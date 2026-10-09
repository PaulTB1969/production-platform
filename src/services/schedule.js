// Production Schedule persistence. Business rules live in domain/schedule.js;
// this file loads, validates and saves.

import { entryFromRow, groupBy, UserError } from './rows.js';
import { getRecipe } from './stock.js';
import { computeEntryStatus, syncNonBatchTrackedUsage, newEntryId } from '../domain/schedule.js';
import { SCHEDULE_LINES } from '../domain/lines.js';
import { parseFlexibleDate } from '../domain/csv.js';

const ENTRY_COLS = `id, sku, line, to_char(date, 'YYYY-MM-DD') AS date, planned_cases, actual_cases,
  wastage_cases, status, group_id, seq, start_time, end_time, notes, exported_at, created_at, updated_at,
  unleashed_guid, unleashed_number, send_started_at, send_error, tracking_error, run_order`;

export async function listEntries(q, { date, from, to, line } = {}) {
  const where = [];
  const params = [];
  if (date) { params.push(date); where.push(`date = $${params.length}`); }
  if (from) { params.push(from); where.push(`date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`date <= $${params.length}`); }
  if (line) { params.push(line); where.push(`line = $${params.length}`); }
  const rows = (await q.query(
    `SELECT ${ENTRY_COLS} FROM schedule_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY date DESC, run_order NULLS LAST, seq, created_at`,
    params,
  )).rows;
  if (rows.length === 0) return [];
  const usage = groupBy((await q.query(
    'SELECT * FROM component_usage WHERE entry_id = ANY($1) ORDER BY id',
    [rows.map((r) => r.id)],
  )).rows, 'entry_id');
  return rows.map((r) => entryFromRow(r, usage.get(r.id) || []));
}

export async function getEntry(q, id) {
  const r = (await q.query(`SELECT ${ENTRY_COLS} FROM schedule_entries WHERE id = $1`, [id])).rows[0];
  if (!r) return null;
  const usage = (await q.query('SELECT * FROM component_usage WHERE entry_id = $1 ORDER BY id', [id])).rows;
  return entryFromRow(r, usage);
}

function checkJobFields({ sku, line, plannedCases, date }) {
  if (sku !== undefined && !String(sku).trim()) throw new UserError('Product code is required.');
  if (line !== undefined && !SCHEDULE_LINES.includes(line)) throw new UserError(`Unknown line "${line}".`);
  if (plannedCases !== undefined && !(Number(plannedCases) > 0)) throw new UserError('Cases must be more than zero.');
  if (date !== undefined && !parseFlexibleDate(String(date))) throw new UserError('Date must be YYYY-MM-DD.');
}

async function insertEntry(q, e) {
  await q.query(
    `INSERT INTO schedule_entries (id, sku, line, date, planned_cases, group_id, seq, run_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.id, e.sku, e.line, e.date, e.plannedCases, e.groupId, e.seq, e.runOrder ?? null],
  );
}

// Next free run_order on a date: new jobs go to the end of the day.
async function nextRunOrder(q, date) {
  const { m } = (await q.query('SELECT MAX(run_order) AS m FROM schedule_entries WHERE date = $1', [date])).rows[0];
  return (m || 0) + 1;
}

export async function createEntry(db, { sku, line, plannedCases, date }) {
  checkJobFields({ sku, line, plannedCases, date });
  const id = newEntryId();
  await db.tx(async (q) => insertEntry(q, {
    id, sku: String(sku).trim(), line, date, plannedCases: Number(plannedCases), groupId: id, seq: 1,
    runOrder: await nextRunOrder(q, date),
  }));
  return getEntry(db, id);
}

async function writeUsage(q, id, usage) {
  await q.query('DELETE FROM component_usage WHERE entry_id = $1', [id]);
  for (const u of usage) {
    await q.query(
      `INSERT INTO component_usage (entry_id, component_sku, batch_number, qty_used, wastage)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, u.componentSku, u.batchNumber || null, Number(u.qtyUsed) || 0, Number(u.wastage) || 0],
    );
  }
}

const EDITABLE = {
  sku: 'sku', line: 'line', plannedCases: 'planned_cases', date: 'date',
  actualCases: 'actual_cases', wastageCases: 'wastage_cases', status: 'status',
  startTime: 'start_time', endTime: 'end_time', notes: 'notes', exportedAt: 'exported_at',
};
// Locked once anything is recorded against the job, to keep them matched to
// what was produced (same as the artifact, now enforced server-side).
const SCHEDULE_FIELDS = ['sku', 'line', 'plannedCases', 'date'];

// Partial update. componentUsage, when given, replaces the job's usage.
// Non-batch-tracked usage is recomputed from actualCases on every save.
export async function updateEntry(db, id, patch) {
  return db.tx(async (q) => {
    const entry = await getEntry(q, id);
    if (!entry) throw new UserError('Job not found.', 404);

    const touchesSchedule = SCHEDULE_FIELDS.some((f) => f in patch && patch[f] !== entry[f]);
    if (touchesSchedule && computeEntryStatus(entry) !== 'scheduled') {
      throw new UserError('Product, line, cases and date can only be changed before production is recorded.', 409);
    }
    checkJobFields(patch);
    if ('status' in patch && patch.status !== null && patch.status !== 'done') throw new UserError('Status must be "done" or null.');
    if ('exportedAt' in patch && patch.exportedAt !== null) throw new UserError('exportedAt can only be cleared.');
    if ('exportedAt' in patch && entry.unleashedGuid) {
      throw new UserError(`Sent to Unleashed as ${entry.unleashedNumber || 'an assembly'} — delete it there first; clearing the flag here would send it twice.`, 409);
    }

    const next = { ...entry, ...Object.fromEntries(Object.keys(EDITABLE).filter((k) => k in patch).map((k) => [k, patch[k]])) };
    if (next.status === 'done' && !next.startTime) {
      throw new UserError(`No start time for ${entry.sku} — press Start (or enter the start time) before completing.`, 409);
    }
    if (patch.componentUsage) next.componentUsage = patch.componentUsage;
    const recipe = await getRecipe(q, next.sku);
    next.componentUsage = syncNonBatchTrackedUsage(next, recipe);

    const sets = [];
    const params = [id];
    for (const [k, col] of Object.entries(EDITABLE)) {
      if (!(k in patch)) continue;
      params.push(k === 'sku' ? String(patch[k]).trim() : patch[k] === '' ? null : patch[k]);
      sets.push(`${col} = $${params.length}`);
    }
    if ('date' in patch && patch.date !== entry.date) {
      params.push(await nextRunOrder(q, patch.date));
      sets.push(`run_order = $${params.length}`);
    }
    sets.push('updated_at = now()');
    await q.query(`UPDATE schedule_entries SET ${sets.join(', ')} WHERE id = $1`, params);
    await writeUsage(q, id, next.componentUsage);
    return getEntry(q, id);
  });
}

// "Split into new batch": moves `moveQty` planned cases onto a new sibling
// job (same group, next seq) — for a bottle/cap batch change mid-run.
export async function splitEntry(db, id, moveQty) {
  return db.tx(async (q) => {
    const src = await getEntry(q, id);
    if (!src) throw new UserError('Job not found.', 404);
    const qty = Number(moveQty);
    if (!(qty > 0)) throw new UserError('Enter how many cases move to the new batch first.');
    if (qty >= src.plannedCases) throw new UserError(`That's the whole job — enter fewer than the ${src.plannedCases} cases currently scheduled.`);
    const maxSeq = (await q.query('SELECT MAX(seq) AS m FROM schedule_entries WHERE group_id = $1', [src.groupId])).rows[0].m || 1;
    const newId = newEntryId();
    await insertEntry(q, {
      id: newId, sku: src.sku, line: src.line, date: src.date, plannedCases: qty,
      groupId: src.groupId, seq: maxSeq + 1, runOrder: src.runOrder,
    });
    await q.query('UPDATE schedule_entries SET planned_cases = planned_cases - $2, updated_at = now() WHERE id = $1', [id, qty]);
    return { source: await getEntry(q, id), created: await getEntry(q, newId) };
  });
}

export async function deleteEntry(db, id) {
  const r = await db.query('DELETE FROM schedule_entries WHERE id = $1', [id]);
  if (!r.affectedRows && !r.rowCount) throw new UserError('Job not found.', 404);
}

// Schedule upload: a row updates an existing job with the same sku + line +
// date only while that job is still scheduled; otherwise it becomes a new job.
// Run order follows the order of rows in the file: each date's rows go after
// the jobs already on that date, in file order (an updated job moves to its
// place in the file, taking its split family with it).
export async function applyScheduleRows(db, rows) {
  return db.tx(async (q) => {
    let created = 0, updated = 0;
    const next = new Map(); // date -> next run_order for this upload
    for (const row of rows) {
      if (!next.has(row.date)) next.set(row.date, await nextRunOrder(q, row.date));
      const runOrder = next.get(row.date);
      next.set(row.date, runOrder + 1);

      const candidates = await listEntriesForMatch(q, row);
      const match = candidates.find((e) => computeEntryStatus(e) === 'scheduled');
      if (match) {
        await q.query('UPDATE schedule_entries SET planned_cases = $2, updated_at = now() WHERE id = $1', [match.id, row.plannedCases]);
        await q.query('UPDATE schedule_entries SET run_order = $2 WHERE group_id = $1 AND date = $3', [match.groupId, runOrder, row.date]);
        updated++;
      } else {
        const id = newEntryId();
        await insertEntry(q, { ...row, id, groupId: id, seq: 1, runOrder });
        created++;
      }
    }
    return { created, updated };
  });
}

// Drag-to-reorder: `ids` lists the date's jobs in the new order (any job of
// a split family stands for the whole family). Families are numbered 1, 2,
// 3… in that order; jobs of the date not in the list keep their relative
// order after them. Returns the date's jobs in the new order.
export async function reorderEntries(db, date, ids) {
  if (!parseFlexibleDate(String(date || ''))) throw new UserError('Pick a production date first.');
  if (!Array.isArray(ids) || ids.length === 0) throw new UserError('Nothing to reorder.');
  return db.tx(async (q) => {
    const current = await listEntries(q, { date });
    const byId = new Map(current.map((e) => [e.id, e]));
    for (const id of ids) {
      if (!byId.has(id)) throw new UserError('That job is not on ' + date + ' any more — reload the page.', 409);
    }
    const families = [];
    for (const id of [...ids, ...current.map((e) => e.id)]) {
      const g = byId.get(id).groupId;
      if (!families.includes(g)) families.push(g);
    }
    for (const [i, g] of families.entries()) {
      await q.query('UPDATE schedule_entries SET run_order = $3 WHERE group_id = $1 AND date = $2', [g, date, i + 1]);
    }
    return listEntries(q, { date });
  });
}

async function listEntriesForMatch(q, { sku, line, date }) {
  const rows = (await q.query(
    `SELECT ${ENTRY_COLS} FROM schedule_entries WHERE sku = $1 AND line = $2 AND date = $3 ORDER BY created_at`,
    [sku, line, date],
  )).rows;
  const out = [];
  for (const r of rows) {
    const usage = (await q.query('SELECT * FROM component_usage WHERE entry_id = $1', [r.id])).rows;
    out.push(entryFromRow(r, usage));
  }
  return out;
}
