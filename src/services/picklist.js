// Requisition pick list: what each line's requisition asks for on a date,
// next to what Unleashed says is in the bulk store (PRD), with blank columns
// for checking against the stock actually on the floor — before batches are
// assigned or the requisition is completed in the app.
//
// One sheet per line, laid out to print on A4 landscape.

import ExcelJS from 'exceljs';
import { listRequisitions } from './requisitions.js';
import { listComponentBatches, bulkStockMap } from './stock.js';
import { LINE_LABELS, lineShortCode } from '../domain/lines.js';
import { requisitionName } from '../domain/requisitions.js';

const fmtQty = (n) => Number(n).toLocaleString('en-ZA', { maximumFractionDigits: 2 });
// Brand colours (mountainfalls.co.za): black on warm off-white.
const INK = 'FF000000';
const SOFT = 'FFF0ECE6';
const SHORT_FILL = 'FFF7E3DF';
const thin = { style: 'thin', color: { argb: 'FFD8D1C6' } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

// Totals per material (a material split over several batches has several
// rows) against the bulk store. Stock on hand comes from Unleashed
// /StockOnHand for every product; batch totals are the fallback for a
// batch-tracked material missing from it. null = not known.
function stockCheck(lines, bulk, onHand) {
  const need = new Map();
  for (const l of lines) need.set(l.sku, (need.get(l.sku) || 0) + (Number(l.qtyUsed) || 0));
  const out = new Map();
  for (const [sku, qty] of need) {
    const batches = bulk[sku]?.batches || [];
    const batchTotal = batches.length ? batches.reduce((s, b) => s + (b.quantityRemaining || 0), 0) : null;
    const inStore = onHand.has(sku) ? onHand.get(sku) : batchTotal;
    out.set(sku, { need: qty, inStore, batches });
  }
  return out;
}

// Sort key: groups alphabetically, materials without a group last.
const groupKey = (l) => (l.group ? '0' + l.group.toLowerCase() : '1');

// FEFO suggestion: batches in pick order, enough to cover the need.
function suggestBatches(batches, need) {
  const picks = [];
  let left = need;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, b.quantityRemaining || 0);
    picks.push(`${b.batchNumber} (${fmtQty(take)})`);
    left -= take;
  }
  return picks.join(', ');
}

