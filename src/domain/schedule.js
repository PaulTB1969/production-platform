// Production Schedule rules, ported from the artifact. Pure functions over
// plain objects so they can be tested without a database.
//
// Entry: { id, sku, line, date, plannedCases, actualCases, wastageCases,
//          status (null|'done'), groupId, seq, startTime, endTime, notes,
//          exportedAt, componentUsage: [{componentSku, batchNumber, qtyUsed, wastage}] }
// Recipe: { sku, expectedDuration, lines: [{componentSku, componentDescription,
//           qtyPerUnit, wastageQty, isBatchTracked}] }

import { csvField, csvTextGuard, csvDocument, parseCsv, parseFlexibleDate, addDaysISO } from './csv.js';
import { lineShortCode, assemblySourceWarehouse, normalizeWarehouse, BULK_STORE } from './lines.js';

const hasValue = (v) => v !== null && v !== undefined && v !== '';

// 'done' is stored; 'in_progress' and 'scheduled' are derived from whether
// anything has been recorded against the job yet.
export function computeEntryStatus(entry) {
  if (entry.status === 'done') return 'done';
  // Started (Start pressed / cases entered) or anything recorded = in progress.
  if (hasValue(entry.startTime) || (entry.componentUsage || []).length > 0 || hasValue(entry.actualCases)) return 'in_progress';
  return 'scheduled';
}

// Keeps every non-batch-tracked component's qtyUsed equal to what the recipe
// needs for the cases actually produced. Applied on every save. Creates no
// usage row until actualCases is entered — doing so earlier would flip a
// still-scheduled job to in progress.
export function syncNonBatchTrackedUsage(entry, recipe) {
  const usage = (entry.componentUsage || []).map((u) => ({ ...u }));
  if (!recipe || !recipe.lines || !hasValue(entry.actualCases)) return usage;
  for (const line of recipe.lines) {
    if (line.isBatchTracked) continue;
    const required = (line.qtyPerUnit || 0) * (entry.actualCases || 0);
    const u = usage.find((x) => x.componentSku === line.componentSku && !x.batchNumber);
    if (u) u.qtyUsed = required;
    else usage.push({ componentSku: line.componentSku, batchNumber: null, qtyUsed: required, wastage: 0 });
  }
  return usage;
}

// Adding the same batch twice sums onto the existing usage line.
export function addUsage(usage, { componentSku, batchNumber, qtyUsed = 0, wastage = 0 }) {
  const out = (usage || []).map((u) => ({ ...u }));
  const existing = out.find((u) => u.componentSku === componentSku && u.batchNumber === batchNumber);
  if (existing) {
    existing.qtyUsed = (existing.qtyUsed || 0) + qtyUsed;
    existing.wastage = (existing.wastage || 0) + wastage;
  } else {
    out.push({ componentSku, batchNumber, qtyUsed, wastage });
  }
  return out;
}

// ---------- exports ----------

export const ASSEMBLY_CSV_HEADERS = [
  '*Assembly Number', '*Product Code', '*Source Warehouse Code',
  '*Destination Warehouse Code', '*Assembly Status', 'Assembled Quantity', 'Assemble By',
  'Comments', 'Serial Number', 'Batch Number', 'Batch Quantity', 'Batch Expiry Date',
  'Expected Duration', 'Actual Duration', 'Duration Comments', 'Production Person Email',
];

export const WASTAGE_CSV_HEADERS = [
  'Date', 'Product Code', 'Source Warehouse Code', 'Batch Number',
  'Case Wastage', 'Component Wastage', 'Notes', 'Production Person Email',
];

export function actualDurationHours(entry) {
  if (!entry.startTime || !entry.endTime) return '';
  const toMin = (t) => { const [h, m] = t.split(':'); return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0); };
  let diff = toMin(entry.endTime) - toMin(entry.startTime);
  if (diff < 0) diff += 24 * 60; // ran past midnight
  return (diff / 60).toFixed(2);
}

// Finished-goods batch number, e.g. "20260916 UWH 1", text-guarded.
export function batchNumberCell(entry) {
  return csvTextGuard(String(entry.date || '').replace(/-/g, '') + ' ' + lineShortCode(entry.line) + ' ' + (entry.seq || 1));
}

// No thousands separator: the artifact used the browser locale, which could
// put a comma inside the cell.
const fmtQty = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });

