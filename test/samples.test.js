// Sample Retention forms: rows from the schedule, fill in, sign, sign off, locks.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';
import { activityDetail } from '../src/permissions.js';

const DATE = '2026-10-06';
const SIG = 'data:image/png;base64,' + 'A'.repeat(400);
let app, db, base;

async function api(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Cookie: app.cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* */ }
  return { status: res.status, data };
}

before(async () => {
  app = await startApp();
  db = app.siteDb;
  base = app.base;
  for (const [sku, line] of [['GN750ST_MF', 'PRD - UWH'], ['P500ST_MF', 'PRD - UWH'], ['GN750ST_MF', 'PRD - UWH'],
    ['P330ST_MFSIG_PN', 'PRD - LWH'], ['B20.0_BIB_TAP_BLUE', 'PRD - AQB']]) {
    await api('POST', '/api/schedule', { sku, line, plannedCases: 10, date: DATE });
  }
});

after(async () => {
  await app.close();
});

test('forms list the day\'s products per line, LWH with an AcquaBox section', async () => {
  const day = (await api('GET', '/api/samples/day?date=' + DATE)).data;
  const uwh = day.find((f) => f.form === 'UWH');
  const lwh = day.find((f) => f.form === 'LWH');
  assert.deepEqual(uwh.sections[0].rows.map((r) => r.sku), ['GN750ST_MF', 'P500ST_MF']); // split batch listed once
  assert.deepEqual(lwh.sections.map((s) => [s.heading, s.rows.map((r) => r.sku)]),
    [['LWH - Samples', ['P330ST_MFSIG_PN']], ['AcquaBox', ['B20.0_BIB_TAP_BLUE']]]);
  assert.equal(uwh.status, 'new');
});

test('fill in, sign (locks results), sign off (locks the form)', async () => {
  const base = `/api/samples/${DATE}/UWH`;
  assert.equal((await api('PUT', base + '/results/GN750ST_MF', { test: 'Y', time: '9:5', pass: 'Y' })).status, 400);
  assert.equal((await api('PUT', base + '/results/GN750ST_MF', { test: 'Y', time: '09:05', pass: 'Y' })).status, 200);

  // Every product needs Test; a tested one needs Time and Pass.
  let r = await api('POST', base + '/sign', { name: 'Thandi', signature: SIG });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /P500ST_MF/);
  await api('PUT', base + '/results/P500ST_MF', { test: 'N' });
  assert.equal((await api('POST', base + '/sign', { name: 'Thandi', signature: 'nope' })).status, 400);
  r = await api('POST', base + '/sign', { name: 'Thandi', signature: SIG, signedDate: DATE });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'signed');
  assert.equal(r.data.takenBy.name, 'Thandi');
  assert.equal(r.data.takenBy.date, DATE);

  assert.equal((await api('PUT', base + '/results/P500ST_MF', { test: 'Y' })).status, 409);

  r = await api('POST', base + '/signoff', { name: 'Paul', signature: SIG });
  assert.equal(r.data.status, 'signed_off');
  assert.equal((await api('DELETE', base + '/sign')).status, 409);

  // Remove the sign-off, undo the signature, and it can be changed again.
  await api('DELETE', base + '/signoff');
  await api('DELETE', base + '/sign');
  assert.equal((await api('PUT', base + '/results/P500ST_MF', { test: 'Y', time: '10:00', pass: 'Y' })).status, 200);
});

test('no management sign-off before the samples are signed for', async () => {
  assert.equal((await api('POST', `/api/samples/${DATE}/LWH/signoff`, { name: 'Paul', signature: SIG })).status, 409);
});

test('signatures are not copied into the activity log', () => {
  assert.deepEqual(activityDetail('/samples/x/UWH/sign', { name: 'A', signature: SIG }), { path: '/samples/x/UWH/sign', name: 'A' });
});
