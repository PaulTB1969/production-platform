-- Stock Collection, reworked (Oct 2026): the truck belongs to each SKU line,
-- not the collection — one truck can carry several destinations, and a line
-- can be split across trucks by quantity. Each truck is dispatched when it
-- leaves: one "dispatch" per collection per truck trip, i.e. one Unleashed
-- transfer (PRD -> CPT, or PRD -> HLD and later HLD -> destination).
--
-- A dispatch row holds what the collection row used to hold for its whole
-- self: numbers, export times, API ids. Lines point at the dispatch that
-- took them; dispatched lines are locked.

CREATE TABLE collection_dispatches (
  id                       bigserial PRIMARY KEY,
  collection_id            text NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
  truck                    text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  hld_transfer_number      text,          -- PRD -> HLD (not for Cape Town)
  transfer_number          text,          -- into the destination
  dispatch_exported_at     timestamptz,
  arrival_exported_at      timestamptz,
  dispatch_guid            text,
  arrival_guid             text,
  dispatch_send_started_at timestamptz,
  arrival_send_started_at  timestamptz,
  send_error               text
);
CREATE INDEX collection_dispatches_collection_idx ON collection_dispatches(collection_id);

ALTER TABLE collection_lines
  ADD COLUMN truck text,
  ADD COLUMN dispatch_id bigint REFERENCES collection_dispatches(id);

-- Carry over: every line takes its collection's truck; a collection already
-- dispatched becomes one dispatch holding all its lines.
UPDATE collection_lines l SET truck = c.truck FROM collections c WHERE c.id = l.collection_id;

INSERT INTO collection_dispatches (collection_id, truck, created_at, hld_transfer_number, transfer_number,
    dispatch_exported_at, arrival_exported_at, dispatch_guid, arrival_guid,
    dispatch_send_started_at, arrival_send_started_at, send_error)
  SELECT id, COALESCE(truck, 'RML'), COALESCE(dispatch_exported_at, now()), hld_transfer_number, transfer_number,
         dispatch_exported_at, arrival_exported_at, dispatch_guid, arrival_guid,
         dispatch_send_started_at, arrival_send_started_at, send_error
    FROM collections WHERE dispatch_exported_at IS NOT NULL OR dispatch_send_started_at IS NOT NULL;

UPDATE collection_lines l SET dispatch_id = d.id FROM collection_dispatches d WHERE d.collection_id = l.collection_id;

ALTER TABLE collections
  DROP COLUMN truck,
  DROP COLUMN status,
  DROP COLUMN hld_transfer_number,
  DROP COLUMN transfer_number,
  DROP COLUMN dispatch_exported_at,
  DROP COLUMN arrival_exported_at,
  DROP COLUMN dispatch_guid,
  DROP COLUMN arrival_guid,
  DROP COLUMN dispatch_send_started_at,
  DROP COLUMN arrival_send_started_at,
  DROP COLUMN send_error;
