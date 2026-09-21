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
| [`docs/04-field-sync.md`](docs/04-field-sync.md) | How the tablet works offline: intent-based sync, idempotent replay, conflict outcomes, and ledger authority |

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

## Running it

```bash
npm run build && npm start     # or: npm run dev
```

Open <http://localhost:3000>. Sign in as a technician from the seeded company —
`marcus.deleon@apexhandyman.test` with the password the seed prints — and the device pulls
that technician's week down. Turn the network off and keep working: the app is built for a
crawl space, not a coffee shop.

## Getting started

```bash
npm install
cp .env.example .env          # point DATABASE_URL at your Postgres
npm run db:deploy             # apply migrations
npm run db:seed               # build the Apex Handyman demo company
```

### The demo company

`npm run db:seed` builds **Apex Handyman Services** — three branches (Phoenix, Mesa,
Scottsdale), fourteen technicians with their own vans, ~600 customers, and twelve months of
trading history.

```bash
npm run db:seed                  # volume derived from headcount and utilization
DEMO_JOBS=300 npm run db:seed    # smaller and faster, for development
DEMO_SEED=42 npm run db:seed     # a different but equally reproducible company
```

The seed lays out the days either side of now deliberately: the morning's calls are
finished and invoiced, one technician is mid-job, the afternoon is still ahead, and the
rest of the week is booked. Left to the random month generator, "today" gets whatever
happens to land on it — frequently nothing, and a demo that opens on a technician with an
empty morning is over before it starts. Re-run the seed on the day you present.

Every financial figure is produced by the same posting engine the product uses. No journal
entry is written directly and no dashboard number is a fixture — the first thing a
prospect's controller does is drill into a figure, and if the trail ends at hardcoded data
the demo is over.

Three things the seed gets right that a naive one would not:

- **Volume is derived from headcount.** Fourteen technicians, 173 paid hours a month and a
  62% utilization rate determine how much work there has to be. A job count picked out of
  the air leaves technicians 97% idle and produces an income statement nobody believes.
- **Unbilled technician time is costed.** Drive time, shop time and the gaps between calls
  are paid, so they are cost of providing the service. Costing only billable hours is the
  most flattering mistake a field service system can make: it reports gross margins in the
  seventies for a trade that runs in the forties.
- **Operating expenses are posted.** Rent, advertising, office payroll, vehicles, insurance
  and depreciation, monthly, per branch where they belong to a branch. Without them net
  income equals gross profit and the P&L is obviously fake.

Sign in as any seeded user with the password printed by the seed. `diane.kowalczyk@` is the
controller (full ledger), `marcus.deleon@` is a technician (no cost, own jobs only).

Resetting is safe by construction: it refuses on any organization whose `dataMode` is not
`DEMO`, so a sales reset cannot reach a customer's real books.

## Testing

```bash
npm test          # 307 tests: unit + integration against Postgres
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
- Inventory across warehouses and per-technician vans: moving-average costing under row
  locks, transfers, consumption to COGS on a job, cycle counts with shrinkage, reorder
  suggestions, and a valuation that is asserted equal to the inventory accounts in the
  general ledger.
- Purchasing and payables: a technician's supply-house receipt becomes a vendor bill coded
  straight to the job, subcontracted work posts to its own account, and bills are paid in
  runs.
- The Apex Handyman demo company: three branches, fourteen technicians, ~4,500 jobs across
  twelve months, ~18,000 journal entries — all produced by the posting engine above.
- The import wizard: delimiter and header detection, per-column date-order and
  decimal-separator detection, automatic column mapping with a stated confidence and
  reason, validation, a dry run that really executes and is rolled back, opening balances
  through Opening Balance Equity, a reconciliation that proves the totals, and batch
  rollback.
- The field sync engine: a cost-free working set for a technician's device, and an outbox
  that replays intent rather than state — idempotent under retry, ordered by the device's
  own sequence, and settling each operation independently so one conflict does not strand a
  technician's day.
- The tablet app itself: an installable PWA with a service worker for the offline shell,
  IndexedDB for the day's work and queued photos, and screens for the whole visit — my day,
  the job with access notes and prior visits, parts off the van, quoting on site in
  good/better/best options priced from the book already on the device and accepted on the
  glass, before/after photos, a change order signed on the glass, and completion.
- The office web app. Every figure on every screen is read from posted journal lines or
  from the documents themselves — there is no summary table a report could disagree with.
  - **Dashboard** — the company's four numbers, then the findings: work nobody invoiced, a
    flat rate priced under what it costs, a branch whose margin goes on hours that never
    reached a job.
  - **Dispatch**, and **jobs** with ledger-backed costing that drills into the entries the
    job posted, and states what an hour of that technician's time actually costs.
  - **Quotes** — what is still out there, what it is worth, and a close rate measured
    against the quotes that got an answer rather than against everything ever sent.
  - **Invoices** — what was billed, the margin on it, and how the sales tax was worked out,
    jurisdiction by jurisdiction.
  - **Journal entries**, both sides, immutable, linking back to the document that caused
    them; **financial statements** with account drill-down; **receivables**.
  - **Price book review** — every flat rate against the cost it carries, thinnest first.
  - **Inventory** — valuation against the ledger accounts it must equal, what each van is
    carrying and short of, and every movement a part has made with the job it went out on.
  - **Close** — what is in the month, what is worth finishing first, the close itself, a
    reopening that insists on a reason, and every posting the lock has turned away.
- The migration wizard: the five entities in dependency order, detection you can overrule,
  a mapping table listed by target field with the reason for each match, validation that
  reruns as you change it, a dry run that really executes and is rolled back, the
  reconciliation, and a batch list with a reverse button. Sample exports ship with it, so a
  migration can be demonstrated without the customer's files in the room.

The full path is covered end to end by `tests/workflow.test.ts`: a quote approved in the
field becomes a job, the job becomes an invoice, the invoice posts to the general ledger,
and the margin on that job is read back off the same journal lines the P&L is built from.

**Next:** nothing is blocking a demo. The obvious things after that are inbound payment
capture from the field, a customer-facing portal, and scheduled service agreements moving
from the data model into screens.

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
