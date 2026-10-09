-- Unleashed product group per product (e.g. "Raw Materials - Personalised
-- Labels"), refreshed from /Products on every sync. Used to group and sort
-- raw materials on requisitions and the pick list.

CREATE TABLE product_groups (
  product_code  text PRIMARY KEY,
  group_name    text,
  synced_at     timestamptz
);
