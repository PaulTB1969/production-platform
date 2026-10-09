# Production Platform

*Working name.* Production-floor management for companies that use
**Unleashed**: production schedules, raw-material requisitions with pick
lists, finished-goods collections and truck loading, sample-retention (QC)
forms, and sending Parked assemblies and transfers to Unleashed — for many
customers, each with one or more Unleashed accounts.

- **Plan and decisions:** [docs/PLAN.md](docs/PLAN.md)
- **Features as built for Mountain Falls:** [docs/FEATURES-mountain-falls.md](docs/FEATURES-mountain-falls.md)

## How it's organised

- **Customers → sites.** A site is one Unleashed account. Each site's data
  lives in its own Postgres schema (`site_<id>`); the platform's own tables
  (customers, sites, users, support sessions) are in `public`.
- **Admin console** at `/admin` for the platform owner: customers, sites,
  encrypted Unleashed keys, Test & import, tracking mode, support sessions.
- **Customer users** sign in at `/login` with email or cell number. A user
  belongs to a customer and has a role and production lines per site, with a
  site switcher when they have more than one.
- **Support sessions:** the admin opens a customer's site with a reason —
  view-only unless edit is chosen, 2 hours, logged, visible to the customer,
  who can switch support access off.

## Run it locally

```bash
npm install
npm run seed -- you@example.com      # demo customer, site, BOMs and a site admin
npm run admin:create -- "Your Name" you@example.com   # a platform admin for /admin
npm run dev
npm test
```

Without `DATABASE_URL` it uses PGlite (Postgres in WebAssembly) in `./.data`.
Settings are in `.env` (see `.env.example`); `MASTER_KEY` is required in
production.
