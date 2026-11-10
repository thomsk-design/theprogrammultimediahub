/**
 * The Program · Multimedia Hub → Google Drive bridge
 *
 * Runs as the Next to Kin Google account that deploys it. Hub members (checked against
 * Supabase on every request) receive a short-lived upload token. The token can only touch
 * files and folders this script creates (drive.file scope) — nothing else in the Drive.
 * Files upload straight from the browser to Google Drive; nothing passes through here.
 */
const SUPABASE_URL = 'https://etukrfqlrhiepsedrvzr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QV-frUgCkQ02FEd_8_C8wg_Bnfuvid3';
const ROOT_NAME = 'The Program · Multimedia Hub';
const FOLDERS = ['01_Incoming', '02_Working', '03_Approved', '04_Delivery'];
const DRIVE = 'https://www.googleapis.com/drive/v3';

function doGet() {
  return out_({ ok: true, service: 'The Program hub · Google Drive bridge' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!hubRole_(req.token)) return out_({ error: 'Sign in to the hub first.' });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const root = rootId_();
      if (req.action === 'status') return out_({ ok: true, root: info_(root) });
      if (req.action === 'start') {
        const area = FOLDERS.indexOf(req.folder) >= 0 ? req.folder : '01_Incoming';
        let parent = childFolder_(root, area);
        const sub = req.subfolder ? String(req.subfolder).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) : '';
        if (sub) parent = childFolder_(parent, sub);
        return out_({ ok: true, token: ScriptApp.getOAuthToken(), folderId: parent, folderPath: [ROOT_NAME, area, sub].filter(String).join(' / ') });
      }
      return out_({ error: 'Unknown action' });
    } finally {
      lock.releaseLock();
    }
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

function api_(method, path, body) {
  const options = { method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(DRIVE + path, options);
  if (res.getResponseCode() >= 300) throw new Error('Google Drive: ' + res.getContentText());
  return JSON.parse(res.getContentText());
}
function exists_(id) {
  try { return !api_('get', '/files/' + id + '?fields=id,trashed').trashed; } catch (e) { return false; }
}
function find_(name, parent) {
  const q = "mimeType='application/vnd.google-apps.folder' and trashed=false and name='" + name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and '" + parent + "' in parents";
  const r = api_('get', '/files?fields=files(id)&q=' + encodeURIComponent(q));
  return r.files.length ? r.files[0].id : null;
}
function make_(name, parent) {
  return api_('post', '/files?fields=id', { name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }).id;
}
function childFolder_(parent, name) {
  const props = PropertiesService.getScriptProperties(), key = 'folder:' + parent + ':' + name;
  const cached = props.getProperty(key);
  if (cached && exists_(cached)) return cached;
  const id = find_(name, parent) || make_(name, parent);
  props.setProperty(key, id);
  return id;
}
function rootId_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('root');
  if (id && exists_(id)) return id;
  id = find_(ROOT_NAME, 'root') || make_(ROOT_NAME, 'root');
  props.setProperty('root', id);
  FOLDERS.forEach(function (f) { childFolder_(id, f); });
  return id;
}
function info_(id) {
  return api_('get', '/files/' + id + '?fields=id,name,webViewLink');
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
