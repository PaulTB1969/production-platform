// Unleashed CSV exports. Each export runs in one transaction: take the next
// MFB/MFR numbers (row-locked), stamp the jobs/requisitions as exported,
// and store the CSV. If the browser download fails, the same file is
// fetched again from /api/exports/:id — no new numbers, no duplicates in
// Unleashed. This replaces the artifacts' leased counter documents.

import { UserError } from './rows.js';
import { listEntries } from './schedule.js';
import { listRequisitions } from './requisitions.js';
import { recipeMap } from './stock.js';
import { pad8 } from '../domain/csv.js';
import { doneEntriesForExport, assemblyRow, assembliesCsv, wastageRow, wastageCsv } from '../domain/schedule.js';
import { transferRows, transferCsv } from '../domain/requisitions.js';

async function takeNumbers(q, name, count) {
  const { next } = (await q.query('SELECT next FROM counters WHERE name = $1 FOR UPDATE', [name])).rows[0];
  await q.query('UPDATE counters SET next = $2 WHERE name = $1', [name, Number(next) + count]);
  return Array.from({ length: count }, (_, i) => Number(next) + i);
}

async function saveExport(q, kind, date, filename, csv) {
  const { id } = (await q.query(
    'INSERT INTO exports (kind, date, filename, csv) VALUES ($1, $2, $3, $4) RETURNING id',
    [kind, date, filename, csv],
  )).rows[0];
  return { id: Number(id), kind, date, filename, csv };
}

// Done jobs for the date not yet exported, one row each, numbered MFB-########.
export async function exportAssemblies(db, date, { productionEmail }) {
  return db.tx(async (q) => {
    const all = doneEntriesForExport(await listEntries(q, { date }), date);
    if (all.length === 0) throw new UserError(`No completed jobs for ${date} yet — mark jobs complete before exporting.`);
    const todo = all.filter((e) => !e.exportedAt);
    if (todo.length === 0) throw new UserError(`All completed jobs for ${date} have already been exported — clear a job's exported flag first if it needs re-sending.`);

    const recipes = await recipeMap(q);
    const numbers = await takeNumbers(q, 'assembly', todo.length);
    const rows = todo.map((e, i) => assemblyRow(e, 'MFB-' + pad8(numbers[i]), { recipe: recipes.get(e.sku), productionEmail }));
    await q.query('UPDATE schedule_entries SET exported_at = now() WHERE id = ANY($1)', [todo.map((e) => e.id)]);
    return saveExport(q, 'assemblies', date, `batch-sheet-assemblies-${date}.csv`, assembliesCsv(rows));
  });
}

// Wastage report: every done job for the date (no numbering, repeatable).
export async function exportWastage(db, date, { productionEmail }) {
  return db.tx(async (q) => {
    const done = doneEntriesForExport(await listEntries(q, { date }), date);
    if (done.length === 0) throw new UserError(`No completed jobs for ${date} yet — mark jobs complete before exporting.`);
    const rows = done.map((e) => wastageRow(e, { productionEmail }));
    return saveExport(q, 'wastage', date, `batch-sheet-wastage-${date}.csv`, wastageCsv(rows));
  });
}

// Completed, unexported requisitions for the date — one Warehouse Transfer
// (MFR-########) each, PRD to the line.
export async function exportTransfers(db, date) {
  return db.tx(async (q) => {
    const reqs = (await listRequisitions(q, { date }))
      .filter((r) => r.status === 'done' && !r.exportedAt && r.lines.length > 0)
      .sort((a, b) => (a.line < b.line ? -1 : 1));
    if (reqs.length === 0) throw new UserError(`No completed, unexported requisitions for ${date} yet.`);

    const numbers = await takeNumbers(q, 'transfer', reqs.length);
    const rows = [];
    for (const [i, req] of reqs.entries()) {
      const number = 'MFR-' + pad8(numbers[i]);
      rows.push(...transferRows(req, number));
      await q.query('UPDATE requisitions SET transfer_number = $2, exported_at = now() WHERE id = $1', [req.id, number]);
    }
    return saveExport(q, 'transfer', date, `stock-requisition-transfer-${date}.csv`, transferCsv(rows));
  });
}

export async function getExport(db, id) {
  const r = (await db.query(
    `SELECT id, kind, to_char(date, 'YYYY-MM-DD') AS date, filename, csv, created_at FROM exports WHERE id = $1`,
    [id],
  )).rows[0];
  return r || null;
}

export async function listExports(db, { date } = {}) {
  const params = date ? [date] : [];
  return (await db.query(
    `SELECT id, kind, to_char(date, 'YYYY-MM-DD') AS date, filename, created_at FROM exports
      ${date ? 'WHERE date = $1' : ''} ORDER BY created_at DESC LIMIT 100`,
    params,
  )).rows;
}
