// What gets sent to the Unleashed API for a completed requisition (a
// Warehouse Stock Transfer) and a completed job (an Assembly). Pure
// functions, so the exact payloads are pinned by tests.
//
// Field names from apidocs.unleashedsoftware.com (WarehouseStockTransfers,
// Assemblies), checked 2026-10-06.

import { BULK_STORE, assemblySourceWarehouse, lineShortCode } from './lines.js';
import { requisitionName } from './requisitions.js';

// Tag in the Comments of everything this app sends, so a send whose reply
// was lost can be found again instead of being created twice.
export const tagFor = (id) => `[PH ${id}]`;
export const hasTag = (comments, id) => String(comments || '').includes(tagFor(id));

const round = (n) => Math.round(n * 1e6) / 1e6;

// A completed requisition -> Parked transfer, PRD to the line.
// The transfer API has no batch field, so (as with the CSV import) each
// line's batch goes in that line's Comments.
export function transferPayload(req) {
  const details = (req.lines || [])
    .filter((l) => Number(l.qtyUsed) > 0)
    .map((l) => ({
      Product: { ProductCode: l.sku },
      TransferQuantity: round(Number(l.qtyUsed)),
      ...(l.batchNumber ? { Comments: `Batch ${l.batchNumber}` } : {}),
    }));
  if (details.length === 0) throw new Error('This requisition has no quantities to transfer.');
  return {
    Comments: `${requisitionName(req)} ${tagFor(req.id)}`,
    SourceWarehouse: { WarehouseCode: BULK_STORE },
    DestinationWarehouse: { WarehouseCode: req.line },
    TransferDetails: details,
  };
}

// Finished-goods batch number, as in the CSV: "20261007 UWH 1".
export const finishedBatchNumber = (e) =>
  String(e.date).replace(/-/g, '') + ' ' + lineShortCode(e.line) + ' ' + (e.seq || 1);

// "2h 30m" — the human-readable form Unleashed accepts for durations.
export function durationText(start, end) {
  if (!start || !end) return undefined;
  const toMin = (t) => { const [h, m] = t.split(':'); return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0); };
  let diff = toMin(end) - toMin(start);
  if (diff < 0) diff += 24 * 60;
  return `${Math.floor(diff / 60)}h ${diff % 60}m`;
}

// Component quantities actually used on the floor. Every BOM component
// gets a line: what was recorded against it, or — if nothing was recorded —
// the recipe amount for the cases produced. Components recorded but not in
// the BOM are included too.
export function assemblyLines(entry, recipe) {
  const used = new Map();
  for (const u of entry.componentUsage || []) {
    const t = used.get(u.componentSku) || { qty: 0, wastage: 0 };
    t.qty += Number(u.qtyUsed) || 0;
    t.wastage += Number(u.wastage) || 0;
    used.set(u.componentSku, t);
  }
  const lines = [];
  const seen = new Set();
  for (const rl of recipe?.lines || []) {
    seen.add(rl.componentSku);
    const u = used.get(rl.componentSku);
    lines.push({
      Product: { ProductCode: rl.componentSku },
      Quantity: round(u ? u.qty : (rl.qtyPerUnit || 0) * (Number(entry.actualCases) || 0)),
      WastageQuantity: round(u ? u.wastage : 0),
    });
  }
  for (const [sku, u] of used) {
    if (!seen.has(sku)) lines.push({ Product: { ProductCode: sku }, Quantity: round(u.qty), WastageQuantity: round(u.wastage) });
  }
  return lines;
}

// A completed job -> Parked assembly, PRD to PRD for now (same as the CSV;
// see assemblySourceWarehouse).
export function assemblyPayload(entry, recipe, { productionEmail } = {}) {
  if (!(Number(entry.actualCases) > 0)) throw new Error('Record the cases produced before sending.');
  const batches = [...new Set((entry.componentUsage || []).map((u) => u.batchNumber).filter(Boolean))];
  const comments = [
    `Batch ${finishedBatchNumber(entry)}`,
    batches.length ? `Components: ${batches.join('; ')}` : null,
    tagFor(entry.id),
  ].filter(Boolean).join(' · ');
  const payload = {
    Product: { ProductCode: entry.sku },
    SourceWarehouse: { WarehouseCode: assemblySourceWarehouse(entry.line) },
    DestinationWarehouse: { WarehouseCode: BULK_STORE },
    Quantity: Number(entry.actualCases),
    AssembleBy: entry.date,
    Comments: comments,
    AssemblyLines: assemblyLines(entry, recipe),
  };
  if (recipe?.expectedDuration) payload.ExpectedDuration = recipe.expectedDuration;
  const actual = durationText(entry.startTime, entry.endTime);
  if (actual) payload.ActualDuration = actual;
  if (entry.notes) payload.DurationComments = entry.notes;
  if (productionEmail) payload.ProductionPerson = { Email: productionEmail };
  return payload;
}

// Batch numbers for the components (bottles, caps) — attached after the
// assembly is created, via POST /Assemblies/{guid}/ProductTracking.
// Batch quantity = used + wasted, i.e. everything drawn from that batch.
// null when nothing batch-tracked was recorded.
export function trackingPayload(entry) {
  const byProduct = new Map();
  for (const u of entry.componentUsage || []) {
    if (!u.batchNumber) continue;
    const qty = (Number(u.qtyUsed) || 0) + (Number(u.wastage) || 0);
    if (qty <= 0) continue;
    const list = byProduct.get(u.componentSku) || [];
    const same = list.find((b) => b.BatchNumber === u.batchNumber);
    if (same) same.Quantity = round(same.Quantity + qty);
    else list.push({ BatchNumber: u.batchNumber, Quantity: round(qty) });
    byProduct.set(u.componentSku, list);
  }
  if (byProduct.size === 0) return null;
  return {
    ProductBatches: [...byProduct].map(([sku, Batches]) => ({ Product: { ProductCode: sku }, Batches })),
  };
}
