// Users & Roles: add people, set their role and lines, edit what each role
// can do, switch the shared login off, and see who did what.

import { api, busy, confirmClick, showError, escapeHtml, fmtTimestamp, lineShortCode, LINE_LABELS, me } from '/common.js';

const AREAS = [['schedule', 'Production Schedule'], ['requisitions', 'Raw Material Requisitions'], ['collections', 'Stock Collections'], ['samples', 'Sample Retention']];
const ACTIONS = [['unleashed', 'Send to Unleashed / export CSVs'], ['approve', 'Approve truck sheets'], ['samplesSignOff', 'Sign off sample forms'], ['manageUsers', 'Manage users & roles']];

const state = { users: [], roles: [], lines: [], sharedLoginEnabled: true, editing: null, me: null };
const $ = (id) => document.getElementById(id);

async function load() {
  const data = await api('GET', '/users');
  Object.assign(state, data);
  renderUsers();
  renderRoles();
  renderShared();
  renderActivityPeople();
}

// ---------- users ----------

function signInText(u) {
  return [u.email, u.cell].filter(Boolean).join(' · ');
}

function renderUsers() {
  const list = $('userList');
  if (!state.users.length) {
    list.innerHTML = '<div class="empty">No users yet. Add yourself first, with the Admin role.</div>';
    return;
  }
  list.innerHTML = state.users.map((u) => {
    const status = !u.active ? 'Switched off'
      : u.mustChangePassword ? 'Waiting for first sign-in'
      : u.lastLoginAt ? 'Last signed in ' + fmtTimestamp(u.lastLoginAt) : 'Active';
    const lines = u.lines.length ? u.lines.map(lineShortCode).join(', ') : 'All lines';
    return '<div class="person' + (u.active ? '' : ' off') + '">' +
      '<div class="who">' + escapeHtml(u.name) + ' <span class="pill pill-line">' + escapeHtml(u.roleName) + '</span></div>' +
      '<div class="meta">' + escapeHtml(signInText(u)) + ' · ' + escapeHtml(lines) + ' · ' + escapeHtml(status) + '</div>' +
      '<div class="actions"><button type="button" class="btn-ghost btn-small" data-edit-user="' + u.id + '">Edit</button></div>' +
      '</div>';
  }).join('');
}

function fillRoleSelect(selected) {
  $('uRole').innerHTML = state.roles.map((r) =>
    '<option value="' + r.id + '"' + (r.id === selected ? ' selected' : '') + '>' + escapeHtml(r.name) + '</option>').join('');
}

function openUserForm(user) {
  state.editing = user ? user.id : null;
  $('userFormTitle').textContent = user ? 'Change ' + user.name : 'Add a user';
  $('uName').value = user?.name || '';
  $('uEmail').value = user?.email || '';
  $('uCell').value = user?.cell || '';
  fillRoleSelect(user?.roleId ?? state.roles.find((r) => r.name === 'Line operator')?.id ?? state.roles[0]?.id);
  $('uLines').innerHTML = state.lines.map((l) =>
    '<label><input type="checkbox" value="' + escapeHtml(l) + '"' + (user?.lines?.includes(l) ? ' checked' : '') + '> ' +
    escapeHtml(LINE_LABELS[l] || l) + '</label>').join('');
  $('uActive').checked = user ? user.active : true;
  $('uActiveField').hidden = !user;
  $('resetPwBtn').hidden = !user;
  $('saveUserBtn').textContent = user ? 'Save' : 'Add and make a one-time password';
  $('userForm').hidden = false;
  $('uName').focus();
}

function closeUserForm() {
  $('userForm').hidden = true;
  state.editing = null;
}

function showOtp(user, password) {
  const box = $('otpBox');
  box.innerHTML = '<div class="otp">One-time password for <b>' + escapeHtml(user.name) + '</b>: <code>' + escapeHtml(password) + '</code><br>' +
    'They sign in at production.mountainfalls.co.za with <b>' + escapeHtml(signInText(user)) + '</b> and this password, then choose their own. ' +
    'It is shown only now, so pass it on before leaving this page. ' +
    '<button type="button" class="btn-ghost btn-small" id="copyOtpBtn">Copy</button></div>';
  box.hidden = false;
  $('copyOtpBtn').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(password); e.target.textContent = 'Copied'; }
    catch { e.target.textContent = 'Select it and copy'; }
  });
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('addUserBtn').addEventListener('click', () => openUserForm(null));
$('cancelUserBtn').addEventListener('click', closeUserForm);
$('userList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-edit-user]')?.dataset.editUser;
  if (id) openUserForm(state.users.find((u) => u.id === Number(id)));
});

$('userForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const body = {
    name: $('uName').value,
    email: $('uEmail').value,
    cell: $('uCell').value,
    roleId: Number($('uRole').value),
    lines: [...$('uLines').querySelectorAll('input:checked')].map((i) => i.value),
    active: state.editing ? $('uActive').checked : true,
  };
  busy($('saveUserBtn'), 'Saving…', async () => {
    if (state.editing) {
      await api('PATCH', '/users/' + state.editing, body);
      $('otpBox').hidden = true;
    } else {
      const { user, password } = await api('POST', '/users', body);
      showOtp(user, password);
    }
    closeUserForm();
    await load();
  });
});

// One tap for someone who hasn't signed in yet; someone with their own
// password gets "Confirm?" first, as it signs them out everywhere.
$('resetPwBtn').addEventListener('click', (e) => {
  const user = state.users.find((u) => u.id === state.editing);
  const go = () => busy(e.target, 'Making…', async () => {
    const { password } = await api('POST', '/users/' + user.id + '/reset-password');
    closeUserForm();
    showOtp(user, password);
    load().catch((err) => showError(err.message));
  });
  if (user.mustChangePassword) go(); else confirmClick(e.target, go);
});