export function assemblyRow(entry, assemblyNumber, { recipe, productionEmail }) {
  const actual = hasValue(entry.actualCases) ? entry.actualCases : '';
  const comments = (entry.componentUsage || []).map((u) => u.batchNumber).filter(Boolean).join('; ');
  return [
    csvField(assemblyNumber),
    csvField(entry.sku || ''),
    csvField(assemblySourceWarehouse(entry.line)),
    csvField(BULK_STORE),
    csvField('Parked'),
    csvField(actual),
    csvField(entry.date || ''),
    csvField(comments),
    csvField(''),
    batchNumberCell(entry),
    csvField(actual),
    csvField(entry.date ? addDaysISO(entry.date, 365) : ''),
    csvField(recipe && recipe.expectedDuration ? recipe.expectedDuration : ''),
    csvField(actualDurationHours(entry)),
    csvField(entry.notes || ''),
    csvField(productionEmail),
  ];
}

export function wastageRow(entry, { productionEmail }) {
  const componentWastage = (entry.componentUsage || [])
    .filter((u) => u.wastage)
    .map((u) => u.componentSku + ': ' + fmtQty(u.wastage))
    .join('; ');
  return [
    csvField(entry.date || ''),
    csvField(entry.sku || ''),
    csvField(assemblySourceWarehouse(entry.line)),
    batchNumberCell(entry),
    csvField(hasValue(entry.wastageCases) ? entry.wastageCases : 0),
    csvField(componentWastage),
    csvField(entry.notes || ''),
    csvField(productionEmail),
  ];
}

// Done jobs for a date, in export order: by SKU, then batch sequence.
export function doneEntriesForExport(entries, date) {
  return entries
    .filter((e) => e.date === date && computeEntryStatus(e) === 'done')
    .sort((a, b) => (a.sku !== b.sku ? (a.sku < b.sku ? -1 : 1) : (a.seq || 1) - (b.seq || 1)));
}

export function assembliesCsv(rows) { return csvDocument(ASSEMBLY_CSV_HEADERS, rows); }
export function wastageCsv(rows) { return csvDocument(WASTAGE_CSV_HEADERS, rows); }

// ---------- schedule upload ----------

// Parses and validates a schedule CSV (SKU, Warehouse, Quantity, Date).
// Any bad row rejects the whole file: a partial import is how a silent date
// misread turns into a wrong production run.
export function parseScheduleCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { rows: [], errors: ['The file is empty.'] };

  const header = rows[0].map((h) => (h || '').trim().toLowerCase());
  const idx = { sku: header.indexOf('sku'), wh: header.indexOf('warehouse'), qty: header.indexOf('quantity'), date: header.indexOf('date') };
  if (Object.values(idx).some((i) => i === -1)) {
    return { rows: [], errors: ['Header row must have columns: SKU, Warehouse, Quantity, Date.'] };
  }

  const errors = [];
  const parsed = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const rowNum = r + 1; // matches what a spreadsheet shows
    const sku = (cells[idx.sku] || '').trim();
    const warehouseRaw = (cells[idx.wh] || '').trim();
    const line = normalizeWarehouse(warehouseRaw);
    const qtyRaw = (cells[idx.qty] || '').trim();
    const dateRaw = (cells[idx.date] || '').trim();

    if (!sku) { errors.push(`Row ${rowNum}: missing SKU.`); continue; }
    if (line === null) {
      errors.push(`Row ${rowNum}: "${warehouseRaw}" isn't a production line — use PRD - UWH, PRD - LWH, PRD - AQB, or Other (this looks like it might be a stock collection file, not a schedule).`);
      continue;
    }
    const qty = parseFloat(qtyRaw);
    if (!qtyRaw || isNaN(qty) || qty <= 0) { errors.push(`Row ${rowNum}: quantity must be a positive number.`); continue; }
    const date = parseFlexibleDate(dateRaw);
    if (!date) { errors.push(`Row ${rowNum}: date must be YYYY-MM-DD or YYYY/MM/DD (got "${dateRaw}").`); continue; }
    parsed.push({ sku, line, plannedCases: qty, date });
  }
  if (parsed.length === 0 && errors.length === 0) errors.push('No data rows found.');
  return { rows: parsed, errors };
}

export const SCHEDULE_TEMPLATE_CSV = 'SKU,Warehouse,Quantity,Date\r\nP500ST_MFSIG_PN,PRD - UWH,120,2026-09-22\r\n';

export function newEntryId() {
  return 'entry_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
