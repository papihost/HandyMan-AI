import type { PrismaClient } from '@prisma/client';
import { ValidationError } from '../errors';
import { seedDemoCompany, type SeedOptions, type SeedResult } from './seed';

/**
 * Demo reset.
 *
 * A salesperson resets the demo between meetings. That operation must be incapable of
 * touching a customer's real books, so it refuses on anything not explicitly marked DEMO —
 * the check is on the organization's own `dataMode`, not on a name, an environment
 * variable, or a convention someone might forget.
 */

export async function assertDemoOrganization(
  db: PrismaClient,
  organizationId: string,
): Promise<void> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, dataMode: true },
  });
  if (!org) throw new ValidationError('Organization not found');
  if (org.dataMode !== 'DEMO') {
    throw new ValidationError(
      `"${org.name}" holds live data. Demo reset is refused on anything that is not a demo organization.`,
    );
  }
}

/**
 * Teardown order.
 *
 * Deleting the organization row and letting the database cascade does not work, and
 * should not: `JournalLine.accountId` is deliberately `RESTRICT`, because an account with
 * postings against it must never be deletable. The same is true of a customer with jobs,
 * and a bank account with deposits. Those restrictions are correct everywhere except
 * here, so this is the one place that unwinds the graph by hand, children first.
 *
 * Each entry deletes the rows belonging to one organization. `demoResetLeavesNothing` in
 * the demo tests walks every model in the schema and fails if any row survives, so a
 * table added later cannot quietly start leaking across resets.
 */
const TEARDOWN: readonly string[] = [
  // Ledger first: it references accounts, jobs, locations and periods.
  `DELETE FROM "JournalLine" WHERE "journalEntryId" IN (SELECT "id" FROM "JournalEntry" WHERE "organizationId" = $1)`,
  `DELETE FROM "JournalEntry" WHERE "organizationId" = $1`,
  `DELETE FROM "AuditLog" WHERE "organizationId" = $1`,

  // Receivables.
  `DELETE FROM "PaymentApplication" WHERE "paymentId" IN (SELECT "id" FROM "Payment" WHERE "organizationId" = $1)`,
  `DELETE FROM "Payment" WHERE "organizationId" = $1`,
  `DELETE FROM "DepositBatch" WHERE "organizationId" = $1`,
  `DELETE FROM "CreditMemo" WHERE "organizationId" = $1`,
  `DELETE FROM "InvoiceTaxLine" WHERE "invoiceId" IN (SELECT "id" FROM "Invoice" WHERE "organizationId" = $1)`,
  `DELETE FROM "InvoiceLine" WHERE "invoiceId" IN (SELECT "id" FROM "Invoice" WHERE "organizationId" = $1)`,

  // Payables and purchasing.
  `DELETE FROM "BillPayment" WHERE "organizationId" = $1`,
  `DELETE FROM "VendorBillLine" WHERE "vendorBillId" IN (SELECT "id" FROM "VendorBill" WHERE "organizationId" = $1)`,
  `DELETE FROM "VendorBill" WHERE "organizationId" = $1`,
  `DELETE FROM "PurchaseOrderLine" WHERE "purchaseOrderId" IN (SELECT "id" FROM "PurchaseOrder" WHERE "organizationId" = $1)`,

  // Inventory.
  `DELETE FROM "InventoryTransaction" WHERE "organizationId" = $1`,
  `DELETE FROM "CycleCountLine" WHERE "cycleCountId" IN (SELECT "id" FROM "CycleCount" WHERE "organizationId" = $1)`,
  `DELETE FROM "CycleCount" WHERE "organizationId" = $1`,
  `DELETE FROM "StockLevel" WHERE "stockLocationId" IN (SELECT "id" FROM "StockLocation" WHERE "organizationId" = $1)`,
  `DELETE FROM "PurchaseOrder" WHERE "organizationId" = $1`,
  `DELETE FROM "StockLocation" WHERE "organizationId" = $1`,
  `DELETE FROM "Vendor" WHERE "organizationId" = $1`,

  // Invoices now that nothing points at them.
  `DELETE FROM "Invoice" WHERE "organizationId" = $1`,

  // Field work.
  `DELETE FROM "TimeEntry" WHERE "technicianId" IN (SELECT "id" FROM "Technician" WHERE "organizationId" = $1)`,
  `DELETE FROM "Photo" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1) OR "quoteId" IN (SELECT "id" FROM "Quote" WHERE "organizationId" = $1)`,
  `DELETE FROM "ChecklistInstance" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1)`,
  `DELETE FROM "ChecklistTemplate" WHERE "organizationId" = $1`,
  `DELETE FROM "JobNote" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1)`,
  `DELETE FROM "Permit" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1)`,
  `DELETE FROM "JobLine" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1)`,
  `DELETE FROM "ChangeOrder" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1)`,
  `DELETE FROM "JobAssignment" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1)`,
  `DELETE FROM "JobVisit" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1)`,

  // Quotes release their hold on jobs, then jobs release theirs on quotes.
  `UPDATE "Quote" SET "jobId" = NULL, "signatureId" = NULL WHERE "organizationId" = $1`,
  `UPDATE "Job" SET "parentJobId" = NULL, "sourceQuoteId" = NULL WHERE "organizationId" = $1`,
  `DELETE FROM "QuoteLine" WHERE "quoteId" IN (SELECT "id" FROM "Quote" WHERE "organizationId" = $1)`,
  `DELETE FROM "QuoteOption" WHERE "quoteId" IN (SELECT "id" FROM "Quote" WHERE "organizationId" = $1)`,
  `DELETE FROM "Quote" WHERE "organizationId" = $1`,
  `DELETE FROM "Signature" WHERE "jobId" IN (SELECT "id" FROM "Job" WHERE "organizationId" = $1) OR "jobId" IS NULL AND "id" NOT IN (SELECT "signatureId" FROM "Quote" WHERE "signatureId" IS NOT NULL)`,
  `DELETE FROM "Job" WHERE "organizationId" = $1`,
  `DELETE FROM "ServiceAgreement" WHERE "organizationId" = $1`,
  `DELETE FROM "Lead" WHERE "organizationId" = $1`,

  // Catalog.
  `DELETE FROM "PriceBookKitComponent" WHERE "parentId" IN (SELECT "id" FROM "PriceBookItem" WHERE "organizationId" = $1)`,
  `DELETE FROM "PriceOverride" WHERE "priceBookItemId" IN (SELECT "id" FROM "PriceBookItem" WHERE "organizationId" = $1)`,
  `DELETE FROM "PriceBookItem" WHERE "organizationId" = $1`,
  `DELETE FROM "ServiceType" WHERE "organizationId" = $1`,

  // CRM.
  `DELETE FROM "Equipment" WHERE "propertyId" IN (SELECT p."id" FROM "Property" p JOIN "Customer" c ON c."id" = p."customerId" WHERE c."organizationId" = $1)`,
  `DELETE FROM "Contact" WHERE "customerId" IN (SELECT "id" FROM "Customer" WHERE "organizationId" = $1)`,
  `DELETE FROM "Property" WHERE "customerId" IN (SELECT "id" FROM "Customer" WHERE "organizationId" = $1)`,
  `DELETE FROM "Customer" WHERE "organizationId" = $1`,

  // People.
  `DELETE FROM "TechnicianCredential" WHERE "technicianId" IN (SELECT "id" FROM "Technician" WHERE "organizationId" = $1)`,
  `DELETE FROM "TechnicianSkill" WHERE "technicianId" IN (SELECT "id" FROM "Technician" WHERE "organizationId" = $1)`,
  `DELETE FROM "TechnicianRate" WHERE "technicianId" IN (SELECT "id" FROM "Technician" WHERE "organizationId" = $1)`,
  `DELETE FROM "Technician" WHERE "organizationId" = $1`,
  `DELETE FROM "Skill" WHERE "organizationId" = $1`,
  `DELETE FROM "Session" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "organizationId" = $1)`,
  `DELETE FROM "UserLocation" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "organizationId" = $1)`,
  `DELETE FROM "UserRole" WHERE "userId" IN (SELECT "id" FROM "User" WHERE "organizationId" = $1)`,
  `DELETE FROM "User" WHERE "organizationId" = $1`,
  `DELETE FROM "Role" WHERE "organizationId" = $1`,

  // Accounting structure.
  `DELETE FROM "BankReconciliation" WHERE "organizationId" = $1`,
  `DELETE FROM "TaxRule" WHERE "taxJurisdictionId" IN (SELECT "id" FROM "TaxJurisdiction" WHERE "organizationId" = $1)`,
  `DELETE FROM "TaxJurisdiction" WHERE "organizationId" = $1`,
  `DELETE FROM "Account" WHERE "organizationId" = $1`,
  `DELETE FROM "AccountingPeriod" WHERE "organizationId" = $1`,
  `DELETE FROM "DocumentSequence" WHERE "organizationId" = $1`,

  // Platform.
  `DELETE FROM "SyncOperation" WHERE "organizationId" = $1`,
  `DELETE FROM "Notification" WHERE "organizationId" = $1`,
  `DELETE FROM "ImportBatch" WHERE "organizationId" = $1`,
  `DELETE FROM "ImportMapping" WHERE "organizationId" = $1`,

  // Sites and, last, the organization itself.
  `DELETE FROM "ServiceArea" WHERE "locationId" IN (SELECT "id" FROM "Location" WHERE "organizationId" = $1)`,
  `DELETE FROM "Location" WHERE "organizationId" = $1`,
  `DELETE FROM "Organization" WHERE "id" = $1`,
];

