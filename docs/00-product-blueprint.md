# HandyMan-AI — Product Blueprint

**One line:** A multi-location field-service operating system for handyman companies, with a
full double-entry accounting system built in. Nothing leaves the app — no QuickBooks, no
external ledger. Techs run the field side from a phone or tablet; accounting runs the books
from the same data, in the same product, behind a separate role wall.

---

## 1. Why this exists

A handyman company with several branches and dozens of techs currently runs on three or four
disconnected systems: a scheduling tool, a spreadsheet price book, QuickBooks, and a group
chat full of job photos. Every handoff between them is a place where margin leaks.

The thesis of this product: **the work order is the accounting document.** When a tech
closes a job on a tablet, the labor hours, the parts pulled off the van, the photos, the
signature, the invoice, and the journal entries that hit the general ledger are all one
transaction. Nobody re-keys anything. The controller opens the books on Monday and the
numbers are already right.

## 2. The two-sided access model

This is a hard requirement, not a preference. The same database serves two populations who
must not see each other's world.

| Role | Sees | Never sees |
|---|---|---|
| **Owner** | Everything, all locations | — |
| **Controller / Accountant** | Full GL, AP, AR, payroll, period close, all locations | Can be scoped to a subset of locations |
| **Bookkeeper** | Data entry into AP/AR, no period close, no COA edits | Payroll detail, net margin reports |
| **Branch Manager** | Their location's jobs, techs, schedule, P&L, margin | Other locations, payroll of other branches |
| **Dispatcher / CSR** | Schedule, customers, jobs, quotes at *sell price* | Any cost, any margin, any GL |
| **Technician** | Only their own assigned jobs, price book at *sell price* | Item cost, job margin, other techs' jobs, customer payment methods |
| **Subcontractor** | A single job they're assigned, limited fields | Everything else |
| **Customer (portal)** | Their own quotes, invoices, appointments, photos | Everything else |

Two enforcement layers, because one is never enough:

1. **Row-level scoping** — every business table carries `organizationId` + `locationId`.
   Queries are scoped at the data-access layer, not in the UI.
2. **Field-level redaction** — cost and margin columns are stripped from API responses for
   roles without the `finance:read_cost` permission. A technician who opens dev tools on the
   PWA must not find `unitCost` sitting in the JSON payload. This is the single most common
   way field-service apps leak cost data to the people quoting the jobs.

Permissions are named capabilities (`job:dispatch`, `gl:post`, `period:close`,
`inventory:adjust`, `finance:read_cost`, …) grouped into roles, so a customer can build their
own "Office Manager" role without a code change.

## 3. Module map

### Field operations
- **CRM** — customers, properties (a customer can own several), contacts, equipment installed
  at a property, service history per property.
- **Leads & estimates** — inbound call/web → lead → site visit → quote.
- **Quotes** — line items from the price book, good/better/best option sets, photos attached,
  e-signature approval, expiry, auto-conversion to a job on acceptance.
- **Work orders / jobs** — the spine. Lifecycle: `draft → quoted → approved → scheduled →
  dispatched → en_route → in_progress → on_hold → completed → invoiced → paid → closed`, plus
  `warranty_callback` as a linked child job.
- **Scheduling & dispatch** — drag-and-drop day/week board per location, capacity by tech,
  skill matching, travel-time awareness, multi-day and multi-visit jobs, recurring maintenance.
- **Service areas** — zip-code sets or geofences per location; drives which branch owns a lead.
- **Mobile field app (PWA)** — offline-first. Job list, checklists, photos, time clock, parts
  consumption, quote building on site, change orders, signature, payment capture.
- **Service agreements** — recurring maintenance contracts, deferred revenue recognition,
  auto-generated visits.

### Money
- **Price book** — parts, materials, labor rates, flat-rate task catalog with cost, markup
  matrix, and sell price. Location-level price overrides. Customer-specific pricing.
- **Inventory** — multi-warehouse **and every van is a stock location**. Receipts, transfers,
  consumption on job close, cycle counts, shrinkage, reorder points, serialized items,
  average-cost valuation posting to the GL.
- **Purchasing** — POs to supply houses, vendor bills, receipt capture from the field,
  3-way match, direct-to-job non-stock purchases.
- **Invoicing & AR** — deposits, progress billing, partial payments, credit memos, statements,
  aging, dunning.
- **Payments** — card / ACH via a tokenizing processor (no raw PAN ever touches our DB),
  card-on-file, merchant fees posted automatically.
