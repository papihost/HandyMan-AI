# Demo Script — 25 Minutes

Seeded company: **Apex Handyman Services** — 3 locations (Phoenix, Mesa, Scottsdale),
14 technicians, ~600 customers, 12 months of posted history with realistic seasonality.

Every figure shown is computed from the ledger. Nothing on screen is hardcoded — that is the
point, and it is what survives a CFO poking at it.

---

### Act 1 — "Can you hold my data?" (4 min)
**Migration** in the office nav. Five steps in the order they have to happen — accounts,
customers, price book, open invoices, trial balance — because invoices need customers and
everything needs accounts.

Each step offers the matching sample export, so nothing depends on having their files in the
room. If they brought their own, use theirs.

> **Run this act as rehearsals, not commits, apart from step 3.** Order matters: the open
> invoices need the customers from step 3 to be really there, so the Reverse comes at the
> end of the act, not in the middle of it. Apex Handyman is a company
> that has been trading for a year; a migration belongs in an empty one. A dry run shows the
> real numbers either way, because it really executes and is rolled back — so the act loses
> nothing, and the figures below are the ones that appear. Committing the open invoices in
> particular breaks step 5: the corrected file then skips every row as a duplicate.

1. **Customers.** Load the sample. It is a real QuickBooks contact list: a title block on
   top, "Surname, Forename" in the first column, an address with a comma in it, the same
   household twice, an email that is not an email. The screen reports what it found — 23
   rows, comma-separated, headings on line 5 — and maps every column, with the reason for
   each one and a wording for how sure it is. Change one by hand and watch the checks below
   rerun.
2. **Dry run.** Around twenty would be added, a couple skipped, one could not be read, each
   with its own line number in the file they will open to fix it. Nothing was written: the
   whole import really ran inside a transaction that was then rolled back, which is why
   those are counts and not estimates.
3. **Import for real.** It appears in the batch list with a Reverse button beside it. Leave
   it there for now — the next step needs these customers, because an invoice has to belong
   to somebody.
4. **Open invoices** — the moment the act is for. Load the sample aging and **dry run only**.
   It carries a row raised against "Ghost Customer Ltd", a name that exists in no customer
   list. The run skips it, names the line and the customer, and the reconciliation reads
   **out by 500.00**.
5. Load **the corrected export** — the same report with that one row fixed, which is what
   their bookkeeper would send back — dry run again, and the reconciliation reads **the
   totals agree**, 22,740.75 against 22,740.75.
6. **Trial balance**, dry run, to show the last step exists: every remaining account posts as
   one balanced opening entry, and the receivables and payables lines are left to the
   subledgers that already carried them. A trial balance has no file-total-against-imported
   comparison to make — what it has is Opening Balance Equity, which clears to zero when the
   books came over whole. On a company with a year of its own trading behind it, it will not
   clear, and the screen says so; on an empty one it does, which is the only place the figure
   means anything.
7. Back to the batch list, and **press Reverse** on the customers. The records go, anything
   posted is reversed rather than deleted, and the batch reads "reversed" — which is the
   answer to "what if we get it wrong", given before they have to ask it.

*The line:* "Your books come over balanced, and we prove it before we write a single row —
and when they would not have, we say so instead of finding out in March."

### Act 2 — "Can my techs use it?" (8 min)
Switch to a phone-sized window, logged in as **Marcus Deleon, technician, Mesa**.

1. His day, in time order, partitioned into today, the days ahead, and a collapsed tail of
   finished work. Each job carries the customer, the address, the ticket value and a
   Directions link. He only sees his own.
2. Open the job that is **under way** — the one badged IN PROGRESS. Property history sits on
   it: the last four visits to that address, with dates.
3. **Turn off the network.** The banner turns to "Offline". Everything still works: clock
   in, and the button flips to Clock out with "Offline · 1 waiting" beside it.
4. **Parts off the van.** The sheet lists what is on his truck with the quantity on hand,
   and the button counts up — "Take 2 off the van". Queued, not sent.
5. He finds extra damage → **Found extra work**. A change order priced from the price book,
   with "Get this signed before you start the extra work" on it, and the customer signs on
   the glass.
