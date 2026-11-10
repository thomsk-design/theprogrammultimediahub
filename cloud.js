// Team workspace: sign-in and shared data on Supabase (ketchup-tools project, program_* tables).
// app.js keeps working as before; this file swaps the demo login for real accounts and syncs
// the catalogue, sessions, scripts, SOPs and tasks so everyone sees the same workspace.
(() => {
  const SUPABASE_URL = 'https://etukrfqlrhiepsedrvzr.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_QV-frUgCkQ02FEd_8_C8wg_Bnfuvid3'; // publishable key: safe in the browser, access is enforced by row-level security
  const KINDS = ['assets', 'sessions', 'scripts', 'sops', 'tasks', 'files'];
  const list = kind => (Array.isArray(state[kind]) ? state[kind] : (state[kind] = []));
  const SEP = '\u0000';
  const keyOf = (kind, id) => kind + SEP + id;
  const originalSave = window.save, originalLanding = window.showLanding;
  let door = null; // which login card was used: 'talent' or 'production'
  let sb = null, loading = null, member = null, userId = null, synced = new Map(), timer = 0, syncing = false, lastBadge = '';

  function client() {
    if (sb) return Promise.resolve(sb);
    if (!loading) loading = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm').then(mod => {
      sb = mod.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      sb.auth.onAuthStateChange(event => {
        if (event === 'PASSWORD_RECOVERY') setTimeout(newPasswordDialog, 0);
        if (event === 'SIGNED_OUT' && member) { member = null; signedOutView(); }
      });
      return sb;
    });
    return loading;
  }

  // ---- Sign-in form (replaces the demo password) ----
  function friendly(error) {
    const m = String(error && error.message || error);
    if (/Database error saving new user|not been invited/i.test(m)) return 'This email hasn’t been invited to The Program hub yet. Ask a producer to invite you.';
    if (/Invalid login credentials/i.test(m)) return 'That email and password don’t match. First time here? Create your password below.';
    if (/already registered|already exists/i.test(m)) return 'You already have an account. Sign in instead.';
    if (/Email not confirmed/i.test(m)) return 'Confirm your email first (check your inbox), then sign in.';
    if (/Password should be/i.test(m)) return 'Choose a password with at least 8 characters.';
    if (/rate limit/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    return 'Couldn’t sign in: ' + m;
  }
  window.showLanding = function (mode) {
    originalLanding(mode);
    const form = document.getElementById('demo-login');
    if (!form) return;
    const chosenDoor = mode === 'login-talent' ? 'talent' : 'production';
    const card = form.closest('.login-card');
    if (card) { const intro = card.querySelector(':scope > p'); if (intro) intro.textContent += ' Sign in with the email you were invited with.'; }
    form.innerHTML = `<label for="hub-email">Email</label><input id="hub-email" type="email" autocomplete="email" required placeholder="you@example.com">
      <label for="hub-password" style="margin-top:14px">Password</label><input id="hub-password" type="password" autocomplete="current-password" required minlength="8" placeholder="At least 8 characters">
      <p id="login-error" role="alert"></p><button class="btn gold w-full" type="submit" data-hub-submit>Sign in →</button>
      <div class="hub-auth-links"><button class="text-link" type="button" data-hub-mode>First time? Create your password</button><button class="text-link" type="button" data-hub-reset>Forgot password?</button></div>`;
    let creating = false;
    const email = form.querySelector('#hub-email'), password = form.querySelector('#hub-password'), submit = form.querySelector('[data-hub-submit]');
    const say = text => { form.querySelector('#login-error').textContent = text; };
    form.querySelector('[data-hub-mode]').onclick = event => {
      creating = !creating;
      submit.textContent = creating ? 'Create account →' : 'Sign in →';
      event.target.textContent = creating ? 'Already have a password? Sign in' : 'First time? Create your password';
      password.autocomplete = creating ? 'new-password' : 'current-password';
      say('');
    };
    form.querySelector('[data-hub-reset]').onclick = async () => {
      if (!email.value) { say('Enter your email first, then choose Forgot password.'); email.focus(); return; }
      try {
        const { error } = await (await client()).auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        say('If that email is on the team, a reset link is on its way.');
      } catch (error) { say(friendly(error)); }
    };
    form.onsubmit = async event => {
      event.preventDefault();
      door = chosenDoor; // only an actual sign-in decides the view
      say(''); submit.disabled = true;
      try {
        const auth = (await client()).auth, creds = { email: email.value.trim().toLowerCase(), password: password.value };
        if (creating) {
          const { data, error } = await auth.signUp({ ...creds, options: { emailRedirectTo: location.origin + location.pathname } });
          if (error) throw error;
          if (!data.session) { say('Account created. Check your email to confirm it, then sign in.'); return; }
        } else {
          const { error } = await auth.signInWithPassword(creds);
          if (error) throw error;
        }
        if (!(await start())) say('This account isn’t part of The Program hub.');
      } catch (error) { say(friendly(error)); }
      finally { submit.disabled = false; }
    };
  };
  function newPasswordDialog() {
    modal('Choose a new password', `<form id="hub-new-password"><label class="field">New password<input type="password" name="password" minlength="8" required autocomplete="new-password"></label><button class="btn primary mt" type="submit">Save password</button><p class="small muted mt" id="hub-np-msg"></p></form>`);
    $('#hub-new-password').onsubmit = async event => {
      event.preventDefault();
      const { error } = await sb.auth.updateUser({ password: new FormData(event.target).get('password') });
      if (error) { $('#hub-np-msg').textContent = friendly(error); return; }
      $('#dialog').close(); toast('Password updated'); start();
    };
  }

  // ---- Session ----
  async function start() {
    const auth = (await client()).auth;
    const { data: { session } } = await auth.getSession();
    if (!session) { signedOutView(); return false; }
    userId = session.user.id;
    const { data: m, error } = await sb.from('program_members').select('role, display_name, email').eq('user_id', userId).maybeSingle();
    if (error || !m) { await auth.signOut(); member = null; signedOutView(); return false; }
    member = m;
    for (const i of integrations) if (['Shared database', 'Team accounts'].includes(i.name)) i.connected = true;
    await pull(true);
    // Producers and admins can use either view; talent only ever get the talent view.
    let view = null;
    try { view = sessionStorage.getItem('program-demo-role'); } catch {}
    if (door) view = door;
    demoRole = m.role === 'talent' ? 'talent' : (view === 'talent' ? 'talent' : 'production');
    door = null;
    try { sessionStorage.setItem('program-demo-role', demoRole); } catch {}
    document.body.classList.remove('cloud-wait');
    const here = location.hash.slice(1);
    if (!here || ['home', 'login-talent', 'login-production'].includes(here) || (demoRole === 'talent' && here !== 'talent')) location.hash = demoRole === 'talent' ? 'talent' : 'overview';
    render();
    return true;
  }
  function signedOutView() {
    demoRole = null;
    try { sessionStorage.removeItem('program-demo-role'); } catch {}
    document.body.classList.remove('cloud-wait');
    render();
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action="logout"]');
    if (button && sb) { member = null; sb.auth.signOut(); }
  }, true);

  // ---- Sync ----
  function order(kind, rows) {
    const index = new Map(list(kind).map((d, i) => [d.id, i]));
    return rows.sort((a, b) => (index.has(a.id) ? index.get(a.id) : 1e9) - (index.has(b.id) ? index.get(b.id) : 1e9) || String(a.id).localeCompare(String(b.id)));
  }
  function dirty() {
    for (const kind of KINDS) for (const d of list(kind)) if (synced.get(keyOf(kind, d.id)) !== JSON.stringify(d)) return true;
    const live = new Set(KINDS.flatMap(kind => list(kind).map(d => keyOf(kind, d.id))));
    return [...synced.keys()].some(key => !live.has(key));
  }
  async function pull(first) {
    const { data, error } = await sb.from('program_records').select('kind,id,data');
    if (error) throw error;
    if (first && !data.length && member.role === 'admin') { // first sign-in: this browser's workspace becomes the team workspace
      synced = new Map();
      await push(true);
      loadSettings();
      return false;
    }
    const before = JSON.stringify(KINDS.map(kind => list(kind)));
    loadSettings();
    const next = {};
    for (const kind of KINDS) next[kind] = [];
    for (const row of data) if (next[row.kind]) next[row.kind].push(row.data);
    for (const kind of KINDS) state[kind] = order(kind, next[kind]);
    synced = new Map(data.map(row => [keyOf(row.kind, row.id), JSON.stringify(row.data)]));
    originalSave(); // keep a local copy for quick loading
    return before !== JSON.stringify(KINDS.map(kind => list(kind)));
  }
  async function push(now) {
    clearTimeout(timer);
    if (!member || member.role === 'talent') return;
    if (syncing && !now) { timer = setTimeout(push, 400); return; }
    syncing = true;
    badge('Saving…');
    try {
      const rows = [], live = new Set(), stamp = new Date().toISOString();
      for (const kind of KINDS) for (const d of list(kind)) {
        const key = keyOf(kind, d.id), json = JSON.stringify(d);
        live.add(key);
        if (synced.get(key) !== json) rows.push({ kind, id: d.id, data: d, updated_at: stamp, updated_by: userId });
      }
      if (rows.length) {
        const { error } = await sb.from('program_records').upsert(rows);
        if (error) throw error;
        for (const row of rows) synced.set(keyOf(row.kind, row.id), JSON.stringify(row.data));
      }
      for (const key of [...synced.keys()].filter(key => !live.has(key))) {
        const [kind, id] = key.split(SEP);
        const { error } = await sb.from('program_records').delete().eq('kind', kind).eq('id', id);
        if (error) throw error;
        synced.delete(key);
      }
      badge('Synced with the team');
    } catch (error) {
      console.error(error);
      badge('Not synced yet · retrying');
      timer = setTimeout(push, 5000);
    } finally { syncing = false; }
  }
  function talentAcks() {
    for (const s of state.scripts) {
      const key = keyOf('scripts', s.id), was = synced.get(key);
      if (!s.ack || !was || JSON.parse(was).ack) continue;
      sb.rpc('program_ack_script', { script_id: s.id }).then(({ error }) => { if (!error) synced.set(key, JSON.stringify({ ...JSON.parse(was), ack: true })); });
    }
  }
  function talentFiles() {
    for (const f of list('files')) {
      const key = keyOf('files', f.id);
      if (synced.has(key)) continue;
      synced.set(key, JSON.stringify(f));
      sb.from('program_records').insert({ kind: 'files', id: f.id, data: f, updated_by: userId }).then(({ error }) => { if (error) { synced.delete(key); console.error(error); } });
    }
  }
  window.save = function () {
    originalSave();
    if (!member) return;
    if (member.role === 'talent') { talentAcks(); talentFiles(); return; }
    clearTimeout(timer);
    timer = setTimeout(push, 700);
    badge('Saving…');
  };
  async function refresh() {
    if (!member || syncing || timer || document.hidden || document.querySelector('dialog[open]')) return;
    if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    if (dirty()) return;
    try { if (await pull(false)) render(); } catch {}
  }
  window.addEventListener('focus', refresh);
  setInterval(refresh, 45000);

  // ---- Shared settings + API for other parts of the hub ----
  const settings = {};
  async function loadSettings() {
    const { data } = await sb.from('program_settings').select('key,value');
    for (const k of Object.keys(settings)) delete settings[k];
    for (const row of data || []) settings[row.key] = row.value;
    document.dispatchEvent(new CustomEvent('hub:settings'));
  }
  window.HubCloud = {
    member: () => member,
    settings,
    async token() { if (!sb) return null; const { data: { session } } = await sb.auth.getSession(); return session ? session.access_token : null; },
    async setSetting(key, value) {
      const { error } = await sb.from('program_settings').upsert({ key, value, updated_at: new Date().toISOString(), updated_by: userId });
      if (error) throw error;
      settings[key] = value;
      document.dispatchEvent(new CustomEvent('hub:settings'));
    },
  };

  // ---- Workspace chrome ----
  function badge(text) { lastBadge = text; decorate(); }
  function decorate() {
    if (!member) return;
    const banner = document.querySelector('.preview-banner span');
    if (banner) banner.innerHTML = `<b>Team workspace</b> · ${esc(member.display_name || member.email)} · ${esc(member.role)} · ${esc(lastBadge || 'Synced with the team')}`;
    const foot = document.querySelector('.sidebar-foot small');
    if (foot) foot.textContent = member.email;
    const avatar = document.querySelector('.sidebar-foot .avatar');
    if (avatar) avatar.textContent = (member.display_name || member.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
    const dot = document.querySelector('.preview-dot');
    if (dot) dot.textContent = 'Live';
    // View switch for producers and admins.
    let sw = document.querySelector('.view-switch');
    if (member.role === 'talent') { if (sw) sw.remove(); return; }
    if (!sw) {
      sw = document.createElement('button');
      sw.className = 'view-switch';
      sw.onclick = () => switchView(demoRole === 'talent' ? 'production' : 'talent');
      document.querySelector('.sidebar-foot').before(sw);
    }
    sw.innerHTML = demoRole === 'talent' ? '<span>⇄</span> Back to production' : '<span>⇄</span> Open talent view';
  }
  function switchView(view) {
    if (!member || member.role === 'talent') return;
    demoRole = view;
    try { sessionStorage.setItem('program-demo-role', view); } catch {}
    const target = view === 'talent' ? 'talent' : 'overview';
    if (location.hash.slice(1) === target) render(); else location.hash = target;
  }
  const originalRender = window.render;
  window.render = function () { originalRender(); decorate(); };

  // ---- Boot ----
  let remembered = null;
  try { remembered = sessionStorage.getItem('program-demo-role'); } catch {}
  if (remembered) document.body.classList.add('cloud-wait'); // keep the workspace hidden until the account is confirmed
  else demoRole = null;
  client().then(start).catch(error => {
    console.error(error);
    signedOutView();
    toast('Can’t reach the team workspace. Check your connection and reload.');
  });
})();
