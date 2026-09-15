# Demo Script — 25 Minutes

Seeded company: **Apex Handyman Services** — 3 locations (Phoenix, Mesa, Scottsdale),
14 technicians, ~600 customers, 12 months of posted history with realistic seasonality.

Every figure shown is computed from the ledger. Nothing on screen is hardcoded — that is the
point, and it is what survives a CFO poking at it.

---

### Act 1 — "Can you hold my data?" (4 min)
Open the **Import Wizard**. Drop in a messy sample export from their current system. Show the
AI proposing the column mapping, the validation catching three duplicate customers and two
malformed dates, the dry run, and then the **reconciliation report** proving the AR total
matches their source system to the penny and Opening Balance Equity clears to zero.

*The line:* "Your books come over balanced, and we prove it before we write a single row."

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
The **owner dashboard**: margin by location, tech utilization, callback rate by tech, quote
close rate, unbilled completed jobs (money sitting on the table), AR aging.

Show the margin anomaly flag: one service type in Scottsdale is quietly running at 11% gross
margin because the flat-rate price hasn't moved since the material cost rose. Then show
natural-language reporting: *"gross margin on drywall work in Phoenix last quarter."*

*The close:* "Three systems and a spreadsheet become one. And the one thing you've never had —
true margin per job, per tech, per branch — is on the first screen you see every morning."
