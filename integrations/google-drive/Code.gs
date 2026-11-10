/**
 * The Program · Multimedia Hub → Google Drive bridge
 *
 * Runs as the Next to Kin Google account that deploys it (support@nexttokin.ca) and files
 * uploads into "The Program · Multimedia Hub" in that Drive. Every request is checked
 * against the hub's sign-in (Supabase). Contributors never receive a Google token: the
 * bridge opens a one-file upload session and either the browser sends the file straight
 * to it, or the bridge relays the pieces. Each session can only write that single file.
 */
const SUPABASE_URL = 'https://etukrfqlrhiepsedrvzr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QV-frUgCkQ02FEd_8_C8wg_Bnfuvid3';
const ROOT_ID = '10rzUz6wv_GTO0t3V44uuSnDSRpwE-8qB'; // The Program · Multimedia Hub
const FOLDERS = ['01_Incoming', '02_Working', '03_Approved', '04_Delivery'];
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,webViewLink';

function doGet() {
  return out_({ ok: true, service: 'The Program hub · Google Drive bridge' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!hubRole_(req.token)) return out_({ error: 'Sign in to the hub first.' });

    if (req.action === 'status') {
      const root = DriveApp.getFolderById(ROOT_ID);
      return out_({ ok: true, root: { id: root.getId(), name: root.getName(), webViewLink: root.getUrl() } });
    }

    if (req.action === 'start') {
      const area = FOLDERS.indexOf(req.folder) >= 0 ? req.folder : '01_Incoming';
      const sub = req.subfolder ? String(req.subfolder).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) : '';
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      let parent;
      try {
        parent = child_(DriveApp.getFolderById(ROOT_ID), area);
        if (sub) parent = child_(parent, sub);
      } finally { lock.releaseLock(); }
      const name = String(req.name || 'upload').replace(/[\\/]/g, '-').slice(0, 200);
      const size = Math.max(0, Number(req.size) || 0);
      const headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': req.type || 'application/octet-stream', 'X-Upload-Content-Length': String(size) };
      if (/^https:\/\/[\w.-]+(:\d+)?$/.test(req.origin || '')) headers.Origin = req.origin; // lets the browser send pieces directly
      const res = UrlFetchApp.fetch(UPLOAD, { method: 'post', contentType: 'application/json; charset=UTF-8', payload: JSON.stringify({ name: name, parents: [parent.getId()] }), headers: headers, muteHttpExceptions: true });
      const session = header_(res, 'Location');
      if (res.getResponseCode() >= 300 || !session) throw new Error('Google Drive refused the upload: ' + res.getContentText());
      return out_({ ok: true, session: session, folderPath: ['The Program · Multimedia Hub', area, sub].filter(String).join(' / ') });
    }

    if (req.action === 'chunk') {
      // Relay one piece (base64) to an upload session this bridge opened.
      if (String(req.session || '').indexOf('https://www.googleapis.com/upload/drive/v3/files?') !== 0) throw new Error('Not a Drive upload session.');
      const total = Number(req.total);
      const bytes = req.data ? Utilities.base64Decode(req.data) : [];
      const range = bytes.length ? 'bytes ' + req.start + '-' + (Number(req.start) + bytes.length - 1) + '/' + total : 'bytes */' + total;
      const options = { method: 'put', headers: { 'Content-Range': range }, muteHttpExceptions: true };
      if (bytes.length) { options.payload = bytes; options.contentType = 'application/octet-stream'; }
      const res = UrlFetchApp.fetch(req.session, options);
      const code = res.getResponseCode();
      if (code === 308) return out_({ ok: true, status: 308, range: header_(res, 'Range') || '' });
      if (code === 200 || code === 201) return out_({ ok: true, status: code, file: JSON.parse(res.getContentText()) });
      throw new Error('Google Drive stopped the upload (' + code + '): ' + res.getContentText().slice(0, 200));
    }

    return out_({ error: 'Unknown action' });
  } catch (err) {
    return out_({ error: String((err && err.message) || err) });
  }
}

// Asks Supabase whether the caller is a hub member (returns their role, or null).
function hubRole_(token) {
  if (!token) return null;
  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/program_role', {
    method: 'post', contentType: 'application/json', payload: '{}',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return null;
  return JSON.parse(res.getContentText());
}
function child_(folder, name) {
  const found = folder.getFoldersByName(name);
  return found.hasNext() ? found.next() : folder.createFolder(name);
}
function header_(res, name) {
  const headers = res.getAllHeaders();
  for (const key in headers) if (key.toLowerCase() === name.toLowerCase()) return [].concat(headers[key])[0];
  return null;
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Run once from the editor (select "authorize" → Run) to approve access before deploying.
function authorize() {
  Logger.log(DriveApp.getFolderById(ROOT_ID).getName());
  UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/health', { muteHttpExceptions: true });
}
