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
