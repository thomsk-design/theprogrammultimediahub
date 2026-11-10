// Google Drive (Next to Kin account) via the Apps Script bridge in integrations/google-drive.
// The bridge checks the hub sign-in, then hands back a short-lived token that can only touch
// files the bridge itself created. Files go straight from this browser to Google Drive.
window.HubDrive = (() => {
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink';
  const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KB
  const bridge = () => { const s = window.HubCloud && HubCloud.settings.drive_bridge; return (s && s.url) || ''; };
  const connected = () => !!(bridge() && window.HubCloud && HubCloud.member());
  const today = () => new Date().toLocaleDateString('en-CA');

  async function call(action, extra = {}) {
    const token = window.HubCloud && await HubCloud.token();
    if (!token) throw new Error('Sign in to the hub first.');
    let res;
    try { res = await fetch(bridge(), { method: 'POST', body: JSON.stringify({ action, token, ...extra }) }); }
    catch { throw new Error('Couldn’t reach the Google Drive bridge.'); }
    const data = await res.json().catch(() => ({ error: 'The Google Drive bridge didn’t answer. Check its web app address.' }));
    if (data.error) throw new Error(data.error);
    return data;
  }

  async function upload(blob, { name, folder = '01_Incoming', subfolder = today(), type, onProgress } = {}) {
    const start = await call('start', { folder, subfolder });
    const init = await fetch(UPLOAD, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + start.token, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type || blob.type || 'application/octet-stream', 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify({ name, parents: [start.folderId] }),
    });
    const session = init.headers.get('Location');
    if (!init.ok || !session) throw new Error(`Google Drive refused the upload (${init.status}).`);
    let offset = 0, failures = 0;
    for (;;) {
      const end = Math.min(offset + CHUNK, blob.size);
      let res;
      try {
        res = await fetch(session, { method: 'PUT', headers: blob.size ? { 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}` } : { 'Content-Range': 'bytes */0' }, body: blob.slice(offset, end) });
      } catch {
        if (++failures > 4) throw new Error('The connection dropped during the upload.');
        await new Promise(r => setTimeout(r, 1500 * failures));
        // Ask Google how much arrived, then carry on from there.
        const check = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${blob.size}` } }).catch(() => null);
        const range = check && check.headers.get('Range');
        if (check && check.ok) res = check; else { offset = range ? Number(range.split('-')[1]) + 1 : offset; continue; }
      }
      if (res.status === 308) {
        const range = res.headers.get('Range');
        offset = range ? Number(range.split('-')[1]) + 1 : end;
        failures = 0;
        if (onProgress) onProgress(offset / blob.size);
        continue;
      }
      if (res.ok) {
        const f = await res.json();
        if (onProgress) onProgress(1);
        return { id: f.id, name: f.name, size: Number(f.size) || blob.size, link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, folder: start.folderPath };
      }
      if (res.status >= 500 && ++failures <= 4) { await new Promise(r => setTimeout(r, 1500 * failures)); continue; }
      throw new Error(`The upload stopped (${res.status}).`);
    }
  }

  // Lists the uploaded file for the whole team (staff can see the Drive list in the Media library).
  function addFile(file, extra = {}) {
    if (!Array.isArray(state.files)) state.files = [];
    const member = window.HubCloud && HubCloud.member();
    state.files.unshift({ id: file.id, name: file.name, size: file.size, link: file.link, folder: file.folder, uploadedAt: new Date().toISOString(), by: member ? (member.display_name || member.email) : '', ...extra });
    save();
  }

  return { connected, call, upload, addFile };
})();

