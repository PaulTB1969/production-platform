// Stock Requisition rules. The generation step was done by hand by Claude
// from the artifact's queue; it's written out here from the handover doc.
//
// Requisition: { id, date, line, status (null|'done'), transferNumber,
//                exportedAt, generatedAt,
//                lines: [{sku, description, batchNumber, qtyUsed, needsBatch}] }

import { csvField, csvTextGuard, csvDocument } from './csv.js';
import { BULK_STORE, LINES, LINE_LABELS, requisitionId } from './lines.js';
import { computeEntryStatus } from './schedule.js';

const round = (n) => Math.round(n * 1e6) / 1e6; // trims float noise from qty x cases

// Builds one requisition per line for `date` from the jobs still
// "scheduled" (nothing recorded yet). For each component: qtyPerUnit x
// plannedCases, summed over the line's jobs. Non-batch-tracked materials
// are netted against the balance already at the line (sent - used), and
// dropped if the line already holds enough.
//
//   entries        all schedule entries for the date
//   recipes        Map sku -> recipe
//   balances       Map `${line}|${sku}` -> current balance at the line
//   existingLines  Set of lines that already have a requisition for the
//                  date — left alone rather than overwritten.
//
// Returns { requisitions, skipped: [{line, reason}], missingRecipes: [sku] }
export function buildRequisitions({ date, entries, recipes, balances = new Map(), existingLines = new Set(), now = new Date() }) {
  const requisitions = [];
  const skipped = [];
  const missingRecipes = new Set();

  for (const line of LINES) {
    if (existingLines.has(line)) { skipped.push({ line, reason: 'already has a requisition for this date' }); continue; }

    const jobs = entries.filter((e) => e.date === date && e.line === line && computeEntryStatus(e) === 'scheduled');
    if (jobs.length === 0) { skipped.push({ line, reason: 'no scheduled jobs' }); continue; }

    const totals = new Map(); // componentSku -> {sku, description, qty, needsBatch}
    for (const job of jobs) {
      const recipe = recipes.get(job.sku);
      if (!recipe || !recipe.lines || recipe.lines.length === 0) { missingRecipes.add(job.sku); continue; }
      for (const rl of recipe.lines) {
        const qty = (rl.qtyPerUnit || 0) * (job.plannedCases || 0);
        const t = totals.get(rl.componentSku) || {
          sku: rl.componentSku,
          description: rl.componentDescription || '',
          qty: 0,
          needsBatch: rl.isBatchTracked !== false,
        };
        t.qty += qty;
        totals.set(rl.componentSku, t);
      }
    }

    const lines = [];
    for (const t of totals.values()) {
      let qty = round(t.qty);
      if (!t.needsBatch) {
        const onHand = Math.max(0, balances.get(`${line}|${t.sku}`) || 0);
        qty = round(Math.max(0, qty - onHand));
      }
      if (qty <= 0) continue;
      lines.push({ sku: t.sku, description: t.description, batchNumber: null, qtyUsed: qty, needsBatch: t.needsBatch });
    }
    lines.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

    if (lines.length === 0) { skipped.push({ line, reason: 'nothing to send — the line already holds enough' }); continue; }
    requisitions.push({
      id: requisitionId(date, line), date, line, status: null,
      transferNumber: null, exportedAt: null, generatedAt: now, lines,
    });
  }
  return { requisitions, skipped, missingRecipes: [...missingRecipes].sort() };
}

// Only batch-tracked lines need a batch; hand-added lines default to needing one.
export const lineNeedsBatch = (l) => l.needsBatch !== false;

export function requisitionIssues(req) {
  const lines = req.lines || [];
  if (lines.length === 0) return ['add at least one raw material'];
  if (lines.some((l) => lineNeedsBatch(l) && !l.batchNumber)) return ['assign a batch to every raw material that needs one'];
  return [];
}

// Drawing part of a requisition: picks = [{ index, qty }] (qty omitted = the
// whole line). Returns the lines drawn now and what stays for later; a line
// drawn in part leaves its remainder (same batch) behind. Throws on a bad pick.
export function splitDraw(lines, picks) {
  const byIdx = new Map();
  for (const p of picks || []) {
    const i = Number(p.index);
    const line = lines[i];
    if (!Number.isInteger(i) || !line) throw new Error('That raw material is no longer on the requisition — reload the page.');
    if (byIdx.has(i)) throw new Error(`${line.sku} is selected twice.`);
    const full = Number(line.qtyUsed) || 0;
    const qty = p.qty === undefined || p.qty === null || p.qty === '' ? full : Number(p.qty);
    if (!(qty > 0)) throw new Error(`Enter how much of ${line.sku} is drawn now.`);
    if (qty > full + 1e-9) throw new Error(`Only ${full} of ${line.sku} is on the requisition — ${qty} can't be drawn.`);
    byIdx.set(i, qty);
  }
  const drawn = [];
  const remaining = [];
  lines.forEach((l, i) => {
    if (!byIdx.has(i)) { remaining.push({ ...l }); return; }
    const take = byIdx.get(i);
    drawn.push({ ...l, qtyUsed: take });
    const left = Math.round(((Number(l.qtyUsed) || 0) - take) * 1e6) / 1e6;
    if (left > 0) remaining.push({ ...l, qtyUsed: left });
  });
  return { drawn, remaining };
}

// Assigns a batch to line `idx`. With qty below the line's full quantity,
// splits that amount off onto the batch (merging into an existing line for
// the same sku + batch), so one material can be spread over several batches.
export function allocateBatch(lines, idx, batchNumber, qty) {
  const out = lines.map((l) => ({ ...l }));
  const line = out[idx];
  if (!line || !batchNumber) return out;
  const full = line.qtyUsed || 0;
  const amt = qty === null || qty === undefined || isNaN(qty) || qty <= 0 ? full : Math.min(qty, full);
  if (amt >= full) {
    line.batchNumber = batchNumber;
    return out;
  }
  line.qtyUsed = full - amt;
  const existing = out.find((l, i) => i !== idx && l.sku === line.sku && l.batchNumber === batchNumber);
  if (existing) existing.qtyUsed = (existing.qtyUsed || 0) + amt;
  else out.push({ sku: line.sku, description: line.description, batchNumber, qtyUsed: amt, needsBatch: true });
  return out;
}

// ---------- export ----------

export const TRANSFER_CSV_HEADERS = [
  '*Transfer Number', '*Source Warehouse Code', '*Destination Warehouse Code',
  'Comments', '*Product Code', '*Transfer Quantity', 'Line Comments',
];

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr || '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

// Shown on screen and sent as the transfer Comments, e.g.
// "PRD - UWH — Upper Warehouse — 1 Oct 2026".
export function requisitionName(req) {
  return (LINE_LABELS[req.line] || req.line || '') + ' — ' + fmtDateLabel(req.date) + (req.seq > 1 ? ` (${req.seq})` : '');
}

export function transferRows(req, transferNumber) {
  const comments = requisitionName(req);
  return (req.lines || []).map((l) => [
    csvField(transferNumber),
    csvField(BULK_STORE),
    csvField(req.line),
    csvField(comments),
    csvField(l.sku),
    csvField(l.qtyUsed),
    csvTextGuard(l.batchNumber || ''),
  ]);
}

export function transferCsv(rows) { return csvDocument(TRANSFER_CSV_HEADERS, rows); }
