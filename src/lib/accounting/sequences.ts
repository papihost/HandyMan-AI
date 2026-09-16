import type { Tx } from '../db';

/**
 * Gapless, unique document numbers.
 *
 * Invoice numbers cannot repeat and auditors dislike gaps, so the counter is allocated
 * inside the same transaction as the document it numbers: the row lock serializes
 * concurrent allocation, and a rollback returns the number to the pool.
 *
 * `SELECT ... FOR UPDATE` rather than an atomic increment, because the sequence row must
 * stay locked for the remainder of the transaction — an atomic bump would release
 * immediately and could hand out a number that a later rollback silently burns.
 */

export type DocumentType =
  | 'JOURNAL_ENTRY'
  | 'CUSTOMER'
  | 'INVOICE'
  | 'QUOTE'
  | 'JOB'
  | 'PAYMENT'
  | 'PURCHASE_ORDER'
  | 'VENDOR_BILL'
  | 'BILL_PAYMENT'
  | 'CREDIT_MEMO'
  | 'DEPOSIT'
  | 'CHANGE_ORDER'
  | 'CYCLE_COUNT'
  | 'SERVICE_AGREEMENT';

const DEFAULT_PREFIX: Record<DocumentType, string> = {
  JOURNAL_ENTRY: 'JE-',
  CUSTOMER: 'C-',
  INVOICE: 'INV-',
  QUOTE: 'Q-',
  JOB: 'J-',
  PAYMENT: 'PMT-',
  PURCHASE_ORDER: 'PO-',
  VENDOR_BILL: 'BILL-',
  BILL_PAYMENT: 'BP-',
  CREDIT_MEMO: 'CM-',
  DEPOSIT: 'DEP-',
  CHANGE_ORDER: 'CO-',
  CYCLE_COUNT: 'CC-',
  SERVICE_AGREEMENT: 'SA-',
};

export async function nextDocumentNumber(
  tx: Tx,
  organizationId: string,
  docType: DocumentType,
  locationCode?: string,
): Promise<string> {
  // '' means "not location-scoped". It is a sentinel rather than NULL because Postgres
  // treats NULLs as distinct in a unique index, which would let concurrent callers each
  // create their own sequence row and issue the same number twice.
  const scope = locationCode ?? '';

  // Ensure the row exists before locking it. skipDuplicates keeps concurrent creators safe.
  await tx.documentSequence.createMany({
    data: [
      {
        organizationId,
        docType,
        locationCode: scope,
        prefix: DEFAULT_PREFIX[docType],
        nextValue: 1,
        padding: 5,
      },
    ],
    skipDuplicates: true,
  });

  const rows = await tx.$queryRaw<
    { id: string; prefix: string; nextValue: number; padding: number }[]
  >`
    SELECT "id", "prefix", "nextValue", "padding"
    FROM "DocumentSequence"
    WHERE "organizationId" = ${organizationId}
      AND "docType" = ${docType}
      AND "locationCode" = ${scope}
    FOR UPDATE
  `;

  const row = rows[0];
  if (!row) throw new Error(`Document sequence for ${docType} could not be allocated`);

  await tx.documentSequence.update({
    where: { id: row.id },
    data: { nextValue: row.nextValue + 1 },
  });

  return formatDocumentNumber(row.prefix, scope, row.nextValue, row.padding);
}

export function formatDocumentNumber(
  prefix: string,
  locationCode: string | null,
  value: number,
  padding: number,
): string {
  const scopePart = locationCode ? `${locationCode}-` : '';
  return `${prefix}${scopePart}${String(value).padStart(padding, '0')}`;
}
