-- Money taken at the door belongs to a call and to a pair of hands.
--
-- A payment has always pointed at a customer, which is enough once an invoice exists to
-- settle. It is not enough at the moment a technician is handed cash on a doorstep: there
-- is no invoice yet, and "which of this customer's three calls was that for" has no answer
-- afterwards. Tagging the job lets the deposit find its own invoice when the office raises
-- it, and tagging the technician makes the classic question about cash — whose hands was
-- it in — one the ledger can answer rather than one the office argues about.

ALTER TABLE "Payment" ADD COLUMN "jobId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "collectedByTechnicianId" TEXT;

CREATE INDEX "Payment_jobId_idx" ON "Payment"("jobId");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_collectedByTechnicianId_fkey"
  FOREIGN KEY ("collectedByTechnicianId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;
