-- Sample Retention forms (Food Safety System, Doc No 128), one per
-- production date per form: UWH, and LWH (which also carries AcquaBox).
-- The rows are the day's products on the Production Schedule; results holds
-- what was filled in per product: {"P500ST_MF": {"test":"Y","time":"09:15","pass":"Y"}}.
-- Signatures are PNG data URLs drawn on screen.

CREATE TABLE sample_forms (
  id                  serial PRIMARY KEY,
  date                date NOT NULL,
  form                text NOT NULL CHECK (form IN ('UWH', 'LWH')),
  results             jsonb NOT NULL DEFAULT '{}',
  taken_by_name       text,
  taken_by_user_id    int,
  taken_signature     text,
  taken_date          date,
  taken_at            timestamptz,
  signoff_name        text,
  signoff_user_id     int,
  signoff_signature   text,
  signoff_at          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (date, form)
);

-- New area and action on the existing roles. Line operators take the samples;
-- admins and production managers sign off.
UPDATE roles SET areas = areas || jsonb_build_object('samples',
  CASE WHEN name IN ('Admin', 'Production manager', 'Line operator') OR (actions->>'manageUsers')::boolean
       THEN 'edit' ELSE 'none' END);
UPDATE roles SET actions = actions || jsonb_build_object('samplesSignOff',
  name IN ('Admin', 'Production manager') OR (actions->>'manageUsers')::boolean);
