// "Download as Excel": a read-only copy of the database for reporting.
// The database stays the live source — nothing is ever read back from this.
// Batch numbers are written as text cells, so Excel can't turn one that
// looks like a date into a date.

import ExcelJS from 'exceljs';
import { listEntries } from './schedule.js';
import { listRequisitions } from './requisitions.js';
import { listBalances } from './stock.js';
import { computeEntryStatus, actualDurationHours } from '../domain/schedule.js';
import { lineShortCode, LINE_LABELS } from '../domain/lines.js';
import { requisitionName } from '../domain/requisitions.js';

const STATUS_LABEL = { scheduled: 'Scheduled', in_progress: 'In progress', done: 'Done' };

// 'YYYY-MM-DD' -> a real Excel date (UTC midnight, so it never shifts a day).
const xlDate = (s) => (s ? new Date(s + 'T00:00:00Z') : null);
const xlTime = (v) => (v ? new Date(v) : null);
const fgBatchNumber = (e) => String(e.date).replace(/-/g, '') + ' ' + lineShortCode(e.line) + ' ' + (e.seq || 1);

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, key, width, numFmt]) => ({ header, key, width, style: numFmt ? { numFmt } : {} }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE1EFEE' } };
  for (const r of rows) ws.addRow(r);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

const DATE = 'yyyy-mm-dd';
const STAMP = 'yyyy-mm-dd hh:mm';

export async function buildWorkbook(db, { from, to }) {
  const entries = await listEntries(db, { from, to });
  const reqs = await listRequisitions(db, { from, to });
  const balances = await listBalances(db);
  const lineStock = (await db.query(
    `SELECT line, component_sku, batch_number, quantity_remaining, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
       FROM line_batch_stock WHERE quantity_remaining <> 0 ORDER BY line, component_sku, batch_number`,
  )).rows;

  const byDateLine = (a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.line < b.line ? -1 : a.line > b.line ? 1 : 0);
  entries.sort((a, b) => byDateLine(a, b) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : (a.seq || 1) - (b.seq || 1)));
  reqs.sort(byDateLine);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mountain Falls Production Hub';
  wb.created = new Date();

  addSheet(wb, 'Schedule', [
    ['Date', 'date', 12, DATE], ['Line', 'line', 11], ['Product', 'sku', 24], ['Batch number', 'fg', 18],
    ['Status', 'status', 12], ['Planned cases', 'planned', 14], ['Cases produced', 'actual', 15],
    ['Wastage (cases)', 'wastage', 15], ['Start', 'start', 8], ['End', 'end', 8], ['Hours', 'hours', 8],
    ['Notes', 'notes', 40], ['Exported to Unleashed', 'exported', 20, STAMP],
  ], entries.map((e) => ({
    date: xlDate(e.date), line: e.line, sku: e.sku, fg: fgBatchNumber(e),
    status: STATUS_LABEL[computeEntryStatus(e)], planned: e.plannedCases, actual: e.actualCases,
    wastage: e.wastageCases, start: e.startTime, end: e.endTime,
    hours: actualDurationHours(e) === '' ? null : Number(actualDurationHours(e)),
    notes: e.notes || null, exported: xlTime(e.exportedAt),
  })));

  addSheet(wb, 'Batch usage', [
    ['Date', 'date', 12, DATE], ['Line', 'line', 11], ['Product', 'sku', 24], ['Batch number', 'fg', 18],
    ['Component', 'comp', 24], ['Component batch', 'batch', 18], ['Qty used', 'used', 10], ['Wastage', 'wastage', 10],
  ], entries.flatMap((e) => e.componentUsage.map((u) => ({
    date: xlDate(e.date), line: e.line, sku: e.sku, fg: fgBatchNumber(e),
    comp: u.componentSku, batch: u.batchNumber || '(not batch-tracked)', used: u.qtyUsed, wastage: u.wastage,
  }))));

  addSheet(wb, 'Requisitions', [
    ['Date', 'date', 12, DATE], ['Line', 'line', 11], ['Requisition', 'name', 40], ['Status', 'status', 11],
    ['Transfer number', 'transfer', 16], ['Exported to Unleashed', 'exported', 20, STAMP],
    ['Raw material', 'sku', 24], ['Description', 'desc', 36], ['Batch', 'batch', 18], ['Quantity sent', 'qty', 14],
  ], reqs.flatMap((r) => r.lines.map((l) => ({
    date: xlDate(r.date), line: r.line, name: requisitionName(r), status: r.status === 'done' ? 'Completed' : 'Open',
    transfer: r.transferNumber, exported: xlTime(r.exportedAt),
    sku: l.sku, desc: l.description || null, batch: l.batchNumber || (l.needsBatch === false ? '(not batch-tracked)' : '(not assigned)'),
    qty: l.qtyUsed,
  }))));

  addSheet(wb, 'Line batch stock', [
    ['Line', 'line', 28], ['Component', 'comp', 24], ['Batch', 'batch', 18], ['Qty at line', 'qty', 12], ['Expiry', 'expiry', 12, DATE],
  ], lineStock.map((s) => ({
    line: LINE_LABELS[s.line] || s.line, comp: s.component_sku, batch: s.batch_number,
    qty: s.quantity_remaining, expiry: xlDate(s.expiry_date),
  })));

  addSheet(wb, 'Raw material balance', [
    ['Line', 'line', 28], ['Raw material', 'sku', 24], ['Description', 'desc', 36],
    ['Sent', 'sent', 10], ['Used', 'used', 10], ['Balance', 'balance', 10],
  ], balances.map((b) => ({
    line: LINE_LABELS[b.line] || b.line, sku: b.sku, desc: b.description || null,
    sent: b.sentTotal, used: b.usedTotal, balance: b.balance,
  })));

  return {
    filename: `production-hub-${from}-to-${to}.xlsx`,
    buffer: Buffer.from(await wb.xlsx.writeBuffer()),
  };
}
