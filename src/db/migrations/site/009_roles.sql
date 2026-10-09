-- Roles for this site and its activity log. (Users are platform-wide — see
-- platform/002_users.sql — with a role and lines per site.)
--
-- A role sets, per area, 'none' (hidden) / 'view' / 'edit', plus actions:
--   unleashed     send to Unleashed and export CSVs
--   approve       approve truck sheets (Stock Collections)
--   manageUsers   the Users & Roles page

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

CREATE TABLE activity_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    int,
  user_name  text NOT NULL,
  action     text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  support    boolean NOT NULL DEFAULT false   -- done by platform support
);
CREATE INDEX activity_log_at_idx ON activity_log(at DESC);
