# HandyMan-AI

A multi-location field-service platform for handyman companies, with a **full double-entry
accounting system built in**. No QuickBooks sync, no external ledger — the books live here.

- **Office:** CRM, scheduling & dispatch, quoting, invoicing, purchasing, inventory, payroll
  inputs, and a complete general ledger with period close.
- **Field:** an offline-first PWA for phones and tablets — job checklists, before/after photos,
  on-site quoting, change orders with customer e-signature, van stock consumption, time clock.
- **Separation of duties:** accounting users and field users share one database and see
  entirely different worlds. Technicians never see cost or margin — not in the UI, and not in
  the API payload.

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/00-product-blueprint.md`](docs/00-product-blueprint.md) | The concept, the role matrix, the module map, and **the gap analysis** — 29 things a build like this needs that aren't obvious at the start |
| [`docs/01-accounting-design.md`](docs/01-accounting-design.md) | Chart of accounts, the posting-rule table for every business event, job costing and labor burden, sales tax, and the ledger safeguards |
| [`docs/02-data-migration.md`](docs/02-data-migration.md) | The import wizard: order of operations, opening balances, dry run, reconciliation proof, rollback, and demo-vs-live isolation |
| [`docs/03-demo-script.md`](docs/03-demo-script.md) | A 25-minute customer demo, in four acts |

## Data model

`prisma/schema.prisma` — 68 models covering tenancy and RBAC, CRM and properties, the price
book, jobs and field work, multi-warehouse and van inventory, purchasing and AP, invoicing and
AR, the general ledger, sales tax, audit, the import pipeline, and the offline sync outbox.

Two rules run through all of it:

- **Money is `BigInt` minor units.** No floats anywhere near the ledger.
- **Every journal line carries dimensions** (`locationId`, `jobId`, `technicianId`,
  `serviceTypeId`), which is what produces P&L by location and margin by job without a
  separate reporting database.

## Stack

Next.js (App Router) · PostgreSQL + Prisma · PWA with a service worker and IndexedDB outbox
for offline field work · object storage for job photos.

## Getting started

```bash
npm install
cp .env.example .env          # point DATABASE_URL at your Postgres
npx prisma db push
npm run db:seed               # seeds the Apex Handyman demo company
```

## Status

Foundation stage: architecture, accounting design, and data model are complete and the schema
validates. Application code is next — see the build order in the blueprint.
