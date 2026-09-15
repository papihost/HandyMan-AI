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
