// Printable line sheets: the Production Schedule for a date as the paper
// forms the lines used before the app — one sheet per warehouse (UWH; LWH
// with an AcquaBox section), with columns for cases produced, the date, and
// the bottle and closure batches used. Printed blank to fill in by hand, or
// filled in from what's been recorded in the app.
//
// Bottles and closures are told apart by their Unleashed product group.

import { listEntries } from './schedule.js';
import { DESTINATIONS } from '../domain/collections.js';

export const SHEETS = {
  UWH: { title: 'UWH - Production Schedule', sections: [{ line: 'PRD - UWH', heading: 'UWH - Production Schedule' }] },
  LWH: {
    title: 'LWH - Production Schedule',
    sections: [{ line: 'PRD - LWH', heading: 'LWH - Production Schedule' }, { line: 'PRD - AQB', heading: 'AcquaBox', destinations: true }],
  },
};

const isBottle = (group) => /bottle/i.test(group || '');
const isClosure = (group) => /cap|closure/i.test(group || '');

const fmt = (n) => Number(n).toLocaleString('en-ZA', { maximumFractionDigits: 2, useGrouping: false });

// "B-SOON" or "B-SOON; B-LATE" and the matching quantities (used + wasted).
function usageCells(usage) {
  const byBatch = new Map();
  for (const u of usage) {
    if (!u.batchNumber) continue;
    byBatch.set(u.batchNumber, (byBatch.get(u.batchNumber) || 0) + (Number(u.qtyUsed) || 0) + (Number(u.wastage) || 0));
  }
  return {
    sku: [...new Set(usage.filter((u) => u.batchNumber).map((u) => u.componentSku))].join('; '),
    batch: [...byBatch.keys()].join('; '),
    qty: [...byBatch.values()].map(fmt).join('; '),
  };
}

// Destination split for the AcquaBox products, from that day's collection list.
async function destinationTable(db, date, skus) {
  if (!skus.length) return null;
  const rows = (await db.query(
    `SELECT c.destination, l.sku, SUM(l.qty) AS qty FROM collections c JOIN collection_lines l ON l.collection_id = c.id
      WHERE c.date = $1 AND l.sku = ANY($2) GROUP BY c.destination, l.sku`, [date, skus])).rows;
  if (!rows.length) return null;
  const order = DESTINATIONS.map((d) => d.code);
  const dests = [...new Set(rows.map((r) => r.destination))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return {
    destinations: dests,
    rows: skus.filter((s) => rows.some((r) => r.sku === s)).map((sku) => ({
      sku, qty: dests.map((d) => { const r = rows.find((x) => x.sku === sku && x.destination === d); return r ? Number(r.qty) : null; }),
    })),
  };
}

// The sheets for a date. lineFilter(line) -> false hides lines the user
// isn't linked to.
export async function lineSheets(db, date, { lineFilter = () => true } = {}) {
  const entries = (await listEntries(db, { date }))
    .filter((e) => lineFilter(e.line))
    .sort((a, b) => (a.runOrder ?? 1e9) - (b.runOrder ?? 1e9) || (a.seq || 1) - (b.seq || 1));
  const skus = [...new Set(entries.flatMap((e) => (e.componentUsage || []).map((u) => u.componentSku)))];
  const groups = new Map((await db.query('SELECT product_code, group_name FROM product_groups WHERE product_code = ANY($1)', [skus])).rows
    .map((r) => [r.product_code, r.group_name]));

  const sheets = [];
  for (const [form, def] of Object.entries(SHEETS)) {
    const sections = [];
    for (const s of def.sections) {
      if (!lineFilter(s.line)) continue;
      const jobs = entries.filter((e) => e.line === s.line);
      const rows = jobs.map((e) => {
        const usage = e.componentUsage || [];
        const bottles = usageCells(usage.filter((u) => isBottle(groups.get(u.componentSku))));
        const closures = usageCells(usage.filter((u) => isClosure(groups.get(u.componentSku))));
        const produced = e.actualCases !== null && e.actualCases !== undefined && e.actualCases !== '';
        return {
          sku: e.sku + ((e.seq || 1) > 1 ? ` (${e.seq})` : ''),
          planned: e.plannedCases,
          produced: produced ? e.actualCases : null,
          prodDate: produced ? e.date : null,
          bottleSku: bottles.sku, bottleBatch: bottles.batch, bottleQty: bottles.qty,
          closureSku: closures.sku, closureBatch: closures.batch, closureQty: closures.qty,
        };
      });
      const section = { line: s.line, heading: s.heading, rows };
      if (s.destinations) section.destinationTable = await destinationTable(db, date, [...new Set(jobs.map((e) => e.sku))]);
      sections.push(section);
    }
    if (sections.length) sheets.push({ form, date, sections });
  }
  return sheets;
}
