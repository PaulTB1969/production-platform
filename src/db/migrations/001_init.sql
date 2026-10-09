-- Initial schema, translated from the Production Schedule and Stock
-- Requisition artifacts' collections (see docs/legacy/ and README).
--
-- Line values are the exact Unleashed warehouse codes ('PRD - UWH',
-- 'PRD - LWH', 'PRD - AQB') or the catch-all 'Other', same as the artifacts.
--
-- What the artifacts kept as synced copies (lineComponentBatches,
-- rawMaterialBalances) is derived here from requisitions + actuals by the
-- views at the bottom, so there is nothing to refresh.

-- ---------- master data synced from Unleashed ----------

CREATE TABLE recipes (
  sku                        text PRIMARY KEY,
  description                text,
  auto_assign_oldest_batch   boolean NOT NULL DEFAULT false,
  expected_duration          text,
  synced_at                  timestamptz
);

CREATE TABLE recipe_lines (
  id                     bigserial PRIMARY KEY,
  recipe_sku             text NOT NULL REFERENCES recipes(sku) ON DELETE CASCADE,
  position               int  NOT NULL DEFAULT 0,
  component_sku          text NOT NULL,
  component_description  text,
  qty_per_unit           numeric NOT NULL DEFAULT 0,
  wastage_qty            numeric NOT NULL DEFAULT 0,
  is_batch_tracked       boolean NOT NULL DEFAULT true
);
CREATE INDEX recipe_lines_recipe_idx ON recipe_lines(recipe_sku);

-- Full Unleashed raw-material stock position by batch (bulk store, PRD).
-- Used when assigning batches on a requisition.
CREATE TABLE component_batches (
  component_sku       text NOT NULL,
  batch_number        text NOT NULL,
  quantity_remaining  numeric NOT NULL DEFAULT 0,
  original_qty        numeric,
  expiry_date         date,
  created_on          date,
  synced_at           timestamptz,
  PRIMARY KEY (component_sku, batch_number)
);

-- ---------- production schedule ----------

CREATE TABLE schedule_entries (
  id              text PRIMARY KEY,
  sku             text NOT NULL,
  line            text NOT NULL,
  date            date NOT NULL,
  planned_cases   numeric NOT NULL,
  actual_cases    numeric,
  wastage_cases   numeric,
  -- NULL or 'done', as in the artifact. 'scheduled' / 'in_progress' are
  -- computed (see domain/schedule.js computeEntryStatus).
  status          text CHECK (status IS NULL OR status = 'done'),
  group_id        text NOT NULL,
  seq             int  NOT NULL DEFAULT 1,
  start_time      text,
  end_time        text,
  notes           text NOT NULL DEFAULT '',
  exported_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedule_entries_date_line_idx ON schedule_entries(date, line);
CREATE INDEX schedule_entries_group_idx ON schedule_entries(group_id);

CREATE TABLE component_usage (
  id              bigserial PRIMARY KEY,
  entry_id        text NOT NULL REFERENCES schedule_entries(id) ON DELETE CASCADE,
  component_sku   text NOT NULL,
  -- NULL for non-batch-tracked components.
  batch_number    text,
  qty_used        numeric NOT NULL DEFAULT 0,
  wastage         numeric NOT NULL DEFAULT 0
);
CREATE INDEX component_usage_entry_idx ON component_usage(entry_id);

-- ---------- stock requisitions ----------

CREATE TABLE requisitions (
  id               text PRIMARY KEY,           -- req_YYYYMMDD_uwh
  date             date NOT NULL,
  line             text NOT NULL,
  status           text CHECK (status IS NULL OR status = 'done'),
  transfer_number  text,
  exported_at      timestamptz,
  generated_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, line)
);

CREATE TABLE requisition_lines (
  id               bigserial PRIMARY KEY,
  requisition_id   text NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,
  position         int  NOT NULL DEFAULT 0,
  sku              text NOT NULL,
  description      text NOT NULL DEFAULT '',
  batch_number     text,
  qty_used         numeric NOT NULL DEFAULT 0,
  needs_batch      boolean NOT NULL DEFAULT true
);
CREATE INDEX requisition_lines_req_idx ON requisition_lines(requisition_id);

