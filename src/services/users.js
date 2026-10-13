// Users, roles and the activity log.
//
// A user is platform-wide (table "users" in the public schema) and belongs to
// a customer. They get access to one or more of that customer's sites, each
// with a role and production lines (table "site_access"). Roles and the
// activity log live in each site's own schema.
//
//   pdb = the platform database (public schema)
//   sdb = the current site's scoped database
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
export const ACTIONS = ['uploadCsv', 'generateRequisitions', 'unleashed', 'approve', 'samplesSignOff', 'manageUsers'];

// What platform support in edit mode (and local dev) can do.
export const FULL_ACCESS = {
  areas: { schedule: 'edit', requisitions: 'edit', collections: 'edit', samples: 'edit' },
  actions: { uploadCsv: true, generateRequisitions: true, unleashed: true, approve: true, samplesSignOff: true, manageUsers: true },
};
// Support in view mode: sees everything, changes nothing.
export const VIEW_ACCESS = {
  areas: { schedule: 'view', requisitions: 'view', collections: 'view', samples: 'view' },
  actions: { uploadCsv: false, generateRequisitions: false, unleashed: false, approve: false, samplesSignOff: false, manageUsers: true },
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

// ---------- roles (per site) ----------

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

export async function getRole(sdb, id) {
  const r = (await sdb.query('SELECT * FROM roles WHERE id = $1', [id])).rows[0];
  return r ? roleRow(r) : null;
}

export async function listRoles(sdb, siteId) {
  const rows = (await sdb.query(
    `SELECT r.*, (SELECT count(*) FROM public.site_access a WHERE a.site_id = $1 AND a.role_id = r.id)::int AS users
       FROM roles r ORDER BY r.id`, [siteId])).rows;
  return rows.map((r) => ({ ...roleRow(r), users: r.users }));
}

export async function createRole(sdb, body) {
  const r = cleanRole(body);
  try {
    const row = (await sdb.query('INSERT INTO roles (name, areas, actions) VALUES ($1, $2, $3) RETURNING *',
      [r.name, JSON.stringify(r.areas), JSON.stringify(r.actions)])).rows[0];
    return roleRow(row);
  } catch (err) {
    if (err.code === '23505') throw new UserError(`There is already a role called "${r.name}".`, 409);
    throw err;
  }
}

export async function updateRole(pdb, sdb, siteId, id, body) {
  const r = cleanRole(body);
  const before = await getRole(sdb, id);
  if (!before) throw new UserError('Role not found.', 404);
  if (before.actions.manageUsers && !r.actions.manageUsers) {
    const admins = await siteAdmins(pdb, sdb, siteId);
    const others = admins.filter((a) => a.roleId !== id);
    if (admins.length && !others.length) throw lockoutError();
  }
  try {
    const row = (await sdb.query('UPDATE roles SET name = $2, areas = $3, actions = $4 WHERE id = $1 RETURNING *',
      [id, r.name, JSON.stringify(r.areas), JSON.stringify(r.actions)])).rows[0];
    return roleRow(row);
  } catch (err) {
    if (err.code === '23505') throw new UserError(`There is already a role called "${r.name}".`, 409);
    throw err;
  }
}

export async function deleteRole(pdb, sdb, siteId, id) {
  const { n } = (await pdb.query('SELECT count(*)::int AS n FROM site_access WHERE site_id = $1 AND role_id = $2', [siteId, id])).rows[0];
  if (n) throw new UserError(`${n} user(s) have this role — give them another role first.`, 409);
  await sdb.query('DELETE FROM roles WHERE id = $1', [id]);
}

// ---------- users ----------

const USER_COLS = `u.id, u.customer_id, u.name, u.email, u.cell, u.active, u.must_change_password,
  u.session_version, u.last_login_at, u.created_at`;

// Full record for signing in / checking a session (includes the hash).
export async function findUserForLogin(pdb, key) {
  if (!key) return null;
  const [col, val] = key.email ? ['lower(u.email)', key.email] : ['u.cell', key.cell];
  return (await pdb.query(`SELECT ${USER_COLS}, u.password_hash FROM users u WHERE ${col} = $1`, [val])).rows[0] || null;
}

export async function getUserById(pdb, id) {
  return (await pdb.query(`SELECT ${USER_COLS}, u.password_hash FROM users u WHERE u.id = $1`, [id])).rows[0] || null;
}

// The active sites a user can open, with their role id and lines on each.
export async function userSites(pdb, userId) {
  return (await pdb.query(
    `SELECT s.id, s.name, s.customer_id, a.role_id, a.lines
       FROM site_access a JOIN sites s ON s.id = a.site_id
      WHERE a.user_id = $1 AND s.status = 'active' ORDER BY lower(s.name)`, [userId])).rows
    .map((r) => ({ id: r.id, name: r.name, customerId: r.customer_id, roleId: r.role_id, lines: r.lines || [] }));
}

// Everyone at the customer, with their access to this site (or none).
export async function listUsers(pdb, sdb, { customerId, siteId }) {
  const roles = new Map((await sdb.query('SELECT id, name FROM roles')).rows.map((r) => [r.id, r.name]));
  const rows = (await pdb.query(
    `SELECT ${USER_COLS}, a.role_id, a.lines,
            (SELECT array_agg(s.name ORDER BY s.name) FROM site_access x JOIN sites s ON s.id = x.site_id
              WHERE x.user_id = u.id AND x.site_id <> $2) AS other_sites
       FROM users u LEFT JOIN site_access a ON a.user_id = u.id AND a.site_id = $2
      WHERE u.customer_id = $1 ORDER BY u.active DESC, (a.role_id IS NULL), lower(u.name)`, [customerId, siteId])).rows;
  return rows.map((u) => ({
    id: u.id, name: u.name, email: u.email, cell: u.cell, active: u.active, mustChangePassword: u.must_change_password,
    lastLoginAt: u.last_login_at, createdAt: u.created_at,
    hasAccess: u.role_id !== null, roleId: u.role_id, roleName: u.role_id !== null ? roles.get(u.role_id) || '?' : null,
    lines: u.lines || [], otherSites: u.other_sites || [],
  }));
}

function cleanUser(body) {
  const name = String(body?.name || '').trim();
  if (!name) throw new UserError('Enter the person’s name.');
  const email = normalizeEmail(body?.email);
  const cell = normalizeCell(body?.cell);
  if (!email && !cell) throw new UserError('Enter an email address or a cell number (or both) — that is what they sign in with.');
  return { name, email, cell, active: body?.active !== false };
}

async function cleanAccess(sdb, body) {
  if (body?.hasAccess === false) return null;
  const roleId = Number(body?.roleId);
  if (!Number.isInteger(roleId) || !(await getRole(sdb, roleId))) throw new UserError('Pick a role.');
  const lines = Array.isArray(body?.lines) ? [...new Set(body.lines)] : [];
  for (const l of lines) if (!LINES.includes(l)) throw new UserError(`Unknown production line "${l}".`);
  return { roleId, lines };
}

const duplicate = (err, u) => {
  if (err.code !== '23505') return err;
  return new UserError(String(err.detail || err.message).includes('email')
    ? `Someone else already signs in with ${u.email}.`
    : `Someone else already signs in with ${u.cell}.`, 409);
};

// A new user at the customer, with access to this site. Returns the user's
// id and their one-time password (shown once).
export async function createUser(pdb, sdb, { customerId, siteId }, body) {
  const u = cleanUser(body);
  const access = await cleanAccess(sdb, { ...body, hasAccess: true });
  const password = oneTimePassword();
  const hash = await hashPassword(password);
  const id = await pdb.tx(async (q) => {
    let row;
    try {
      row = (await q.query(
        `INSERT INTO users (customer_id, name, email, cell, active, password_hash, must_change_password)
         VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
        [customerId, u.name, u.email, u.cell, u.active, hash])).rows[0];
    } catch (err) {
      throw duplicate(err, u);
    }
    await q.query('INSERT INTO site_access (user_id, site_id, role_id, lines) VALUES ($1, $2, $3, $4)',
      [row.id, siteId, access.roleId, access.lines]);
    return row.id;
  });
  return { id, password };
}

// Details (all sites) plus access to this site: role and lines, or
// hasAccess: false to remove it.
export async function updateUser(pdb, sdb, { customerId, siteId }, id, body) {
  const before = (await pdb.query('SELECT * FROM users WHERE id = $1 AND customer_id = $2', [id, customerId])).rows[0];
  if (!before) throw new UserError('User not found.', 404);
  const u = cleanUser(body);
  const access = await cleanAccess(sdb, body);

  // Never leave the site without someone who can manage users.
  const admins = await siteAdmins(pdb, sdb, siteId);
  if (admins.some((a) => a.id === id)) {
    const newRole = access ? await getRole(sdb, access.roleId) : null;
    const staysAdmin = u.active && access && newRole?.actions.manageUsers;
    if (!staysAdmin && admins.length === 1) throw lockoutError();
  }

  await pdb.tx(async (q) => {
    try {
      // Switching someone off signs them out everywhere.
      await q.query(
        `UPDATE users SET name = $2, email = $3, cell = $4, active = $5,
           session_version = session_version + CASE WHEN active AND NOT $5 THEN 1 ELSE 0 END
         WHERE id = $1`,
        [id, u.name, u.email, u.cell, u.active]);
    } catch (err) {
      throw duplicate(err, u);
    }
    if (access) {
      await q.query(`INSERT INTO site_access (user_id, site_id, role_id, lines) VALUES ($1, $2, $3, $4)
        ON CONFLICT (user_id, site_id) DO UPDATE SET role_id = EXCLUDED.role_id, lines = EXCLUDED.lines`,
        [id, siteId, access.roleId, access.lines]);
    } else {
      await q.query('DELETE FROM site_access WHERE user_id = $1 AND site_id = $2', [id, siteId]);
    }
  });
}

export async function resetPassword(pdb, customerId, id) {
  const password = oneTimePassword();
  const r = await pdb.query(
    `UPDATE users SET password_hash = $3, must_change_password = true, session_version = session_version + 1
      WHERE id = $1 AND customer_id = $2`,
    [id, customerId, await hashPassword(password)]);
  if (!r.affectedRows && !r.rowCount) throw new UserError('User not found.', 404);
  return { password };
}

// The user's own change. Returns the updated user.
export async function changePassword(pdb, id, { current, next }, { skipCurrent = false } = {}) {
  const u = await getUserById(pdb, id);
  if (!u) throw new UserError('User not found.', 404);
  if (!skipCurrent && !(await verifyPassword(current || '', u.password_hash))) throw new UserError('Your current password is not right.');
  checkNewPassword(next);
  if (await verifyPassword(next, u.password_hash)) throw new UserError('Choose a new password, different from the one-time password.');
  await pdb.query(
    `UPDATE users SET password_hash = $2, must_change_password = false, session_version = session_version + 1
      WHERE id = $1`, [id, await hashPassword(next)]);
  return getUserById(pdb, id);
}

export async function recordLogin(pdb, id) {
  await pdb.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

// Active users of this site who can manage users and have chosen a password.
async function siteAdmins(pdb, sdb, siteId) {
  const manageRoles = new Set((await sdb.query(`SELECT id FROM roles WHERE (actions->>'manageUsers')::boolean`)).rows.map((r) => r.id));
  const rows = (await pdb.query(
    `SELECT u.id, a.role_id FROM site_access a JOIN users u ON u.id = a.user_id
      WHERE a.site_id = $1 AND u.active AND NOT u.must_change_password`, [siteId])).rows;
  return rows.filter((r) => manageRoles.has(r.role_id)).map((r) => ({ id: r.id, roleId: r.role_id }));
}

const lockoutError = () => new UserError('That would leave this site with nobody who can manage users. Keep at least one active user (who has signed in and set their password) with a role that can manage users.', 409);

// ---------- activity log (per site) ----------

export async function logActivity(sdb, user, action, detail = {}) {
  await sdb.query('INSERT INTO activity_log (user_id, user_name, action, detail, support) VALUES ($1, $2, $3, $4, $5)',
    [user?.id ?? null, user?.name || 'Unknown', action, JSON.stringify(detail), !!user?.support]);
}

export async function listActivity(sdb, { limit = 200, userId } = {}) {
  const params = [Math.min(Number(limit) || 200, 1000)];
  let where = '';
  if (userId) { params.push(Number(userId)); where = 'WHERE user_id = $2'; }
  return (await sdb.query(`SELECT id, at, user_id, user_name, action, detail, support FROM activity_log ${where} ORDER BY at DESC, id DESC LIMIT $1`, params))
    .rows.map((r) => ({ id: Number(r.id), at: r.at, userId: r.user_id, userName: r.user_name, action: r.action, detail: r.detail, support: r.support }));
}
