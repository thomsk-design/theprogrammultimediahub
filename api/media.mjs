// Streams a review version (video/audio) from the Next to Kin Google Drive to a signed-in hub member.
//
//   POST /api/media            Authorization: Bearer <hub sign-in token>  → sets a short-lived, HttpOnly cookie
//   GET  /api/media?v=<id>     (cookie)                                   → the file, in byte ranges
//
// The browser never receives a Google token. Supabase row-level security decides whether the caller
// may see the version; the Drive bridge (Apps Script) hands this function a short-lived Drive token
// only when it presents BRIDGE_VIEW_SECRET, and that token can only read files the bridge created.

const SUPABASE_URL = 'https://etukrfqlrhiepsedrvzr.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QV-frUgCkQ02FEd_8_C8wg_Bnfuvid3';
const COOKIE = 'hub_media';
const CHUNK = 8 * 1024 * 1024; // largest range served per request; players ask again for the next piece
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const versionCache = new Map(); // token+version → { row, until }
let drive = { token: '', until: 0 };
let bridgeUrl = { url: '', until: 0 };

const text = (status, message, headers = {}) => new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const cookieOf = request => {
  const raw = request.headers.get('cookie') || '';
  const hit = raw.split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  return hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : '';
};
const rest = (path, token) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });

export async function POST(request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return text(401, 'Sign in to the hub first.');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/program_role`, { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  const role = res.ok ? await res.json().catch(() => null) : null;
  if (!role) return text(403, 'This account isn’t part of The Program hub.');
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'Set-Cookie': `${COOKIE}=${encodeURIComponent(token)}; Path=/api/media; Max-Age=3300; HttpOnly; Secure; SameSite=Strict` } });
}

async function versionFor(token, id) {
  const key = token.slice(-24) + id, hit = versionCache.get(key);
  if (hit && hit.until > Date.now()) return hit.row;
  const res = await rest(`program_review_versions?id=eq.${id}&select=drive_id,mime,size,file_name`, token);
  if (res.status === 401) return { expired: true };
  const rows = res.ok ? await res.json() : [];
  const row = rows[0] || null;
  versionCache.set(key, { row, until: Date.now() + 5 * 60 * 1000 });
  if (versionCache.size > 500) versionCache.delete(versionCache.keys().next().value);
  return row;
}

async function driveToken(token) {
  if (drive.token && drive.until > Date.now()) return drive.token;
  const secret = process.env.BRIDGE_VIEW_SECRET;
  if (!secret) throw new Error('Playback isn’t switched on yet (BRIDGE_VIEW_SECRET is missing).');
  if (!bridgeUrl.url || bridgeUrl.until < Date.now()) {
    const res = await rest('program_settings?key=eq.drive_bridge&select=value', token);
    const rows = res.ok ? await res.json() : [];
    bridgeUrl = { url: (rows[0] && rows[0].value && rows[0].value.url) || '', until: Date.now() + 10 * 60 * 1000 };
  }
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(bridgeUrl.url)) throw new Error('The Google Drive bridge isn’t connected.');
  const res = await fetch(bridgeUrl.url, { method: 'POST', body: JSON.stringify({ action: 'viewToken', secret }), redirect: 'follow' });
  const data = await res.json().catch(() => ({ error: 'The Drive bridge didn’t answer.' }));
  if (data.error || !data.token) throw new Error(/Unknown action/.test(data.error || '') ? 'Update the Drive bridge code (Connections → Google Drive → Update bridge code).' : (data.error || 'No Drive token.'));
  drive = { token: data.token, until: Date.now() + Math.max(60, (Number(data.expiresIn) || 1800) - 120) * 1000 };
  return drive.token;
}

export async function GET(request) {
  const id = new URL(request.url).searchParams.get('v') || '';
  if (!UUID.test(id)) return text(400, 'Unknown file.');
  const token = cookieOf(request);
  if (!token) return text(401, 'Sign in to the hub first.');
  const row = await versionFor(token, id);
  if (row && row.expired) return text(401, 'Your sign-in expired. Reload the page.');
  if (!row || !row.drive_id) return text(404, 'That version isn’t available.');

  // Clamp the requested range so each answer stays small.
  const size = Number(row.size) || 0;
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  let start = 0, end = CHUNK - 1;
  if (m && m[1] !== '') { start = Number(m[1]); end = m[2] !== '' ? Number(m[2]) : start + CHUNK - 1; }
  else if (m && m[2] !== '' && size) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  end = Math.min(end, start + CHUNK - 1);
  if (size) {
    if (start >= size) return text(416, 'Out of range.', { 'Content-Range': `bytes */${size}` });
    end = Math.min(end, size - 1);
  }

  let upstream;
  for (let attempt = 0; attempt < 2; attempt++) {
    let gtoken;
    try { gtoken = await driveToken(token); } catch (error) { return text(503, error.message); }
    upstream = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(row.drive_id)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${gtoken}`, Range: `bytes=${start}-${end}` } });
    if (upstream.status !== 401) break;
    drive = { token: '', until: 0 }; // token expired early: get a fresh one once
  }
  if (upstream.status === 404) return text(404, 'The file is no longer in Google Drive.');
  if (!upstream.ok) return text(502, `Google Drive said ${upstream.status}.`);

  const headers = {
    'Content-Type': row.mime || upstream.headers.get('content-type') || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  };
  const range = upstream.headers.get('content-range');
  if (range) headers['Content-Range'] = range;
  const length = upstream.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
}
