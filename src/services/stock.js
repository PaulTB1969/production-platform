// Recipes (BOMs), raw-material batch stock and the per-line stock views.

import { recipeFromRows, groupBy } from './rows.js';

// FEFO: soonest expiry first, so the batch to use up first tops the picker.
// Batches with no expiry sort last.
function sortByExpiry(batches) {
  const t = (b) => (b.expiryDate ? new Date(b.expiryDate).getTime() : NaN);
  return batches.slice().sort((a, b) => {
    const ta = t(a), tb = t(b);
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return ta - tb;
  });
}

export async function listRecipes(db) {
  const recipes = (await db.query('SELECT * FROM recipes ORDER BY sku')).rows;
  const lines = groupBy((await db.query('SELECT * FROM recipe_lines ORDER BY recipe_sku, position, id')).rows, 'recipe_sku');
  return recipes.map((r) => recipeFromRows(r, lines.get(r.sku) || []));
}

export async function recipeMap(db) {
  return new Map((await listRecipes(db)).map((r) => [r.sku, r]));
}

export async function getRecipe(q, sku) {
  const r = (await q.query('SELECT * FROM recipes WHERE sku = $1', [sku])).rows[0];
  if (!r) return null;
  const lines = (await q.query('SELECT * FROM recipe_lines WHERE recipe_sku = $1 ORDER BY position, id', [sku])).rows;
  return recipeFromRows(r, lines);
}

// Replaces all recipes with what Unleashed returned, in one transaction.
// Recipes no longer in Unleashed are removed. Settings kept in this app
// rather than Unleashed (expected duration, auto-assign) survive the sync.
export async function replaceRecipes(db, recipes, syncedAt = new Date()) {
  await db.tx(async (q) => {
    const kept = new Map((await q.query('SELECT sku, auto_assign_oldest_batch, expected_duration FROM recipes')).rows.map((r) => [r.sku, r]));
    await q.query('DELETE FROM recipes');
    for (const r of recipes) {
      const old = kept.get(r.sku);
      await q.query(
        `INSERT INTO recipes (sku, description, auto_assign_oldest_batch, expected_duration, synced_at, is_batch_tracked)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          r.sku, r.description || null,
          r.autoAssignOldestBatch ?? old?.auto_assign_oldest_batch ?? false,
          r.expectedDuration || old?.expected_duration || null,
          syncedAt,
          r.batchTracked ?? null,
        ],
      );
      for (const [i, l] of (r.lines || []).entries()) {
        await q.query(
          `INSERT INTO recipe_lines (recipe_sku, position, component_sku, component_description, qty_per_unit, wastage_qty, is_batch_tracked)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [r.sku, i, l.componentSku, l.componentDescription || null, l.qtyPerUnit || 0, l.wastageQty || 0, l.isBatchTracked !== false],
        );
      }
    }
  });
}

// Bulk-store batch stock, keyed by component SKU.
// Bulk-store (PRD) stock on hand per product, from Unleashed /StockOnHand.
export async function replaceBulkStock(db, rows, syncedAt = new Date()) {
  await db.tx(async (q) => {
    await q.query('DELETE FROM bulk_stock');
    for (const r of rows) {
      await q.query(
        `INSERT INTO bulk_stock (product_code, description, qty_on_hand, available_qty, synced_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (product_code) DO NOTHING`,
        [r.productCode, r.description || null, r.qtyOnHand || 0, r.availableQty || 0, syncedAt],
      );
    }
  });
}

// Unleashed product groups, from /Products.
export async function replaceProductGroups(db, rows, syncedAt = new Date()) {
  await db.tx(async (q) => {
    await q.query('DELETE FROM product_groups');
    for (const r of rows) {
      await q.query(
        `INSERT INTO product_groups (product_code, group_name, synced_at) VALUES ($1, $2, $3)
         ON CONFLICT (product_code) DO NOTHING`,
        [r.productCode, r.groupName || null, syncedAt],
      );
    }
  });
}

// product code -> qty on hand in PRD. Empty until the first sync after this
// table was added.
export async function bulkStockMap(q) {
  const rows = (await q.query('SELECT product_code, qty_on_hand FROM bulk_stock')).rows;
  return new Map(rows.map((r) => [r.product_code, r.qty_on_hand]));
}

