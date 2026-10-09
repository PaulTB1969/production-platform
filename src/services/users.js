// Users, roles and the activity log.
//
// Passwords are stored as scrypt hashes. A new user (or a password reset)
// gets a one-time password, shown once to the admin; the user must choose
// their own at first sign-in.

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { UserError } from './rows.js';
import { LINES } from '../domain/lines.js';

const scrypt = promisify(scryptCb);

export const AREAS = ['schedule', 'requisitions', 'collections', 'samples'];
export const LEVELS = ['none', 'view', 'edit'];
export const ACTIONS = ['unleashed', 'approve', 'samplesSignOff', 'manageUsers'];

// What the shared 'production' login (and local dev without a password) can do.
export const FULL_ACCESS = {
  areas: { schedule: 'edit', requisitions: 'edit', collections: 'edit', samples: 'edit' },
  actions: { unleashed: true, approve: true, samplesSignOff: true, manageUsers: true },
};

// ---------- passwords ----------

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(String(password), salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

// Easy to read out or type on a phone: no 0/O, 1/l/I.
export function oneTimePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(8);
  const s = Array.from(bytes, (b) => chars[b % chars.length]).join('');
  return s.slice(0, 4) + '-' + s.slice(4);
}

export function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new UserError('Choose a password of at least 8 characters.');
}

// ---------- sign-in IDs ----------

export function normalizeEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new UserError(`"${v}" is not an email address.`);
  return s;
}

// South African numbers in local form: +27 82 123 4567 -> 0821234567.
export function normalizeCell(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('27') && d.length === 11) d = '0' + d.slice(2);
  if (!/^0\d{9}$/.test(d)) throw new UserError(`"${v}" is not a cell number — use 10 digits, e.g. 082 123 4567.`);
  return d;
}

// What someone typed on the sign-in page: an email or a cell number.
export function loginKey(v) {
  const s = String(v || '').trim();
  if (s.includes('@')) return { email: s.toLowerCase() };
  try { return { cell: normalizeCell(s) }; } catch { return null; }
}

// ---------- roles ----------

const roleRow = (r) => ({ id: r.id, name: r.name, areas: r.areas, actions: r.actions });

function cleanRole(body) {
  const name = String(body?.name || '').trim();
  if (!name) throw new UserError('Give the role a name.');
  const areas = {}, actions = {};
  for (const a of AREAS) {
    const v = body?.areas?.[a] || 'none';
    if (!LEVELS.includes(v)) throw new UserError(`Unknown access level "${v}".`);
    areas[a] = v;
  }
  for (const a of ACTIONS) actions[a] = !!body?.actions?.[a];
  return { name, areas, actions };
}

export async function listRoles(db) {
  const rows = (await db.query(
    `SELECT r.*, (SELECT count(*) FROM users u WHERE u.role_id = r.id)::int AS users FROM roles r ORDER BY r.id`)).rows;
  return rows.map((r) => ({ ...roleRow(r), users: r.users }));
}

export async function createRole(db, body) {
  const r = cleanRole(body);
  try {
    const row = (await db.query('INSERT INTO roles (name, areas, actions) VALUES ($1, $2, $3) RETURNING *',
      [r.name, JSON.stringify(r.areas), JSON.stringify(r.actions)])).rows[0];
    return roleRow(row);
  } catch (err) {
    if (err.code === '23505') throw new UserError(`There is already a role called "${r.name}".`, 409);
    throw err;
  }
}

export async function updateRole(db, id, body) {
  const r = cleanRole(body);
  return db.tx(async (q) => {
    let row;
    try {
      row = (await q.query('UPDATE roles SET name = $2, areas = $3, actions = $4 WHERE id = $1 RETURNING *',
        [id, r.name, JSON.stringify(r.areas), JSON.stringify(r.actions)])).rows[0];
    } catch (err) {
      if (err.code === '23505') throw new UserError(`There is already a role called "${r.name}".`, 409);
      throw err;
    }
    if (!row) throw new UserError('Role not found.', 404);
    await ensureAnAdmin(q);
    return roleRow(row);
  });
}

