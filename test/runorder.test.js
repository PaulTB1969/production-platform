// Run order on the Production Schedule: file order on upload, drag to
// reorder, split batches stay together.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { applyScheduleRows, listEntries, createEntry, splitEntry, reorderEntries, updateEntry } from '../src/services/schedule.js';

const D = '2026-10-09';
let db;
beforeEach(async () => { db = await openDb({}); await migrate(db); });
afterEach(() => db.close());

const order = async (date = D) => (await listEntries(db, { date })).map((e) => `${e.sku}${e.seq > 1 ? '#' + e.seq : ''}`);
const row = (sku, line = 'PRD - UWH', date = D, plannedCases = 100) => ({ sku, line, date, plannedCases });

test('upload: jobs appear in the same order as the rows in the file', async () => {
  await applyScheduleRows(db, [row('C'), row('A', 'PRD - LWH'), row('B'), row('X', 'PRD - UWH', '2026-10-10')]);
  assert.deepEqual(await order(), ['C', 'A', 'B']);
  assert.deepEqual(await order('2026-10-10'), ['X']);
});

test('added by hand: goes to the end of its day', async () => {
  await applyScheduleRows(db, [row('A'), row('B')]);
  await createEntry(db, row('Z'));
  assert.deepEqual(await order(), ['A', 'B', 'Z']);
});

test('split batches stay together, in batch order', async () => {
  await applyScheduleRows(db, [row('A'), row('B'), row('C')]);
  const b = (await listEntries(db, { date: D })).find((e) => e.sku === 'B');
  const { created } = await splitEntry(db, b.id, 30);
  await splitEntry(db, created.id, 10);
  assert.deepEqual(await order(), ['A', 'B', 'B#2', 'B#3', 'C']);
});

test('drag: new order is saved; a split family moves as one block', async () => {
  await applyScheduleRows(db, [row('A'), row('B'), row('C')]);
  const all = await listEntries(db, { date: D });
  const id = (sku) => all.find((e) => e.sku === sku).id;
  await splitEntry(db, id('A'), 40);
  // Drag C to the top, then B: the A family follows as one.
  await reorderEntries(db, D, [id('C'), id('B'), id('A')]);
  assert.deepEqual(await order(), ['C', 'B', 'A', 'A#2']);
});

test('drag while filtered to one line: other lines keep their places', async () => {
  // UWH: A, C   LWH: B, D   (file order A, B, C, D)
  await applyScheduleRows(db, [row('A'), row('B', 'PRD - LWH'), row('C'), row('D', 'PRD - LWH')]);
  const all = await listEntries(db, { date: D });
  const id = (sku) => all.find((e) => e.sku === sku).id;
  // The screen sends the full day: UWH reversed, LWH jobs left in their slots.
  await reorderEntries(db, D, [id('C'), id('B'), id('A'), id('D')]);
  assert.deepEqual(await order(), ['C', 'B', 'A', 'D']);
});

test('re-upload: an updated job moves to its place in the new file; started jobs stay put', async () => {
  await applyScheduleRows(db, [row('A'), row('B'), row('C')]);
  const a = (await listEntries(db, { date: D })).find((e) => e.sku === 'A');
  await updateEntry(db, a.id, { actualCases: 5 }); // A has started
  await applyScheduleRows(db, [row('C', 'PRD - UWH', D, 120), row('B', 'PRD - UWH', D, 80)]);
  assert.deepEqual(await order(), ['A', 'C', 'B']);
});

test('moving a job to another date puts it at the end of that day', async () => {
  await applyScheduleRows(db, [row('A'), row('B', 'PRD - UWH', '2026-10-10'), row('C', 'PRD - UWH', '2026-10-10')]);
  const a = (await listEntries(db, { date: D })).find((e) => e.sku === 'A');
  await updateEntry(db, a.id, { date: '2026-10-10' });
  assert.deepEqual(await order('2026-10-10'), ['B', 'C', 'A']);
});

test('reorder refuses a job from another date', async () => {
  await applyScheduleRows(db, [row('A'), row('B', 'PRD - UWH', '2026-10-10')]);
  const b = (await listEntries(db, { date: '2026-10-10' }))[0];
  await assert.rejects(reorderEntries(db, D, [b.id]), /not on 2026-10-09 any more/);
});