export async function listComponentBatches(db) {
  const rows = (await db.query(
    `SELECT component_sku, batch_number, quantity_remaining, original_qty,
            to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            to_char(created_on, 'YYYY-MM-DD') AS created_on
       FROM component_batches WHERE quantity_remaining > 0`,
  )).rows;
  const out = {};
  for (const [sku, list] of groupBy(rows, 'component_sku')) {
    out[sku] = {
      componentSku: sku,
      batches: sortByExpiry(list.map((b) => ({
        batchNumber: b.batch_number,
        quantityRemaining: b.quantity_remaining,
        originalQty: b.original_qty,
        expiryDate: b.expiry_date,
        createdOn: b.created_on,
      }))),
    };
  }
  return out;
}

export async function replaceComponentBatches(db, batches, syncedAt = new Date()) {
  await db.tx(async (q) => {
    await q.query('DELETE FROM component_batches');
    for (const b of batches) {
      await q.query(
        `INSERT INTO component_batches (component_sku, batch_number, quantity_remaining, original_qty, expiry_date, created_on, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (component_sku, batch_number) DO UPDATE SET quantity_remaining = component_batches.quantity_remaining + EXCLUDED.quantity_remaining`,
        [b.componentSku, b.batchNumber, b.quantityRemaining || 0, b.originalQty ?? null, b.expiryDate || null, b.createdOn || null, syncedAt],
      );
    }
  });
}

// Batches physically at each line (sent by completed requisitions, minus
// what production drew). Keyed "<line>|<componentSku>", as in the artifact.
// Includes used-up (0) and over-drawn (negative) batches so the screen can
// flag them; the picker offers only those with stock left.
export async function listLineBatches(db) {
  const rows = (await db.query(
    `SELECT line, component_sku, batch_number, quantity_remaining,
            to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
       FROM line_batch_stock`,
  )).rows;
  const out = {};
  for (const r of rows) {
    const key = r.line + '|' + r.component_sku;
    out[key] ||= { line: r.line, componentSku: r.component_sku, batches: [] };
    out[key].batches.push({ batchNumber: r.batch_number, quantityRemaining: r.quantity_remaining, expiryDate: r.expiry_date });
  }
  for (const v of Object.values(out)) v.batches = sortByExpiry(v.batches);
  return out;
}

// Raw materials that can go on a requisition: every BOM component, plus
// anything with batches in the bulk store. Batch-tracked comes from the BOM
// lines (Unleashed's product flag); a material in no BOM counts as
// batch-tracked if it has batches in PRD. onHand = PRD stock on hand.
export async function listMaterials(q) {
  const rows = (await q.query(`
    WITH comps AS (
      SELECT component_sku AS sku, MAX(component_description) AS description, BOOL_OR(is_batch_tracked) AS tracked
        FROM recipe_lines GROUP BY component_sku
    ), batches AS (
      SELECT DISTINCT component_sku AS sku FROM component_batches
    ), skus AS (
      SELECT sku FROM comps UNION SELECT sku FROM batches
    )
    SELECT s.sku,
           COALESCE(c.description, b.description) AS description,
           COALESCE(c.tracked, bt.sku IS NOT NULL) AS batch_tracked,
           b.qty_on_hand,
           g.group_name
      FROM skus s
      LEFT JOIN product_groups g ON g.product_code = s.sku
      LEFT JOIN comps c ON c.sku = s.sku
      LEFT JOIN bulk_stock b ON b.product_code = s.sku
      LEFT JOIN batches bt ON bt.sku = s.sku
     ORDER BY s.sku`)).rows;
  return rows.map((r) => ({
    sku: r.sku,
    description: r.description || '',
    batchTracked: !!r.batch_tracked,
    onHand: r.qty_on_hand ?? null,
    group: r.group_name || null,
  }));
}

export async function listBalances(q) {
  return (await q.query('SELECT * FROM raw_material_balances ORDER BY line, sku')).rows.map((r) => ({
    line: r.line,
    sku: r.sku,
    description: r.description,
    sentTotal: r.sent_total,
    usedTotal: r.used_total,
    balance: r.sent_total - r.used_total,
  }));
}

export async function balanceMap(q) {
  return new Map((await listBalances(q)).map((b) => [`${b.line}|${b.sku}`, b.balance]));
}

export async function addAdjustment(db, { line, sku, batchNumber = null, description = '', qty, reason }) {
  await db.query(
    `INSERT INTO line_stock_adjustments (line, sku, batch_number, description, qty, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [line, sku, batchNumber || null, description, qty, reason],
  );
}
