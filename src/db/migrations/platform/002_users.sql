-- Customer users: one login per person, belonging to a customer, with access
-- to one or more of that customer's sites — a role (from the site's own
-- roles table) and production lines per site.
-- Sign-in ID: email or cell number (unique across the platform).

CREATE TABLE users (
  id                     serial PRIMARY KEY,
  customer_id            int NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  name                   text NOT NULL,
  email                  text UNIQUE,          -- lower case
  cell                   text UNIQUE,          -- digits, local format, e.g. 0821234567
  password_hash          text NOT NULL,
  must_change_password   boolean NOT NULL DEFAULT true,
  active                 boolean NOT NULL DEFAULT true,
  -- Bumped on password change / reset / deactivation: signs that user out everywhere.
  session_version        int NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_login_at          timestamptz,
  CHECK (email IS NOT NULL OR cell IS NOT NULL)
);
CREATE INDEX users_customer_idx ON users(customer_id);

CREATE TABLE site_access (
  user_id   int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id   int NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  role_id   int NOT NULL,                     -- roles.id in that site's schema
  lines     text[] NOT NULL DEFAULT '{}',     -- empty = all lines
  PRIMARY KEY (user_id, site_id)
);
CREATE INDEX site_access_site_idx ON site_access(site_id);

-- Platform support visits to a customer's site: named, with a reason,
-- time-limited, view-only unless switched to edit. Shown to the customer.
CREATE TABLE support_sessions (
  id          serial PRIMARY KEY,
  admin_id    int NOT NULL REFERENCES platform_admins(id),
  admin_name  text NOT NULL,
  site_id     int NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  mode        text NOT NULL DEFAULT 'view' CHECK (mode IN ('view', 'edit')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  ended_at    timestamptz
);
CREATE INDEX support_sessions_site_idx ON support_sessions(site_id, started_at DESC);