6. Before and after photos, by stage. Then **Finish job** and the completion signature.
7. **Reload the page, still offline.** The queue is still there — it is IndexedDB, not React
   state — so a tablet that sleeps, or a browser that reaps the tab, loses nothing.
8. **Turn the network back on.** The outbox drains in order and the banner returns to
   "All saved".
9. Note what he *cannot* see: no cost, no margin, no other techs' jobs. Open the network tab
   and look at the pull payload — 43KB, and the words `costCents`, `unitCostCents` and
   `loadedHourly` do not appear in it. The cost fields are not hidden on the client; they
   are not sent.

*The line:* "Your techs document everything, price extra work on the spot, and never see your
margins."

> **Not yet built, so do not promise it:** there is no camera-driven quoting and no AI
> drafting. On-site pricing is the change order in step 5, built from the price book by hand.
> Good/better/best option sets exist in the quoting engine and on the office side, not on the
> technician's screen. If they ask for quoting from the field, that is a roadmap answer.

### Act 3 — "Are the books right?" (8 min)
Switch to **Diane Kowalczyk, controller**.

1. **Receivables → an invoice** — pick one with parts on it as well as labour, so the
   revenue split has something to split. It shows what was billed with the cost that stood
   behind each line, and **how the tax was worked out**: the jurisdiction, the base it was
   applied to and the rate, resolved on the service address rather than the billing one.
   Then **View journal entry**: receivable, labour revenue, materials revenue and sales tax,
   posted by the invoice rather than by anybody typing. The entry links back to the invoice,
   so the trip runs both ways.
2. **Jobs → a completed job.** Revenue, cost and margin, all read from posted journal lines
   rather than from a cached column.
3. **What it cost**, broken out: direct labour with the hours and the wage behind it, labour
   burden, materials. Under it, the sentence the act is really for — *an hour of this
   technician's time is paid at $38.00 and costs $52.73, 1.38× the wage; a price set against
   the wage is a price set against about 72% of what the hour costs.* Most shops in this
   trade have never seen that number.
4. **Everything this job posted** — every entry, with the accounts it touched. Open one:
   both sides, the branch and job on each line, "In balance", and *Posted … — cannot be
   edited*, with the note that corrections are made by posting a reversing entry. There is
   no edit button to try, because there is no edit.
5. **Financials.** Trial balance in balance, balance sheet ties, income statement, and the
   same period segmented **by branch**. Click any account and drill into the entries behind
   it — 31 accounts drill.
6. **Periods** at the foot of the same screen: everything up to two months ago is closed.
   A posting dated inside a closed period is refused and the attempt is logged.

*The line:* "The field closed the job. Nobody in the office typed anything. The books are
done."

> **Not yet built, so do not promise it:** there is no inventory screen in the office app, so
> the van-stock and reorder story is data and API only. Period close and reopen are engine
> operations with an audit trail, but there is no button, so step 6 shows the state rather
> than performing the close.

### Act 4 — "What does it tell me I don't know?" (5 min)
The **owner dashboard** opens with four numbers and then three findings, in the order an
owner would want them. Each one is a different kind of problem, and none of them is visible
in revenue.

1. **Money on the table.** A handful of finished jobs were never invoiced — the callout
   names the count and how long the oldest has been waiting, which lands around a month.
   One click to the list, one click to bill them.
2. **A price that stopped moving.** *Drywall patch — small* returns about 8% over its
   standard cost, on 369 calls; Scottsdale sells it at under 1%, because a branch override
   set in 2023 is still in force. Follow the callout into **Price book review**: every flat
   rate against the cost it carries, thinnest first, with the branches that disagree listed
   under the item.

   The point to make here: the *trade* looks fine. Drywall & Paint reads 54.8% because
   painting a room earns 66% and carries the patches. A margin-by-trade report — the one
   most field software ships — cannot find this. Only the price book can.
3. **A branch that is priced correctly and still losing.** Scottsdale spends about 24% of
   its revenue on paid hours that never reached a job, against Phoenix's 11%. **Where the
   branch margin goes** splits every dollar of cost into the part that landed on a job and
   the part that landed on the branch and nothing else. Scottsdale's prices are in line with
   its siblings; its dispatch board is not.

Then the **technician scorecard**: utilization read out of the ledger rather than a
timesheet — billable wage against total wage, so it cannot disagree with the P&L — and
callback rate per technician. Teddy Brasch has the highest revenue on the board and the
worst rework rate; Marcus Deleon bills less and almost never goes back.

