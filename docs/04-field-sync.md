# Offline Sync — How the Tablet Works

A technician spends the day in crawl spaces, plant rooms, new-build sites and rural
driveways. If closing a job needs signal, the app stops being used in week two and the
company goes back to paper. Offline is not a feature here; it is the shape of the thing.

This is the design of the server half. The device half — service worker, IndexedDB
outbox, the screens — sits on top of it.

---

## 1. The rule everything follows

**The outbox replays intent, not state.**

A device sends *"add these two lines"*. It never sends *"the job's lines are now these"*.

The difference matters because a tablet that has been out of signal for three hours holds
a stale copy of the job. If it pushed its whole state, it would silently overwrite
whatever the dispatcher changed while it was away — a rescheduled visit, an added note, a
second technician assigned. Intents compose with other people's work; snapshots destroy
it. Every operation in `src/lib/field/operations.ts` is an intent.

## 2. Pull: what a device carries

`pullFieldData` builds a device's working set: the technician's assigned jobs within a
window, the customer and property for each, **access notes** (the gate code and where to
park — the difference between a completed call and a callback), installed equipment, prior
visits to the same address, the whole price book, van stock, and checklist templates.

The price book goes down in full rather than only what today's jobs need, because the work
a technician finds on site is by definition not the work that was scheduled.

**No cost leaves the building.** The payload is assembled through `scopedDb`, so item cost,
job cost and margin are never fetched, never serialized, and never sit in a device's local
database. The test asserts this against the entire serialized payload rather than against
the fields a screen happens to read — a technician who opens dev tools must not find
margin there.

**Deltas and revocations.** A pull takes the server clock *before* reading, so no write can
slip through the gap between reading and stamping. The device sends the job ids it holds,
and the response names the ones that have left its scope — without that, a reassigned job
lingers on the wrong truck all week.

## 3. Push: draining the outbox

`pushOperations` has to hold three properties, each corresponding to something that really
happens to a tablet.

**Replaying is safe.** The device sends its queue, the response is lost on a flaky
connection, and it sends the same queue again. Every operation carries an id generated on
the device, unique per device in the database. The row is inserted *before* the work is
done, so the insert is a claim rather than a hope: a concurrent retry loses the unique
index and returns the first attempt's answer instead of running the handler again. Without
this, one dropped response bills a customer twice.

**Order is preserved.** Operations apply in the device's own sequence, so "en route", "in
progress" and "completed" — queued over three hours underground — land in that order
rather than in whatever order the network delivers them. The tests deliver them backwards
and assert they still apply forwards.

**One failure does not strand the rest.** Each operation settles independently. A
technician whose second job was reassigned still gets the other five recorded, and is told
plainly about the one that was not.

### Outcomes

| Outcome | Means |
|---|---|
| `APPLIED` | Done |
| `DUPLICATE` | Seen before; the original answer is returned |
| `NOOP` | Already true on the server — the device was behind, not wrong |
| `CONFLICT` | The world moved; the change was not applied and the technician is told why |
| `REJECTED` | Malformed or not permitted |

**`NOOP` is why reconnecting is not a wall of errors.** A device that recorded "en route"
an hour ago, on a job since completed, is behind rather than in conflict. Asking for a
status the job has already passed is nothing to do. Treating it as a failure would produce
a screenful of red for a day that went perfectly well, and technicians would learn to
ignore the screen.

**Conflicts are the cases that genuinely need a person.** The job was reassigned while the
device was away. The office already invoiced it — so a late line change is refused with
*"raise a change order or speak to the office"* rather than quietly altering a document the
customer has already been sent.

**A half-finished operation is not retried.** If a claim row is still pending, an earlier
attempt started and never finished — a crash or a lost connection mid-write. That is
reported honestly instead of replayed, because a half-applied operation replayed is how a
customer gets billed twice.

## 4. Ledger authority

A technician does not have `gl:post`, and must not: nobody in a van should be able to write
an arbitrary journal entry. But clocking out and taking parts off the truck *have* to post.

Both are true through `postingContextFor`:

> `gl:post` guards **discretionary** journal entries — someone deciding to move money
> between accounts by hand. It is not what guards an invoice being issued or parts coming
> off a van. Those postings are consequences of the posting rules, not choices, and the
> permission that matters was already checked on the operation itself.

The derived authority carries the original actor through, so the entry records *who caused
it*. Two tests lock this down: a technician posting a manual entry is refused, and a
technician clocking out produces a posting attributed to them.

