// Stock Collection rules, shaped like the paper process. Pure functions.
//
// The day's LIST: sections (collections, one per destination) with lines
//   { id, sku, description, qty (= Qty Req), needsBatch,
//     loads: [{ id, truck, qty (= Qty Trf), batch, dispatchId, arrivalId }] }.
// One TRUCK SHEET per truck per day: Qty Trf and Batch per line for that
// truck. Loaded -> Approved; approval makes one transfer per section on
// the truck (PRD -> CPT for Cape Town, PRD -> HLD for the rest).
// The second leg, HLD -> destination, is one transfer per destination
// covering every truck's loads.

import { csvField, csvTextGuard, csvDocument, parseCsv, parseFlexibleDate } from './csv.js';
import { BULK_STORE } from './lines.js';
import { tagFor } from './unleashedPayloads.js';

// code -> warehouse it's transferred into first.
export const DESTINATIONS = [
  { code: 'CPT', label: 'Cape Town', warehouse: 'CPT' },
  { code: 'RML-JHB', label: 'RM Logistics JHB', warehouse: 'RML-JHB' },
  { code: 'ZARMI-JHB', label: 'Johannesburg - Zarmi', warehouse: 'ZARMI-JHB' },
  { code: 'PE', label: 'Port Elizabeth', warehouse: 'PE' },
  { code: 'DBN', label: 'Durban', warehouse: 'DBN' },
  { code: 'JBAY', label: "Jeffery's Bay", warehouse: 'JBAY' },
  { code: 'HER', label: 'Hermanus Sales', warehouse: 'HER' },
  { code: 'PND', label: 'Pending Warehouse Orders', warehouse: 'PND' },
];
export const DESTINATION_LABELS = Object.fromEntries(DESTINATIONS.map((d) => [d.code, d.label]));
const WAREHOUSE = Object.fromEntries(DESTINATIONS.map((d) => [d.code, d.warehouse]));
export const TRUCKS = ['RML', 'MFE'];
export const HOLDING = 'HLD';

export const warehouseOf = (destination) => WAREHOUSE[destination] || destination;
// Cape Town goes straight in; the rest via HLD.
export const needsHoldingLeg = (destination) => warehouseOf(destination) !== 'CPT';
// First leg's destination warehouse.
export const firstLegTo = (destination) => (needsHoldingLeg(destination) ? HOLDING : warehouseOf(destination));

export const sectionLabel = (destination) => DESTINATION_LABELS[destination] || destination;

// Sheet headings that aren't warehouses but are collected from one:
// Digistics collects from Cape Town, so its lines are part of CPT.
const ALIASES = { DIGISTICS: 'CPT' };

// Accepts a code ("ZARMI-JHB"), a label, or a sheet heading
// ("Digistics (Wed Collection)" -> CPT).
export function normalizeDestination(v) {
  const t = String(v || '').trim().toUpperCase();
  const first = t.split(/[\s(]/)[0];
  if (ALIASES[t] || ALIASES[first]) return ALIASES[t] || ALIASES[first];
  if (WAREHOUSE[t]) return t;
  const word = t.split(/[\s(]/)[0];
  if (WAREHOUSE[word]) return word;
  const byLabel = DESTINATIONS.find((d) => d.label.toUpperCase() === t);
  return byLabel ? byLabel.code : null;
}

// Transfer Comments, e.g. "ZARMI-JHB — Johannesburg - Zarmi (RML)".
export const legName = (destination, truck) =>
  `${destination} — ${sectionLabel(destination)}${truck ? ` (${truck})` : ''}`;

// A load needs a batch only for a finished good Unleashed batch-tracks.
export const loadMissingBatch = (line, load) => Number(load.qty) > 0 && line.needsBatch && !String(load.batch || '').trim();

// ---------- truck sheet status ----------

export function sheetStatus(sheet) {
  if (sheet?.approvedAt) return 'approved';
  if (sheet?.loadedAt) return 'loaded';
  return 'open';
}
export const SHEET_LABELS = { open: 'Being loaded', loaded: 'Loaded — waiting for approval', approved: 'Approved' };

// What approving a truck would send: per section, its loads with qty > 0
// not yet dispatched; plus the loads still missing a batch.
export function truckTransfers(collections, truck) {
  const out = [];
  const missing = [];
  for (const c of collections) {
    const loads = [];
    for (const l of c.lines) {
      const load = l.loads.find((x) => x.truck === truck && !x.dispatchId && Number(x.qty) > 0);
      if (!load) continue;
      if (loadMissingBatch(l, load)) missing.push(`${c.destination} ${l.sku}`);
      loads.push({ line: l, load });
    }
    if (loads.length) out.push({ collection: c, loads });
  }
  return { transfers: out, missing };
}

// ---------- CSV upload: Date, Destination, SKU, Quantity ----------

export function parseCollectionCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { groups: [], errors: ['The file is empty.'] };
  const header = rows[0].map((h) => (h || '').trim().toLowerCase());
  const idx = { date: header.indexOf('date'), dest: header.indexOf('destination'), sku: header.indexOf('sku'), qty: header.indexOf('quantity') };
  if (Object.values(idx).some((i) => i === -1)) return { groups: [], errors: ['Header row must have: Date, Destination, SKU, Quantity.'] };

  const errors = [];
  const groups = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0].trim() === '') continue;
    const rowNum = r + 1;
    const dateRaw = (cells[idx.date] || '').trim();
    const destRaw = (cells[idx.dest] || '').trim();
    const sku = (cells[idx.sku] || '').trim();
    const qtyRaw = (cells[idx.qty] || '').trim();
    const date = parseFlexibleDate(dateRaw);
    if (!date) { errors.push(`Row ${rowNum}: date must be YYYY-MM-DD or YYYY/MM/DD (got "${dateRaw}").`); continue; }
    const destination = normalizeDestination(destRaw);
    if (!destination) { errors.push(`Row ${rowNum}: "${destRaw}" isn't a known destination (${DESTINATIONS.map((d) => d.code).join(', ')}).`); continue; }
    if (!sku) { errors.push(`Row ${rowNum}: missing SKU.`); continue; }
    const qty = parseFloat(qtyRaw);
    if (!qtyRaw || isNaN(qty) || qty <= 0) { errors.push(`Row ${rowNum}: quantity must be a positive number.`); continue; }
    const key = date + '|' + destination;
    if (!groups.has(key)) groups.set(key, { date, destination, lines: [] });
    groups.get(key).lines.push({ sku, qty });
  }
  if (groups.size === 0 && errors.length === 0) errors.push('No data rows found.');
  return { groups: [...groups.values()], errors };
}