-- Manual corrections and opening balances carried over from the artifacts
-- at cutover. Positive qty = stock at the line, negative = taken away.
-- batch_number NULL = a non-batch-tracked raw material.
CREATE TABLE line_stock_adjustments (
  id             bigserial PRIMARY KEY,
  line           text NOT NULL,
  sku            text NOT NULL,
  batch_number   text,
  description    text NOT NULL DEFAULT '',
  qty            numeric NOT NULL,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- numbering, exports, sync bookkeeping ----------

-- MFB (assemblies) and MFR (transfers) counters. Taken with SELECT ... FOR
-- UPDATE inside the export transaction, so two exports can't share a number.
CREATE TABLE counters (
  name  text PRIMARY KEY,
  next  bigint NOT NULL
);
INSERT INTO counters (name, next) VALUES ('assembly', 1), ('transfer', 1);

-- Every CSV handed out is kept, so a failed download can be fetched again
-- without allocating new numbers (which would duplicate it in Unleashed).
CREATE TABLE exports (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('assemblies', 'wastage', 'transfer')),
  date        date NOT NULL,
  filename    text NOT NULL,
  csv         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_status (
  name        text PRIMARY KEY,                -- 'unleashed'
  synced_at   timestamptz,
  ok          boolean,
  message     text
);

-- ---------- derived stock at each line ----------

-- Batch-tracked stock physically at a line: sent by completed requisitions,
-- minus drawn (used + wastage) by production on that line, plus adjustments.
-- Replaces the artifacts' lineComponentBatches collection.
CREATE VIEW line_batch_stock AS
WITH moves AS (
  SELECT r.line, rl.sku, rl.batch_number, rl.qty_used AS qty
    FROM requisition_lines rl JOIN requisitions r ON r.id = rl.requisition_id
   WHERE r.status = 'done' AND rl.batch_number IS NOT NULL
  UNION ALL
  SELECT e.line, cu.component_sku, cu.batch_number, -(cu.qty_used + cu.wastage)
    FROM component_usage cu JOIN schedule_entries e ON e.id = cu.entry_id
   WHERE cu.batch_number IS NOT NULL
  UNION ALL
  SELECT line, sku, batch_number, qty
    FROM line_stock_adjustments WHERE batch_number IS NOT NULL
)
SELECT m.line, m.sku AS component_sku, m.batch_number,
       SUM(m.qty) AS quantity_remaining,
       MAX(cb.expiry_date) AS expiry_date
  FROM moves m
  LEFT JOIN component_batches cb
         ON cb.component_sku = m.sku AND cb.batch_number = m.batch_number
 GROUP BY m.line, m.sku, m.batch_number;

-- Non-batch-tracked raw materials at a line: sent vs used, balance carried
-- forward. Replaces the artifacts' rawMaterialBalances collection.
CREATE VIEW raw_material_balances AS
WITH sent AS (
  SELECT r.line, rl.sku, MAX(rl.description) AS description, SUM(rl.qty_used) AS qty
    FROM requisition_lines rl JOIN requisitions r ON r.id = rl.requisition_id
   WHERE r.status = 'done' AND rl.needs_batch = false
   GROUP BY r.line, rl.sku
  UNION ALL
  SELECT line, sku, MAX(description), SUM(qty)
    FROM line_stock_adjustments WHERE batch_number IS NULL
   GROUP BY line, sku
), used AS (
  SELECT e.line, cu.component_sku AS sku, SUM(cu.qty_used + cu.wastage) AS qty
    FROM component_usage cu JOIN schedule_entries e ON e.id = cu.entry_id
   WHERE cu.batch_number IS NULL
   GROUP BY e.line, cu.component_sku
), keys AS (
  SELECT line, sku FROM sent UNION SELECT line, sku FROM used
)
SELECT k.line, k.sku,
       COALESCE((SELECT MAX(description) FROM sent s WHERE s.line = k.line AND s.sku = k.sku), '') AS description,
       COALESCE((SELECT SUM(qty) FROM sent s WHERE s.line = k.line AND s.sku = k.sku), 0) AS sent_total,
       COALESCE((SELECT SUM(qty) FROM used u WHERE u.line = k.line AND u.sku = k.sku), 0) AS used_total
  FROM keys k;