function addLineSheet(wb, req, bulk, onHand, generatedAt) {
  const ws = wb.addWorksheet(lineShortCode(req.line), {
    pageSetup: {
      paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      printTitlesRow: '4:4',
    },
    headerFooter: { oddFooter: '&LPick list · ' + requisitionName(req) + '&RPage &P of &N' },
  });
  ws.columns = [
    { key: 'group', width: 26 }, { key: 'sku', width: 24 }, { key: 'desc', width: 38 }, { key: 'qty', width: 12 },
    { key: 'batch', width: 22 }, { key: 'store', width: 13 }, { key: 'suggest', width: 34 },
    { key: 'floor', width: 13 }, { key: 'picked', width: 18 }, { key: 'notes', width: 26 },
  ];

  ws.mergeCells('A1:J1');
  ws.getCell('A1').value = 'Pick list — ' + requisitionName(req);
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: INK } };
  ws.mergeCells('A2:J2');
  ws.getCell('A2').value =
    `From PRD (bulk store) to ${LINE_LABELS[req.line] || req.line} · ` +
    `Requisition ${req.status === 'done' ? 'COMPLETED' + (req.transferNumber ? ' (' + req.transferNumber + ')' : '') : 'OPEN'} · ` +
    `Printed ${generatedAt.toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' })} · ` +
    'Bulk store stock as of the last Unleashed sync';
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF5B665F' } };

  const header = ws.getRow(4);
  header.values = ['Product group', 'Raw material', 'Description', 'Qty to send', 'Batch (in app)', 'In bulk store',
    'Pick these batches first', '✓ Qty on floor', 'Batch picked', 'Notes'];
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
  header.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SOFT } };
    c.border = box;
  });

  const checks = stockCheck(req.lines, bulk, onHand);
  const shownSuggestion = new Set();
  let shortCount = 0;
  // By Unleashed product group (labels together, bottles together, …),
  // keeping the requisition's order within each group.
  const lines = req.lines
    .map((l, i) => ({ l, i }))
    .sort((a, b) => groupKey(a.l).localeCompare(groupKey(b.l)) || a.i - b.i)
    .map((x) => x.l);
  let lastGroup = null;
  for (const l of lines) {
    const tracked = l.needsBatch !== false;
    const c = checks.get(l.sku);
    const short = c.inStore !== null && c.inStore < c.need;
    // Suggest batches once per material, on its first row, when none assigned yet.
    let suggest = '';
    if (!shownSuggestion.has(l.sku)) {
      shownSuggestion.add(l.sku);
      if (!tracked) suggest = 'not batch-tracked';
      else if (c.batches.length === 0) suggest = 'no batches in PRD';
      else if (!req.lines.some((x) => x.sku === l.sku && x.batchNumber)) suggest = suggestBatches(c.batches, c.need);
      if (short) shortCount++;
    }
    const group = l.group || 'No product group';
    const row = ws.addRow({
      group: group === lastGroup ? '' : group,
      sku: l.sku,
      desc: l.description || '',
      qty: Number(l.qtyUsed) || 0,
      batch: tracked ? (l.batchNumber || '— not assigned —') : 'n/a',
      store: c.inStore === null ? 'unknown' : c.inStore,
      suggest: short ? `SHORT by ${fmtQty(c.need - c.inStore)}. ${suggest}` : suggest,
      floor: null, picked: null, notes: null, // filled in on the floor
    });
    if (group !== lastGroup) row.getCell('group').font = { bold: true };
    lastGroup = group;
    row.height = 24;
    row.alignment = { vertical: 'middle', wrapText: true };
    row.getCell('qty').numFmt = '#,##0.##';
    row.getCell('store').numFmt = '#,##0.##';
    row.eachCell({ includeEmpty: true }, (cell) => { cell.border = box; });
    if (short) {
      for (const k of ['store', 'suggest']) {
        row.getCell(k).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SHORT_FILL } };
        row.getCell(k).font = { bold: true, color: { argb: 'FFAD392E' } };
      }
    }
  }
  if (req.lines.length === 0) ws.addRow({ group: 'No raw materials on this requisition.' });

  ws.addRow([]);
  const note = ws.addRow({
    group: shortCount
      ? `${shortCount} material(s) may be short in the bulk store — check before sending.`
      : 'Bulk store holds enough of every material, as of the last Unleashed sync.',
  });
  ws.mergeCells(`A${note.number}:J${note.number}`);
  note.font = { italic: true, color: { argb: shortCount ? 'FFAD392E' : 'FF5B665F' } };
  ws.addRow([]);
  const sign = ws.addRow({ group: 'Checked by: ______________________', sku: '', desc: 'Date / time: ______________' });
  ws.mergeCells(`A${sign.number}:B${sign.number}`);
  sign.height = 28;
  sign.alignment = { vertical: 'bottom' };
  return ws;
}

// Throws nothing for an empty day — returns null so the route can say so.
export async function buildPickList(db, { date, line, group }) {
  let reqs = (await listRequisitions(db, { date, line })).sort((a, b) => (a.line < b.line ? -1 : 1));
  if (group !== undefined) {
    reqs = reqs.map((r) => ({ ...r, lines: r.lines.filter((l) => (l.group || '') === group) })).filter((r) => r.lines.length);
  }
  if (reqs.length === 0) return null;
  const bulk = await listComponentBatches(db);
  const onHand = await bulkStockMap(db);
  const generatedAt = new Date();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mountain Falls Production Hub';
  wb.created = generatedAt;
  for (const req of reqs) addLineSheet(wb, req, bulk, onHand, generatedAt);

  const suffix = line ? '-' + lineShortCode(line).toLowerCase() : '';
  return {
    filename: `pick-list-${date}${suffix}.xlsx`,
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  };
}
