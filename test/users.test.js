// Individual logins, roles, production lines per user, the shared login
// switch, "Sent by" and the activity log — through the real app.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { requiredFor, can, lineAllowed } from '../src/permissions.js';
import { normalizeCell, hashPassword, verifyPassword } from '../src/services/users.js';
import { sendTransfer } from '../src/services/unleashedSend.js';

const DATE = '2026-10-01';
let db, server, base;
const SHARED = 'Basic ' + Buffer.from('team:secret').toString('base64');

async function call(method, path, body, auth = SHARED) {
  const headers = {};
  if (auth?.startsWith('Basic')) headers.Authorization = auth;
  else if (auth) headers.Cookie = auth;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* page */ }
  return { status: res.status, data, headers: res.headers };
}

async function signIn(username, password) {
  const res = await fetch(base + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, next: '/' }),
  });
  return { location: res.headers.get('location'), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

// Sign in with a one-time password and choose a real one; returns the cookie.
async function firstSignIn(username, otp, newPw) {
  const s = await signIn(username, otp);
  assert.match(s.location, /^\/account\?first=1/);
  const r = await call('POST', '/api/me/password', { next: newPw }, s.cookie);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

const roleId = async (name, auth) => (await call('GET', '/api/roles', undefined, auth)).data.find((r) => r.name === name).id;

before(async () => {
  db = await openDb({});
  await migrate(db);
  const config = { auth: { user: 'team', password: 'secret' }, productionEmail: 'prod@example.com' };
  server = createApp({ db, config, unleashed: null }).listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await db.close();
});

test('permission rules', () => {
  assert.deepEqual(requiredFor('GET', '/schedule'), { area: 'schedule', level: 'view' });
  assert.deepEqual(requiredFor('PATCH', '/schedule/5'), { area: 'schedule', level: 'edit' });
  assert.deepEqual(requiredFor('POST', '/unleashed/send/transfers'), { area: 'requisitions', level: 'edit', action: 'unleashed' });
  assert.deepEqual(requiredFor('POST', '/collections/sheets/RML/send'), { area: 'collections', level: 'edit', action: 'approve' });
  assert.deepEqual(requiredFor('GET', '/users'), { action: 'manageUsers' });
  assert.deepEqual(requiredFor('GET', '/recipes'), {});
  assert.ok(can({ areas: { schedule: 'edit' } }, 'schedule', 'view'));
  assert.ok(!can({ areas: { schedule: 'view' } }, 'schedule', 'edit'));
  assert.ok(lineAllowed({ lines: [] }, 'PRD - AQB'));
  assert.ok(!lineAllowed({ lines: ['PRD - UWH'] }, 'PRD - AQB'));
  assert.equal(normalizeCell('+27 82 123 4567'), '0821234567');
  assert.equal(normalizeCell('082-123-4567'), '0821234567');
});

test('passwords are hashed and checked', async () => {
  const h = await hashPassword('hello-there');
  assert.ok(h.startsWith('scrypt$') && !h.includes('hello'));
  assert.ok(await verifyPassword('hello-there', h));
  assert.ok(!(await verifyPassword('hello-therE', h)));
});

test('admin adds a line operator; they see only their line, view-only requisitions, no Unleashed', async () => {
  // Data on two lines (as the shared login, which has full access).
  await call('POST', '/api/schedule', { sku: 'P500', line: 'PRD - UWH', plannedCases: 10, date: DATE });
  const aqb = (await call('POST', '/api/schedule', { sku: 'P500', line: 'PRD - AQB', plannedCases: 4, date: DATE })).data;

  const created = await call('POST', '/api/users', {
    name: 'Thandi Operator', cell: '+27 82 555 0001', roleId: await roleId('Line operator'), lines: ['PRD - UWH'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.cell, '0825550001');
  assert.match(created.data.password, /^[a-z2-9]{4}-[a-z2-9]{4}$/);

  // Wrong password: back to the login page.
  assert.match((await signIn('082 555 0001', 'nope')).location, /error=wrong/);

  // Before choosing a password, only the account page works.
  const first = await signIn('0825550001', created.data.password);
  assert.equal((await call('GET', '/api/schedule', undefined, first.cookie)).status, 403);
  assert.equal((await call('GET', '/schedule', undefined, first.cookie)).headers.get('location'), '/account?first=1');
  assert.equal((await call('POST', '/api/me/password', { next: 'short' }, first.cookie)).status, 400);

  const cookie = await firstSignIn('0825550001', created.data.password, 'thandi-pass-1');
  const me = (await call('GET', '/api/me', undefined, cookie)).data;
  assert.equal(me.name, 'Thandi Operator');
  assert.deepEqual(me.lines, ['PRD - UWH']);

  // Only UWH jobs, and AQB jobs can't be touched.
  const jobs = (await call('GET', '/api/schedule?date=' + DATE, undefined, cookie)).data;
  assert.deepEqual([...new Set(jobs.map((j) => j.line))], ['PRD - UWH']);
  assert.equal((await call('PATCH', '/api/schedule/' + aqb.id, { notes: 'x' }, cookie)).status, 403);
  assert.equal((await call('POST', '/api/schedule', { sku: 'P500', line: 'PRD - AQB', plannedCases: 1, date: DATE }, cookie)).status, 403);
  assert.equal((await call('PATCH', '/api/schedule/' + jobs[0].id, { notes: 'line 1 slow start' }, cookie)).status, 200);

  // Requisitions: view only. Collections: hidden. No sends, no exports, no users page.
  assert.equal((await call('GET', '/api/requisitions?date=' + DATE, undefined, cookie)).status, 200);
  assert.equal((await call('POST', '/api/requisitions/generate', { date: DATE }, cookie)).status, 403);
  assert.equal((await call('GET', '/api/collections/day?date=' + DATE, undefined, cookie)).status, 403);
  assert.equal((await call('GET', '/collections', undefined, cookie)).headers.get('location'), '/?denied=collections');
  assert.equal((await call('POST', '/api/exports/assemblies', { date: DATE }, cookie)).status, 403);
  assert.equal((await call('GET', '/api/users', undefined, cookie)).status, 403);
  assert.equal((await call('GET', '/users', undefined, cookie)).headers.get('location'), '/?denied=users');

  // The activity log says who did it.
  const log = (await call('GET', '/api/activity')).data;
  const mine = log.filter((l) => l.userName === 'Thandi Operator').map((l) => l.action);
  assert.ok(mine.includes('Updated a job'));
  assert.ok(mine.includes('Signed in'));
  assert.ok(!JSON.stringify(log).includes('thandi-pass-1'));
});

test('editing a role changes what its users can do straight away', async () => {
  const created = (await call('POST', '/api/users', { name: 'Sipho Store', email: 'Sipho@Example.com', roleId: await roleId('Warehouse team') })).data;
  const cookie = await firstSignIn('sipho@example.com', created.password, 'sipho-pass-1');
  assert.equal((await call('GET', '/api/collections/day?date=' + DATE, undefined, cookie)).status, 200);
  assert.equal((await call('POST', '/api/collections/sheets/RML/csv', { date: DATE }, cookie)).status, 403);

  const wid = await roleId('Warehouse team');
  const upd = await call('PATCH', '/api/roles/' + wid, {
    name: 'Warehouse team',
    areas: { schedule: 'view', requisitions: 'edit', collections: 'none' },
    actions: { unleashed: false, approve: false, manageUsers: false },
  });
  assert.equal(upd.status, 200);
  assert.equal((await call('GET', '/api/collections/day?date=' + DATE, undefined, cookie)).status, 403);

  // A role in use can't be deleted.
  assert.equal((await call('DELETE', '/api/roles/' + wid)).status, 409);
});

test('password reset and switching a user off sign them out', async () => {
  const created = (await call('POST', '/api/users', { name: 'Temp Person', email: 'temp@example.com', roleId: await roleId('Line operator') })).data;
  const cookie = await firstSignIn('temp@example.com', created.password, 'temp-pass-1');
  assert.equal((await call('GET', '/api/me', undefined, cookie)).status, 200);

  const { password } = (await call('POST', `/api/users/${created.user.id}/reset-password`)).data;
  assert.equal((await call('GET', '/api/me', undefined, cookie)).status, 401);
  const cookie2 = await firstSignIn('temp@example.com', password, 'temp-pass-2');

  await call('PATCH', '/api/users/' + created.user.id, { ...created.user, active: false });
  assert.equal((await call('GET', '/api/me', undefined, cookie2)).status, 401);
  assert.match((await signIn('temp@example.com', 'temp-pass-2')).location, /error=wrong/);
});

test('one email or cell per person; at least one is needed', async () => {
  const rid = await roleId('Line operator');
  assert.equal((await call('POST', '/api/users', { name: 'No Contact', roleId: rid })).status, 400);
  assert.equal((await call('POST', '/api/users', { name: 'Copy', email: 'SIPHO@example.com', roleId: rid })).status, 409);
  assert.equal((await call('POST', '/api/users', { name: 'Bad Cell', cell: '12345', roleId: rid })).status, 400);
});

test('shared login: only switched off from a personal admin login, and never leaving nobody in charge', async () => {
  // Not from the shared login itself.
  assert.equal((await call('PUT', '/api/settings/shared-login', { enabled: false })).status, 400);

  const admin = (await call('POST', '/api/users', { name: 'Paul Admin', email: 'paul@example.com', roleId: await roleId('Admin') })).data;
  const cookie = await firstSignIn('paul@example.com', admin.password, 'paul-pass-1');
  assert.equal((await call('GET', '/api/users', undefined, cookie)).status, 200);
  assert.equal((await call('PUT', '/api/settings/shared-login', { enabled: false }, cookie)).status, 200);

  // The shared login no longer works, by header or the login page.
  assert.equal((await call('GET', '/api/schedule')).status, 401);
  assert.match((await signIn('team', 'secret')).location, /error=shared-off/);

  // Can't switch off or demote the last admin while the shared login is off.
  assert.equal((await call('PATCH', '/api/users/' + admin.user.id, { ...admin.user, roleId: await roleId('Line operator', cookie) }, cookie)).status, 409);
  assert.equal((await call('PATCH', '/api/users/' + admin.user.id, { ...admin.user, active: false }, cookie)).status, 400);
  const adminRole = (await call('GET', '/api/roles', undefined, cookie)).data.find((r) => r.name === 'Admin');
  assert.equal((await call('PATCH', '/api/roles/' + adminRole.id, { ...adminRole, actions: { ...adminRole.actions, manageUsers: false } }, cookie)).status, 409);

  // Back on.
  assert.equal((await call('PUT', '/api/settings/shared-login', { enabled: true }, cookie)).status, 200);
  assert.equal((await call('GET', '/api/schedule')).status, 200);
});

test('"Sent by" goes in the Unleashed comments', async () => {
  const req = (await call('POST', '/api/requisitions', { date: DATE, line: 'PRD - LWH' })).data;
  await db.query(`INSERT INTO requisition_lines (requisition_id, sku, description, qty_used, position)
    VALUES ($1, 'BOTTLE', 'Bottle', 10, 1)`, [req.id]);
  await db.query(`UPDATE requisitions SET status = 'done' WHERE id = $1`, [req.id]);
  let sent;
  const client = { post: async (resource, payload) => { sent = payload; return { Guid: 'g', TransferOrderNumber: 'TX-1' }; } };
  await sendTransfer(db, client, req.id, { sentBy: 'Paul Admin' });
  assert.match(sent.Comments, /\[PH .+\] · Sent by Paul Admin$/);
});
