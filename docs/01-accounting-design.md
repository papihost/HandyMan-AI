# Accounting Design — Self-Contained Double-Entry Ledger

No QuickBooks. No external sync. The general ledger lives here and is the system of record.
The design goal is *QuickBooks-simple to use, but structurally correct underneath* — the
bookkeeper sees invoices, bills, and payments; the ledger sees balanced journal entries.

---

## 1. Core principles

1. **Every financial event produces a balanced journal entry.** Debits equal credits, enforced
   in a database transaction and by a check constraint on the batch.
2. **Posted entries are immutable.** No edits, no deletes. A mistake is corrected with a
   reversing entry that references the original. This is what makes the books defensible.
3. **Money is stored as `BigInt` minor units** (cents) with an explicit currency. Never a float.
4. **Every journal line carries dimensions:** `locationId`, optional `jobId`, optional
   `technicianId`, optional `serviceTypeId`. This is what produces P&L by location, margin by
   job, and revenue by tech without a separate reporting database.
5. **Source documents post, users don't.** An invoice, a bill, a payment, an inventory
   consumption, or a payroll run *generates* its journal entry through a posting rule. Manual
   journal entries exist but are the exception and are permission-gated.
6. **Periods lock.** A posting dated inside a closed period is rejected. Reopening a period is
   an audited event.

## 2. Chart of accounts (seeded default, customer-editable)

Numbered ranges so reports can segment by range:

```
1000–1999  Assets
  1010  Operating Bank Account
  1020  Payroll Bank Account
  1050  Undeposited Funds          <- payments land here before deposit
  1060  Credit Card Clearing       <- processor holds before payout
  1200  Accounts Receivable
  1300  Inventory — Warehouse
  1310  Inventory — Van Stock
  1350  Work in Process (WIP)
  1400  Prepaid Expenses
  1500  Vehicles & Equipment
  1590  Accumulated Depreciation

2000–2999  Liabilities
  2010  Accounts Payable
  2050  Credit Cards Payable
  2100  Sales Tax Payable          <- by jurisdiction, sub-accounts
  2200  Payroll Liabilities
  2300  Customer Deposits          <- deposits are a LIABILITY until earned
  2350  Deferred Revenue           <- unearned service-agreement revenue
  2400  Accrued Expenses

3000–3999  Equity
  3010  Owner's Equity
  3020  Owner's Draw
  3100  Retained Earnings
  3900  Opening Balance Equity     <- migration lands here, then is cleared

4000–4999  Revenue
  4010  Service Revenue — Labor
  4020  Service Revenue — Materials
  4030  Service Agreement Revenue
  4040  Trip / Diagnostic Fees
  4900  Discounts & Allowances     (contra)

5000–5999  Cost of Goods Sold
  5010  COGS — Direct Labor
  5020  COGS — Labor Burden
  5030  COGS — Materials & Parts
  5040  COGS — Subcontractors
  5050  COGS — Equipment Rental
  5060  COGS — Permits
  5090  Inventory Shrinkage

6000–6999  Operating Expenses
  6010  Advertising & Marketing        6110  Vehicle — Fuel
  6020  Office Salaries                6120  Vehicle — Maintenance
  6030  Payroll Taxes — Admin          6200  Insurance — General Liability
  6040  Rent — Facilities              6210  Insurance — Workers' Comp
  6050  Utilities                      6300  Merchant Processing Fees
  6060  Software & Subscriptions        6400  Professional Fees
  6070  Licenses & Permits — Company    6500  Depreciation
  6080  Training                        6900  Bad Debt
```

## 3. Posting rules (the heart of the system)

Each business event maps to a deterministic entry. `LOC` = the job's location dimension.

