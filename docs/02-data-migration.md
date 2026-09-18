# Data Migration — Importing from Existing Handyman Software

The customer is coming off an existing platform plus (almost certainly) QuickBooks. Migration
is not a side feature here; it is the thing that decides whether they sign. It must be a
guided, reversible, *provable* process.

## 1. Supported inputs

1. **Generic CSV / Excel mapper** — the universal path. Handles any export from any system.
2. **QuickBooks export** — customers, items/services, chart of accounts, open AR, open AP,
   vendors, and trial-balance opening figures.

Both run through the same pipeline; the QuickBooks path just ships with pre-built field
mappings and COA-range detection.

## 2. Import order (dependencies are strict)

```
1. Chart of Accounts          (or accept our seeded default)
2. Tax jurisdictions & rates
3. Locations / branches
4. Users & technicians        (with wage + burden, if available)
5. Vendors
6. Customers → Properties → Contacts
7. Price book: parts, materials, labor rates, flat-rate tasks
8. Inventory on hand          (per warehouse and per van, with unit cost)
9. Open AR (unpaid invoices)  → offset to 3900 Opening Balance Equity
10. Open AP (unpaid bills)    → offset to 3900
11. Customer deposits held    → offset to 3900
12. Trial balance as of cutover date → clears 3900 to zero
13. Historical closed jobs    (non-posting, reference only — keeps service history)
14. Job photos & documents    (bulk, async, linked by external job id)
```

Steps 9–12 are the part every naive importer gets wrong. Opening balances come in as journal
entries against **3900 Opening Balance Equity**, and when the trial balance is loaded, 3900
must net to zero. If it doesn't, the import is out of balance and the wizard says so loudly
instead of silently creating a broken ledger.

## 3. Wizard flow

**Upload → Detect → Map → Validate → Preview → Dry run → Commit → Reconcile**

- **Detect** — sniff delimiter, encoding, header row, date format, currency format
  (`$1,234.56`, `1.234,56`, `(45.00)` for negatives).
- **Map** — AI proposes a column mapping from the header names and a sample of the rows; the
  user confirms or overrides. Mappings are saved as a reusable template.
- **Validate** — per-row rules: required fields, type coercion, referential integrity
  (does this invoice's customer exist?), duplicate detection (fuzzy match on name + address +
  phone), and value sanity (negative quantities, dates in the future).
- **Preview** — a table of the first 100 rows exactly as they will be created, plus a full
  error report downloadable as CSV so their office manager can fix the source file.
- **Dry run** — the entire import executes inside a transaction that is rolled back. Produces
  the real counts, the real GL impact, and the real error list without writing anything.
- **Commit** — runs in batches with a job id; every created record is stamped with
  `importBatchId` and `externalId`.
- **Reconcile** — the report that wins the deal:

  ```
  Customers in file      612   imported 609   skipped 3 (duplicates)   errors 0
  Open invoices          148   imported 148   total $284,193.22
  Source system AR total               $284,193.22   ✓ MATCH
  Inventory value        $67,410.88    ✓ MATCH
  Opening Balance Equity $0.00         ✓ BALANCED
  ```

- **Rollback** — because every record carries `importBatchId`, an entire batch can be reversed
  (GL entries reversed, records soft-deleted) up until the first live transaction is recorded.

## 4. Re-import and delta sync

Migration is rarely one shot. The customer will run a trial import, keep working in the old
system for two more weeks, then run a final cutover. `externalId` + `importBatchId` make the
second run an upsert rather than a duplication.

## 5. Demo data vs. live data

The demo company and the customer's real data never touch:

- Every organization carries a `dataMode` of `DEMO` or `LIVE`.
- The seeded demo company is a complete, self-consistent `DEMO` organization.
- Provisioning a customer creates a fresh `LIVE` organization. The import wizard targets it.
- `POST /api/admin/demo/reset` wipes and re-seeds the demo organization only — it is hard-gated
  to refuse when `dataMode = LIVE`, so there is no path by which a sales reset can touch real
  books.
- A `LIVE` organization can be seeded with *reference* data only (default COA, standard price
  book templates) without any transactional demo noise.

---

## 6. Implementation notes

The engine is `src/lib/import/`. Parsing, coercion and row building are pure functions, so
the awkward cases can be tested against a table of inputs rather than a database.

### Parsing

A delimited-text parser rather than a dependency, because the interesting cases here are
the ones a general-purpose parser treats as edge cases and a customer's export treats as
Tuesday: a quoted field containing the delimiter, a newline inside an address, doubled
quotes, a UTF-8 BOM from Excel, mixed line endings, and rows with the wrong column count.

- **Delimiter detection** counts candidates *outside* quotes and prefers consistency over
  volume. A file of quoted addresses is full of commas and is still tab-delimited.
- **Header detection** skips the title block accounting packages print on top. The header
  is the first row whose cells are mostly populated, distinct, and not numbers.
- **Ragged rows are padded, not shifted.** One malformed line must not move every
  subsequent column by one, which is the failure that produces a plausible-looking import
  where every phone number is a postal code.
- **Line numbers are absolute**, counted past the title block, so "fix line 11" points at
  line 11 of the file the office manager opens.

### Coercion

Where migrations actually go wrong. Each of these is a silent, plausible-looking error:

| Input | Trap |
|---|---|
| `03/04/2025` | March or April depending on the country |
| `(45.00)` | Negative, not a footnote |
| `1.234,56` | A European thousand separator — reading it as a decimal point is off by 1000× |
| `01/15/24` | A two-digit year |
| `02/31/2025` | Not a real date; must not roll into March |

The date order and decimal separator are **detected per column** from a sample, not
assumed. When every date in a column is ambiguous the wizard says so and asks, because a
wrong guess misdates a year of history by up to eleven months.

### Dry run

The entire import executes inside a transaction that is then deliberately rolled back. The
counts, the errors and the ledger impact shown are therefore the real ones rather than a
prediction — the same code path that will commit, run for real and then unwound. The batch
record itself is written outside that transaction, so there is an audit trail of having
tested first.

### Opening balances

Subledger imports post against **3900 Opening Balance Equity**, and the trial balance
clears it:

```
Open invoices     Dr 1200 Accounts Receivable   Cr 3900 Opening Balance Equity
Trial balance     Dr/Cr every remaining account, balanced by 3900 → nets to zero
```

**A trial balance line is skipped only when that subledger actually loaded.** Assuming it
did is a real bug and was found by a test: receivables came over as invoices, so the trial
balance's AR line is correctly skipped — but payables had no subledger import, so skipping
theirs would have buried $14,880 of AP in opening equity and left a balance sheet that
balanced while being wrong. The rule is to look at the account's current balance, not to
assume.

If 3900 does not net to zero after the trial balance is loaded, the migration is out of
balance and the reconciliation says so loudly rather than leaving a broken ledger to be
discovered at the first month end.

### Rollback

Every imported record carries its `importBatchId`. Rolling back reverses the journal
entries — a posted entry is never deleted, even one that should not have been made — and
removes the records, **except** anything that has since been used: a customer with a job,
an item that has been quoted, an account with postings. Those have stopped being the
import's to remove.
