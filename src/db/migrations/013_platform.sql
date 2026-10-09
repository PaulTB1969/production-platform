-- The platform: admins (Paul, later staff) who look after customers, and
-- customers with their sites. A site is one Unleashed account; a customer
-- (separate legal entities) can have several.
--
-- Unleashed API keys are stored encrypted (AES-256-GCM, MASTER_KEY in the
-- server's environment) and are never sent back to the browser.

CREATE TABLE platform_admins (
  id                     serial PRIMARY KEY,
  name                   text NOT NULL,
  email                  text NOT NULL UNIQUE,      -- lower case
  password_hash          text NOT NULL,
  must_change_password   boolean NOT NULL DEFAULT true,
  active                 boolean NOT NULL DEFAULT true,
  session_version        int NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_login_at          timestamptz
);

CREATE TABLE customers (
  id                serial PRIMARY KEY,
  name              text NOT NULL,
  registration_no   text,
  vat_no            text,
  contact_name      text,
  contact_email     text,
  contact_phone     text,
  address           text,
  notes             text,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- Billing (plan, price, start date) is added here later.
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id                      serial PRIMARY KEY,
  customer_id             int NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  name                    text NOT NULL,
  -- Unleashed connection
  api_id                  text NOT NULL,
  api_key_enc             text NOT NULL,
  api_base_url            text NOT NULL DEFAULT 'https://api.unleashedsoftware.com',
  -- Imported from Unleashed (Test & import)
  unleashed_company_guid  text UNIQUE,              -- the same account can't be added twice
  company_name            text,
  base_currency           text,
  default_tax_rate        numeric,
  warehouses              jsonb NOT NULL DEFAULT '[]',   -- [{code, name, city, isDefault, obsolete}]
  product_group_count     int,
  product_counts          jsonb,                         -- {total, batchTracked, serialized}
  tracking_detected       text CHECK (tracking_detected IN ('batch', 'serial', 'both', 'none')),
  tracking_override       text CHECK (tracking_override IN ('batch', 'serial', 'both', 'none')),
  imported_at             timestamptz,
  import_error            text,
  -- Per-site settings (warehouse roles, destinations, trucks, number series, …) — phase 3.
  settings                jsonb NOT NULL DEFAULT '{}',
  time_zone               text NOT NULL DEFAULT 'Africa/Johannesburg',
  support_access          boolean NOT NULL DEFAULT true,
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sites_customer_idx ON sites(customer_id);

CREATE TABLE platform_activity (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  admin_id    int,
  admin_name  text NOT NULL,
  action      text NOT NULL,
  customer_id int,
  site_id     int,
  detail      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX platform_activity_at_idx ON platform_activity(at DESC);