| Event | Debit | Credit |
|---|---|---|
| Customer deposit received | 1050 Undeposited Funds | 2300 Customer Deposits |
| Invoice issued (labor) | 1200 AR | 4010 Service Revenue — Labor |
| Invoice issued (materials) | 1200 AR | 4020 Service Revenue — Materials |
| Invoice sales tax | 1200 AR | 2100 Sales Tax Payable (by jurisdiction) |
| Deposit applied to invoice | 2300 Customer Deposits | 1200 AR |
| Parts consumed on job (van) | 5030 COGS — Materials | 1310 Inventory — Van Stock |
| Tech labor posted to job | 5010 COGS — Direct Labor | 2200 Payroll Liabilities |
| Labor burden applied | 5020 COGS — Labor Burden | 2200 Payroll Liabilities |
| Subcontractor bill on job | 5040 COGS — Subcontractors | 2010 AP |
| Customer payment (card) | 1060 CC Clearing | 1200 AR |
| Merchant fee | 6300 Merchant Fees | 1060 CC Clearing |
| Processor payout to bank | 1010 Bank | 1060 CC Clearing |
| Deposit of cash/checks | 1010 Bank | 1050 Undeposited Funds |
| PO received into warehouse | 1300 Inventory — Warehouse | 2010 AP (or 2050) |
| Warehouse → van transfer | 1310 Inventory — Van | 1300 Inventory — Warehouse |
| Direct job purchase (non-stock) | 5030 COGS — Materials | 2010 AP |
| Vendor bill paid | 2010 AP | 1010 Bank |
| Cycle count shrinkage | 5090 Inventory Shrinkage | 1300/1310 Inventory |
| Sales tax remitted | 2100 Sales Tax Payable | 1010 Bank |
| Service agreement billed up front | 1200 AR | 2350 Deferred Revenue |
| Agreement visit performed | 2350 Deferred Revenue | 4030 Agreement Revenue |
| Invoice written off | 6900 Bad Debt | 1200 AR |
| Credit memo | 4900 Discounts & Allowances | 1200 AR |

**Optional WIP mode** (for companies that want costs held until invoicing): job costs debit
1350 WIP instead of 5xxx, and the invoice event relieves WIP to COGS. Configurable per
organization — some owners want it, most don't.

## 4. Job costing and true margin

Per job the system accumulates four cost buckets and one revenue figure:

```
Revenue        = sum of invoice lines (net of discounts, excluding tax)
Labor cost     = Σ (hours × technician.loadedHourlyCost)
Material cost  = Σ (quantity × inventory average cost at consumption time)
Sub cost       = Σ vendor bill lines coded to the job
Other cost     = permits, equipment rental, disposal
Gross margin   = Revenue − (Labor + Material + Sub + Other)
```

`loadedHourlyCost` is *not* the wage. It is:

```
loadedHourlyCost = baseWage × burdenMultiplier
burdenMultiplier = 1 + payrollTaxRate + workersCompRate + benefitsRate
                     + (vehicleMonthlyCost + phoneMonthlyCost) / (billableHoursPerMonth × baseWage)
```

Stored per technician, versioned with an effective date so historical jobs keep the burden rate
that applied when the work happened. Typical result: a $28/hr tech costs $42–48/hr loaded.

The cost of a part is captured **at consumption time**, not at report time, so restating
average cost later never rewrites history.

## 5. Sales tax

A rules engine, not a rate field:

- `TaxJurisdiction` — state / county / city, each with its own rate and effective dates.
- `TaxRule` — per jurisdiction: is *labor* taxable, is *material* taxable, does repair differ
  from capital improvement, are service agreements taxable.
- Resolution is by the **service address of the property**, not the branch address.
- Customer-level exemption certificates with expiry dates.
- Output: a per-jurisdiction liability report ready for filing, backed by 2100 sub-accounts.

## 6. Reports the customer will ask for on day one

**Financial:** P&L (consolidated and by location, with comparatives), Balance Sheet, Cash Flow,
Trial Balance, General Ledger detail, AR Aging, AP Aging, Sales Tax Liability, Bank
Reconciliation, 1099 summary.

**Operational (the ones that actually change behavior):** Gross margin by job / service type /
tech / location, tech utilization (billable ÷ paid hours), revenue per tech per day, average
ticket, quote close rate, callback rate by tech, first-time-fix rate, inventory valuation and
turns, WIP aging, unbilled completed jobs (money sitting on the table).

## 7. Non-negotiable safeguards

- Balanced-batch check enforced inside the same transaction that writes the lines.
- Closed-period guard on every posting path.
- `postedAt` (system time) is distinct from `entryDate` (accounting date); backdating is
  allowed only into an open period and is logged.
