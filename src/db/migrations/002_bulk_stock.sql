-- Stock on hand in the bulk store (PRD) for every product, from Unleashed's
-- /StockOnHand — including raw materials that aren't batch-tracked (labels,
-- boxes, overcaps), which component_batches can't show. Used by the pick list.
CREATE TABLE bulk_stock (
  product_code   text PRIMARY KEY,
  description    text,
  qty_on_hand    numeric NOT NULL DEFAULT 0,
  available_qty  numeric NOT NULL DEFAULT 0,
  synced_at      timestamptz
);
