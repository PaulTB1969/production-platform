// Pulls BOMs and bulk-store batch stock from Unleashed into the database.
// Replaces "ask Claude to refresh" in the artifacts. Runs on a timer
// (UNLEASHED_SYNC_MINUTES) and on demand from POST /api/unleashed/sync.
//
// Field names checked against Mountain Falls' live account on 2026-10-01
// (npm run unleashed:probe); test/unleashed.test.js pins the mapping.

import { parseUnleashedDate } from './client.js';
import { replaceRecipes, replaceComponentBatches, replaceBulkStock, replaceProductGroups } from '../services/stock.js';
import { BULK_STORE } from '../domain/lines.js';

// /BillOfMaterials -> recipes. Each BOM line embeds its component product,
// including IsBatchTracked, which drives the batch pickers. BOMs for
// obsolete finished goods are skipped.
export function mapBillsOfMaterials(boms) {
  return boms
    .filter((b) => !b.Obsolete && b.Product?.ProductCode && !b.Product.Obsolete)
    .map((b) => ({
      sku: b.Product.ProductCode,
      description: b.Product.ProductDescription || null,
      autoAssignOldestBatch: !!b.AutoAssignOldestBatchSerial,
      // The finished good itself (not its components) — collections only
      // need a batch for products Unleashed batch-tracks.
      batchTracked: !!b.Product.IsBatchTracked,
      // Free text as entered in Unleashed (e.g. "40m"); goes straight into
      // the assemblies CSV's Expected Duration column.
      expectedDuration: b.ExpectedDuration || null,
      lines: (b.BillOfMaterialsLines || [])
        .slice()
        .sort((x, y) => (x.LineNumber ?? 0) - (y.LineNumber ?? 0))
        .map((l) => ({
          componentSku: l.Product?.ProductCode,
          componentDescription: l.Product?.ProductDescription || null,
          qtyPerUnit: Number(l.Quantity) || 0,
          wastageQty: Number(l.WastageQuantity) || 0,
          isBatchTracked: !!l.Product?.IsBatchTracked,
        }))
        .filter((l) => l.componentSku),
    }));
}

// /BatchNumbers -> available bulk-store (PRD) batches with stock on hand.
export function mapBatchNumbers(items, { warehouseCode = BULK_STORE } = {}) {
  return items
    .filter((b) => b.WarehouseCode === warehouseCode && (b.Status ?? 'Available') === 'Available')
    .map((b) => ({
      componentSku: b.ProductCode,
      batchNumber: b.Number,
      quantityRemaining: Number(b.Quantity) || 0,
      originalQty: b.OriginalQty ?? null,
      expiryDate: parseUnleashedDate(b.ExpiryDate),
      createdOn: parseUnleashedDate(b.CreatedOn),
    }))
    .filter((b) => b.componentSku && b.batchNumber && b.quantityRemaining > 0);
}

// /StockOnHand?warehouseCode=PRD -> qty on hand per product in the bulk store.
export function mapStockOnHand(items, { warehouseCode = BULK_STORE } = {}) {
  return items
    .filter((s) => s.WarehouseCode === warehouseCode && s.ProductCode)
    .map((s) => ({
      productCode: s.ProductCode,
      description: s.ProductDescription || null,
      qtyOnHand: Number(s.QtyOnHand) || 0,
      availableQty: Number(s.AvailableQty) || 0,
    }));
}

// /Products -> product group per product code.
export function mapProductGroups(items) {
  return items
    .filter((p) => p.ProductCode)
    .map((p) => ({ productCode: p.ProductCode, groupName: p.ProductGroup?.GroupName || null }));
}

export async function syncFromUnleashed(db, client, { log = () => {} } = {}) {
  if (!client) throw new Error('Unleashed API credentials are not configured (UNLEASHED_API_ID / UNLEASHED_API_KEY).');
  const startedAt = new Date();
  try {
    const boms = await client.getAll('BillOfMaterials');
    const batches = await client.getAll('BatchNumbers');
    const stock = await client.getAll('StockOnHand', { warehouseCode: BULK_STORE }, 200);
    const products = await client.getAll('Products', {}, 200);

    const recipes = mapBillsOfMaterials(boms);
    const componentBatches = mapBatchNumbers(batches);
    await replaceRecipes(db, recipes, startedAt);
    await replaceComponentBatches(db, componentBatches, startedAt);
    const bulkStock = mapStockOnHand(stock);
    await replaceBulkStock(db, bulkStock, startedAt);
    await replaceProductGroups(db, mapProductGroups(products), startedAt);

    const message = `${recipes.length} BOMs, ${componentBatches.length} raw-material batches, ${bulkStock.length} products in PRD`;
    await recordSync(db, true, message, startedAt);
    log(`unleashed sync ok: ${message}`);
    return { ok: true, message };
  } catch (err) {
    await recordSync(db, false, err.message, startedAt);
    log(`unleashed sync failed: ${err.message}`);
    throw err;
  }
}

async function recordSync(db, ok, message, at) {
  await db.query(
    `INSERT INTO sync_status (name, synced_at, ok, message) VALUES ('unleashed', $1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET synced_at = EXCLUDED.synced_at, ok = EXCLUDED.ok, message = EXCLUDED.message`,
    [at, ok, message],
  );
}

export async function getSyncStatus(db) {
  const r = (await db.query(`SELECT synced_at, ok, message FROM sync_status WHERE name = 'unleashed'`)).rows[0];
  return r ? { syncedAt: r.synced_at, ok: r.ok, message: r.message } : { syncedAt: null, ok: null, message: 'Not synced yet' };
}
