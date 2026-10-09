-- Stock Collection: finished goods collected from Hermanus (PRD) for a
-- destination warehouse. Ported from the Stock Collection artifact
-- (docs/legacy/stock-collection.html).
--
-- Cape Town is one transfer, PRD -> CPT. Every other destination is two:
-- PRD -> HLD (holding) when it leaves Hermanus ("dispatch"), then
-- HLD -> destination once delivery is confirmed ("arrival").
--   hld_transfer_number  the PRD -> HLD leg (not used for CPT)
--   transfer_number      the leg into the destination (PRD -> CPT, or HLD -> dest)
-- By CSV both are MFT-… numbers reserved at dispatch; sent via the API they
-- are Unleashed's TX-… numbers, the second one filled in at arrival.

CREATE TABLE collections (
  id                       text PRIMARY KEY,
  date                     date NOT NULL,
  destination              text NOT NULL,
  driver                   text NOT NULL DEFAULT '',
  truck                    text,
  status                   text CHECK (status IS NULL OR status = 'done'),   -- 'done' = collected
  group_id                 text NOT NULL,          -- split collections share it
  seq                      int  NOT NULL DEFAULT 1,
  hld_transfer_number      text,
  transfer_number          text,
  dispatch_exported_at     timestamptz,
  arrival_exported_at      timestamptz,
  -- Sent via the API (as with requisitions; see unleashedSend.js).
  dispatch_guid            text,
  arrival_guid             text,
  dispatch_send_started_at timestamptz,
  arrival_send_started_at  timestamptz,
  send_error               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collections_date_idx ON collections(date);
CREATE INDEX collections_group_idx ON collections(group_id);

CREATE TABLE collection_lines (
  id             bigserial PRIMARY KEY,
  collection_id  text NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  position       int  NOT NULL DEFAULT 0,
  sku            text NOT NULL,
  description    text NOT NULL DEFAULT '',
  batch_number   text,
  qty            numeric NOT NULL DEFAULT 0
);
CREATE INDEX collection_lines_collection_idx ON collection_lines(collection_id);

-- MFT-… numbers for the collection CSVs (none exist in Unleashed yet).
INSERT INTO counters (name, next) VALUES ('collection_transfer', 1);

ALTER TABLE exports DROP CONSTRAINT exports_kind_check;
ALTER TABLE exports ADD CONSTRAINT exports_kind_check
  CHECK (kind IN ('assemblies', 'wastage', 'transfer', 'dispatch', 'arrival'));
