import { ValidationError } from '../../errors';
import { ZERO, type Cents } from '../../money';
import { ACCOUNTS } from '../chart-of-accounts';
import type { PostingLine } from '../ledger';

/**
 * Inventory movements.
 *
 * Cost is always the cost captured at the moment of the movement, never a cost looked up
 * at report time. That is what lets average cost be restated going forward without
 * rewriting the margin on a job that closed last March.
 */

export type StockKind = 'WAREHOUSE' | 'VAN';

const INVENTORY_ACCOUNT: Record<StockKind, string> = {
  WAREHOUSE: ACCOUNTS.INVENTORY_WAREHOUSE,
  VAN: ACCOUNTS.INVENTORY_VAN,
};

/**
 * Parts consumed on a job. This is the moment inventory becomes cost of goods sold, and
 * the moment a job's material cost becomes real.
 *
 *   Dr  COGS — Materials & Parts
 *     Cr  Inventory — Van Stock (or Warehouse)
 *
 * With WIP accounting enabled the debit goes to Work in Process instead, and is relieved
 * to COGS when the job is invoiced.
 */
export function partsConsumedLines(input: {
  jobId: string;
  locationId: string;
  technicianId?: string | null;
  serviceTypeId?: string | null;
  totalCostCents: Cents;
  fromStockKind: StockKind;
  useWip?: boolean;
  description?: string;
}): PostingLine[] {
  if (input.totalCostCents <= ZERO) {
    throw new ValidationError('Consumption must carry a positive cost');
  }

  const dimensions = {
    locationId: input.locationId,
    jobId: input.jobId,
    technicianId: input.technicianId ?? null,
    serviceTypeId: input.serviceTypeId ?? null,
  };
  const memo = input.description ?? 'Parts consumed on job';

  return [
    {
      accountCode: input.useWip ? ACCOUNTS.WIP : ACCOUNTS.COGS_MATERIALS,
      debitCents: input.totalCostCents,
      memo,
      ...dimensions,
    },
    {
      accountCode: INVENTORY_ACCOUNT[input.fromStockKind],
      creditCents: input.totalCostCents,
      memo,
      ...dimensions,
    },
  ];
}

/**
 * Stock received against a purchase order.
 *
 *   Dr  Inventory — Warehouse
 *     Cr  Accounts Payable
 */
export function stockReceivedLines(input: {
  poNo: string;
  locationId?: string | null;
  vendorId?: string | null;
  totalCostCents: Cents;
  toStockKind: StockKind;
  payableAccountCode?: string;
}): PostingLine[] {
  if (input.totalCostCents <= ZERO) throw new ValidationError('Receipt must carry a positive cost');

  const dimensions = { locationId: input.locationId ?? null, vendorId: input.vendorId ?? null };
  return [
    {
      accountCode: INVENTORY_ACCOUNT[input.toStockKind],
      debitCents: input.totalCostCents,
      memo: `Received on ${input.poNo}`,
      ...dimensions,
    },
    {
      accountCode: input.payableAccountCode ?? ACCOUNTS.AP,
      creditCents: input.totalCostCents,
      memo: `Received on ${input.poNo}`,
      ...dimensions,
    },
  ];
}

/**
 * Warehouse to van transfer. Both sides are assets, so this never touches the income
 * statement — but it must still be recorded, or van stock and warehouse stock both drift.
 *
 *   Dr  Inventory — Van Stock
 *     Cr  Inventory — Warehouse
 */
export function stockTransferLines(input: {
  reference: string;
  locationId?: string | null;
  technicianId?: string | null;
  totalCostCents: Cents;
  fromStockKind: StockKind;
  toStockKind: StockKind;
}): PostingLine[] {
  if (input.totalCostCents <= ZERO) throw new ValidationError('Transfer must carry a positive cost');
  if (input.fromStockKind === input.toStockKind) {
    // Same GL account on both sides would net to nothing and clutter the ledger; the
    // inventory subledger still records the movement.
    throw new ValidationError('A transfer between two locations of the same kind has no GL effect');
  }

  const dimensions = {
    locationId: input.locationId ?? null,
    technicianId: input.technicianId ?? null,
  };
  return [
    {
      accountCode: INVENTORY_ACCOUNT[input.toStockKind],
      debitCents: input.totalCostCents,
      memo: `Stock transfer ${input.reference}`,
      ...dimensions,
    },
    {
      accountCode: INVENTORY_ACCOUNT[input.fromStockKind],
      creditCents: input.totalCostCents,
      memo: `Stock transfer ${input.reference}`,
      ...dimensions,
    },
  ];
}

/**
 * Cycle count variance. A positive variance means more stock was found than the system
 * expected; a negative one is shrinkage.
 *
 *   shortage:  Dr Inventory Shrinkage  /  Cr Inventory
 *   overage:   Dr Inventory            /  Cr Inventory Shrinkage
 */
export function cycleCountVarianceLines(input: {
  countNo: string;
  locationId?: string | null;
  stockKind: StockKind;
  varianceCents: Cents;
}): PostingLine[] {
  if (input.varianceCents === ZERO) {
    throw new ValidationError('A count with no variance produces no journal entry');
  }

  const dimensions = { locationId: input.locationId ?? null };
  const inventoryAccount = INVENTORY_ACCOUNT[input.stockKind];
  const memo = `Cycle count ${input.countNo}`;
  const magnitude = input.varianceCents < ZERO ? -input.varianceCents : input.varianceCents;

  if (input.varianceCents < ZERO) {
    return [
      { accountCode: ACCOUNTS.INVENTORY_SHRINKAGE, debitCents: magnitude, memo, ...dimensions },
      { accountCode: inventoryAccount, creditCents: magnitude, memo, ...dimensions },
    ];
  }

  return [
    { accountCode: inventoryAccount, debitCents: magnitude, memo, ...dimensions },
    { accountCode: ACCOUNTS.INVENTORY_SHRINKAGE, creditCents: magnitude, memo, ...dimensions },
  ];
}