export const COLLECTION_TEMPLATE_CSV =
  'Date,Destination,SKU,Quantity\r\n2026-10-07,CPT,GN330ST_MF,34\r\n2026-10-07,CPT,MF_PALLETS,14\r\n' +
  '2026-10-07,ZARMI-JHB,P500ST_MFSIG_PN,72\r\n2026-10-07,RML-JHB,P330ST_MFSIG_PN,84\r\n';

// ---------- CSV exports ----------

export const TRANSFER_HEADERS = [
  '*Transfer Number', '*Source Warehouse Code', '*Destination Warehouse Code',
  'Comments', '*Product Code', '*Transfer Quantity', 'Line Comments',
];
const fmtQty = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });

// items: [{sku, qty, batch}]. Line Comments ="<batch> - <qty>" when there's a batch.
export function transferRows(number, source, destination, comments, items) {
  return items.map((i) => [
    csvField(number), csvField(source), csvField(destination), csvField(comments),
    csvField(i.sku), csvField(i.qty), i.batch ? csvTextGuard(`${i.batch} - ${fmtQty(i.qty)}`) : '',
  ]);
}
export const transfersCsv = (rows) => csvDocument(TRANSFER_HEADERS, rows);

// ---------- Unleashed API payload ----------

// items: [{sku, qty, batch}]; tag identifies the record for duplicate recovery.
export function legPayload({ from, to, comments, items, tag }) {
  const details = items.filter((i) => Number(i.qty) > 0).map((i) => ({
    Product: { ProductCode: i.sku },
    TransferQuantity: Number(i.qty),
    ...(i.batch ? { Comments: `Batch ${i.batch}` } : {}),
  }));
  if (!details.length) throw new Error('Nothing to transfer.');
  return {
    Comments: `${comments} ${tagFor(tag)}`,
    SourceWarehouse: { WarehouseCode: from },
    DestinationWarehouse: { WarehouseCode: to },
    TransferDetails: details,
  };
}

export { BULK_STORE };

// ---------- several batches on one line ----------
// Stored the way the sheets write it: one batch on its own ("20261007"),
// several as "20261007 (215) 20261005 (1)". A batch number may contain
// spaces ("20261007 UWH 1"), so splitting is by the "(qty)" markers.

export function parseBatches(text, qty) {
  const t = String(text || '').trim();
  if (!t) return [];
  const parts = [...t.matchAll(/(.+?)\s*\(\s*(\d+(?:\.\d+)?)\s*\)/g)];
  if (!parts.length) return [{ batch: t, qty: qty === undefined || qty === null ? null : Number(qty) }];
  return parts.map((m) => ({ batch: m[1].trim(), qty: Number(m[2]) }));
}

export function formatBatches(entries) {
  const list = entries.filter((e) => String(e.batch || '').trim());
  if (list.length === 1) return list[0].batch.trim();
  return list.map((e) => `${e.batch.trim()} (${Number(e.qty)})`).join(' ');
}