The same mechanism is why a bookkeeper can issue an invoice without being handed the keys
to the general ledger.

## 5. Field operations

`JOB_STATUS`, `CLOCK_IN`, `CLOCK_OUT`, `ADD_JOB_LINES`, `CONSUME_PARTS`, `ADD_PHOTO`,
`CAPTURE_SIGNATURE`, `CREATE_CHANGE_ORDER`, `COMPLETE_CHECKLIST`, `ADD_JOB_NOTE`.

Three of them carry most of the value:

**`CLOCK_OUT`** is where field time becomes cost. The technician's loaded rate is read *as
it stood on the day the work happened*, so a rate change next month never restates a job
that closed today. Wage and burden post separately, so burden is a number an owner can see
rather than one buried inside a labour figure.

**`CONSUME_PARTS`** is where inventory becomes cost of goods sold, off that technician's
own van, at the cost captured at the moment it left.

**`CREATE_CHANGE_ORDER`** is the margin one. A technician opens a wall, finds something,
fixes it, and nobody ever bills for it — that is the single biggest leak in this trade. A
change order raised and signed *before* the extra work starts turns it into revenue. The
operation creates the order, captures the signature, and adds the lines through the normal
pricing path in one go.

**Photo metadata is separate from the image.** The record exists the moment the shutter
closes; the file uploads whenever there is bandwidth. A technician on a rural route queues
forty photos and sends them over the depot's wifi that evening, and the job's documentation
is never waiting on a file transfer. Each photo carries GPS, capture time, and a content
hash — the provenance that wins a chargeback.

## 6. The test that matters

`tests/field.test.ts` → *"an offline day, replayed"*.

Twelve operations queued with no signal: dispatched, en route, clock in, in progress,
before photos, lines added, a change order found and signed on the tablet, parts off the
van, after photos, completion signature, clock out, completed. All pushed in one go on the
way back to the depot.

It then asserts the job is complete with three lines, both photos, an approved change
order and two signatures; the van is two wax rings lighter; labour is costed at the day's
loaded rate; the trial balance balances; and job margin is readable from the ledger.

Then it sends the whole queue a second time and asserts the books do not move.

---

## 7. The device half

`src/client/` and `src/app/field/`. Three decisions shape it.

**Everything is queued, including when there is signal.** An action writes to the outbox and
updates the local copy; sending happens separately. One code path means the offline case is
the case that runs all day, rather than a rarely-taken branch that breaks quietly in a
basement.

**Push before pull, always.** The device's own work is the newest truth about a job it has
been working. Pulling first would overwrite an unsent change with the server's older copy,
and a technician would watch their last hour disappear.

**The local copy is a cache, not a second source of truth.** Actions apply locally at once
so the screen responds immediately — a tablet that waited for a round trip before showing a
status change feels broken, and a technician who thinks the app is broken stops using it.
The next pull overwrites that copy with whatever the server says, which is how a conflict
resolves itself visibly instead of leaving the device quietly wrong.

### Details that matter in a van

- **Sequence numbers are persisted**, never derived from the queue's length. Acknowledged
  work leaves the queue, so counting it would reuse a number and the server would apply a
  morning in the wrong order.
- **Photos upload before the operation that references them.** A record never points at a
  file the server does not have; the evidence and the record travel together.
- **A failed send requeues rather than discards.** The queue is the record; the network is
  not.
- **Van stock decrements locally** when parts are booked out, so a technician cannot record
  using stock they no longer have and discover it at the depot.
- **Unsent lines are labelled "not sent"** rather than shown as if they were saved.
- **Backoff, not hammering.** Retrying every second in a dead zone flattens the battery by
  lunchtime, so the interval doubles to five minutes — but reconnecting fires immediately,
  because driving out of a basement is exactly when a morning should go up.
- **The service worker caches the shell and never the API.** Job data belongs to the sync
  engine, which knows about cursors, conflicts and the outbox; a worker replaying a stale
  API response would hand the app data the sync engine never agreed to.
- **The sync badge is always visible.** "3 waiting" is reassuring. A silent app that might
  or might not have saved the morning is what makes people photograph their own screen as a
  backup.

### Verified in a browser

Driven with Playwright at iPad size against the seeded company: sign in, pull the week,
open a job, **go offline**, mark en route, search the price book, add work — the badge
reads `Offline · 2 waiting` and the job total updates on screen — then reconnect and watch
it settle to `All saved`, with the lines and the status change confirmed in the database.
