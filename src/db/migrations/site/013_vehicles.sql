-- Vehicles for Stock Collections: the trucks (RML, MFE, and any added
-- later) and the built-in "Interim transfer" — stock moved in Unleashed
-- straight from PRD to the destination ahead of the physical delivery, so
-- the order team there can work with it. Its stock still travels on a truck
-- later: carried_by says which, and that truck doesn't transfer it again.

CREATE TABLE vehicles (
  code        text PRIMARY KEY,                -- used on loads, sheets and dispatches
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'truck' CHECK (kind IN ('truck', 'interim')),
  active      boolean NOT NULL DEFAULT true,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO vehicles (code, name, kind, position) VALUES
  ('RML', 'RML', 'truck', 1),
  ('MFE', 'MFE', 'truck', 2),
  ('INTERIM', 'Interim transfer', 'interim', 100);

ALTER TABLE collection_loads ADD COLUMN carried_by text;