- **Payroll inputs & labor burden** — hourly, overtime, commission and spiff plans; a burden
  multiplier (payroll taxes, workers' comp, benefits, vehicle, phone) so job costing reflects
  the *true* cost of an hour, not the wage.
- **Job costing & WIP** — labor, material, subcontractor, equipment, and overhead allocation
  per job. Margin by job, tech, service type, location, customer.
- **General ledger** — see `docs/01-accounting-design.md`.

### Governance
- **Audit trail** — append-only log of every mutation with actor, before/after, IP, device.
- **Period close & locking** — closed periods reject postings; reopening is a logged event.
- **Compliance** — tech license and insurance expiry per state/location, permits per job,
  lien waivers, 1099 vendor tracking.
- **Document retention** — photos with EXIF, GPS, and server-side timestamp as dispute evidence.

## 4. What you did not mention — and will need

You listed accounting, multi-location, techs, photos, quotes, inventory, prices and labor
cost. Here is what is missing from that list and why each one matters in practice.

### Will bite you in month one
1. **Scheduling and dispatch.** You described everything *around* the schedule but not the
   schedule. This is the screen a dispatcher lives in eight hours a day; it decides whether
   the product gets used at all.
2. **Change orders.** A tech opens a wall and finds rotted framing. Without a first-class
   change order with customer e-approval on the spot, that work is either done free or
   argued about later. This is the #1 margin leak in handyman work.
3. **Offline mode.** Basements, crawl spaces, new construction, rural routes. If the app
   needs signal to close a job, techs will stop using it in week two. Offline is an
   architecture decision made on day one, not a feature added in v2.
4. **Labor burden multiplier.** If you cost a job at the tech's $28/hr wage instead of the
   ~$44/hr loaded cost, every margin number in the system is a lie and the owner will make
   pricing decisions on it.
5. **Sales tax by jurisdiction.** Several locations means several tax regimes, and whether
   *labor* is taxable differs by state and sometimes by whether it's repair vs. improvement.
   This must be a rules table, not a single tax rate field.
6. **Van stock as inventory locations.** Parts do not sit in a warehouse; they sit in 20
   trucks. Without per-van stock, consumption on job close, and replenishment, your inventory
   value is fiction.

### Will bite you in month three
7. **Deposits and progress billing** — larger jobs need money up front; that's a liability,
   not revenue, until the work is done.
8. **Purchase orders and AP** — techs buy at Home Depot mid-job. Capture the receipt on the
   phone, cost it to the job, and create the payable.
9. **Warranty and callback tracking** — a callback must link to the original job, be flagged
   non-billable, and roll up into a per-tech quality metric.
10. **Recurring service agreements** — steady revenue and the reason customers stay. Needs
    deferred revenue accounting.
11. **Customer portal** — approve quotes and pay invoices without a phone call. Directly
    shortens your cash cycle.
12. **Automated customer comms** — appointment reminders and "your tech is on the way" SMS.
    The cheapest no-show reduction there is.
13. **Time clock with GPS** — separates drive time from wrench time; feeds both payroll and
    job cost. Also settles "I was there" disputes.
14. **Multi-visit jobs** — one job, three trips, partial completion, one invoice.

### Will bite you at audit or lawsuit time
15. **Immutable GL + period locking.** If someone can edit a posted journal entry, you do not
    have an accounting system. Corrections are reversing entries, never edits.
16. **Full audit trail** on every table, especially price and invoice changes.
17. **Photo provenance** — GPS, EXIF, server timestamp, and no client-side editing of the
    original. Before/after photo pairs are what win chargeback disputes.
18. **Licensing and insurance expiry alerts** per tech per state.
19. **PCI scope** — tokenize through the processor; never store a card number.
20. **1099 tracking** for subcontractor techs.

### Structural decisions to make before the first line of accounting code
21. **Are your locations separate legal entities or departments of one company?**
    This is the first question a controller will ask. If separate entities: separate books,
    intercompany transactions, consolidated reporting. If departments: one set of books with
    a `location` dimension on every journal line and per-location P&L via segmentation.
    *Recommendation for the demo: one legal entity, locations as a GL dimension, with the
    schema built so multi-entity is an additive change rather than a rewrite.*
22. **Inventory costing method** — average cost (simpler, recommended) vs. FIFO. It changes
    how COGS posts and cannot be switched casually later.
23. **Accrual vs. cash basis reporting** — build accrual, and generate cash-basis reports as a
    view. Small businesses file cash-basis and will ask for both.

### The AI layer (the name on the repo)
24. **Photo → job documentation.** Tech shoots the work; the app drafts the work-performed
    narrative for the invoice.
25. **Photo + price book → draft quote.** Point the camera at the job, get a priced line-item
    quote to review. This is the demo moment that sells the product.
26. **Receipt OCR** → vendor bill + job cost, from a phone photo.
27. **Import column mapping** — the AI reads the customer's messy export file and proposes the
    field mapping instead of making them do it by hand.
28. **Margin anomaly detection** — flags the jobs and techs quietly losing money.
29. **Natural-language reporting** — "gross margin on drywall work in Phoenix last quarter."

## 5. Demo strategy

The customer is migrating off existing handyman software, so the demo has to answer three
questions in order: *can you hold my data, can my techs use it, and are the books right?*

Seeded demo company: **3 locations, 14 techs, ~600 customers, 12 months of job history**,
realistic seasonality, a populated price book, van inventory, and a fully posted GL with real
financial statements. Every number on every dashboard traces back to a journal entry — because
if the demo P&L is hardcoded, the first CFO question kills it.

**Demo mode is a flag, not a fork.** The seeded company lives in a `DEMO` tenant. When the
customer signs, they get a `LIVE` tenant, run the import wizard against their real export, and
the demo data is never touched or migrated. One-click reset re-seeds demo for the next
presentation. See `docs/03-demo-script.md`.

## 6. Stack

- **Next.js (App Router)** — one codebase for office web and the field PWA.
- **PostgreSQL + Prisma** — the GL demands relational integrity and real transactions.
- **PWA with a service worker + IndexedDB outbox** — offline job access and queued mutations
  with conflict resolution on reconnect.
- **Object storage** for photos, with client-side compression and a resumable offline
  upload queue.
- **Money as integer minor units** everywhere. No floats in an accounting system, ever.
