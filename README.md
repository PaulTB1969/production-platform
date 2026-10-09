# Mountain Falls Production Hub

Production planning for the Hermanus site: the daily **Production Schedule**,
**Stock Requisitions** from the bulk store (PRD) to each line, **Stock
Collection** of finished goods to the regional warehouses, and the transfers
and assemblies for Unleashed. It replaces the Claude artifacts (Production
Hub, Production Schedule, Stock Requisition, Stock Collection). Their source is kept in
[`docs/legacy/`](docs/legacy/) as the reference for behaviour.

The main change from the artifacts: everything lives in **one Postgres
database**, so nothing has to be queued or bridged by hand.

| Artifact behaviour | Now |
| --- | --- |
| "Generate" queued a request for Claude to process | `POST /api/requisitions/generate` runs immediately |
| "Sync to Production Schedule" queue | Not needed: the schedule's batch picker reads requisitions directly |
| `lineComponentBatches`, `rawMaterialBalances` refreshed by Claude | SQL views `line_batch_stock` and `raw_material_balances`, always current |
| "Ask Claude to refresh" BOMs and batch stock | Unleashed API sync on a timer (`UNLEASHED_SYNC_MINUTES`) plus a "Sync now" button |
| Leased counter documents for MFB/MFR numbers | Row-locked counters inside the export transaction |
| A failed download risked a duplicate in Unleashed | Every export is stored and can be downloaded again without new numbers |

## Sending to Unleashed

**Send to Unleashed** (Stock Requisition and Production Schedule) creates
records straight in Unleashed through its API, as **Parked**, so someone
completes them in Unleashed as before. The CSV exports are still there as a
fallback. Use one or the other for a given requisition or job, not both.

- **Transfers:** each completed requisition becomes a Warehouse Stock Transfer
  from PRD to its line. Each line's batch number goes in that line's comment
  (the transfer API has no batch field, same as the CSV). Unleashed numbers
  them **TX-…**, and the app stores that number.
- **Assemblies:** each Done job becomes an Assembly from the line's warehouse
  into PRD, with the **actual** component quantities and wastage from the
  floor, durations, notes and the production person. The bottle and cap batch
  numbers are attached afterwards. Unleashed only accepts them once those
  batches are in the line's warehouse, i.e. after the requisition transfer is
  completed in Unleashed. Until then they're marked pending and attached on
  the next send. Unleashed numbers assemblies **ASM-…**.
- **Not possible via the API:** the finished-goods batch number
  (`20261007 UWH 1`). Unleashed only takes batch numbers that already exist,
  so it's typed in when completing the assembly in Unleashed. The app shows it,
  and it's in the assembly's comments. The assemblies CSV does set it.
- **No duplicates:** the app records that a send started before calling
  Unleashed. If the reply is lost, the next send looks for the record by the
  `[PH <id>]` tag in its comments and uses it instead of creating another.
  A record sent through the API can't have its "exported" flag cleared.
- `PRODUCTION_EMAIL` must be an Unleashed user. It's
  `nicolette@mountainfalls.co.za`; the old artifacts had a typo (`nicolotte`).

Verified against the live account on 6 Oct 2026 with
`scripts/unleashed-live-check.js`, which creates one labelled Parked test
transfer and one test assembly. `--delete` removes them.

## Stock Collection

Built to match the paper process (the "Stock collection <date> list / RML /
MFE" sheets):

1. **List** — the day's collection list: sections (CPT, RML-JHB, ZARMI-JHB,
   PE, …) with SKU and **Qty Req**. Upload it as a CSV (Date,
   Destination, SKU, Quantity; the destination is a warehouse code, and the
   heading "Digistics (Wed Collection)" goes into CPT), or type it in. Uploading
   again updates Qty Req by SKU. The List tab shows what each truck took and
   what's left.
2. **Truck sheets** (RML, MFE) — the same list, where the warehouse fills in
   **Qty Trf** and **Batch** for what went on that truck. The batch is typed as
   on paper (`20261007`, `20261007 (215) 20261005 (1)`), with suggestions.
   Qty Trf may differ from Qty Req. Pallets (MF_PALLETS, CHEP_PALLETS) are lines
   like any other. Only finished goods Unleashed batch-tracks need a batch.
