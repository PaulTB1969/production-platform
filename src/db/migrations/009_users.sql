-- Individual logins, editable roles, lines per user, and an activity log.
--
-- A role sets, per area, 'none' (hidden) / 'view' / 'edit', plus actions:
--   unleashed     send to Unleashed and export CSVs
--   approve       approve truck sheets (Stock Collections)
--   manageUsers   the Users & Roles page
-- A user signs in with email or cell number. lines = the production lines
-- they work on; empty = all lines.

CREATE TABLE roles (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  areas       jsonb NOT NULL,     -- {"schedule":"edit","requisitions":"view","collections":"none"}
  actions     jsonb NOT NULL,     -- {"unleashed":true,"approve":false,"manageUsers":false}
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles (name, areas, actions) VALUES
  ('Admin', '{"schedule":"edit","requisitions":"edit","collections":"edit"}', '{"unleashed":true,"approve":true,"manageUsers":true}'),
  ('Production manager', '{"schedule":"edit","requisitions":"edit","collections":"edit"}', '{"unleashed":true,"approve":true,"manageUsers":false}'),
  ('Line operator', '{"schedule":"edit","requisitions":"view","collections":"none"}', '{"unleashed":false,"approve":false,"manageUsers":false}'),
  ('Warehouse team', '{"schedule":"view","requisitions":"edit","collections":"edit"}', '{"unleashed":false,"approve":false,"manageUsers":false}');

CREATE TABLE users (
  id                     serial PRIMARY KEY,
  name                   text NOT NULL,
  email                  text UNIQUE,          -- lower case
  cell                   text UNIQUE,          -- digits, local format, e.g. 0821234567
  password_hash          text NOT NULL,
  must_change_password   boolean NOT NULL DEFAULT true,
  role_id                int NOT NULL REFERENCES roles(id),
  lines                  text[] NOT NULL DEFAULT '{}',
  active                 boolean NOT NULL DEFAULT true,
  -- Bumped on password change / deactivation: signs that user out everywhere.
  session_version        int NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_login_at          timestamptz,
  CHECK (email IS NOT NULL OR cell IS NOT NULL)
);

-- App-wide settings (e.g. whether the shared login still works).
CREATE TABLE settings (
  name   text PRIMARY KEY,
  value  jsonb NOT NULL
);
INSERT INTO settings (name, value) VALUES ('sharedLoginEnabled', 'true');

CREATE TABLE activity_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    int,
  user_name  text NOT NULL,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX activity_log_at_idx ON activity_log(at DESC);
