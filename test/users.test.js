// Users across sites, roles, production lines, data kept apart per site and
// per customer, platform support sessions, and "Sent by".

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signIn, firstSignIn, caller } from './helpers.js';
import { requiredFor, can, lineAllowed } from '../src/permissions.js';
import { normalizeCell, hashPassword, verifyPassword } from '../src/services/users.js';
import * as platform from '../src/services/platform.js';
import { sendTransfer } from '../src/services/unleashedSend.js';
import { createAdmin } from '../src/services/platform.js';

const DATE = '2026-10-01';
let app, api;

const roleId = async (name, cookie) => (await api('GET', '/api/roles', undefined, cookie)).data.find((r) => r.name === name).id;

before(async () => {
  app = await startApp();
  api = app.api;
});
after(() => app.close());

test('permission rules and sign-in IDs', async () => {
  assert.deepEqual(requiredFor('GET', '/schedule'), { area: 'schedule', level: 'view' });
  assert.deepEqual(requiredFor('POST', '/unleashed/send/transfers'), { area: 'requisitions', level: 'edit', action: 'unleashed' });
  assert.deepEqual(requiredFor('PUT', '/settings/support-access'), { action: 'manageUsers' });
  assert.ok(can({ areas: { schedule: 'edit' } }, 'schedule', 'view'));
  assert.ok(!lineAllowed({ lines: ['PRD - UWH'] }, 'PRD - AQB'));
  assert.equal(normalizeCell('+27 82 123 4567'), '0821234567');
  const h = await hashPassword('hello-there');
  assert.ok(await verifyPassword('hello-there', h) && !(await verifyPassword('nope', h)));
});

test('signed out: pages go to the login page, the API says 401', async () => {
  const call = caller(app.base);
  assert.equal((await call('GET', '/api/schedule')).status, 401);
  assert.match((await call('GET', '/schedule')).headers.get('location'), /^\/login\?next=/);
  assert.equal((await call('GET', '/healthz')).status, 200);
});