*The close:* "Three systems and a spreadsheet become one. And the one thing you've never had —
true margin per job, per tech, per branch, per flat rate — is on the first screen you see
every morning."

---

## The seeded company

`npm run db:seed` builds Apex Handyman Services from scratch, every figure produced by the
same posting engine the product uses. Nothing on any screen is a fixture.

**Three branches** — Phoenix (the original), Mesa, Scottsdale — with their own service
areas, sales tax rates, warehouses and P&L.

**Fourteen technicians**, each with a van that is a real stock location, a wage, a burden
multiplier, and a callback rate that differs between them. Wages run from $20.50 to $38.00
an hour and load to between 1.38× and 1.45× once payroll taxes, workers' comp, benefits and
the van are carried. Teddy Brasch has the highest revenue on the board and the worst rework
rate at 10.6%; Marcus Deleon bills less and goes back on 0.7% of his jobs, which is what
makes the scorecard worth showing.

**Twelve months of trading**, seasonal the way Phoenix actually is: plumbing peaks through
the summer, the last two weeks of December are dead.

### What is deliberately imperfect

A demo where everything is tidy proves nothing. The seeded company has problems, because
the product's value is that it surfaces them:

- **Two drywall flat rates were priced in 2023 and never revisited** while board and
  compound costs climbed, and Scottsdale carries a branch override that is lower still. They
  return roughly 8% over standard cost company-wide and under 1% in Scottsdale, against 63%
  or better for everything else in the book. Deliberately, this is *not* visible in
  margin-by-trade — the paint work in the same trade carries it — which is the point of
  showing the price book review in Act 4.
- **Scottsdale spends about a quarter of its revenue on hours that never reach a job**,
  roughly double the best-run branch. It is why the branch finishes fifteen points behind
  Phoenix while pricing its trades identically, and it is a different conversation from the
  price book: a dispatch problem, not a pricing one.
- **A handful of finished jobs were never invoiced**, spread across the last month, so the
  most actionable number on the dashboard is not a suspiciously perfect zero. The count and
  the value vary with the seed; read them off the screen rather than quoting them.
- **Some jobs are still in flight**, so the dispatch board has work on it rather than being
  a graveyard of completed calls.
- **Some quotes are still open**, so the pipeline report has a pipeline.
- **Some invoices are unpaid and ageing**, so the AR aging report has buckets.
- **Warranty callbacks exist**, costed but never billed, assigned back to the technician who
  did the original job so they land on that technician's scorecard. Rates run from under 1%
  to nearly 11%, and the worst of them belongs to one of the highest earners on the board.
- **Van stock has drifted** on some trucks and dropped below reorder point on others.
- **Older periods are closed.** Try to post into one and the system refuses, which is the
  point of Act 3 step 6.

### Today looks like today

The days either side of now are scheduled deliberately rather than left to the random
month generator. The morning's calls are finished and invoiced, one technician is mid-job,
the afternoon is still ahead, the next working day is assigned and the rest of the week is
booked in. Status follows the clock, so a board run at nine in the morning and one run at
four in the afternoon both look right.

Outside working hours the *status* question is answered as if it were mid-morning. The
scheduled times stay real — an eight o'clock job is at eight o'clock — but a seed run at
six in the morning would otherwise produce a board with nothing under way and every call
still ahead: accurate, and useless. **Re-run the seed on the day you present.**

### Before you present

Run the whole thing once on the machine you will present from. The rehearsal that produced
this version of the script found four things that only show up when you actually click:
committing the open invoices breaks the step after it, the receivables drill had no invoice
page behind it, reloading the technician's screen while offline used to land on the wrong
page, and the burden figures in an earlier draft belonged to no technician in the company.
Numbers in this script that name a technician or a flat rate are checked against the seed;
counts that vary run by run are described rather than quoted.

### Reproducibility

The same seed number produces the same company every time, so a demo script can name
figures and they will still be true after a reset. `DEMO_SEED=42` produces a different but
equally reproducible one.

Reset is safe by construction: it refuses on any organization whose `dataMode` is not
`DEMO`. A salesperson resetting between meetings cannot reach a customer's live books.
