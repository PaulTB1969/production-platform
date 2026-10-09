# Production Platform: plan

*Working name. The product name and domain will be chosen later.*

Turning Production Hub (built for Mountain Falls) into a product for any company that uses Unleashed. The product is owned by Paul Beatham and is kept separate from Mountain Falls' code, server, domain and Unleashed account.

## Decisions so far (9 Oct 2026)

- **A new repository** under Paul's own GitHub account.
  - The Mountain Falls app (`production-hub`) carries on unchanged at production.mountainfalls.co.za.
  - Mountain Falls can later move onto this product as a customer.
- **One shared web address** for every customer. Each user signs in and sees only the sites they have access to.
- **The model is customer → sites:**
  - **Customer:** a company Paul deals with and bills.
  - **Site:** one Unleashed account. A customer can have several (separate legal entities).
  - Users can be given access to several sites of their customer, with a site switcher.
  - Nothing is ever sent from one site's Unleashed account to another.
- **Support access** for the platform admin (Paul): see "Support access" below.
- **Billing** is not tracked yet. The customer record is designed so it can be added later.
- **Development uses an Unleashed sandbox or test account, never a customer's live data.** Until one exists, development uses fake data. Reading live data is allowed only with permission.

## Data model

```
platform_admins           Paul (and later staff): sign in to the admin console
customers                 name, registration no, VAT no, billing contact (name/email/phone),
                          address, notes, status, created_at   (plan/price fields added later)
sites                     customer_id, name, Unleashed API id + key (encrypted), API base URL,
                          company name / currency / tax rate (imported), tracking mode
                          (batch | serial | both | none, detected + override), time zone,
                          settings (JSON: warehouse roles, destinations, trucks, number series,
                          batch-number format, form headers, branding), sync status,
                          support access setting
users                     customer_id, name, email/cell, password, active
site_users                user_id, site_id, role_id, lines[]   (a role per site)
roles                     per site (or customer): areas none/view/edit + actions
support_sessions          admin, site, reason, started/ended, mode (view | edit)
activity_log              + site_id, + support flag
every data table          + site_id NOT NULL, with every query limited to the current site
```

**Unleashed API keys:** encrypted with AES-256-GCM, using a master key held in the server's environment (`MASTER_KEY`). They are never sent back to the browser. They can be replaced but not viewed.

## Import from Unleashed (checked against the live API, read-only)

| Available | Not available |
|---|---|
| `/Companies`: company name, base currency, default tax rate | Company settings, such as "batch tracking on" (the API refuses the request) |
| `/Warehouses`: code, name, address, contact | |
| `/ProductGroups`, `/UnitOfMeasures`, `/Currencies` | |
| `/Products`: `IsBatchTracked`, `IsSerialized` per product | |

**Adding a site:**
1. Paste the API ID and key, then press **Test & import**.
2. The app reads the company and warehouses.
3. It detects the tracking mode from the product flags. If any product is batch-tracked, the mode includes batch; if any is serialised, it includes serial.
4. It proposes warehouse roles: bulk store, production lines, holding and destinations.
5. Paul or the customer admin confirms and saves.

The Companies `Guid` identifies the account, so the same Unleashed account can't be added twice by mistake.

## Support access (standard practice in SaaS)

- **The customer controls it.** Their admin has a setting: *Allow support access*, which is on by default and covered in the terms of service. They can switch it off at any time.
- **Each visit is a named session with a reason** ("checking sync error"). It is time-limited (2 hours) and **view-only by default**.
- **Making changes needs an explicit "edit mode"** switch, with its own reason.
- **It's visible:**
  - A banner shows "Support session (Paul, view only)" while the session is open.
  - Every action is logged with the support flag.
  - The customer can see these sessions in their activity log.
- **There is no access to passwords or API keys**, even in support mode.

## Tracking modes

Each site has a tracking mode of **batch / serial / both / none**.
- **Batch:** today's behaviour.
- **None:** no batch pickers, columns or batch fields in CSVs and payloads.
- **Serial:** serial capture per unit is a later phase, built when a real customer needs it. Until then, serialised products are flagged as "serials are entered in Unleashed".

## Phases

0. **New repository:** code copied from production-hub, Mountain Falls' artifacts and keys removed. ✔
1. **Platform foundation** ✔ (admin console at `/admin`; create the first admin with `npm run admin:create`):
   - platform admin login and console;
   - customers and sites, with encrypted keys;
   - Test & import from Unleashed;
   - the tracking-mode indicator.
2. **Tenancy:**
   - `site_id` on every table, and every query limited to the current site;
   - an Unleashed client and hourly sync for each site;
   - users, with access to several sites and a site switcher;
   - support sessions.
3. **Configuration:** move Mountain Falls' fixed settings into each site's settings, with a settings screen:
   - warehouse roles, destinations and routing, trucks;
   - number series, batch-number format;
   - the sample form header, branding;
   - the production-person email, time zone.
4. **Tracking-mode aware screens:** batch / none, with serial flagged.
5. **Hosting:**
   - own domain and server;
   - backups held off the server, and monitoring;
   - deploy script;
   - terms of service and privacy policy (POPIA).
6. **Mountain Falls as the first customer:** migrate their data from production-hub, if and when agreed.
7. **Later:** billing, Unleashed partner listing, webhooks, serial capture.

## What stays the same

The production features as they work at Mountain Falls:
- the schedule, requisitions, pick list and product groups;
- collections and truck sheets;
- sample retention;
- users and roles;
- the activity log;
- Parked sends with duplicate protection.