test('a line operator sees only their line, view-only requisitions, no Unleashed', async () => {
  await api('POST', '/api/schedule', { sku: 'P500', line: 'PRD - UWH', plannedCases: 10, date: DATE });
  const aqb = (await api('POST', '/api/schedule', { sku: 'P500', line: 'PRD - AQB', plannedCases: 4, date: DATE })).data;

  const created = await api('POST', '/api/users', {
    name: 'Thandi Operator', cell: '+27 82 555 0001', roleId: await roleId('Line operator'), lines: ['PRD - UWH'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.cell, '0825550001');
  assert.equal(created.data.user.roleName, 'Line operator');
  assert.match(created.data.password, /^[a-z2-9]{4}-[a-z2-9]{4}$/);

  assert.match((await signIn(app.base, '082 555 0001', 'nope')).location, /error=wrong/);
  const first = await signIn(app.base, '0825550001', created.data.password);
  assert.equal((await api('GET', '/api/schedule', undefined, first.cookie)).status, 403); // choose a password first
  const cookie = await firstSignIn(app.base, '0825550001', created.data.password, 'thandi-pass-1');
  const me = (await api('GET', '/api/me', undefined, cookie)).data;
  assert.equal(me.name, 'Thandi Operator');
  assert.equal(me.site.name, 'Test Site');
  assert.deepEqual(me.lines, ['PRD - UWH']);

  const jobs = (await api('GET', '/api/schedule?date=' + DATE, undefined, cookie)).data;
  assert.deepEqual([...new Set(jobs.map((j) => j.line))], ['PRD - UWH']);
  assert.equal((await api('PATCH', '/api/schedule/' + aqb.id, { notes: 'x' }, cookie)).status, 403);
  assert.equal((await api('PATCH', '/api/schedule/' + jobs[0].id, { notes: 'slow start' }, cookie)).status, 200);
  assert.equal((await api('POST', '/api/requisitions/generate', { date: DATE }, cookie)).status, 403);
  assert.equal((await api('GET', '/api/collections/day?date=' + DATE, undefined, cookie)).status, 403);
  assert.equal((await api('POST', '/api/exports/assemblies', { date: DATE }, cookie)).status, 403);
  assert.equal((await api('GET', '/api/users', undefined, cookie)).status, 403);
  assert.equal((await api('GET', '/users', undefined, cookie)).headers.get('location'), '/?denied=users');

  const log = (await api('GET', '/api/activity')).data;
  assert.ok(log.some((l) => l.userName === 'Thandi Operator' && l.action === 'Updated a job'));
  assert.ok(!JSON.stringify(log).includes('thandi-pass-1'));
});

test('roles: edits apply straight away; a role in use can’t be deleted; the last admin stays', async () => {
  const created = (await api('POST', '/api/users', { name: 'Sipho Store', email: 'Sipho@Example.com', roleId: await roleId('Warehouse team') })).data;
  const cookie = await firstSignIn(app.base, 'sipho@example.com', created.password, 'sipho-pass-1');
  assert.equal((await api('GET', '/api/collections/day?date=' + DATE, undefined, cookie)).status, 200);
  const wid = await roleId('Warehouse team');
  await api('PATCH', '/api/roles/' + wid, {
    name: 'Warehouse team', areas: { schedule: 'view', requisitions: 'edit', collections: 'none' }, actions: {},
  });
  assert.equal((await api('GET', '/api/collections/day?date=' + DATE, undefined, cookie)).status, 403);
  assert.equal((await api('DELETE', '/api/roles/' + wid)).status, 409);

  // The site's only admin can't lose the right to manage users.
  const me = (await api('GET', '/api/me')).data;
  assert.equal((await api('PATCH', '/api/users/' + me.id, { name: me.name, email: me.email, active: false })).status, 400);
  const admin = (await api('GET', '/api/users')).data.users.find((u) => u.id === me.id);
  assert.equal((await api('PATCH', '/api/users/' + me.id, { ...admin, roleId: wid })).status, 409);
  const adminRole = (await api('GET', '/api/roles')).data.find((r) => r.name === 'Admin');
  assert.equal((await api('PATCH', '/api/roles/' + adminRole.id, { ...adminRole, actions: { ...adminRole.actions, manageUsers: false } })).status, 409);
});

test('password reset and switching a user off sign them out', async () => {
  const created = (await api('POST', '/api/users', { name: 'Temp Person', email: 'temp@example.com', roleId: await roleId('Line operator') })).data;
  const cookie = await firstSignIn(app.base, 'temp@example.com', created.password, 'temp-pass-1');
  assert.equal((await api('GET', '/api/me', undefined, cookie)).status, 200);
  const { password } = (await api('POST', `/api/users/${created.user.id}/reset-password`)).data;
  assert.equal((await api('GET', '/api/me', undefined, cookie)).status, 401);
  const cookie2 = await firstSignIn(app.base, 'temp@example.com', password, 'temp-pass-2');
  await api('PATCH', '/api/users/' + created.user.id, { ...created.user, active: false });
  assert.equal((await api('GET', '/api/me', undefined, cookie2)).status, 401);
  assert.match((await signIn(app.base, 'temp@example.com', 'temp-pass-2')).location, /error=wrong/);
});

test('one sign-in ID per person; at least one is needed', async () => {
  const rid = await roleId('Line operator');
  assert.equal((await api('POST', '/api/users', { name: 'No Contact', roleId: rid })).status, 400);
  assert.equal((await api('POST', '/api/users', { name: 'Copy', email: 'SIPHO@example.com', roleId: rid })).status, 409);
  assert.equal((await api('POST', '/api/users', { name: 'Bad Cell', cell: '12345', roleId: rid })).status, 400);
});

test('two sites for one customer: data kept apart, one login works on both, switching sites', async () => {
  const site2 = await platform.createSite(app.db, { customerId: app.customer.id, name: 'Second Site', apiId: 'id2', apiKey: 'k2' }, { masterKey: app.masterKey });

  // The admin has no access to site 2 yet: can't switch to it.
  assert.equal((await api('POST', '/api/me/site', { siteId: site2.id })).status, 403);

  // Give the admin access to site 2 (as its Admin), directly in the platform tables.
  const me = (await api('GET', '/api/me')).data;
  const s2db = app.db.scoped('site_' + site2.id);
  const s2Admin = (await s2db.query(`SELECT id FROM roles WHERE name = 'Admin'`)).rows[0].id;
  await app.db.query('INSERT INTO site_access (user_id, site_id, role_id) VALUES ($1, $2, $3)', [me.id, site2.id, s2Admin]);
  const sites = (await api('GET', '/api/me')).data.sites.map((s) => s.name);
  assert.deepEqual(sites, ['Second Site', 'Test Site']);

  const switched = await api('POST', '/api/me/site', { siteId: site2.id });
  assert.equal(switched.status, 200);
  const siteCookie = app.cookie + '; ' + (switched.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await api('GET', '/api/me', undefined, siteCookie)).data.site.name, 'Second Site');
  // Site 2 has its own, empty schedule…
  assert.deepEqual((await api('GET', '/api/schedule?date=' + DATE, undefined, siteCookie)).data, []);
  await api('POST', '/api/schedule', { sku: 'ONLY_ON_2', line: 'PRD - LWH', plannedCases: 1, date: DATE }, siteCookie);
  // …and site 1 never sees site 2's jobs.
  const back = await api('POST', '/api/me/site', { siteId: app.site.id });
  const site1Cookie = app.cookie + '; ' + (back.headers.get('set-cookie') || '').split(';')[0];
  const site1Skus = (await api('GET', '/api/schedule?date=' + DATE, undefined, site1Cookie)).data.map((j) => j.sku);
  assert.ok(site1Skus.includes('P500') && !site1Skus.includes('ONLY_ON_2'));
  // The users page shows site 1 access, with site 2 listed as another site.
  const meRow = (await api('GET', '/api/users', undefined, site1Cookie)).data.users.find((u) => u.id === me.id);
  assert.deepEqual(meRow.otherSites, ['Second Site']);
  // Back to one site for the tests that follow.
  await app.db.query('DELETE FROM site_access WHERE user_id = $1 AND site_id = $2', [me.id, site2.id]);
});

test('another customer’s users can’t see this customer’s people or data', async () => {
  const other = await platform.createCustomer(app.db, { name: 'Other Co' });
  const otherSite = await platform.createSite(app.db, { customerId: other.id, name: 'Other Site', apiId: 'o', apiKey: 'o' }, { masterKey: app.masterKey });
  const odb = app.db.scoped('site_' + otherSite.id);
  const { createUser, listRoles } = await import('../src/services/users.js');
  const role = (await listRoles(odb, otherSite.id)).find((r) => r.name === 'Admin');
  const { password } = await createUser(app.db, odb, { customerId: other.id, siteId: otherSite.id }, { name: 'Olga', email: 'olga@other.example', roleId: role.id });
  const cookie = await firstSignIn(app.base, 'olga@other.example', password, 'olga-pass-1');
  assert.equal((await api('GET', '/api/me', undefined, cookie)).data.site.name, 'Other Site');
  assert.deepEqual((await api('GET', '/api/schedule?date=' + DATE, undefined, cookie)).data, []);
  const people = (await api('GET', '/api/users', undefined, cookie)).data.users.map((u) => u.name);
  assert.deepEqual(people, ['Olga']);
  // Can't switch into this customer's site, nor edit its users.
  assert.equal((await api('POST', '/api/me/site', { siteId: app.site.id }, cookie)).status, 403);
  const thandi = (await api('GET', '/api/users')).data.users.find((u) => u.name === 'Thandi Operator');
  assert.equal((await api('POST', `/api/users/${thandi.id}/reset-password`, undefined, cookie)).status, 404);
});

test('platform support: view-only by default, edit when chosen, logged, and the customer can switch it off', async () => {
  const { password } = await createAdmin(app.db, { name: 'Paul Beatham', email: 'paul@platform.example' });
  const call = caller(app.base);
  const login = await fetch(app.base + '/admin/login', {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'paul@platform.example', password }),
  });
  let adminCookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const pw = await call('POST', '/admin/api/me/password', { next: 'paul-admin-1' }, adminCookie);
  adminCookie = (pw.headers.get('set-cookie') || '').split(';')[0];

  // A reason is required.
  assert.equal((await call('POST', `/admin/api/sites/${app.site.id}/support`, { reason: '' }, adminCookie)).status, 400);
  const open = await call('POST', `/admin/api/sites/${app.site.id}/support`, { reason: 'Checking the sync' }, adminCookie);
  assert.equal(open.status, 200);
  const support = (open.headers.get('set-cookie') || '').split(';')[0];

  const me = (await api('GET', '/api/me', undefined, support)).data;
  assert.equal(me.name, 'Paul Beatham (support)');
  assert.equal(me.support.mode, 'view');
  assert.equal((await api('GET', '/api/schedule?date=' + DATE, undefined, support)).status, 200);
  const blocked = await api('POST', '/api/schedule', { sku: 'X', line: 'PRD - UWH', plannedCases: 1, date: DATE }, support);
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /view-only/);

  // Edit mode: changes allowed, and logged as support.
  const edit = await call('POST', `/admin/api/sites/${app.site.id}/support`, { reason: 'Fixing a job', mode: 'edit' }, adminCookie);
  const editCookie = (edit.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await api('POST', '/api/schedule', { sku: 'FIX', line: 'PRD - UWH', plannedCases: 1, date: DATE }, editCookie)).status, 201);
  const log = (await api('GET', '/api/activity')).data;
  assert.ok(log.some((l) => l.support && l.userName === 'Paul Beatham (support)' && l.action === 'Added a job'));

  // The customer sees the sessions, and switches support off — which ends them.
  const page = (await api('GET', '/api/users')).data;
  assert.deepEqual(page.supportSessions.map((s) => s.reason), ['Fixing a job', 'Checking the sync']);
  assert.equal((await api('PUT', '/api/settings/support-access', { allowed: false }, editCookie)).status, 403); // not by support
  assert.equal((await api('PUT', '/api/settings/support-access', { allowed: false })).status, 200);
  assert.equal((await api('GET', '/api/me', undefined, editCookie)).status, 401);
  assert.equal((await call('POST', `/admin/api/sites/${app.site.id}/support`, { reason: 'Again' }, adminCookie)).status, 403);
  await api('PUT', '/api/settings/support-access', { allowed: true });
});