3. **Mark loaded** (warehouse), then **Approve** — "Approve & send to
   Unleashed" (or "Approve by CSV", MFT-… numbers) makes **one Parked transfer
   per section on that truck**: Cape Town PRD → CPT, the rest
   PRD → HLD. An approved sheet is locked. "Undo CSV approval" is there for a
   CSV that wasn't uploaded.
4. **Second leg** — per destination, both trucks together: "Arrived — send
   HLD → ZARMI-JHB" (or CSV) once delivered.

Tables: `collections` (one per date + section), `collection_lines` (Qty
Req), `collection_loads` (per line per truck: Qty Trf, batch, dispatch,
arrival), `truck_sheets` (loaded / approved), `collection_dispatches` and
`collection_arrivals` (one Unleashed transfer each). Duplicate protection
tags: `[PH cd<id>]` and `[PH ca<id>]`. `test/collections.test.js` replays
the real 7 Oct 2026 sheets: 6 transfers (Digistics inside CPT), then 2 second legs.

## Look and feel

The look follows mountainfalls.co.za: the Mountain Falls logo, black and white on
a warm off-white, Instrument Sans, and square capitalised buttons. The site's
heading font (sweet-gothic) is an Adobe font licensed to the website, so
Tenor Sans stands in. The logo source is `assets/mf-logo-source.png`.

## Signing in, users and roles

Each person has their own login (⋮ → Users & Roles, admins only). They sign in
with their email or cell number. A new user, or a password reset, gets a
one-time password. The admin passes it on, and the person chooses their own
password at first sign-in. Each device stays signed in for 90 days. A password
change, a reset or switching a user off signs that person out everywhere.
After 10 wrong attempts, that address is blocked for 15 minutes.

- **Roles** set, per area (Production Schedule, Raw Material Requisitions,
  Stock Collections), *None* (hidden), *View* or *Edit*. They also set three
  actions: send to Unleashed / export CSVs, approve truck sheets, and manage
  users. The server checks every request; the screens hide what a role can't use.
- **Production lines** per user limit the schedule and requisitions to those
  lines. No lines means all lines.
- **Sent by**: sends to Unleashed add "· Sent by <name>" to the Comments.
  Unleashed's Created By stays the API key's owner.
- **Activity**: every change is logged with who made it (Users & Roles → Activity).

