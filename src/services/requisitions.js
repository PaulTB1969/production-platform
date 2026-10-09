// Stock Requisition persistence. Generation is now a plain request — no
// queue — and completing a requisition is immediately reflected in the
// schedule's batch picker, because both read the same database.

import { requisitionFromRow, groupBy, UserError } from './rows.js';
import { listEntries } from './schedule.js';
import { recipeMap, balanceMap } from './stock.js';
import { buildRequisitions, requisitionIssues } from '../domain/requisitions.js';
import { LINES, requisitionId } from '../domain/lines.js';

const REQ_COLS = `id, to_char(date, 'YYYY-MM-DD') AS date, line, status, transfer_number,
  exported_at, generated_at, created_at, updated_at, unleashed_guid, send_started_at, send_error`;

export async function listRequisitions(q, { date, from, to, line } = {}) {
  const where = [];
  const params = [];
  if (date) { params.push(date); where.push(`date = $${params.length}`); }
  if (from) { params.push(from); where.push(`date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`date <= $${params.length}`); }
  if (line) { params.push(line); where.push(`line = $${params.length}`); }
  const rows = (await q.query(
    `SELECT ${REQ_COLS} FROM requisitions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, line`,
    params,
  )).rows;
  if (rows.length === 0) return [];
  const lines = groupBy((await q.query(
    `SELECT rl.*, g.group_name FROM requisition_lines rl LEFT JOIN product_groups g ON g.product_code = rl.sku
      WHERE rl.requisition_id = ANY($1) ORDER BY rl.position, rl.id`,
    [rows.map((r) => r.id)],
  )).rows, 'requisition_id');
  return rows.map((r) => requisitionFromRow(r, lines.get(r.id) || []));
}

export async function getRequisition(q, id) {
  const r = (await q.query(`SELECT ${REQ_COLS} FROM requisitions WHERE id = $1`, [id])).rows[0];
  if (!r) return null;
  const lines = (await q.query(`SELECT rl.*, g.group_name FROM requisition_lines rl LEFT JOIN product_groups g ON g.product_code = rl.sku
    WHERE rl.requisition_id = $1 ORDER BY rl.position, rl.id`, [id])).rows;
  return requisitionFromRow(r, lines);
}

async function writeLines(q, id, lines) {
  await q.query('DELETE FROM requisition_lines WHERE requisition_id = $1', [id]);
  for (const [i, l] of lines.entries()) {
    await q.query(
      `INSERT INTO requisition_lines (requisition_id, position, sku, description, batch_number, qty_used, needs_batch)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, i, l.sku, l.description || '', l.batchNumber || null, Number(l.qtyUsed) || 0, l.needsBatch !== false],
    );
  }
}

// Generates one requisition per line for `date` from still-scheduled jobs.
// Lines that already have one for the date are left alone.
export async function generateRequisitions(db, date) {
  return db.tx(async (q) => {
    const entries = await listEntries(q, { date });
    const recipes = await recipeMap(q);
    const balances = await balanceMap(q);
    const existing = await listRequisitions(q, { date });
    const result = buildRequisitions({
      date, entries, recipes, balances,
      existingLines: new Set(existing.map((r) => r.line)),
    });
    for (const req of result.requisitions) {
      await q.query(
        'INSERT INTO requisitions (id, date, line, generated_at) VALUES ($1, $2, $3, $4)',
        [req.id, req.date, req.line, req.generatedAt],
      );
      await writeLines(q, req.id, req.lines);
    }
    return {
      created: result.requisitions.map((r) => r.id),
      skipped: result.skipped,
      missingRecipes: result.missingRecipes,
    };
  });
}

// Hand-made requisition (rare — normally generated).
export async function createRequisition(db, { date, line }) {
  if (!LINES.includes(line)) throw new UserError(`Unknown line "${line}".`);
  const id = requisitionId(date, line);
  try {
    await db.query('INSERT INTO requisitions (id, date, line) VALUES ($1, $2, $3)', [id, date, line]);
  } catch (err) {
    if (err.code === '23505') throw new UserError('That line already has a requisition for this date.', 409);
    throw err;
  }
  return getRequisition(db, id);
}

// Updates lines and/or status.
//  - lines can only change while the requisition is open
//  - completing requires every batch-tracked line to have a batch
//  - an exported requisition can't be reopened: Unleashed already has it
export async function updateRequisition(db, id, { lines, status }) {
  return db.tx(async (q) => {
    const req = await getRequisition(q, id);
    if (!req) throw new UserError('Requisition not found.', 404);

    if (lines !== undefined) {
      if (req.status === 'done') throw new UserError('Reopen the requisition before changing it.', 409);
      if (!Array.isArray(lines)) throw new UserError('lines must be a list.');
      for (const l of lines) {
        if (!l.sku || !(Number(l.qtyUsed) >= 0)) throw new UserError('Every line needs a SKU and a quantity of zero or more.');
      }
      await writeLines(q, id, lines);
      req.lines = lines;
    }

    if (status !== undefined) {
      if (status !== null && status !== 'done') throw new UserError('Status must be "done" or null.');
      if (status === 'done') {
        const issues = requisitionIssues(req);
        if (issues.length) throw new UserError('Still need: ' + issues.join(', ') + '.', 409);
      }
      if (status === null && req.exportedAt) {
        throw new UserError(`Already exported to Unleashed as ${req.transferNumber} — it can't be reopened. Make a correcting transfer instead.`, 409);
      }
      await q.query('UPDATE requisitions SET status = $2 WHERE id = $1', [id, status]);
    }
    await q.query('UPDATE requisitions SET updated_at = now() WHERE id = $1', [id]);
    return getRequisition(q, id);
  });
}

export async function deleteRequisition(db, id) {
  const req = await getRequisition(db, id);
  if (!req) throw new UserError('Requisition not found.', 404);
  if (req.exportedAt) throw new UserError(`Already exported to Unleashed as ${req.transferNumber} — it can't be deleted.`, 409);
  await db.query('DELETE FROM requisitions WHERE id = $1', [id]);
}