test('"Sent by" goes in the Unleashed comments', async () => {
  const db = app.siteDb;
  const req = (await api('POST', '/api/requisitions', { date: DATE, line: 'PRD - LWH' })).data;
  await db.query(`INSERT INTO requisition_lines (requisition_id, sku, description, qty_used, position)
    VALUES ($1, 'BOTTLE', 'Bottle', 10, 1)`, [req.id]);
  await db.query(`UPDATE requisitions SET status = 'done' WHERE id = $1`, [req.id]);
  let sent;
  const client = { post: async (resource, payload) => { sent = payload; return { Guid: 'g', TransferOrderNumber: 'TX-1' }; } };
  await sendTransfer(db, client, req.id, { sentBy: 'Paul Admin' });
  assert.match(sent.Comments, /\[PH .+\] · Sent by Paul Admin$/);
});

test('uploading CSVs and generating requisitions are role actions (Admin and Production manager by default)', async () => {
  const roles = (await api('GET', '/api/roles')).data;
  const pm = roles.find((r) => r.name === 'Production manager');
  const wh = roles.find((r) => r.name === 'Warehouse team');
  assert.equal(pm.actions.uploadCsv, true);
  assert.equal(pm.actions.generateRequisitions, true);
  assert.equal(wh.actions.uploadCsv, false);
  assert.equal(wh.actions.generateRequisitions, false);

  await api('PATCH', '/api/roles/' + wh.id, { ...wh, areas: { ...wh.areas, requisitions: 'edit', collections: 'edit' } });
  const u = (await api('POST', '/api/users', { name: 'Store Person', email: 'store@example.com', roleId: wh.id })).data;
  const cookie = await firstSignIn(app.base, 'store@example.com', u.password, 'store-pass-1');
  const gen = await api('POST', '/api/requisitions/generate', { date: DATE }, cookie);
  assert.equal(gen.status, 403);
  assert.match(gen.data.error, /cannot generate requisitions/);
  const csv = ['Date,Destination,SKU,Quantity', '2026-10-20,CPT,P500,1', ''].join('\n');
  assert.equal((await api('POST', '/api/collections/upload', csv, cookie)).status, 403);
  await api('PATCH', '/api/roles/' + wh.id, { ...wh, areas: { ...wh.areas, requisitions: 'edit', collections: 'edit' }, actions: { ...wh.actions, generateRequisitions: true, uploadCsv: true } });
  assert.equal((await api('POST', '/api/requisitions/generate', { date: DATE }, cookie)).status, 200);
  assert.equal((await api('POST', '/api/collections/upload', csv, cookie)).status, 200);
});