- Unique, gapless document numbering per organization per document type, allocated inside the
  transaction so an invoice number is never reused or skipped.
- Every posting carries `sourceType` + `sourceId`, so any GL line can be traced back to the
  job, invoice, or bill that created it — and every document can show its resulting entry.

---

## 8. Implementation notes

The posting engine is `src/lib/accounting/ledger.ts`. Nothing else in the system writes to
`JournalEntry` or `JournalLine`, which is what makes the guarantees below unconditional
rather than a convention.

**Posting rules are pure functions.** Each rule in `src/lib/accounting/rules/` takes a
business event and returns journal lines — no database, no clock, no auth context. Every
row of the posting table in §3 is therefore unit-testable against expected debits and
credits, and the table above is executable documentation rather than a wish. The caller
hands the lines to `postJournalEntry` inside the same transaction as the document that
produced them.

**The guarantees are enforced twice.** The application layer validates so that errors are
legible; the database enforces so that the guarantee does not depend on every future code
path remembering to ask. From `prisma/migrations/*_ledger_guards`:

| Guarantee | Database mechanism |
|---|---|
| A line is a debit or a credit, never both, never negative | `CHECK` constraints on `JournalLine` |
| Debits equal credits on every posted entry | Deferred `CONSTRAINT TRIGGER`, verified at `COMMIT` |
| A posted entry has at least two lines | Same deferred trigger |
| Posted entries and their lines can never be altered or deleted | `BEFORE UPDATE OR DELETE` triggers |
| The audit log is append-only | `BEFORE UPDATE OR DELETE` trigger that always raises |

The balance check is *deferred* so lines can be inserted one at a time inside a
transaction and verified once at commit. An unbalanced entry cannot reach a committed
state, whatever wrote it — including a direct `psql` session.

**Period locking** is a single choke point: `assertPostingAllowed` resolves the period for
an entry date and refuses anything that is not `OPEN`. Closing a period requires every
earlier period to be closed first, so a correction cannot be slipped in behind a month
that has already been reported. Reopening requires `period:reopen`, demands a reason, and
writes an audit record. `LOCKED` is permanent.

**Document numbering** allocates inside the caller's transaction with `SELECT … FOR
UPDATE` on the sequence row, so a rollback returns the number to the pool and concurrent
callers serialize. The scope column uses an empty string rather than `NULL` for
"organization-wide": Postgres treats `NULL`s as distinct in a unique index, so a nullable
column would have let concurrent allocators each create their own sequence row and issue
the same invoice number twice.

**Reporting reads the ledger.** `src/lib/accounting/reports.ts` computes the trial balance,
income statement, balance sheet and P&L-by-branch from posted journal lines. Nothing is
cached in a summary table and nothing is derived from document totals, because the moment
a reported number can disagree with the general ledger, the general ledger has stopped
being the system of record.

## 9. Document flow

```
Quote  ──approve (signature)──▶  Job  ──work performed──▶  Invoice  ──issue──▶  Journal Entry
  │                               │                          │                      │
  │ posts nothing                 │ accrues actual cost      │ computes tax         │ AR / revenue /
  │ (a proposal, not revenue)     │ (labor, parts, subs)     │ on service address   │ sales tax payable
