-- Approved hours, and the run that pays them.
--
-- The jobs have been accruing labour at a loaded rate since the beginning: every costed
-- hour credits Payroll Liabilities, and nothing has ever relieved it. A year of that is a
-- balance sheet claiming the company owes its technicians more than a million dollars.
--
-- A payroll run is what settles it. What is added here is the minimum that makes an hour
-- payable and provable: when it was approved and by whom, which run paid it — an hour is
-- paid exactly once, the same discipline as a bank line clearing on one statement — and
-- the register itself, per technician, so a figure on the entry can be opened up into the
-- people it was made of.

ALTER TABLE "TimeEntry" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "TimeEntry" ADD COLUMN "approvedByUserId" TEXT;
ALTER TABLE "TimeEntry" ADD COLUMN "payrollRunId" TEXT;

CREATE TABLE "PayrollRun" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "runNo" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "payDate" TIMESTAMP(3) NOT NULL,
  "regularHours" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "overtimeHours" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "grossCents" BIGINT NOT NULL DEFAULT 0,
  "employerTaxCents" BIGINT NOT NULL DEFAULT 0,
  "benefitsCents" BIGINT NOT NULL DEFAULT 0,
  "totalCostCents" BIGINT NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "journalEntryId" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayrollRunLine" (
  "id" TEXT NOT NULL,
  "payrollRunId" TEXT NOT NULL,
  "technicianId" TEXT NOT NULL,
  "regularHours" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "overtimeHours" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "baseHourlyCents" BIGINT NOT NULL DEFAULT 0,
  "grossCents" BIGINT NOT NULL DEFAULT 0,
  "employerTaxCents" BIGINT NOT NULL DEFAULT 0,
  "benefitsCents" BIGINT NOT NULL DEFAULT 0,
  "totalCostCents" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "PayrollRunLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollRun_organizationId_runNo_key" ON "PayrollRun"("organizationId", "runNo");
CREATE INDEX "PayrollRun_organizationId_payDate_idx" ON "PayrollRun"("organizationId", "payDate");
CREATE INDEX "PayrollRunLine_payrollRunId_idx" ON "PayrollRunLine"("payrollRunId");
CREATE INDEX "TimeEntry_payrollRunId_idx" ON "TimeEntry"("payrollRunId");

ALTER TABLE "PayrollRun"
  ADD CONSTRAINT "PayrollRun_journalEntryId_fkey"
  FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PayrollRunLine"
  ADD CONSTRAINT "PayrollRunLine_payrollRunId_fkey"
  FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PayrollRunLine"
  ADD CONSTRAINT "PayrollRunLine_technicianId_fkey"
  FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TimeEntry"
  ADD CONSTRAINT "TimeEntry_payrollRunId_fkey"
  FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