/**
 * Delete a demo organization outright.
 *
 * The ledger's immutability triggers block deleting a posted journal entry, which is the
 * correct behaviour everywhere except here. They are disabled for the duration of this
 * transaction only, and only after the DEMO check above has passed.
 */
export async function deleteDemoOrganization(
  db: PrismaClient,
  organizationId: string,
): Promise<void> {
  await assertDemoOrganization(db, organizationId);

  await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "JournalEntry" DISABLE TRIGGER "JournalEntry_immutable"');
      await tx.$executeRawUnsafe('ALTER TABLE "JournalLine" DISABLE TRIGGER "JournalLine_immutable"');
      await tx.$executeRawUnsafe('ALTER TABLE "JournalLine" DISABLE TRIGGER "JournalLine_balanced"');
      await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_append_only"');
      try {
        for (const statement of TEARDOWN) {
          await tx.$executeRawUnsafe(statement, organizationId);
        }
      } finally {
        await tx.$executeRawUnsafe('ALTER TABLE "JournalEntry" ENABLE TRIGGER "JournalEntry_immutable"');
        await tx.$executeRawUnsafe('ALTER TABLE "JournalLine" ENABLE TRIGGER "JournalLine_immutable"');
        await tx.$executeRawUnsafe('ALTER TABLE "JournalLine" ENABLE TRIGGER "JournalLine_balanced"');
        await tx.$executeRawUnsafe('ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_append_only"');
      }
    },
    { timeout: 120_000 },
  );
}

/** Wipe every demo organization and build a fresh one. Live organizations are untouched. */
export async function resetDemoData(
  db: PrismaClient,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const existing = await db.organization.findMany({
    where: { dataMode: 'DEMO' },
    select: { id: true },
  });

  for (const org of existing) {
    await deleteDemoOrganization(db, org.id);
  }

  return seedDemoCompany(db, options);
}