```

Three properties hold across that chain:

1. **A quote posts nothing.** Revenue is recognized when work is invoiced, not when it is
   offered. The quote's cost figure exists only so quoted-versus-actual margin is
   answerable later.
2. **Job lines are copied from the quote, not referenced.** The quote records what was
   proposed; the job records what was done. They diverge the moment anything changes on
   site, and keeping both is the only way to learn whether the estimate was any good.
3. **A job line is billed exactly once.** A draft invoice claims its lines as it is
   created, so a second invoice cannot pick up the same work. Progress billing is simply
   an invoice that claims some of the lines and leaves the rest.

**Tax is computed on the aggregate, then allocated.** Rounding each line separately drifts
from the invoice total by a cent or two, and a customer who adds up the lines and gets a
different answer will call about it. One rounding on the taxable base, spread across the
taxable lines by weight, with any remainder pushed onto the first of them.

**Margin never includes tax.** Sales tax is collected on behalf of the state; it is a
liability from the moment it is charged and it is not revenue. Job costing reports net
revenue for the same reason.

## 10. Inventory costing

**Every van is a stock location.** Parts do not sit in a warehouse; they sit in twenty
trucks. Warehouse stock posts to 1300 and van stock to 1310, so the balance sheet shows
how much of the inventory asset is actually driving around.

**Moving average, captured at the movement.** A receipt adds value and quantity; the
average is derived from the two. A later receipt at a higher price changes what the *next*
job costs and never restates a job that closed last March.

**Value is stored, not recomputed.** `StockLevel` carries `valueCents` alongside
`quantity`. Valuing inventory as quantity × average re-rounds a rounded number on every
report and the drift compounds with each receipt; holding the value keeps the subledger
equal to the money actually spent. A consumption that empties a bin relieves exactly what
is left rather than a rounded approximation of it — `tests/inventory.test.ts` asserts this
on three units bought at $3.33 each.

**Read-modify-write is locked.** A moving average is read, modified and written back, so
`SELECT … FOR UPDATE` holds the stock level row for the rest of the transaction. Without
it, two concurrent receipts each read the old average and the second silently discards the
first — the inventory asset stops matching what was paid for it, quietly, with no error
anywhere. Transfers lock the two sides in a stable order so opposite-direction transfers
between the same pair of locations cannot deadlock.

**Stock is allowed to go negative.** A technician uses a part nobody recorded as received.
Refusing the entry would only mean the job never gets costed at all, and the technician
stops using the app. The consumption is priced at the item's standard cost so the job
still carries a defensible figure, and the negative appears on its own report — every
negative line is a receipt somebody did not enter.

**Counts re-read under lock.** A cycle count's expected quantity is read at post time, not
at open time, so a job that consumed parts while the technician was counting does not turn
into a phantom variance. Shortages debit 5090 Inventory Shrinkage; overages credit it.

The subledger and the general ledger are asserted equal: `inventoryValuation()` and the
1300 + 1310 balances on the trial balance must agree to the penny. If they ever disagree,
one of them is wrong and nobody can tell which.

## 11. Job purchases and payables

The case that matters in the field is small and constant: a technician is mid-job, needs a
part nobody stocks, buys it at the supply house and photographs the receipt.

That purchase never touches inventory. Receiving it into stock and relieving it moments
later would be two lies that cancel, and it would corrupt the moving average of an item
that was bought at a one-off price for one job. It posts directly:

```
Dr  5030 COGS — Materials & Parts     coded to the job
  Cr  2010 Accounts Payable           coded to the vendor
```

Subcontracted work posts the same shape to 5040 instead, and the vendor is flagged for
1099 reporting.

If this does not become a cost against the job within a minute of happening, it is either
lost entirely or lands next month against nothing in particular — and the job's margin is
wrong either way. Roughly a third of jobs in the seeded company carry one, which is what
moves its gross margin from a flattering 59% to a realistic 48%.

## 12. Why the demo company's numbers are believable

Three corrections separate a seeded dataset that survives a controller's questions from one
that does not. All three are in `src/lib/demo/seed.ts`.

**Volume follows headcount.** Fourteen technicians × 173 paid hours × 12 months × 62%
utilization ÷ 3.6 hours a job determines how many jobs there have to be. A job count chosen
by feel leaves technicians 97% idle, and the income statement that falls out of that is
absurd — which is how the arithmetic tells you the number was wrong.

**Unbilled technician time is costed.** Drive time, shop time, restocking and the gaps
between calls are paid, and they are cost of providing the service. Posting only billable
hours to COGS is the most flattering mistake a field-service system can make: it reports
gross margins in the seventies for a trade that runs in the forties, and an owner who
prices off that number loses money on every job.

**Overhead is posted.** Rent, advertising, office payroll, vehicles, insurance, software and
depreciation, monthly, attributed to a branch where they belong to one. Company overhead is
deliberately left unallocated: spreading it across branches would make branch profit a
function of the allocation formula rather than of the branch.

The result is a company with roughly 48% gross margin and a net margin in the low teens —
which is what a well-run three-branch handyman operation actually looks like, and which is
the point at which the numbers stop being a demo and start being an argument.