export async function deleteRole(db, id) {
  const { n } = (await db.query('SELECT count(*)::int AS n FROM users WHERE role_id = $1', [id])).rows[0];
  if (n) throw new UserError(`${n} user(s) have this role — give them another role first.`, 409);
  await db.query('DELETE FROM roles WHERE id = $1', [id]);
}

// ---------- users ----------

const USER_COLS = `u.id, u.name, u.email, u.cell, u.role_id, u.lines, u.active, u.must_change_password,
  u.session_version, u.last_login_at, u.created_at, r.name AS role_name, r.areas, r.actions`;

export const userRow = (u) => ({
  id: u.id, name: u.name, email: u.email, cell: u.cell, roleId: u.role_id, roleName: u.role_name,
  lines: u.lines || [], active: u.active, mustChangePassword: u.must_change_password,
  lastLoginAt: u.last_login_at, createdAt: u.created_at,
});

export async function listUsers(db) {
  return (await db.query(`SELECT ${USER_COLS} FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.active DESC, lower(u.name)`))
    .rows.map(userRow);
}

// Full record for signing in / checking a session (includes the hash).
export async function findUserForLogin(db, key) {
  if (!key) return null;
  const [col, val] = key.email ? ['lower(u.email)', key.email] : ['u.cell', key.cell];
  return (await db.query(`SELECT ${USER_COLS}, u.password_hash FROM users u JOIN roles r ON r.id = u.role_id WHERE ${col} = $1`, [val])).rows[0] || null;
}

