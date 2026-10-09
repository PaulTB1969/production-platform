-- Stock Collection, third shape (Oct 2026), matching the paper process:
--   * the day's LIST: sections (destinations) with SKU + quantity requested
--     (collection_lines.qty is now "Qty Req");
--   * one TRUCK SHEET per truck per day: the same list with Qty Trf and Batch
--     filled in for what went on that truck (collection_loads);
--   * the warehouse marks a sheet Loaded, then it's Approved, which creates
--     one transfer per section on that truck (collection_dispatches);
--   * the second leg HLD -> destination is one transfer per destination
--     covering every truck's loads (collection_arrivals).
-- Batch is free text, as written on the sheets ("20261007",
-- "20261007 (215) 20261005 (1)").

CREATE TABLE truck_sheets (
  date         date NOT NULL,
  truck        text NOT NULL,
  loaded_at    timestamptz,
  approved_at  timestamptz,
  PRIMARY KEY (date, truck)
);

CREATE TABLE collection_arrivals (
  id                bigserial PRIMARY KEY,
  collection_id     text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  transfer_number   text,
  exported_at       timestamptz,
  guid              text,
  send_started_at   timestamptz,
  send_error        text
);

CREATE TABLE collection_loads (
  id            bigserial PRIMARY KEY,
  line_id       bigint NOT NULL REFERENCES collection_lines(id) ON DELETE CASCADE,
  truck         text NOT NULL,
  qty           numeric NOT NULL DEFAULT 0,
  batch         text,
  dispatch_id   bigint REFERENCES collection_dispatches(id),
  arrival_id    bigint REFERENCES collection_arrivals(id),
  UNIQUE (line_id, truck)
);

-- Carry over the previous shape: a line with a truck becomes a load on that
-- truck (same qty and batch, same dispatch); its arrival, if any, becomes an
-- arrival row.
INSERT INTO collection_loads (line_id, truck, qty, batch, dispatch_id)
  SELECT id, truck, qty, batch_number, dispatch_id FROM collection_lines WHERE truck IS NOT NULL
  ON CONFLICT (line_id, truck) DO NOTHING;

INSERT INTO collection_arrivals (collection_id, created_at, transfer_number, exported_at, guid, send_started_at)
  SELECT collection_id, COALESCE(arrival_exported_at, now()), transfer_number, arrival_exported_at, arrival_guid, arrival_send_started_at
    FROM collection_dispatches
   WHERE arrival_exported_at IS NOT NULL OR arrival_send_started_at IS NOT NULL;
UPDATE collection_loads l SET arrival_id = a.id
  FROM collection_dispatches d JOIN collection_arrivals a ON a.collection_id = d.collection_id
 WHERE l.dispatch_id = d.id AND (d.arrival_exported_at IS NOT NULL OR d.arrival_send_started_at IS NOT NULL);

-- A truck that was already dispatched counts as approved.
INSERT INTO truck_sheets (date, truck, loaded_at, approved_at)
  SELECT DISTINCT c.date, d.truck, MIN(d.created_at), MIN(d.created_at)
    FROM collection_dispatches d JOIN collections c ON c.id = d.collection_id
   GROUP BY c.date, d.truck
  ON CONFLICT DO NOTHING;

ALTER TABLE collection_lines DROP COLUMN truck, DROP COLUMN dispatch_id, DROP COLUMN batch_number;
ALTER TABLE collection_dispatches
  DROP COLUMN arrival_exported_at, DROP COLUMN arrival_guid, DROP COLUMN arrival_send_started_at;
-- transfer_number on a dispatch is now always its own leg (PRD -> CPT/HLD);
-- for HLD destinations the old reserved arrival number moves to hld_transfer_number's place.
UPDATE collection_dispatches SET transfer_number = hld_transfer_number WHERE hld_transfer_number IS NOT NULL;
ALTER TABLE collection_dispatches DROP COLUMN hld_transfer_number;
