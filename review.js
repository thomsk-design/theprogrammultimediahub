// Review room: edits and rough cuts with versions, timestamped notes from contributors,
// and side-by-side comparison (synced video, or a highlighted text comparison).
// Data lives in Supabase (program_review_items / _versions / _notes); video and audio live in the
// Next to Kin Google Drive and stream through /api/media; text versions are stored in the database.
(() => {
  const VIDEO = /\.(mp4|m4v|mov|webm)$/i, AUDIO = /\.(wav|mp3|m4a|aac|aif|aiff|flac|ogg)$/i, TEXT = /\.(txt|srt|vtt|md)$/i;
  const STAGES = ['Rough cut', 'Fine cut', 'Picture lock', 'Final', 'Script draft', 'Transcript'];
  const kindOf = f => (/^video\//.test(f.type) || VIDEO.test(f.name)) ? 'video' : (/^audio\//.test(f.type) || AUDIO.test(f.name)) ? 'audio' : (/^text\//.test(f.type) || TEXT.test(f.name)) ? 'text' : null;
  const member = () => window.HubCloud && HubCloud.member();
  const isStaff = () => { const m = member(); return !!m && m.role !== 'talent'; };
  const me = () => window.HubCloud && HubCloud.userId && HubCloud.userId();
  const client = () => HubCloud.client();
  const VERSION_COLS = 'id,item_id,number,label,change_note,drive_id,file_name,mime,size,link,duration,uploaded_by_name,created_at';

  const db = { items: [], versions: [], notes: [], loaded: false, error: '' };
  const texts = new Map(); // version id → text content
  let loading = null, channel = null, reloadTimer = 0;
  const ui = { tab: 'All', noteFilter: 'open', showOld: true, anchor: null, mode: 'side', linked: true, offset: 0, hear: 'a', onlyChanges: false, replyTo: null, editing: null };

  // ---------- helpers ----------
  const fmt = s => {
    if (s == null || isNaN(s)) return '';
    s = Math.max(0, s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
  };
  const when = d => new Date(d).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const mb = n => n ? (n / 1048576 >= 1024 ? (n / 1073741824).toFixed(2) + ' GB' : (n / 1048576).toFixed(1) + ' MB') : '';
  const versionsOf = id => db.versions.filter(v => v.item_id === id).sort((a, b) => a.number - b.number);
  const notesOf = id => db.notes.filter(n => n.item_id === id);
  const item = id => db.items.find(i => i.id === id);
  const vname = v => `v${v.number}${v.label ? ' · ' + v.label : ''}`;
  const parse = () => {
    const parts = location.hash.slice(1).split('/');
    return { id: parts[1] || '', sub: parts[2] || '', a: parts[3] || '', b: parts[4] || '' };
  };
  const active = () => ['#review', '#overview'].includes(location.hash.split('/')[0]);
  const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
  const kindTag = k => `<span class="tag ${k === 'video' ? 'blue' : k === 'text' ? '' : 'amber'}">${k === 'video' ? 'Video' : k === 'text' ? 'Text' : 'Audio'}</span>`;

  // ---------- data ----------
  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const sb = await client();
      const [items, versions, notes] = await Promise.all([
        sb.from('program_review_items').select('*').eq('archived', false).order('created_at', { ascending: false }),
        sb.from('program_review_versions').select(VERSION_COLS),
        sb.from('program_review_notes').select('*').order('created_at'),
      ]);
      const error = items.error || versions.error || notes.error;
      if (error) throw error;
      db.items = items.data; db.versions = versions.data; db.notes = notes.data; db.loaded = true; db.error = '';
      listen(sb);
    })().catch(error => { console.error(error); db.error = error.message || String(error); db.loaded = true; }).finally(() => { loading = null; });
    return loading;
  }
  function listen(sb) {
    if (channel) return;
    channel = sb.channel('program-review')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_review_notes' }, () => scheduleReload())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'program_review_versions' }, () => scheduleReload())
      .subscribe();
  }
  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => { await load(); refresh(); }, 400);
  }
  async function textOf(versionId) {
    if (texts.has(versionId)) return texts.get(versionId);
    const { data, error } = await (await client()).from('program_review_versions').select('content').eq('id', versionId).single();
    if (error) throw error;
    texts.set(versionId, data.content || '');
    return data.content || '';
  }

  // Signed-in members get a short-lived playback pass for each file from /api/media.
  const passes = new Map(); // version id → { url, at } or pending promise
  async function src(v) {
    const hit = passes.get(v.id);
    if (hit && hit.url && Date.now() - hit.at < 5 * 3600 * 1000) return hit.url;
    if (hit && hit.then) return hit;
    const p = (async () => {
      const token = await HubCloud.token();
      const res = await fetch('/api/media?v=' + encodeURIComponent(v.id), { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error((await res.text()) || 'Playback isn’t available.');
      const url = '/api/media?t=' + encodeURIComponent((await res.json()).pass);
      passes.set(v.id, { url, at: Date.now() });
      return url;
    })();
    passes.set(v.id, p);
    try { return await p; } catch (error) { passes.delete(v.id); throw error; }
  }

  // ---------- page ----------
  window.reviewPage = function () {
    if (!member()) return head('EDITS AND ROUGH CUTS', 'Review room', 'Versions, timestamped notes and comparisons.') + '<div class="notice">Sign in to the team workspace to use the Review room.</div>';
    if (!db.loaded) { load().then(() => render()); return head('EDITS AND ROUGH CUTS', 'Review room', 'Loading…') + '<div class="empty">Loading the Review room…</div>'; }
    if (db.error) return head('EDITS AND ROUGH CUTS', 'Review room', '') + `<div class="notice">Couldn’t load the Review room: ${esc(db.error)}</div>`;
    const r = parse();
    if (!r.id) return listPage();
    const it = item(r.id);
    if (!it) return head('EDITS AND ROUGH CUTS', 'Review room', '') + `<div class="empty">That item isn’t here any more. <a class="text-link" href="#review">Back to the Review room</a></div>`;
    if (r.sub === 'compare') return comparePage(it, r);
    return itemPage(it, r);
  };

  function dropzone(label, hint) {
    if (!isStaff()) return '';
    return `<div class="rv-drop" data-rv-drop tabindex="0" role="button" aria-label="${esc(label)}"><strong>${label}</strong><span>${hint}</span><input type="file" multiple hidden data-rv-file accept="video/*,audio/*,.mp4,.m4v,.mov,.webm,.wav,.mp3,.m4a,.aif,.aiff,.flac,.txt,.srt,.vtt,.md,text/plain"></div>`;
  }

  function listPage() {
    const rows = db.items.filter(i => ui.tab === 'All' || (ui.tab === 'Video' ? i.kind === 'video' : ui.tab === 'Text' ? i.kind === 'text' : i.kind === 'audio')).map(i => {
      const vs = versionsOf(i.id), last = vs[vs.length - 1], open = notesOf(i.id).filter(n => !n.resolved && !n.parent_id).length;
      const updated = [i.created_at, ...vs.map(v => v.created_at), ...notesOf(i.id).map(n => n.created_at)].sort().pop();
      return `<tr class="rv-row" data-href="#review/${esc(i.id)}"><td class="wrap"><a class="file-name" href="#review/${esc(i.id)}">${esc(i.title)}</a></td><td>${kindTag(i.kind)}</td><td>${last ? esc(vname(last)) : '<span class="muted small">no file yet</span>'}</td><td>${vs.length}</td><td>${open ? `<span class="rv-count">${open}</span>` : '<span class="muted small">—</span>'}</td><td class="small muted">${esc(when(updated))}</td></tr>`;
    }).join('');
    return head('EDITS AND ROUGH CUTS', 'Review room', 'Every cut in one place: versions, timestamped notes from the team, and side-by-side comparison.')
      + dropzone('Drop videos, audio or text files here', 'Rough cuts, edits, scripts and transcripts (.mp4, .mov, .wav, .txt, .srt). New items or new versions of existing ones.')
      + `<div class="filter-tabs">${['All', 'Video', 'Audio', 'Text'].map(t => `<button class="${ui.tab === t ? 'active' : ''}" data-rv-tab="${t}">${t}</button>`).join('')}</div>`
      + `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Item</th><th>Type</th><th>Latest version</th><th>Versions</th><th>Open notes</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>${rows ? '' : empty(isStaff() ? 'Nothing to review yet. Drop a cut or a script above.' : 'Nothing to review yet.')}</div></section>`
      + (isStaff() ? '<div class="notice mt">For smooth playback, export review copies as H.264 .mp4 (1080p, about 8–10 Mbps). ProRes .mov files upload fine but most browsers can’t play them.</div>' : '');
  }

  function versionChips(it, vs, current, extra = '') {
    return `<div class="rv-versions" role="tablist">${vs.map(v => `<a role="tab" class="rv-chip ${current && v.id === current.id ? 'active' : ''}" href="#review/${esc(it.id)}/v${v.number}" aria-selected="${current && v.id === current.id}">v${v.number}${v.label ? `<small>${esc(v.label)}</small>` : ''}</a>`).join('')}${extra}</div>`;
  }

  function itemPage(it, r) {
    const vs = versionsOf(it.id);
    const n = /^v(\d+)$/.exec(r.sub);
    const v = (n && vs.find(x => x.number === Number(n[1]))) || vs[vs.length - 1];
    const staffMenu = isStaff() ? `<button class="btn" data-rv-rename>Rename</button><button class="btn" data-rv-archive>Archive</button>` : '';
    const compare = vs.length > 1 ? `<a class="btn primary" href="#review/${esc(it.id)}/compare/${vs[vs.length - 2].number}/${vs[vs.length - 1].number}">⇆ Compare versions</a>` : '';
    let stage = '';
    if (!v) stage = `<div class="empty">No file yet.</div>`;
    else if (it.kind === 'text') stage = `<div class="rv-text" data-rv-text><div class="empty">Loading…</div></div>`;
    else stage = `<div class="rv-player-wrap ${it.kind}"><${it.kind === 'audio' ? 'audio' : 'video'} id="rv-player" controls preload="metadata" playsinline></${it.kind === 'audio' ? 'audio' : 'video'}><div class="rv-player-msg" hidden></div></div>
      <div class="rv-timeline" data-rv-timeline title="Notes on this version"><div class="rv-playhead"></div></div>
      <div class="rv-transport"><span class="rv-time" data-rv-time>0:00</span><button class="btn small" data-rv-step="-5" title="Back 5 seconds (←)">−5s</button><button class="btn small" data-rv-step="-0.0417" title="Back one frame (,)">◁ frame</button><button class="btn small" data-rv-step="0.0417" title="Forward one frame (.)">frame ▷</button><button class="btn small" data-rv-step="5" title="Forward 5 seconds (→)">+5s</button><select class="rv-speed" data-rv-speed aria-label="Playback speed">${[0.5, 0.75, 1, 1.25, 1.5, 2].map(s => `<option value="${s}" ${s === 1 ? 'selected' : ''}>${s}×</option>`).join('')}</select><button class="btn gold small" data-rv-note-here>＋ Note at this moment <kbd>N</kbd></button></div>`;
    const meta = v ? `<div class="rv-meta"><b>${esc(vname(v))}</b> · uploaded by ${esc(v.uploaded_by_name || 'someone')}, ${esc(when(v.created_at))}${v.size ? ' · ' + esc(mb(v.size)) : ''}${v.duration ? ' · ' + esc(fmt(v.duration)) : ''}${v.link ? ` · <a class="text-link" href="${esc(v.link)}" target="_blank" rel="noopener">Open in Drive ↗</a>` : ''}${isStaff() ? ` · <button class="text-link danger-link" data-rv-remove-version="${esc(v.id)}">Remove version</button>` : ''}${v.change_note ? `<p class="rv-change">What changed: ${esc(v.change_note)}</p>` : ''}</div>` : '';
    return `<div class="rv" data-review-view="${esc(location.hash)}" data-item="${esc(it.id)}" data-version="${esc(v ? v.id : '')}">
      <a class="text-link rv-back" href="#review">← Review room</a>
      <div class="page-head rv-head"><div><div class="eyebrow">${it.kind === 'text' ? 'TEXT' : it.kind === 'audio' ? 'AUDIO' : 'VIDEO'} · ${vs.length} VERSION${vs.length === 1 ? '' : 'S'}</div><h1>${esc(it.title)}</h1></div><div class="row">${compare}${staffMenu}</div></div>
      ${versionChips(it, vs, v, isStaff() ? `<button class="rv-chip add" data-rv-add-version>＋ New version</button>` : '')}
      ${meta}
      <div class="rv-grid"><section class="rv-stage">${stage}</section><aside class="rv-notes panel" data-rv-notes>${notesPanel(it, v)}</aside></div>
      ${dropzone(`Drop the next cut here to add v${(vs.length ? vs[vs.length - 1].number : 0) + 1}`, 'It’s added as a new version of this item. Notes on earlier versions stay where they are.')}
    </div>`;
  }

  // ---------- notes ----------
  function anchorLabel(n) {
    if (n.at_seconds != null) return fmt(n.at_seconds);
    if (n.line != null) return 'line ' + n.line;
    return 'general';
  }
  function notesPanel(it, v, versionsShown) {
    if (!v) return '<div class="panel-body small muted">Notes appear once there’s a version to review.</div>';
    const vs = versionsOf(it.id);
    const shown = versionsShown || (ui.showOld ? vs.filter(x => x.number <= v.number).map(x => x.id) : [v.id]);
    const all = notesOf(it.id);
    const tops = all.filter(n => !n.parent_id && shown.includes(n.version_id));
    const open = tops.filter(n => !n.resolved).length;
    const list = tops.filter(n => ui.noteFilter === 'all' || !n.resolved)
      .sort((a, b) => (a.version_id === v.id ? 0 : 1) - (b.version_id === v.id ? 0 : 1) || (a.at_seconds ?? a.line ?? -1) - (b.at_seconds ?? b.line ?? -1) || a.created_at.localeCompare(b.created_at));
    const vOf = id => db.versions.find(x => x.id === id);
    const card = (n, reply) => {
      const nv = vOf(n.version_id), mine = n.author === me(), canEdit = mine, canDelete = mine || isStaff();
      const other = nv && nv.id !== v.id;
      const body = ui.editing === n.id
        ? `<form data-rv-edit-form="${esc(n.id)}"><textarea name="body" rows="3" required maxlength="4000">${esc(n.body)}</textarea><div class="row"><button class="btn small primary">Save</button><button class="btn small" type="button" data-rv-edit-cancel>Cancel</button></div></form>`
        : `<p>${esc(n.body).replace(/\n/g, '<br>')}</p>`;
      return `<li class="rv-note ${n.resolved ? 'resolved' : ''} ${reply ? 'reply' : ''}" data-note="${esc(n.id)}">
        <div class="rv-note-head">${reply ? '' : `<button class="rv-at" data-rv-seek="${n.at_seconds ?? ''}" data-rv-line="${n.line ?? ''}" data-rv-version="${esc(n.version_id)}" title="${other ? 'Left on ' + esc(vname(nv)) : 'Jump here'}">${esc(anchorLabel(n))}</button>`}<b>${esc(n.author_name || 'Someone')}</b>${other ? `<span class="rv-vbadge">v${nv.number}</span>` : ''}<span class="small muted">${esc(when(n.created_at))}</span></div>
        ${body}
        <div class="rv-note-actions">${reply ? '' : `<button class="text-link" data-rv-reply="${esc(n.id)}">Reply</button><button class="text-link" data-rv-resolve="${esc(n.id)}">${n.resolved ? 'Reopen' : 'Resolve'}</button>`}${canEdit && ui.editing !== n.id ? `<button class="text-link" data-rv-edit="${esc(n.id)}">Edit</button>` : ''}${canDelete ? `<button class="text-link danger-link" data-rv-delete="${esc(n.id)}">Delete</button>` : ''}${n.resolved && n.resolved_by_name && !reply ? `<span class="small muted">Resolved by ${esc(n.resolved_by_name)}</span>` : ''}</div>
        ${reply ? '' : `<ul class="rv-replies">${all.filter(x => x.parent_id === n.id).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(x => card(x, true)).join('')}</ul>${ui.replyTo === n.id ? `<form class="rv-reply-form" data-rv-reply-form="${esc(n.id)}"><textarea name="body" rows="2" required maxlength="4000" placeholder="Reply…"></textarea><div class="row"><button class="btn small primary">Reply</button><button class="btn small" type="button" data-rv-reply-cancel>Cancel</button></div></form>` : ''}`}
      </li>`;
    };
    const timed = it.kind !== 'text';
    const a = ui.anchor;
    const anchorChip = a == null ? `<span class="rv-anchor none">General note</span>` : `<span class="rv-anchor">${timed ? 'at ' + fmt(a) : 'line ' + a}<button type="button" data-rv-anchor-clear aria-label="Remove ${timed ? 'timestamp' : 'line'}">×</button></span>`;
    return `<div class="panel-head"><h2>Notes</h2><span class="small muted">${open} open</span></div>
      <form class="rv-compose" data-rv-compose><div class="rv-compose-top">${anchorChip}${timed ? '<button type="button" class="text-link" data-rv-anchor-now>Use current time</button>' : '<span class="small muted">Click a line to pin a note to it</span>'}</div>
        <textarea name="body" rows="3" required maxlength="4000" placeholder="${timed ? 'What should change at this moment?' : 'What should change in this line?'}" data-rv-compose-body></textarea>
        <div class="row rv-compose-foot"><span class="small muted">${esc(vname(v))} · ⌘↩ to post</span><button class="btn primary small">Post note</button></div></form>
      <div class="rv-note-filters"><button class="${ui.noteFilter === 'open' ? 'active' : ''}" data-rv-filter="open">Open</button><button class="${ui.noteFilter === 'all' ? 'active' : ''}" data-rv-filter="all">All</button>${versionsShown ? '' : `<label class="small"><input type="checkbox" data-rv-show-old ${ui.showOld ? 'checked' : ''}> Include earlier versions</label>`}</div>
      <ul class="rv-note-list">${list.map(n => card(n)).join('') || `<li class="empty">${ui.noteFilter === 'open' ? 'No open notes.' : 'No notes yet.'}</li>`}</ul>`;
  }

  async function postNote(form) {
    const root = form.closest('[data-review-view]');
    const body = form.body.value.trim();
    if (!body) return;
    const versionId = root.dataset.version;
    const it = item(root.dataset.item);
    const row = { version_id: versionId, item_id: it.id, body, author: me() };
    if (ui.anchor != null) { if (it.kind === 'text') row.line = ui.anchor; else row.at_seconds = Math.round(ui.anchor * 100) / 100; }
    form.querySelector('button.primary').disabled = true;
    const { data, error } = await (await client()).from('program_review_notes').insert(row).select().single();
    if (error) { toast('Couldn’t post the note: ' + error.message); form.querySelector('button.primary').disabled = false; return; }
    db.notes.push(data);
    form.body.value = '';
    if (it.kind === 'text') ui.anchor = null;
    refresh();
    toast('Note posted');
  }
  async function updateNote(id, patch) {
    const { data, error } = await (await client()).from('program_review_notes').update(patch).eq('id', id).select().single();
    if (error) { toast('Couldn’t update the note: ' + error.message); return; }
    db.notes = db.notes.map(n => n.id === id ? data : n);
    refresh();
  }

  // ---------- mounting (players, text, keyboard) ----------
  let player = null, cmp = null, tick = 0;
  function mount() {
    cancelAnimationFrame(tick); player = null; cmp = null;
    const root = document.querySelector('#main [data-review-view]');
    if (!root) return;
    const it = item(root.dataset.item), v = db.versions.find(x => x.id === root.dataset.version);
    if (root.dataset.compare) return mountCompare(root, it);
    if (!v) return;
    if (it.kind === 'text') return mountText(root, it, v);
    player = root.querySelector('#rv-player');
    const msg = root.querySelector('.rv-player-msg');
    src(v).then(url => { player.src = url; }).catch(error => { msg.hidden = false; msg.textContent = 'Couldn’t play this file: ' + error.message; });
    player.addEventListener('error', async () => {
      msg.hidden = false;
      // Ask the relay what went wrong so the message is specific.
      try {
        const res = await fetch(await src(v), { headers: { Range: 'bytes=0-0' } });
        if (!res.ok) { const why = (await res.text()).slice(0, 300); msg.innerHTML = `Couldn’t play this file: ${esc(why)}${v.link ? ` <a class="text-link" target="_blank" rel="noopener" href="${esc(v.link)}">Open it in Drive ↗</a>` : ''}`; return; }
      } catch {}
      msg.innerHTML = /\.mov$/i.test(v.file_name || '') ? 'This browser can’t play this .mov file (it may be ProRes). Upload an H.264 .mp4 review copy, or <a class="text-link" target="_blank" rel="noopener" href="' + esc(v.link || '#') + '">open it in Drive ↗</a>.' : 'Couldn’t play this file. <a class="text-link" target="_blank" rel="noopener" href="' + esc(v.link || '#') + '">Open it in Drive ↗</a>';
    });
    player.addEventListener('loadedmetadata', () => {
      drawMarkers(root, it, v);
      if (isStaff() && !v.duration && isFinite(player.duration)) client().then(sb => sb.from('program_review_versions').update({ duration: Math.round(player.duration * 10) / 10 }).eq('id', v.id)).then(() => { v.duration = player.duration; });
      const t = sessionStorage.getItem('rv-seek'); if (t) { sessionStorage.removeItem('rv-seek'); player.currentTime = Number(t); }
    });
    const time = root.querySelector('[data-rv-time]'), head = root.querySelector('.rv-playhead');
    const loop = () => {
      if (!player || !document.body.contains(player)) return;
      time.textContent = fmt(player.currentTime) + (isFinite(player.duration) ? ' / ' + fmt(player.duration) : '');
      if (isFinite(player.duration) && player.duration) head.style.left = (player.currentTime / player.duration * 100) + '%';
      tick = requestAnimationFrame(loop);
    };
    loop();
  }
  function drawMarkers(root, it, v) {
    const line = root.querySelector('[data-rv-timeline]');
    if (!line || !player || !isFinite(player.duration)) return;
    line.querySelectorAll('.rv-marker').forEach(m => m.remove());
    for (const n of notesOf(it.id).filter(n => n.version_id === v.id && !n.parent_id && n.at_seconds != null)) {
      const m = document.createElement('button');
      m.className = 'rv-marker' + (n.resolved ? ' resolved' : '');
      m.style.left = Math.min(100, n.at_seconds / player.duration * 100) + '%';
      m.title = `${fmt(n.at_seconds)} · ${n.author_name || ''}: ${n.body.slice(0, 80)}`;
      m.dataset.rvSeek = n.at_seconds; m.dataset.rvNoteFocus = n.id;
      line.append(m);
    }
  }
  async function mountText(root, it, v) {
    const box = root.querySelector('[data-rv-text]');
    let content;
    try { content = await textOf(v.id); } catch (error) { box.innerHTML = `<div class="empty">Couldn’t load the text: ${esc(error.message)}</div>`; return; }
    if (!document.body.contains(box)) return;
    drawText(box, it, v, content);
  }
  function drawText(box, it, v, content) {
    const counts = {};
    for (const n of notesOf(it.id)) if (n.version_id === v.id && n.line != null && !n.parent_id && !n.resolved) counts[n.line] = (counts[n.line] || 0) + 1;
    const lines = linesOf(content);
    box.innerHTML = `<div class="rv-lines">${lines.map((l, i) => `<div class="rv-line ${counts[i + 1] ? 'has-note' : ''} ${ui.anchor === i + 1 ? 'anchored' : ''}" data-rv-pick-line="${i + 1}"><span class="rv-ln">${i + 1}</span><span class="rv-lt">${esc(l) || '&nbsp;'}</span>${counts[i + 1] ? `<span class="rv-count">${counts[i + 1]}</span>` : ''}</div>`).join('')}</div>`;
    const t = sessionStorage.getItem('rv-line');
    if (t) { sessionStorage.removeItem('rv-line'); flashLine(Number(t)); }
  }
  function flashLine(n) {
    const el = document.querySelector(`[data-rv-pick-line="${n}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400);
  }

  // Re-draw notes and markers without reloading the player.
  function refresh() {
    const root = document.querySelector('#main [data-review-view]');
    if (location.hash.split('/')[0] !== '#review') return;
    if (!root) return render();
    const it = item(root.dataset.item);
    if (!it) return render();
    if (root.dataset.compare) {
      const panel = root.querySelector('[data-rv-notes]');
      if (panel) { const keep = panel.querySelector('textarea[name=body]'); const text = keep && keep.value; panel.innerHTML = compareNotes(it, cmp && cmp.va, cmp && cmp.vb); const t = panel.querySelector('textarea[name=body]'); if (t && text) t.value = text; }
      return;
    }
    const v = db.versions.find(x => x.id === root.dataset.version);
    const panel = root.querySelector('[data-rv-notes]');
    const draft = panel.querySelector('[data-rv-compose-body]');
    const text = draft ? draft.value : '';
    const focused = document.activeElement === draft;
    panel.innerHTML = notesPanel(it, v);
    const fresh = panel.querySelector('[data-rv-compose-body]');
    if (fresh && text) fresh.value = text;
    if (fresh && focused) fresh.focus();
    if (it.kind === 'text') { const box = root.querySelector('[data-rv-text]'); if (box && texts.has(v.id)) drawText(box, it, v, texts.get(v.id)); }
    else drawMarkers(root, it, v);
  }

  // ---------- compare ----------
  function comparePage(it, r) {
    const vs = versionsOf(it.id);
    const va = vs.find(x => x.number === Number(r.a)) || vs[vs.length - 2], vb = vs.find(x => x.number === Number(r.b)) || vs[vs.length - 1];
    if (!va || !vb) return `<div class="empty">Two versions are needed to compare. <a class="text-link" href="#review/${esc(it.id)}">Back</a></div>`;
    const pick = (name, cur) => `<select data-rv-cmp="${name}" aria-label="Version ${name.toUpperCase()}">${vs.map(v => `<option value="${v.number}" ${v.id === cur.id ? 'selected' : ''}>${esc(vname(v))}</option>`).join('')}</select>`;
    const head = `<div class="rv-cmp-bar"><span class="rv-cmp-label a">A</span>${pick('a', va)}<button class="btn small" data-rv-swap title="Swap A and B">⇄</button><span class="rv-cmp-label b">B</span>${pick('b', vb)}${it.kind === 'text' ? `<label class="small"><input type="checkbox" data-rv-only-changes ${ui.onlyChanges ? 'checked' : ''}> Only show changes</label>` : `<div class="rv-seg"><button class="${ui.mode === 'side' ? 'active' : ''}" data-rv-mode="side">Side by side</button><button class="${ui.mode === 'flip' ? 'active' : ''}" data-rv-mode="flip">A/B flip <kbd>F</kbd></button></div>`}</div>`;
    let stage;
    if (it.kind === 'text') stage = `<div class="rv-diff" data-rv-diff><div class="empty">Comparing…</div></div>`;
    else {
      const tag = it.kind === 'audio' ? 'audio' : 'video';
      stage = `<div class="rv-cmp-stage ${ui.mode} ${tag}" data-rv-cmp-stage data-show="${ui.hear}">
        <figure class="rv-cmp-pane a"><figcaption><span class="rv-cmp-label a">A</span>${esc(vname(va))}</figcaption><${tag} data-rv-pa preload="metadata" playsinline></${tag}></figure>
        <figure class="rv-cmp-pane b"><figcaption><span class="rv-cmp-label b">B</span>${esc(vname(vb))}</figcaption><${tag} data-rv-pb preload="metadata" playsinline muted></${tag}></figure>
      </div>
      <div class="rv-cmp-controls">
        <button class="btn primary" data-rv-cmp-play aria-label="Play or pause both">▶</button>
        <input type="range" min="0" max="1000" value="0" data-rv-cmp-scrub aria-label="Position">
        <span class="rv-time" data-rv-cmp-time>0:00</span>
        <button class="btn small" data-rv-cmp-step="-5">−5s</button><button class="btn small" data-rv-cmp-step="5">+5s</button>
        <div class="rv-seg"><button class="${ui.hear === 'a' ? 'active' : ''}" data-rv-hear="a">Hear A</button><button class="${ui.hear === 'b' ? 'active' : ''}" data-rv-hear="b">Hear B</button></div>
        <button class="btn small ${ui.linked ? '' : 'gold'}" data-rv-link title="Unlink to line B up by hand (for cuts where a section moved), then link again">${ui.linked ? '🔗 Linked' : '⛓ Unlinked: line up B, then relink'}</button>
        <span class="small muted" data-rv-offset>${ui.offset ? `B is ${ui.offset > 0 ? '+' : '−'}${Math.abs(ui.offset).toFixed(2)}s from A` : ''}</span>
      </div>`;
    }
    return `<div class="rv" data-review-view="${esc(location.hash)}" data-item="${esc(it.id)}" data-compare="1" data-va="${esc(va.id)}" data-vb="${esc(vb.id)}">
      <a class="text-link rv-back" href="#review/${esc(it.id)}/v${vb.number}">← ${esc(it.title)}</a>
      <div class="page-head rv-head"><div><div class="eyebrow">COMPARE VERSIONS</div><h1>${esc(it.title)}</h1></div></div>
      ${head}
      <div class="rv-grid wide"><section class="rv-stage">${stage}</section><aside class="rv-notes panel" data-rv-notes>${compareNotes(it, va, vb)}</aside></div>
    </div>`;
  }
  function compareNotes(it, va, vb) {
    if (!va || !vb) return '';
    const all = notesOf(it.id).filter(n => !n.parent_id && (n.version_id === va.id || n.version_id === vb.id));
    const open = all.filter(n => !n.resolved).length;
    const list = all.filter(n => ui.noteFilter === 'all' || !n.resolved).sort((a, b) => (a.at_seconds ?? a.line ?? -1) - (b.at_seconds ?? b.line ?? -1));
    return `<div class="panel-head"><h2>Notes on A and B</h2><span class="small muted">${open} open</span></div>
      <p class="small muted rv-cmp-hint">Check each note from A against B, then resolve it. ${it.kind === 'text' ? '' : 'Click a time to jump both players there.'}</p>
      <div class="rv-note-filters"><button class="${ui.noteFilter === 'open' ? 'active' : ''}" data-rv-filter="open">Open</button><button class="${ui.noteFilter === 'all' ? 'active' : ''}" data-rv-filter="all">All</button></div>
      <ul class="rv-note-list">${list.map(n => `<li class="rv-note ${n.resolved ? 'resolved' : ''}"><div class="rv-note-head"><button class="rv-at" data-rv-cmp-seek="${n.at_seconds ?? ''}" data-rv-cmp-side="${n.version_id === va.id ? 'a' : 'b'}">${esc(anchorLabel(n))}</button><span class="rv-cmp-label ${n.version_id === va.id ? 'a' : 'b'}">${n.version_id === va.id ? 'A' : 'B'}</span><b>${esc(n.author_name || '')}</b></div><p>${esc(n.body).replace(/\n/g, '<br>')}</p><div class="rv-note-actions"><button class="text-link" data-rv-resolve="${esc(n.id)}">${n.resolved ? 'Reopen' : 'Resolve'}</button></div></li>`).join('') || `<li class="empty">${ui.noteFilter === 'open' ? 'No open notes.' : 'No notes yet.'}</li>`}</ul>`;
  }

  function mountCompare(root, it) {
    const va = db.versions.find(x => x.id === root.dataset.va), vb = db.versions.find(x => x.id === root.dataset.vb);
    cmp = { va, vb };
    if (it.kind === 'text') {
      const box = root.querySelector('[data-rv-diff]');
      Promise.all([textOf(va.id), textOf(vb.id)]).then(([a, b]) => { if (document.body.contains(box)) box.innerHTML = diffView(a, b); })
        .catch(error => { box.innerHTML = `<div class="empty">Couldn’t load: ${esc(error.message)}</div>`; });
      return;
    }
    const A = root.querySelector('[data-rv-pa]'), B = root.querySelector('[data-rv-pb]');
    Object.assign(cmp, { A, B });
    const applyHear = () => { A.muted = ui.hear !== 'a'; B.muted = ui.hear !== 'b'; };
    applyHear();
    Promise.all([src(va), src(vb)]).then(([a, b]) => { A.src = a; B.src = b; }).catch(error => toast('Couldn’t play: ' + error.message));
    const playBtn = root.querySelector('[data-rv-cmp-play]'), scrub = root.querySelector('[data-rv-cmp-scrub]'), time = root.querySelector('[data-rv-cmp-time]');
    let scrubbing = false;
    A.addEventListener('play', () => { playBtn.textContent = '❚❚'; if (ui.linked) B.play().catch(() => {}); });
    A.addEventListener('pause', () => { playBtn.textContent = '▶'; if (ui.linked) B.pause(); });
    A.addEventListener('seeked', () => { if (ui.linked) B.currentTime = Math.max(0, A.currentTime + ui.offset); });
    A.addEventListener('ratechange', () => { B.playbackRate = A.playbackRate; });
    scrub.addEventListener('input', () => { scrubbing = true; if (isFinite(A.duration)) A.currentTime = scrub.value / 1000 * A.duration; });
    scrub.addEventListener('change', () => { scrubbing = false; });
    const loop = () => {
      if (!document.body.contains(A)) return;
      if (ui.linked && !A.paused && !B.seeking && Math.abs(B.currentTime - (A.currentTime + ui.offset)) > 0.12) B.currentTime = Math.max(0, A.currentTime + ui.offset);
      if (isFinite(A.duration) && A.duration) { if (!scrubbing) scrub.value = Math.round(A.currentTime / A.duration * 1000); time.textContent = `A ${fmt(A.currentTime)} · B ${fmt(B.currentTime)}`; }
      tick = requestAnimationFrame(loop);
    };
    loop();
    cmp.applyHear = applyHear;
  }

  // Line diff (LCS), with word-level highlights inside changed lines.
  function lcs(a, b) {
    const n = a.length, m = b.length;
    let s = 0; while (s < n && s < m && a[s] === b[s]) s++;
    let e = 0; while (e < n - s && e < m - s && a[n - 1 - e] === b[m - 1 - e]) e++;
    const A = a.slice(s, n - e), B = b.slice(s, m - e), N = A.length, M = B.length, ops = [];
    for (let i = 0; i < s; i++) ops.push(['=', a[i], b[i]]);
    if (N * M > 12e6) { A.forEach(x => ops.push(['-', x])); B.forEach(y => ops.push(['+', null, y])); }
    else {
      const W = M + 1, T = new Uint32Array((N + 1) * W);
      for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) T[i * W + j] = A[i] === B[j] ? T[(i + 1) * W + j + 1] + 1 : Math.max(T[(i + 1) * W + j], T[i * W + j + 1]);
      let i = 0, j = 0;
      while (i < N && j < M) {
        if (A[i] === B[j]) { ops.push(['=', A[i], B[j]]); i++; j++; }
        else if (T[(i + 1) * W + j] >= T[i * W + j + 1]) ops.push(['-', A[i++]]);
        else ops.push(['+', null, B[j++]]);
      }
      while (i < N) ops.push(['-', A[i++]]);
      while (j < M) ops.push(['+', null, B[j++]]);
    }
    for (let i = n - e; i < n; i++) ops.push(['=', a[i], b[i - n + m]]);
    return ops;
  }
  function words(a, b) {
    const ta = a.split(/(\s+)/), tb = b.split(/(\s+)/);
    if (ta.length * tb.length > 4e5) return [`<del>${esc(a)}</del>`, `<ins>${esc(b)}</ins>`];
    let L = '', R = '';
    for (const [op, x, y] of lcs(ta, tb)) {
      if (op === '=') { L += esc(x); R += esc(y); }
      else if (op === '-') L += /^\s+$/.test(x) ? esc(x) : `<del>${esc(x)}</del>`;
      else R += /^\s+$/.test(y) ? esc(y) : `<ins>${esc(y)}</ins>`;
    }
    return [L, R];
  }
  function similar(a, b) {
    const wa = a.toLowerCase().match(/[\w'’]+/g) || [], wb = b.toLowerCase().match(/[\w'’]+/g) || [];
    if (!wa.length || !wb.length) return false;
    const set = new Set(wb);
    return wa.filter(w => set.has(w)).length / Math.max(wa.length, wb.length) >= 0.5;
  }
  const linesOf = t => { const l = t.replace(/\r\n?/g, '\n').split('\n'); if (l.length > 1 && l[l.length - 1] === '') l.pop(); return l; };
  function diffView(a, b) {
    const la = linesOf(a), lb = linesOf(b);
    const ops = lcs(la, lb), rows = [];
    let ia = 0, ib = 0, added = 0, removed = 0, changed = 0;
    for (let k = 0; k < ops.length;) {
      if (ops[k][0] === '=') { rows.push(['=', ++ia, esc(ops[k][1]), ++ib, esc(ops[k][2])]); k++; continue; }
      const dels = [], ins = [];
      while (k < ops.length && ops[k][0] !== '=') { if (ops[k][0] === '-') dels.push(ops[k][1]); else ins.push(ops[k][2]); k++; }
      // Pair a removed line with an added one only when they share most of their words.
      let p = 0, q = 0;
      while (p < dels.length || q < ins.length) {
        if (p < dels.length && q < ins.length && similar(dels[p], ins[q])) { const [L, R] = words(dels[p++], ins[q++]); rows.push(['~', ++ia, L, ++ib, R]); changed++; }
        else if (p < dels.length && (q >= ins.length || !ins.slice(q).some(y => similar(dels[p], y)))) { rows.push(['-', ++ia, esc(dels[p++]), '', '']); removed++; }
        else { rows.push(['+', '', '', ++ib, esc(ins[q++])]); added++; }
      }
    }
    const shown = ui.onlyChanges ? rows.filter((r, i) => r[0] !== '=' || [-2, -1, 1, 2].some(d => rows[i + d] && rows[i + d][0] !== '=')) : rows;
    const cls = { '=': '', '~': 'chg', '-': 'del', '+': 'ins' };
    return `<div class="rv-diff-sum"><span class="ins">+${added} added</span><span class="del">−${removed} removed</span><span class="chg">${changed} changed</span>${!added && !removed && !changed ? '<span>No differences</span>' : ''}</div>
      <div class="rv-diff-table" role="table"><div class="rv-diff-row head" role="row"><span></span><span>A</span><span></span><span>B</span></div>${shown.map(r => `<div class="rv-diff-row ${cls[r[0]]}" role="row"><span class="rv-ln">${r[1]}</span><span class="rv-dl">${r[2] || (r[0] === '+' ? '' : '&nbsp;')}</span><span class="rv-ln">${r[3]}</span><span class="rv-dr">${r[4] || (r[0] === '-' ? '' : '&nbsp;')}</span></div>`).join('')}</div>`;
  }

  // ---------- uploads ----------
  function addFiles(files, intoItem) {
    if (!isStaff()) return;
    const list = [...files].map(f => ({ f, kind: kindOf(f) }));
    const bad = list.filter(x => !x.kind), good = list.filter(x => x.kind);
    if (bad.length) toast(`${bad.length} file(s) skipped: only video, audio and text files (.txt, .srt, .vtt) can go in the Review room.`);
    if (!good.length) return;
    const needsDrive = good.some(x => x.kind !== 'text');
    if (needsDrive && !(window.HubDrive && HubDrive.connected())) { toast('Connect Google Drive (Connections page) before adding video or audio.'); if (!good.some(x => x.kind === 'text')) return; }
    const options = kind => db.items.filter(i => i.kind === kind);
    const base = name => name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/[\s-]*(v|ver|version)\s*\d+$/i, '').trim() || name;
    const guess = x => { const b = base(x.f.name).toLowerCase(); const hit = options(x.kind).find(it => it.title.toLowerCase() === b); return hit ? hit.id : ''; };
    modal('Add to the Review room', `<form id="rv-add-form" class="rv-add">${good.map((x, i) => {
      const its = options(x.kind), pre = intoItem && intoItem.kind === x.kind ? intoItem.id : guess(x);
      return `<fieldset class="rv-add-file" data-i="${i}"><legend>${esc(x.f.name)} <span class="small muted">${esc(mb(x.f.size))}</span> ${kindTag(x.kind)}</legend>
        <label class="field">Add as<select name="target-${i}" data-rv-target>${`<option value="">New item</option>` + its.map(it => `<option value="${esc(it.id)}" ${it.id === pre ? 'selected' : ''}>New version of “${esc(it.title)}” (v${(versionsOf(it.id).slice(-1)[0] || { number: 0 }).number + 1})</option>`).join('')}</select></label>
        <label class="field" data-rv-title-field ${pre ? 'hidden' : ''}>Title<input name="title-${i}" value="${esc(base(x.f.name))}" maxlength="200"></label>
        <div class="row rv-add-row"><label class="field">Stage<select name="label-${i}">${(x.kind === 'text' ? ['Script draft', 'Transcript', 'Rough cut', 'Final'] : STAGES.filter(s => !['Script draft', 'Transcript'].includes(s))).map(s => `<option>${s}</option>`).join('')}<option value="">(none)</option></select></label>
        <label class="field rv-grow">What changed<input name="note-${i}" maxlength="2000" placeholder="${pre ? 'e.g. tightened the intro, new music under 2:10' : 'e.g. first assembly'}"></label></div>
        <div class="rv-progress-line" data-progress="${i}" hidden><span></span><b></b></div>
      </fieldset>`;
    }).join('')}<p class="small muted">Video and audio go to “02_Working / Review · &lt;title&gt;” in the Next to Kin Drive. Keep this page open until each file shows ✓.</p></form>`,
    `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rv-add-go">Add ${good.length === 1 ? 'file' : good.length + ' files'}</button>`);
    const form = $('#rv-add-form');
    form.addEventListener('change', e => { if (e.target.matches('[data-rv-target]')) e.target.closest('fieldset').querySelector('[data-rv-title-field]').hidden = !!e.target.value; });
    document.querySelectorAll('#dialog [data-close]').forEach(b => b.onclick = () => $('#dialog').close());
    $('#rv-add-go').onclick = async () => {
      $('#rv-add-go').disabled = true;
      const sb = await client();
      let lastItem = null, failures = 0;
      for (const [i, x] of good.entries()) {
        const fs = form.querySelector(`[data-i="${i}"]`), prog = fs.querySelector('[data-progress]'), say = (t, cls = '') => { prog.hidden = false; prog.className = 'rv-progress-line ' + cls; prog.querySelector('b').textContent = t; };
        const bar = p => { prog.hidden = false; prog.querySelector('span').style.width = Math.round(p * 100) + '%'; say(Math.round(p * 100) + '%'); };
        try {
          let target = form[`target-${i}`].value, it = target ? item(target) : null;
          const title = (form[`title-${i}`].value || base(x.f.name)).trim().slice(0, 200);
          const label = form[`label-${i}`].value || null, change = form[`note-${i}`].value.trim() || null;
          const folderTitle = (it ? it.title : title).replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
          let file = null, content = null;
          if (x.kind === 'text') {
            content = await x.f.text();
            if (content.length > 2000000) throw new Error('Text files over 2 MB aren’t supported.');
            if (window.HubDrive && HubDrive.connected()) file = await HubDrive.upload(x.f, { name: x.f.name, folder: '02_Working', subfolder: 'Review · ' + folderTitle, type: x.f.type || 'text/plain', onProgress: bar }).catch(() => null);
          } else {
            if (!(window.HubDrive && HubDrive.connected())) throw new Error('Connect Google Drive first.');
            file = await HubDrive.upload(x.f, { name: x.f.name, folder: '02_Working', subfolder: 'Review · ' + folderTitle, onProgress: bar });
          }
          say('Saving…');
          if (!it) {
            const { data, error } = await sb.from('program_review_items').insert({ title, kind: x.kind }).select().single();
            if (error) throw error;
            it = data; db.items.unshift(it);
          }
          const row = { item_id: it.id, label, change_note: change, file_name: x.f.name, mime: x.f.type || (x.kind === 'text' ? 'text/plain' : null), size: x.f.size, drive_id: file ? file.id : null, link: file ? file.link : null, content };
          const { data: ver, error } = await sb.from('program_review_versions').insert(row).select(VERSION_COLS).single();
          if (error) throw error;
          db.versions.push(ver);
          if (content != null) texts.set(ver.id, content);
          if (file && window.HubDrive) HubDrive.addFile(file, { source: 'Review room', review: it.id });
          lastItem = { it, ver };
          bar(1); say(`✓ Added as v${ver.number}`, 'ok');
        } catch (error) { failures++; say('✕ ' + (error.message || error), 'bad'); }
      }
      if (lastItem && !failures) {
        setTimeout(() => { $('#dialog').close(); location.hash = `#review/${lastItem.it.id}/v${lastItem.ver.number}`; render(); }, 700);
      } else { $('#rv-add-go').textContent = 'Done'; $('#rv-add-go').disabled = false; $('#rv-add-go').onclick = () => { $('#dialog').close(); render(); }; }
    };
  }

  // ---------- events ----------
  document.addEventListener('click', async e => {
    if (!active()) return;
    const t = e.target.closest('[data-rv-tab],[data-rv-filter],[data-rv-reply],[data-rv-reply-cancel],[data-rv-resolve],[data-rv-edit],[data-rv-edit-cancel],[data-rv-delete],[data-rv-seek],[data-rv-step],[data-rv-note-here],[data-rv-anchor-now],[data-rv-anchor-clear],[data-rv-pick-line],[data-rv-add-version],[data-rv-drop],[data-rv-rename],[data-rv-archive],[data-rv-remove-version],[data-rv-mode],[data-rv-hear],[data-rv-link],[data-rv-cmp-play],[data-rv-cmp-step],[data-rv-cmp-seek],[data-rv-swap],.rv-row');
    if (!t) return;
    const d = t.dataset, root = document.querySelector('#main [data-review-view]');
    if (t.classList.contains('rv-row') && !e.target.closest('a')) { location.hash = t.dataset.href; return; }
    if (d.rvTab) { ui.tab = d.rvTab; return render(); }
    if (d.rvFilter) { ui.noteFilter = d.rvFilter; return refresh(); }
    if (d.rvReply) { ui.replyTo = d.rvReply; refresh(); const f = document.querySelector(`[data-rv-reply-form="${d.rvReply}"] textarea`); if (f) f.focus(); return; }
    if (d.rvReplyCancel !== undefined) { ui.replyTo = null; return refresh(); }
    if (d.rvResolve) { const n = db.notes.find(x => x.id === d.rvResolve); return updateNote(n.id, { resolved: !n.resolved }); }
    if (d.rvEdit) { ui.editing = d.rvEdit; return refresh(); }
    if (d.rvEditCancel !== undefined) { ui.editing = null; return refresh(); }
    if (d.rvDelete) {
      return confirmAction('Delete this note and its replies?', async () => {
        $('#dialog').close();
        const { error } = await (await client()).from('program_review_notes').delete().eq('id', d.rvDelete);
        if (error) return toast('Couldn’t delete: ' + error.message);
        db.notes = db.notes.filter(n => n.id !== d.rvDelete && n.parent_id !== d.rvDelete); refresh();
      });
    }
    if (d.rvSeek !== undefined || d.rvLine !== undefined) {
      const ver = d.rvVersion && root && d.rvVersion !== root.dataset.version ? db.versions.find(v => v.id === d.rvVersion) : null;
      if (ver) { // note from another version: open that version at that spot
        if (d.rvSeek) sessionStorage.setItem('rv-seek', d.rvSeek);
        if (d.rvLine) sessionStorage.setItem('rv-line', d.rvLine);
        location.hash = `#review/${ver.item_id}/v${ver.number}`; return;
      }
      if (d.rvSeek !== '' && d.rvSeek !== undefined && player) { player.currentTime = Number(d.rvSeek); player.pause(); }
      if (d.rvLine) flashLine(Number(d.rvLine));
      if (d.rvNoteFocus) { const el = document.querySelector(`[data-note="${d.rvNoteFocus}"]`); if (el) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); } }
      return;
    }
    if (d.rvStep && player) { player.currentTime = Math.max(0, player.currentTime + Number(d.rvStep)); return; }
    if (d.rvNoteHere !== undefined || d.rvAnchorNow !== undefined) { startNote(); return; }
    if (d.rvAnchorClear !== undefined) { ui.anchor = null; return refresh(); }
    if (d.rvPickLine) { ui.anchor = Number(d.rvPickLine); refresh(); const b = document.querySelector('[data-rv-compose-body]'); if (b) b.focus(); return; }
    if (d.rvAddVersion !== undefined || d.rvDrop !== undefined) { if (e.target.matches('input')) return; const input = (root || document).querySelector('[data-rv-file]'); if (input) input.click(); return; }
    if (d.rvRename !== undefined) {
      const it = item(root.dataset.item);
      modal('Rename', `<form id="rv-rename"><label class="field">Title<input name="title" value="${esc(it.title)}" maxlength="200" required></label><button class="btn primary mt">Save</button></form>`);
      $('#rv-rename').onsubmit = async ev => { ev.preventDefault(); const title = ev.target.title.value.trim(); const { error } = await (await client()).from('program_review_items').update({ title }).eq('id', it.id); if (error) return toast(error.message); it.title = title; $('#dialog').close(); render(); };
      return;
    }
    if (d.rvArchive !== undefined) {
      const it = item(root.dataset.item);
      return confirmAction(`Archive “${it.title}”? It leaves the Review room list. Files stay in Google Drive.`, async () => {
        $('#dialog').close();
        const { error } = await (await client()).from('program_review_items').update({ archived: true }).eq('id', it.id);
        if (error) return toast(error.message);
        db.items = db.items.filter(x => x.id !== it.id); location.hash = '#review';
      });
    }
    if (d.rvRemoveVersion) {
      const v = db.versions.find(x => x.id === d.rvRemoveVersion);
      return confirmAction(`Remove ${vname(v)} and its notes from the Review room? The file stays in Google Drive.`, async () => {
        $('#dialog').close();
        const { error } = await (await client()).from('program_review_versions').delete().eq('id', v.id);
        if (error) return toast(error.message);
        db.versions = db.versions.filter(x => x.id !== v.id); db.notes = db.notes.filter(n => n.version_id !== v.id);
        location.hash = `#review/${v.item_id}`; render();
      });
    }
    if (d.rvMode) { ui.mode = d.rvMode; const st = root.querySelector('[data-rv-cmp-stage]'); st.classList.remove('side', 'flip'); st.classList.add(ui.mode); root.querySelectorAll('[data-rv-mode]').forEach(b => b.classList.toggle('active', b.dataset.rvMode === ui.mode)); return; }
    if (d.rvHear && cmp) { ui.hear = d.rvHear; cmp.applyHear(); root.querySelectorAll('[data-rv-hear]').forEach(b => b.classList.toggle('active', b.dataset.rvHear === ui.hear)); if (ui.mode === 'flip') root.querySelector('[data-rv-cmp-stage]').dataset.show = ui.hear; return; }
    if (d.rvLink !== undefined && cmp) {
      ui.linked = !ui.linked;
      if (ui.linked) { ui.offset = Math.round((cmp.B.currentTime - cmp.A.currentTime) * 100) / 100; cmp.B.currentTime = Math.max(0, cmp.A.currentTime + ui.offset); }
      else { cmp.A.pause(); cmp.B.pause(); cmp.B.controls = true; }
      if (ui.linked) cmp.B.controls = false;
      t.className = 'btn small ' + (ui.linked ? '' : 'gold');
      t.textContent = ui.linked ? '🔗 Linked' : '⛓ Unlinked: line up B, then relink';
      root.querySelector('[data-rv-offset]').textContent = ui.offset ? `B is ${ui.offset > 0 ? '+' : '−'}${Math.abs(ui.offset).toFixed(2)}s from A` : '';
      return;
    }
    if (d.rvCmpPlay !== undefined && cmp) { if (cmp.A.paused) cmp.A.play().catch(err => toast(err.message)); else cmp.A.pause(); return; }
    if (d.rvCmpStep && cmp) { cmp.A.currentTime = Math.max(0, cmp.A.currentTime + Number(d.rvCmpStep)); return; }
    if (d.rvCmpSeek !== undefined && cmp && cmp.A && d.rvCmpSeek !== '') { const s = Number(d.rvCmpSeek); cmp.A.pause(); cmp.A.currentTime = d.rvCmpSide === 'b' ? Math.max(0, s - ui.offset) : s; return; }
    if (d.rvSwap !== undefined) { const r = parse(); location.hash = `#review/${r.id}/compare/${r.b}/${r.a}`; return; }
  });
  function startNote() {
    const root = document.querySelector('#main [data-review-view]');
    if (!root || root.dataset.compare) return;
    if (player) { player.pause(); ui.anchor = player.currentTime; }
    refresh();
    const b = document.querySelector('[data-rv-compose-body]'); if (b) b.focus();
  }
  document.addEventListener('change', e => {
    if (!active()) return;
    if (e.target.matches('[data-rv-file]')) { const root = document.querySelector('#main [data-review-view]'); addFiles(e.target.files, root ? item(root.dataset.item) : null); e.target.value = ''; }
    if (e.target.matches('[data-rv-show-old]')) { ui.showOld = e.target.checked; refresh(); }
    if (e.target.matches('[data-rv-speed]') && player) player.playbackRate = Number(e.target.value);
    if (e.target.matches('[data-rv-cmp]')) { const r = parse(), sel = [...document.querySelectorAll('[data-rv-cmp]')].map(s => s.value); location.hash = `#review/${r.id}/compare/${sel[0]}/${sel[1]}`; }
    if (e.target.matches('[data-rv-only-changes]')) { ui.onlyChanges = e.target.checked; mount(); }
  });
  document.addEventListener('focusin', e => {
    if (!e.target.matches('[data-rv-compose-body]') || !player) return;
    if (ui.anchor == null && !e.target.value) { player.pause(); ui.anchor = player.currentTime; const top = e.target.closest('form').querySelector('.rv-compose-top'); if (top) { const keep = e.target.value; refresh(); const b = document.querySelector('[data-rv-compose-body]'); if (b) { b.value = keep; b.focus(); } } }
  });
  document.addEventListener('submit', async e => {
    if (location.hash.split('/')[0] !== '#review') return;
    const f = e.target;
    if (f.matches('[data-rv-compose]')) { e.preventDefault(); return postNote(f); }
    if (f.matches('[data-rv-reply-form]')) {
      e.preventDefault();
      const parent = db.notes.find(n => n.id === f.dataset.rvReplyForm), body = f.body.value.trim();
      if (!body) return;
      const { data, error } = await (await client()).from('program_review_notes').insert({ version_id: parent.version_id, item_id: parent.item_id, parent_id: parent.id, body, author: me() }).select().single();
      if (error) return toast('Couldn’t reply: ' + error.message);
      db.notes.push(data); ui.replyTo = null; refresh();
    }
    if (f.matches('[data-rv-edit-form]')) { e.preventDefault(); ui.editing = null; updateNote(f.dataset.rvEditForm, { body: f.body.value.trim() }); }
  });
  document.addEventListener('keydown', e => {
    if (location.hash.split('/')[0] !== '#review' || document.querySelector('dialog[open]')) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && e.target.matches('textarea')) { e.preventDefault(); e.target.form.requestSubmit(); return; }
    if (e.key === 'Escape' && e.target.matches('[data-rv-compose-body]')) { e.target.blur(); if (player) player.play().catch(() => {}); return; }
    if (typing() || e.metaKey || e.ctrlKey || e.altKey) return;
    if (cmp && cmp.A) {
      if (e.key === ' ') { e.preventDefault(); if (cmp.A.paused) cmp.A.play().catch(() => {}); else cmp.A.pause(); }
      else if (e.key.toLowerCase() === 'f') { e.preventDefault(); document.querySelector(`[data-rv-hear="${ui.hear === 'a' ? 'b' : 'a'}"]`).click(); if (ui.mode !== 'flip') document.querySelector('[data-rv-mode="flip"]').click(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); cmp.A.currentTime = Math.max(0, cmp.A.currentTime + (e.key === 'ArrowLeft' ? -5 : 5)); }
      return;
    }
    if (!player) return;
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); startNote(); }
    else if (e.key === ' ' && e.target === document.body) { e.preventDefault(); if (player.paused) player.play().catch(() => {}); else player.pause(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); player.currentTime = Math.max(0, player.currentTime + (e.key === 'ArrowLeft' ? -5 : 5)); }
    else if (e.key === ',' || e.key === '.') { e.preventDefault(); player.pause(); player.currentTime = Math.max(0, player.currentTime + (e.key === ',' ? -1 / 24 : 1 / 24)); }
  });
  // Drag and drop onto the drop areas (or anywhere on a Review page for staff).
  let dragDepth = 0;
  const dropTarget = () => document.querySelector('#main [data-rv-drop]');
  document.addEventListener('dragenter', e => { if (!dropTarget() || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; dragDepth++; dropTarget().classList.add('over'); });
  document.addEventListener('dragleave', () => { if (!dropTarget()) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropTarget().classList.remove('over'); });
  document.addEventListener('dragover', e => { if (dropTarget() && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', e => {
    const dz = dropTarget();
    if (!dz || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); dragDepth = 0; dz.classList.remove('over');
    const root = document.querySelector('#main [data-review-view]');
    addFiles(e.dataTransfer.files, root && !root.dataset.compare ? item(root.dataset.item) : null);
  });

  // ---------- Overview: the multimedia library up front ----------
  function libraryPanel() {
    if (!member()) return '';
    if (!db.loaded) { load().then(() => { if (location.hash === '#overview') render(); }); }
    const recent = db.items.map(i => {
      const vs = versionsOf(i.id), last = vs[vs.length - 1];
      const updated = [i.created_at, ...vs.map(v => v.created_at), ...notesOf(i.id).map(n => n.created_at)].sort().pop();
      return { i, last, vs, updated, open: notesOf(i.id).filter(n => !n.resolved && !n.parent_id).length };
    }).sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 6);
    const icon = k => k === 'video' ? '▶' : k === 'audio' ? '♫' : '≡';
    const cards = recent.map(r => `<a class="rv-card" href="#review/${esc(r.i.id)}"><span class="rv-card-icon ${r.i.kind}">${icon(r.i.kind)}</span><span class="rv-card-body"><strong>${esc(r.i.title)}</strong><small>${r.last ? esc(vname(r.last)) : 'no file yet'} · ${r.vs.length} version${r.vs.length === 1 ? '' : 's'}</small><small class="muted">${esc(when(r.updated))}</small></span>${r.open ? `<span class="rv-count" title="Open notes">${r.open}</span>` : ''}</a>`).join('');
    return `<section class="rv-library"><div class="rv-library-head"><div><div class="eyebrow">MULTIMEDIA LIBRARY</div><h2>Cuts, edits and scripts</h2></div><div class="row"><a class="btn" href="#media">Media library</a><a class="btn primary" href="#review">Open Review room →</a></div></div>
      ${dropzone('Drop videos, audio or text files here', 'Upload a rough cut, edit, script or transcript. Add it as a new item or the next version of one already here.')}
      ${!db.loaded ? '<div class="empty">Loading…</div>' : cards ? `<div class="rv-cards">${cards}</div>` : empty('Nothing here yet. Drop your first cut above.')}</section>`;
  }
  const originalOverview = window.overview;
  window.overview = function () {
    let html = originalOverview();
    html = html.replace(/<section class="panel"><div class="panel-head"><h2>First things first<\/h2>[\s\S]*?<\/section>/, '');
    const at = html.indexOf('<section class="dashboard-focus">');
    return at < 0 ? html + libraryPanel() : html.slice(0, at) + libraryPanel() + html.slice(at);
  };

  // ---------- hook into the hub's render ----------
  let lastHash = '';
  const originalRender = window.render;
  window.render = function () {
    const h = location.hash, mounted = document.querySelector('#main [data-review-view]');
    // Background syncs re-render the page; keep a playing cut where it is.
    if (h.split('/')[0] === '#review' && mounted && mounted.dataset.reviewView === h && demoRole && member()) { refresh(); return; }
    if (h !== lastHash) { ui.anchor = null; ui.replyTo = null; ui.editing = null; if (!/compare/.test(h)) { ui.offset = 0; ui.linked = true; } }
    lastHash = h;
    originalRender();
    if (h.split('/')[0] === '#review') mount(); else { cancelAnimationFrame(tick); player = null; cmp = null; }
  };
  // Overview count of open notes on the review room link.
  const nav = () => {
    const a = document.querySelector('#nav a[href="#review"]');
    if (!a || !db.loaded) return;
    const open = db.notes.filter(n => !n.parent_id && !n.resolved).length;
    let c = a.querySelector('.nav-count'); if (!c && open) { c = document.createElement('span'); c.className = 'nav-count'; a.append(c); }
    if (c) { c.textContent = open; c.hidden = !open; }
  };
  const r2 = window.render;
  window.render = function () { r2(); nav(); };
  document.addEventListener('hub:settings', () => { if (member() && !db.loaded) load().then(nav); });
})();