export async function getUserById(db, id) {
  return (await db.query(`SELECT ${USER_COLS}, u.password_hash FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [id])).rows[0] || null;
}

function cleanUser(body) {
  const name = String(body?.name || '').trim();
  if (!name) throw new UserError('Enter the person’s name.');
  const email = normalizeEmail(body?.email);
  const cell = normalizeCell(body?.cell);
  if (!email && !cell) throw new UserError('Enter an email address or a cell number (or both) — that is what they sign in with.');
  const roleId = Number(body?.roleId);
  if (!Number.isInteger(roleId)) throw new UserError('Pick a role.');
  const lines = Array.isArray(body?.lines) ? [...new Set(body.lines)] : [];
  for (const l of lines) if (!LINES.includes(l)) throw new UserError(`Unknown production line "${l}".`);
  return { name, email, cell, roleId, lines, active: body?.active !== false };
}

const duplicate = (err, u) => {
  if (err.code !== '23505') return err;
  return new UserError(String(err.detail || err.message).includes('email')
    ? `Someone else already signs in with ${u.email}.`
    : `Someone else already signs in with ${u.cell}.`, 409);
};

// Returns the user and their one-time password (shown once).
export async function createUser(db, body) {
  const u = cleanUser(body);
  const password = oneTimePassword();
  const hash = await hashPassword(password);
  try {
    const { id } = (await db.query(
      `INSERT INTO users (name, email, cell, role_id, lines, active, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true) RETURNING id`,
      [u.name, u.email, u.cell, u.roleId, u.lines, u.active, hash])).rows[0];
    return { user: userRow(await getUserById(db, id)), password };
  } catch (err) {
    if (err.code === '23503') throw new UserError('That role no longer exists.', 409);
    throw duplicate(err, u);
  }
}

export async function updateUser(db, id, body) {
  const u = cleanUser(body);
  return db.tx(async (q) => {
    const before = (await q.query('SELECT active FROM users WHERE id = $1', [id])).rows[0];
    if (!before) throw new UserError('User not found.', 404);
    try {
      // Switching someone off signs them out everywhere.
      await q.query(
        `UPDATE users SET name = $2, email = $3, cell = $4, role_id = $5, lines = $6, active = $7,
           session_version = session_version + CASE WHEN active AND NOT $7 THEN 1 ELSE 0 END
         WHERE id = $1`,
        [id, u.name, u.email, u.cell, u.roleId, u.lines, u.active]);
    } catch (err) {
      if (err.code === '23503') throw new UserError('That role no longer exists.', 409);
      throw duplicate(err, u);
    }
    await ensureAnAdmin(q);
    return userRow(await getUserById(q, id));
  });
}

export async function resetPassword(db, id) {
  const password = oneTimePassword();
  const r = await db.query(
    `UPDATE users SET password_hash = $2, must_change_password = true, session_version = session_version + 1 WHERE id = $1`,
    [id, await hashPassword(password)]);
  if (!r.affectedRows && !r.rowCount) throw new UserError('User not found.', 404);
  return { password };
}

// The user's own change. Returns the new session version.
export async function changePassword(db, id, { current, next }, { skipCurrent = false } = {}) {
  const u = await getUserById(db, id);
  if (!u) throw new UserError('User not found.', 404);
  if (!skipCurrent && !(await verifyPassword(current || '', u.password_hash))) throw new UserError('Your current password is not right.');
  checkNewPassword(next);
  if (await verifyPassword(next, u.password_hash)) throw new UserError('Choose a new password, different from the one-time password.');
  const row = (await db.query(
    `UPDATE users SET password_hash = $2, must_change_password = false, session_version = session_version + 1
      WHERE id = $1 RETURNING session_version`, [id, await hashPassword(next)])).rows[0];
  return row.session_version;
}

export async function recordLogin(db, id) {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

// ---------- settings ----------

export async function getSetting(db, name, fallback) {
  const r = (await db.query('SELECT value FROM settings WHERE name = $1', [name])).rows[0];
  return r ? r.value : fallback;
}

export async function sharedLoginEnabled(db) {
  return (await getSetting(db, 'sharedLoginEnabled', true)) !== false;
}

export async function setSharedLogin(db, enabled) {
  return db.tx(async (q) => {
    await q.query(`INSERT INTO settings (name, value) VALUES ('sharedLoginEnabled', $1)
      ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(!!enabled)]);
    await ensureAnAdmin(q);
    return { sharedLoginEnabled: !!enabled };
  });
}

// Never lock everyone out: with the shared login off, at least one active
// user must still be able to manage users (who has already chosen a password).
async function ensureAnAdmin(q) {
  const shared = (await q.query(`SELECT value FROM settings WHERE name = 'sharedLoginEnabled'`)).rows[0];
  if (!shared || shared.value !== false) return;
  const { n } = (await q.query(
    `SELECT count(*)::int AS n FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.active AND NOT u.must_change_password AND (r.actions->>'manageUsers')::boolean`)).rows[0];
  if (!n) {
    throw new UserError('That would leave nobody who can manage users. Keep at least one active user (who has signed in and set their password) with a role that can manage users — or switch the shared login back on.', 409);
  }
}

// ---------- activity log ----------

export async function logActivity(db, user, action, detail = {}) {
  await db.query('INSERT INTO activity_log (user_id, user_name, action, detail) VALUES ($1, $2, $3, $4)',
    [user?.id ?? null, user?.name || 'Unknown', action, JSON.stringify(detail)]);
}

export async function listActivity(db, { limit = 200, userId } = {}) {
  const params = [Math.min(Number(limit) || 200, 1000)];
  let where = '';
  if (userId) { params.push(Number(userId)); where = 'WHERE user_id = $2'; }
  return (await db.query(`SELECT id, at, user_id, user_name, action, detail FROM activity_log ${where} ORDER BY at DESC, id DESC LIMIT $1`, params))
    .rows.map((r) => ({ id: Number(r.id), at: r.at, userId: r.user_id, userName: r.user_name, action: r.action, detail: r.detail }));
}
