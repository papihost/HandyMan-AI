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

`prisma/schema.prisma` — 69 models covering tenancy and RBAC, CRM and properties, the price
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

## Testing

```bash
npm test          # 119 tests: unit + integration against Postgres
npm run typecheck
```

Integration tests run against a real database rather than a mock, because the guarantees
under test *are* database guarantees — deferred balance constraints, immutability triggers,
and row locks on the document-number sequence. A mock would prove nothing about any of them.

## Status

**Built**

- Data model — 69 models.
- Authentication and RBAC, with tenant scoping and cost redaction enforced at the
  data-access layer.
- Double-entry posting engine, period control, gapless document numbering, and
  database-level ledger guards.
- Posting rules for invoicing, payments, inventory movements and labor with burden.
- Ledger-backed reporting: trial balance, income statement, balance sheet, P&L by branch.
- Customers and properties, with duplicate detection.
- Price book with location and customer-tier price resolution.
- Sales tax as a per-jurisdiction rules engine, resolved on the service address.
- Quoting with good/better/best option sets, e-signature approval, and conversion to a job.
- Jobs with an explicit lifecycle state machine.
- Invoicing that posts itself to the ledger, deposits held as a liability until earned,
  payments, and AR aging.
- Job costing read from the general ledger rather than from a summary table.

The full path is covered end to end by `tests/workflow.test.ts`: a quote approved in the
field becomes a job, the job becomes an invoice, the invoice posts to the general ledger,
and the margin on that job is read back off the same journal lines the P&L is built from.

**Next:** inventory with van stock, the offline field PWA, the import wizard, and the demo
seed. See the build order in the blueprint.

## Architecture notes

### Two-layer access control

`scopedDb(client, ctx)` returns a Prisma client bound to one caller. Every read and write
on every model with an `organizationId` gets the caller's organization injected into its
filter, and every create gets it stamped on — so a handler that forgets a `where` clause
cannot leak another company's data, and a create cannot write into another tenant even if
it is told to.

The same extension removes cost and margin columns from the *query* for callers without
`finance:read_cost`. A technician's request never fetches `costCents`, so the value is
never serialized, never logged, and never sits in a payload waiting for someone to open
dev tools. Handlers still check permissions explicitly; this exists so that one which
forgets is contained rather than catastrophic.

### Sessions

Opaque 256-bit random tokens; only the SHA-256 hash is stored. Passwords use scrypt from
Node's standard library — memory-hard, and no native module to fail at install. Sign-in
failures are deliberately indistinguishable across unknown email, wrong password,
deactivated and locked accounts, and all pay the same hashing cost, so none of it is a
user-enumeration oracle.

Field devices get 30-day sessions: a technician in a crawl space cannot re-authenticate.
