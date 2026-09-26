-- Which statement accounted for which posting.
--
-- A bank reconciliation is not a report, it is a claim: these postings are the ones the
-- bank has also seen, and what is left over is either in transit or wrong. Making that
-- claim durable needs the marks to be stored, and a year later somebody has to be able to
-- ask which cheque was outstanding in March and get an answer.
--
-- The marks live in their own table rather than as a column on the journal line, because a
-- posted line cannot be updated — the trigger forbids it outright, and that guarantee is
-- worth more than the convenience of a column. Clearing is not an edit to the accounting
-- in any case: the amount, the account and the date are exactly as they were, and someone
-- at a bank has merely confirmed they saw it. Unticking is then a row going away rather
-- than a ledger mutation the database would have to be talked into allowing.

ALTER TABLE "BankReconciliation" ADD COLUMN "completedByUserId" TEXT;
ALTER TABLE "BankReconciliation" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "BankReconciliationLine" (
  "id" TEXT NOT NULL,
  "bankReconciliationId" TEXT NOT NULL,
  "journalLineId" TEXT NOT NULL,
  "clearedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BankReconciliationLine_pkey" PRIMARY KEY ("id")
);

-- A line clears once: two statements cannot both claim the same payment.
CREATE UNIQUE INDEX "BankReconciliationLine_journalLineId_key" ON "BankReconciliationLine"("journalLineId");
CREATE INDEX "BankReconciliationLine_bankReconciliationId_idx" ON "BankReconciliationLine"("bankReconciliationId");

ALTER TABLE "BankReconciliationLine"
  ADD CONSTRAINT "BankReconciliationLine_bankReconciliationId_fkey"
  FOREIGN KEY ("bankReconciliationId") REFERENCES "BankReconciliation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BankReconciliationLine"
  ADD CONSTRAINT "BankReconciliationLine_journalLineId_fkey"
  FOREIGN KEY ("journalLineId") REFERENCES "JournalLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
