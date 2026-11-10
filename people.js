// Talent roster: the people recordings, scripts and sessions can be assigned to.
(() => {
  const roster = () => (Array.isArray(state.people) ? state.people : (state.people = []));
  const active = () => roster().filter(p => p.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const isStaff = () => { const m = window.HubCloud && HubCloud.member(); return !m || m.role !== 'talent'; };
  const split = value => String(value || '').split(/\s*(?:,|\+|&|\band\b)\s*/i).map(v => v.trim()).filter(Boolean);
  const mentions = (text, person) => split(text).some(n => n.toLowerCase() === person.name.toLowerCase() || n.toLowerCase() === person.name.split(' ')[0].toLowerCase());

  // Checkbox chips for the roster, plus a free-text box for anyone else. Writes a
  // comma-separated list into a hidden field so the existing forms save it as before.
  window.peoplePick = function (label, name, value) {
    const people = active();
    const chosen = split(value);
    const known = new Set(people.map(p => p.name.toLowerCase()));
    const other = chosen.filter(n => !known.has(n.toLowerCase())).join(', ');
    return `<div class="field full people-pick"><span>${esc(label)}</span>
      <div class="pp-chips">${people.map(p => `<label class="pp-chip"><input type="checkbox" data-pick value="${esc(p.name)}" ${chosen.some(n => n.toLowerCase() === p.name.toLowerCase()) ? 'checked' : ''}><span>${esc(p.name)}</span></label>`).join('') || '<span class="small muted">No one on the roster yet. Add people under Talent roster.</span>'}</div>
      <input data-pick-other placeholder="Someone else (optional)" value="${esc(other)}" aria-label="${esc(label)}: someone else">
      <input type="hidden" name="${esc(name)}" value="${esc(value || '')}"></div>`;
  };
  const syncPick = box => {
    const names = [...box.querySelectorAll('[data-pick]:checked')].map(i => i.value);
    const other = box.querySelector('[data-pick-other]').value.trim();
    if (other) names.push(other);
    box.querySelector('input[type=hidden]').value = names.join(', ');
  };
  document.addEventListener('change', e => { const box = e.target.closest('.people-pick'); if (box) syncPick(box); });
  document.addEventListener('input', e => { const box = e.target.closest('.people-pick'); if (box) syncPick(box); });

  // Talent see the approved scripts assigned to them (plus unassigned ones).
  window.mineOnly = function (script) {
    const m = window.HubCloud && HubCloud.member();
    if (!m || m.role !== 'talent' || !script.talent) return true;
    const me = { name: m.display_name || m.email.split('@')[0] };
    return mentions(script.talent, me);
  };

  // Names for the teleprompter's "Who's reading?" choice.
  window.rosterNames = () => active().map(p => p.name);

  window.peoplePage = function () {
    const people = roster().slice().sort((a, b) => (a.active === false) - (b.active === false) || a.name.localeCompare(b.name));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Regina' });
    const rows = people.map(p => {
      const sessions = state.sessions.filter(s => mentions(s.talent, p));
      const upcoming = sessions.filter(s => s.date >= today && s.status !== 'Cancelled').sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      const scripts = state.scripts.filter(s => mentions(s.talent, p));
      const pieces = state.assets.filter(a => mentions(a.speaker, p));
      const files = (state.files || []).filter(f => (f.talent && mentions(f.talent, p)) || (f.by && mentions(f.by, p)));
      return `<tr${p.active === false ? ' class="muted"' : ''}><td><div class="row"><div class="avatar small-avatar">${esc(p.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase())}</div><div class="file-name">${esc(p.name)}<small>${esc(p.role || 'Talent')}${p.email ? ' · ' + esc(p.email) : ''}${p.active === false ? ' · inactive' : ''}</small></div></div></td>
        <td>${upcoming[0] ? `<button class="text-link" data-session="${esc(upcoming[0].id)}">${esc(dateLabel(upcoming[0].date))} · ${esc(upcoming[0].title)}</button>` : '<span class="muted small">—</span>'}</td>
        <td>${scripts.length}</td><td>${pieces.length}</td><td>${files.length}</td>
        <td>${isStaff() ? `<button class="text-link" data-person="${esc(p.id)}">Edit</button>` : ''}</td></tr>`;
    }).join('');
    return head('THE PEOPLE BEHIND THE WORK', 'Talent roster', 'Everyone who can be assigned to sessions, scripts, content pieces and recordings.', isStaff() ? btn('＋ Add person', 'new-person', true) : '')
      + `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Person</th><th>Next session</th><th>Scripts</th><th>Content pieces</th><th>Recordings</th><th></th></tr></thead><tbody>${rows}</tbody></table>${people.length ? '' : empty('No one on the roster yet.')}</div></section>
      <div class="notice mt">Assign people from a session, script or content piece. Recordings are tagged with whoever is reading in the teleprompter.</div>`;
  };

  function personForm(id) {
    const p = roster().find(x => x.id === id);
    modal(p ? p.name : 'Add a person', `<form id="person-form"><div class="form-grid">
      ${field('Name', 'title', p ? p.name : '', 'text', true)}
      ${selectField('Role', 'role', ['Talent', 'Host', 'Guest', 'Producer'], (p && p.role) || 'Talent')}
      ${field('Email (optional)', 'email', p ? p.email : '', 'email')}
      <label class="field full">Notes<textarea name="notes">${esc((p && p.notes) || '')}</textarea></label>
      ${p ? `<label class="field"><span><input type="checkbox" name="inactive" ${p.active === false ? 'checked' : ''}> Inactive (hide from pickers)</span></label>` : ''}
      </div><div class="row mt"><button class="btn primary" type="submit">Save</button>${p ? '<button class="btn danger" type="button" id="delete-person">Remove from roster</button>' : ''}</div>
      <p class="small muted mt">Adding someone here doesn’t give them a login. To invite them to the hub, ask an admin.</p></form>`);
    $('#person-form').onsubmit = e => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target));
      const name = String(v.title || '').trim();
      if (!name) return;
      const data = { name, role: v.role, email: String(v.email || '').trim(), notes: v.notes || '', active: !v.inactive };
      if (p) Object.assign(p, data);
      else roster().push({ id: 'p-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 6), ...data });
      save(); $('#dialog').close(); render(); toast('Roster updated');
    };
    if (p) $('#delete-person').onclick = () => confirmAction(`Remove ${p.name} from the roster? Their past assignments keep their name.`, () => {
      state.people = roster().filter(x => x.id !== p.id); save(); $('#dialog').close(); render();
    });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.action === 'new-person') personForm();
    if (b.dataset.person) personForm(b.dataset.person);
  });
})();