The shared login (`APP_USER` / `APP_PASSWORD` in the server's `.env`) has full
access until it is switched off on the Users & Roles page. You must be signed
in with your own admin login to switch it off. The app won't allow a change
that leaves no active admin while the shared login is off. Changing
`APP_PASSWORD` (then restarting the app) signs every device out. Scripts can
send the shared credentials as a Basic auth header.

To see the current password: `ssh production-hub "grep APP_PASSWORD /opt/production-hub/.env"`

## Using it on phones and iPads

It's a website, so any browser works. To get an app icon:
- **iPhone / iPad (Safari):** Share → **Add to Home Screen**.
- **Android (Chrome):** menu ⋮ → **Add to Home screen** / **Install app**.

Exports and the Excel download are easiest from a laptop. Home-screen apps on
iPhone open downloaded files in a preview instead of saving them.

## Excel copy

**Download as Excel** on the hub (`GET /api/workbook.xlsx?from=&to=`) gives one
workbook: Schedule, Batch usage, Requisitions, Line batch stock and Raw material
balance. It's a read-only copy for reporting, and nothing is read back from it.
The database is always the live data. Batch numbers are text cells, so Excel
never turns one into a date.

## Run it locally

You need Node 22 or later. Postgres is **not** needed locally: without
`DATABASE_URL` the app uses PGlite (Postgres compiled to WebAssembly) and
keeps its data in `./.data/pglite`.

```bash
npm install
npm run seed      # optional: demo BOMs and batches (local database only)
npm run dev       # http://localhost:3000
npm test          # unit tests + the full workflow against a real Postgres (PGlite)
```

To start over locally, stop the server and delete `.data/`.

## Deploy (Contabo VPS)

One VPS (Ubuntu 24.04) runs three containers: the app, Postgres 17, and
Caddy, which serves HTTPS with an automatic Let's Encrypt certificate. The
firewall (ufw) allows only SSH, 80 and 443. fail2ban blocks repeated SSH login
failures, and security updates install automatically.

The app lives in `/opt/production-hub` on the server. Its `.env` there holds
the production secrets and is never overwritten by a deploy.

**Deploying an update** (from Git Bash, in the repo, after committing):

```bash
scripts/deploy.sh
```

This copies the last commit over SSH (host alias `production-hub` in
`~/.ssh/config`), rebuilds and restarts. Migrations run automatically on start.

**Setting up a new server from scratch:** install Docker, then create
`/opt/production-hub/.env` from `.env.example` (mode 600). Generate
`POSTGRES_PASSWORD` with `openssl rand -hex 24`. Hex only, because it goes
inside the database URL. Set `SITE_DOMAIN` to a name pointing at the server.
Then run `scripts/deploy.sh`.

**Backups:** a cron job (`/etc/cron.d/production-hub-backup`) dumps the
database to `/opt/production-hub/backups/hub-YYYY-MM-DD.sql.gz` at 02:00 every
night and keeps 14 days. To copy one to this PC:
`scp production-hub:/opt/production-hub/backups/hub-2026-10-05.sql.gz .`
To restore (this replaces the current data):
`gunzip -c hub-DATE.sql.gz | docker compose exec -T db psql -U hub -d hub`, run
on an empty database.

## Secrets

`.env` holds every secret and is git-ignored. Never commit it, paste it into
chat, or put it in a ticket. The app refuses to start in production without
`DATABASE_URL`, `APP_USER` and `APP_PASSWORD`. The Unleashed key is only used
to sign API requests, and is never logged.

## Unleashed

`src/unleashed/sync.js` pulls `/StockOnHand` for PRD (every product's quantity in the bulk store, used by the pick list), `/BillOfMaterials` (recipes, with each component's
batch-tracked flag, expected duration and auto-assign setting) and
`/BatchNumbers` (available bulk-store batches in `PRD`). The field mapping was
checked against the live account on 1 Oct 2026, and `test/unleashed.test.js`
pins it. If Unleashed changes something, `npm run unleashed:probe` (read-only)
prints a sample record per resource.

Exports are still CSV files for Unleashed's import screens, in exactly the
artifacts' formats. Posting assemblies and transfers straight to the API is a
possible next step.

## How it fits together

```
src/
  domain/      pure business rules (no I/O), ported from the artifacts — tested directly
  services/    database reads/writes and transactions
  routes/      JSON API under /api
  unleashed/   API client, sync, probe
  db/          adapter (pg or PGlite), migrations, seed
public/        the three screens (plain HTML + ES modules, no build step), icons, manifest
scripts/       make-icons.js — builds public/brand/ and public/icons/ from assets/mf-logo-source.png (needs the dev dependency pngjs); deploy.sh
test/          node:test — domain rules and the end-to-end workflow
```

### Rules worth knowing

- **Lines** are stored as the exact Unleashed warehouse codes:
  `PRD - UWH`, `PRD - LWH`, `PRD - AQB`. The schedule also allows `Other`.
- **Job status** stores only `done`. `scheduled` / `in progress` are derived
  from whether actuals or batch usage have been recorded. Product, line, cases
  and date are locked once anything is recorded.
- **Generation**: for each line, sum `qtyPerUnit × plannedCases` over that
  line's still-scheduled jobs. Non-batch-tracked materials are reduced by the
  balance already at the line. A line that already has a requisition for that
  date is skipped.
- **Line stock** = sent by completed requisitions − (used + wastage) recorded
  on the schedule ± manual adjustments (`line_stock_adjustments`).
- **Completed requisitions** can be reopened until exported. After export they
  are locked, because Unleashed already has the transfer.

### Assumptions to confirm

- Wastage counts as consumed stock at the line, for both batch-tracked
  batches (as the artifact's over-draw check did) and the non-batch balances.
- Generated quantities are not rounded up to pack sizes. The team edits the
  quantity sent, as before.

## Cutover from the artifacts

1. Run both side by side. The artifacts keep working until the cutover is
   proven.
2. Load live data: today's and future schedule entries, open requisitions, and
   the current line balances as `line_stock_adjustments` (reason "opening
   balance from artifact"). Set the `counters` rows to the artifacts' next
   MFB/MFR numbers so numbering continues without gaps or clashes.
3. Switch the team to the new URL.
