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

1. **Customers.** Load the sample. It is a real QuickBooks contact list: a title block on
   top, "Surname, Forename" in the first column, an address with a comma in it, the same
   household twice, an email that is not an email. The screen reports what it found — 23
   rows, comma-separated, headings on line 5 — and maps every column, with the reason for
   each one and a wording for how sure it is. Change one by hand and watch the checks below
   rerun.
2. **Dry run.** Twenty would be added, two skipped, one could not be read, each with its own
   line number in the file they will open to fix it. Nothing was written: the whole import
   really ran inside a transaction that was then rolled back, which is why those are counts
   and not estimates.
3. **Import for real**, and it appears in the batch list with a Reverse button beside it.
4. **Open invoices** — the moment the act is for. The sample aging carries a row raised
   against "Ghost Customer Ltd", a name that exists in no customer list. The dry run skips
   it, says why, and the reconciliation reads **out by 500.00**. Keep going and it does not
   come right: the trial balance's receivables line is the aging's full total, so Opening
   Balance Equity ends at 500.00 instead of zero and the migration is provably wrong.
5. Load **the corrected export** — the same report with that one row fixed, which is what
   their bookkeeper would send back — and the reconciliation reads **the totals agree**,
   22,740.75 against 22,740.75, and opening equity clears to zero.

*The line:* "Your books come over balanced, and we prove it before we write a single row —
and when they would not have, we say so instead of finding out in March."

### Act 2 — "Can my techs use it?" (8 min)
Switch to a phone-sized window, logged in as **Marcus, technician, Mesa**.

1. His day: three jobs, mapped, in route order. He only sees his own.
2. Open the 10:30 job — history of the property, equipment installed, last visit's photos.
3. **Turn off the network.** Everything still works. Clock in, shoot before-photos, run the
   checklist.
4. Point the camera at the work → the AI drafts a **quote** from the price book. He adds a
   good/better/best option set.
5. He finds extra damage → raises a **change order**, customer signs on the tablet.
6. Pull two parts off his van, log 2.5 hours, shoot after-photos, capture the signature.
7. **Turn the network back on.** The outbox drains; every action syncs in order.
8. Note what he *cannot* see: no cost, no margin, no other techs' jobs. Open the network tab —
   the cost fields aren't even in the payload.

*The line:* "Your techs quote more, document everything, and never see your margins."

### Act 3 — "Are the books right?" (8 min)
Switch to **Diane, controller**.

1. Marcus's job is already invoiced. Open the invoice → click **View journal entry**. AR,
   labor revenue, materials revenue, sales tax at the Mesa rate — all posted automatically.
2. Open the **job costing** view: revenue, loaded labor cost (show the burden multiplier —
   $28/hr wage, $44.60/hr true cost), material cost at consumption-time average, gross margin
   and margin %.
3. **P&L by location**, side by side. Drill from a revenue number all the way down to that one
   job. Every number traces.
4. Show the **inventory ledger** — the two parts left Marcus's van, COGS moved, and the van
   dropped below its reorder point, so a replenishment suggestion is waiting.
5. Try to edit a posted journal entry. It refuses, and offers a reversing entry instead.
6. Close the period. Try to post into it. Refused, logged.

*The line:* "The field closed the job. Nobody in the office typed anything. The books are done."

### Act 4 — "What does it tell me I don't know?" (5 min)
The **owner dashboard** opens with four numbers and then three findings, in the order an
owner would want them. Each one is a different kind of problem, and none of them is visible
in revenue.

1. **Money on the table.** Nine finished jobs were never invoiced, the oldest nearly a month
   ago. One click to the list, one click to bill them.
2. **A price that stopped moving.** *Drywall patch — small* returns about 8% over its
   standard cost, on 369 calls; Scottsdale sells it at under 1%, because a branch override
   set in 2023 is still in force. Follow the callout into **Price book review**: every flat
   rate against the cost it carries, thinnest first, with the branches that disagree listed
   under the item.

   The point to make here: the *trade* looks fine. Drywall & Paint reads 54.8% because
   painting a room earns 66% and carries the patches. A margin-by-trade report — the one
   most field software ships — cannot find this. Only the price book can.
3. **A branch that is priced correctly and still losing.** Scottsdale spends 24.3% of its
   revenue on paid hours that never reached a job, against Phoenix's 10.6%. **Where the
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
multiplier, and a callback rate that differs between them. Teddy Brasch's rework rate is
several times Marcus Deleon's, which is what makes the scorecard worth showing.

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
- **Nine finished jobs were never invoiced**, spread across the last month, so the most
  actionable number on the dashboard is not a suspiciously perfect zero.
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

### Reproducibility

The same seed number produces the same company every time, so a demo script can name
figures and they will still be true after a reset. `DEMO_SEED=42` produces a different but
equally reproducible one.

Reset is safe by construction: it refuses on any organization whose `dataMode` is not
`DEMO`. A salesperson resetting between meetings cannot reach a customer's live books.