// ---------- roles ----------

function roleCard(r) {
  const isNew = !r.id;
  return '<div class="role" data-role="' + (r.id || 'new') + '">' +
    '<div class="field"><label>Role name</label><input data-f="name" value="' + escapeHtml(r.name || '') + '" placeholder="e.g. Shift supervisor"></div>' +
    '<div class="role-areas">' + AREAS.map(([k, label]) =>
      '<div class="field"><label>' + label + '</label><select data-area="' + k + '">' +
      ['none', 'view', 'edit'].map((v) => '<option value="' + v + '"' + ((r.areas?.[k] || 'none') === v ? ' selected' : '') + '>' +
        { none: 'None (hidden)', view: 'View', edit: 'Edit' }[v] + '</option>').join('') +
      '</select></div>').join('') + '</div>' +
    '<div class="checks">' + ACTIONS.map(([k, label]) =>
      '<label><input type="checkbox" data-action="' + k + '"' + (r.actions?.[k] ? ' checked' : '') + '> ' + label + '</label>').join('') + '</div>' +
    '<div class="role-foot">' +
      '<span class="count">' + (isNew ? 'New role' : r.users + ' user' + (r.users === 1 ? '' : 's')) + '</span>' +
      '<button type="button" class="btn-primary btn-small" data-save-role>' + (isNew ? 'Add role' : 'Save') + '</button>' +
      (isNew ? '<button type="button" class="btn-ghost btn-small" data-cancel-role>Cancel</button>'
        : (r.users ? '' : '<button type="button" class="btn-danger-ghost btn-small" data-del-role>Delete</button>')) +
    '</div></div>';
}

function renderRoles() {
  $('roleList').innerHTML = state.roles.map(roleCard).join('');
}

function readRole(card) {
  const areas = {}, actions = {};
  for (const s of card.querySelectorAll('[data-area]')) areas[s.dataset.area] = s.value;
  for (const c of card.querySelectorAll('[data-action]')) actions[c.dataset.action] = c.checked;
  return { name: card.querySelector('[data-f="name"]').value, areas, actions };
}

$('addRoleBtn').addEventListener('click', () => {
  if ($('roleList').querySelector('[data-role="new"]')) return;
  $('roleList').insertAdjacentHTML('beforeend', roleCard({ areas: { schedule: 'view', requisitions: 'view', collections: 'view', samples: 'view' }, actions: {} }));
  $('roleList').querySelector('[data-role="new"] input').focus();
});

$('roleList').addEventListener('click', (e) => {
  const card = e.target.closest('[data-role]');
  if (!card) return;
  const id = card.dataset.role;
  if (e.target.matches('[data-cancel-role]')) return card.remove();
  if (e.target.matches('[data-save-role]')) {
    busy(e.target, 'Saving…', async () => {
      if (id === 'new') await api('POST', '/roles', readRole(card));
      else await api('PATCH', '/roles/' + id, readRole(card));
      await load();
    });
  }
  if (e.target.matches('[data-del-role]')) {
    confirmClick(e.target, () => busy(e.target, 'Deleting…', async () => { await api('DELETE', '/roles/' + id); await load(); }));
  }
});

// ---------- shared login ----------

function renderShared() {
  const on = state.sharedLoginEnabled;
  $('sharedState').textContent = on ? 'On — the shared “production” login still works' : 'Off — everyone signs in with their own login';
  $('sharedBtn').textContent = on ? 'Switch the shared login off' : 'Switch the shared login back on';
  $('sharedBtn').className = on ? 'btn-danger-ghost btn-small' : 'btn-ghost btn-small';
  $('sharedNote').textContent = on
    ? 'The shared login has full access. Switch it off once everyone has their own login. Devices signed in with it will be signed out. You need to be signed in with your own admin login to do this.'
    : 'Only individual users can sign in.';
}

$('sharedBtn').addEventListener('click', (e) => {
  const turnOff = state.sharedLoginEnabled;
  const go = () => busy(e.target, 'Saving…', async () => {
    await api('PUT', '/settings/shared-login', { enabled: !turnOff });
    await load();
  });
  if (turnOff) confirmClick(e.target, go); else go();
});

// ---------- activity ----------

function renderActivityPeople() {
  const sel = $('actUser');
  const current = sel.value;
  sel.innerHTML = '<option value="">Everyone</option>' + state.users.map((u) =>
    '<option value="' + u.id + '">' + escapeHtml(u.name) + '</option>').join('');
  sel.value = current;
}

function describe(detail) {
  const d = { ...(detail || {}) };
  delete d.path;
  const parts = Object.entries(d).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object').map(([k, v]) => k + ': ' + v);
  if (detail?.path) parts.unshift(detail.path);
  return parts.join(' · ');
}

async function loadActivity() {
  const userId = $('actUser').value;
  const rows = await api('GET', '/activity?limit=300' + (userId ? '&userId=' + userId : ''));
  $('activityList').innerHTML = rows.length
    ? rows.map((r) => '<div><time>' + escapeHtml(fmtTimestamp(r.at)) + '</time><span><b>' + escapeHtml(r.userName) + '</b> — ' +
        escapeHtml(r.action) + '<small>' + escapeHtml(describe(r.detail)) + '</small></span></div>').join('')
    : '<div class="empty" style="display:block;">Nothing yet.</div>';
}
$('actUser').addEventListener('change', () => loadActivity().catch((err) => showError(err.message)));

me.then((u) => { state.me = u; });
load().then(loadActivity).catch((err) => showError(err.message));