(() => {
  const D = window.HubDrive;
  const isStaff = () => { const m = window.HubCloud && HubCloud.member(); return !!m && m.role !== 'talent'; };
  const isAdmin = () => { const m = window.HubCloud && HubCloud.member(); return !!m && m.role === 'admin'; };

  // Uploads interrupted by a reload can't resume from a new page; flag them.
  for (const q of state.queue || []) if (q.state === 'Uploading') { q.state = 'Interrupted · add it again'; q.progress = null; }

  // ---- Media library: real uploads when Drive is connected ----
  let renderTimer = 0;
  const softRender = () => {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = 0; if (location.hash === '#media' && !document.querySelector('dialog[open]') && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName)) render(); }, 600);
  };
  const originalStage = window.stageFiles;
  window.stageFiles = function (files) {
    if (!D.connected() || !isStaff()) return originalStage(files);
    let rejected = 0;
    for (const f of files) {
      if (!/^(audio|video)\//.test(f.type) && !/\.(wav|mp3|m4a|aif|aiff|flac|mov|mp4|mxf)$/i.test(f.name)) { rejected++; continue; }
      const q = { id: uid(), name: f.name, size: f.size, modified: f.lastModified, state: 'Uploading', progress: 0 };
      state.queue.push(q);
      D.upload(f, { name: f.name, folder: '01_Incoming', onProgress: p => { q.progress = p; softRender(); } })
        .then(file => { state.queue = state.queue.filter(x => x !== q); D.addFile(file, { source: 'Media library' }); toast(`${f.name} is in Google Drive`); })
        .catch(error => { q.state = 'Upload failed'; q.progress = null; toast(`${f.name}: ${error.message}`); })
        .finally(() => { save(); render(); });
    }
    save(); render();
    if (rejected) toast(`${rejected} file(s) skipped: only audio and video can be added here.`);
  };

  window.filesPanel = function () {
    const files = (state.files || []).slice().sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    if (!D.connected() && !files.length) return '';
    const when = d => new Date(d).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<section class="panel mt"><div class="panel-head"><h2>In Google Drive</h2><span class="small muted">${files.length} file${files.length === 1 ? '' : 's'}</span></div>${files.length ? `<div class="table-wrap"><table><thead><tr><th>File</th><th>Folder</th><th>Size</th><th>Added</th><th></th></tr></thead><tbody>${files.slice(0, 60).map(f => `<tr><td class="wrap">${esc(f.name)}${f.take ? `<small class="muted"> · take ${esc(f.take)}</small>` : ''}</td><td class="wrap small muted">${esc(f.folder || '')}</td><td>${((f.size || 0) / 1048576).toFixed(1)} MB</td><td class="small muted">${esc(when(f.uploadedAt))}${f.by ? ' · ' + esc(f.by) : ''}</td><td><a class="text-link" href="${esc(f.link)}" target="_blank" rel="noopener">Open ↗</a></td></tr>`).join('')}</tbody></table></div>` : empty('Uploaded files and teleprompter takes will appear here.')}</section>`;
  };

  // ---- Connections page: connect / check the Drive bridge ----
  function guide() {
    modal('Connect the Next to Kin Google Drive', `<ol class="drive-steps">
      <li>Open <a class="text-link" href="https://script.google.com/home/projects/create" target="_blank" rel="noopener">script.google.com ↗</a> <b>signed in as your Next to Kin Google account</b>. A new project opens.</li>
      <li>Name it “The Program hub · Drive bridge”. Replace everything in <b>Code.gs</b> with the bridge code: <button class="btn small" data-drive-copy="/integrations/google-drive/Code.gs">Copy Code.gs</button></li>
      <li>Project Settings (gear) → tick <b>Show “appsscript.json” manifest file in editor</b>. Back in the editor, replace <b>appsscript.json</b> with: <button class="btn small" data-drive-copy="/integrations/google-drive/appsscript.json">Copy appsscript.json</button></li>
      <li>Save, then <b>Deploy → New deployment</b> → type <b>Web app</b>. Execute as <b>Me</b>; Who has access <b>Anyone</b>. Deploy.</li>
      <li>Approve access when asked. Google will say the app isn’t verified because it’s your own script: choose <b>Advanced → Go to … (unsafe)</b>, then <b>Allow</b>. It can only see files it creates.</li>
      <li>Copy the <b>Web app URL</b> (ends in <code>/exec</code>) and paste it on the Google Drive card here, then press <b>Connect</b>.</li>
    </ol><p class="small muted mt">A “The Program · Multimedia Hub” folder with 01_Incoming, 02_Working, 03_Approved and 04_Delivery is created in that Drive on first use.</p>`);
  }
  async function decorateDrive() {
    const card = [...document.querySelectorAll('.integration-card')].find(c => c.querySelector('h2') && c.querySelector('h2').textContent === 'Google Drive');
    if (!card || card.querySelector('.drive-connect')) return;
    const box = document.createElement('div');
    box.className = 'drive-connect';
    const url = (window.HubCloud && HubCloud.settings.drive_bridge && HubCloud.settings.drive_bridge.url) || '';
    if (D.connected()) {
      box.innerHTML = `<div class="small" data-drive-state>Checking the Next to Kin Drive…</div><div class="row mt"><a class="btn" data-drive-open hidden target="_blank" rel="noopener">Open hub folder ↗</a>${isAdmin() ? '<button class="btn" data-drive-edit>Change bridge</button>' : ''}</div>`;
      D.call('status').then(r => {
        box.querySelector('[data-drive-state]').textContent = `Connected · files go to “${r.root.name}”`;
        const open = box.querySelector('[data-drive-open]'); open.href = r.root.webViewLink; open.hidden = false;
      }).catch(error => { box.querySelector('[data-drive-state]').textContent = 'Bridge isn’t answering: ' + error.message; });
    } else if (isAdmin()) {
      box.innerHTML = `<label class="field">Bridge web app URL<input data-drive-url placeholder="https://script.google.com/macros/s/…/exec" value="${esc(url)}"></label><div class="row mt"><button class="btn primary" data-drive-save>Connect</button><button class="btn" data-drive-guide>Setup guide</button></div><p class="small muted" data-drive-msg></p>`;
    } else {
      box.innerHTML = '<p class="small muted">An admin connects the team Google Drive.</p>';
    }
    card.querySelector('[data-connect]') && card.querySelector('[data-connect]').before(box);
  }
  document.addEventListener('click', async event => {
    const t = event.target.closest('[data-drive-guide],[data-drive-save],[data-drive-edit],[data-drive-copy]');
    if (!t) return;
    if (t.dataset.driveGuide !== undefined) return guide();
    if (t.dataset.driveCopy) {
      try { await navigator.clipboard.writeText(await (await fetch(t.dataset.driveCopy, { cache: 'no-store' })).text()); t.textContent = 'Copied ✓'; }
      catch { window.open(t.dataset.driveCopy, '_blank'); }
      return;
    }
    if (t.dataset.driveEdit !== undefined) { await HubCloud.setSetting('drive_bridge', { url: '' }); return render(); }
    if (t.dataset.driveSave !== undefined) {
      const card = t.closest('.drive-connect'), msg = card.querySelector('[data-drive-msg]');
      const url = card.querySelector('[data-drive-url]').value.trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url)) { msg.textContent = 'Paste the Web app URL from Deploy → Manage deployments. It ends in /exec.'; return; }
      t.disabled = true; msg.textContent = 'Checking the bridge…';
      const previous = HubCloud.settings.drive_bridge;
      HubCloud.settings.drive_bridge = { url };
      try {
        const r = await D.call('status');
        await HubCloud.setSetting('drive_bridge', { url, folder: r.root.name, connectedAt: new Date().toISOString() });
        toast('Google Drive connected');
        render();
      } catch (error) {
        HubCloud.settings.drive_bridge = previous;
        msg.textContent = 'That didn’t work: ' + error.message;
      } finally { t.disabled = false; }
    }
  });

  function syncFlags() { for (const i of integrations) if (i.name === 'Google Drive') i.connected = D.connected(); }
  const originalRender = window.render;
  window.render = function () {
    syncFlags();
    originalRender();
    if (location.hash === '#connections') decorateDrive();
  };
  document.addEventListener('hub:settings', () => { syncFlags(); if (!document.body.classList.contains('cloud-wait') && demoRole && ['#connections', '#media', '#overview'].includes(location.hash)) render(); });
})();
