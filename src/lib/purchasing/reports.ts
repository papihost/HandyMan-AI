import type { PrismaClient } from '@prisma/client';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { sum, type Cents } from '../money';

/**
 * What the company owes, and when.
 *
 * The mirror of the aging report on the receivable side, and read the same way — off the
 * bills themselves rather than a balance somebody maintains. The buckets are the ones a
 * person paying bills on a Friday actually uses: what is already late, what falls due
 * inside the week, and what can wait.
 */
export interface OpenBill {
  id: string;
  billNo: string;
  vendorInvoiceNo: string | null;
  vendorName: string;
  is1099Vendor: boolean;
  billDate: Date;
  dueDate: Date | null;
  /** Negative until it falls due, so "in 4 days" and "9 days late" are one number. */
  daysOverdue: number;
  balanceCents: Cents;
  poNo: string | null;
  /** The job this cost was coded to, when it was bought for one. */
  jobNo: string | null;
}

export async function openBills(
  db: PrismaClient,
  ctx: AuthContext,
  asOf = new Date(),
): Promise<{
  bills: OpenBill[];
  totalCents: Cents;
  overdueCents: Cents;
  dueThisWeekCents: Cents;
  laterCents: Cents;
}> {
  requirePermission(ctx, PERMISSIONS.BILL_READ);

  const rows = await db.vendorBill.findMany({
    where: {
      organizationId: ctx.organizationId,
      status: { in: ['OPEN', 'PARTIALLY_PAID'] },
    },
    // Oldest due first: that is the order they should be paid in, so it is the order they
    // are shown in.
    orderBy: [{ dueDate: 'asc' }, { billNo: 'asc' }],
    take: 200,
    select: {
      id: true,
      billNo: true,
      vendorInvoiceNo: true,
      billDate: true,
      dueDate: true,
      totalCents: true,
      paidCents: true,
      vendor: { select: { name: true, is1099Vendor: true } },
      purchaseOrder: { select: { poNo: true } },
      lines: { where: { jobId: { not: null } }, select: { job: { select: { jobNo: true } } } },
    },
  });

  const day = 86_400_000;
  const bills: OpenBill[] = rows.map((row) => ({
    id: row.id,
    billNo: row.billNo,
    vendorInvoiceNo: row.vendorInvoiceNo,
    vendorName: row.vendor.name,
    is1099Vendor: row.vendor.is1099Vendor,
    billDate: row.billDate,
    dueDate: row.dueDate,
    daysOverdue: row.dueDate
      ? Math.floor((asOf.getTime() - row.dueDate.getTime()) / day)
      : 0,
    balanceCents: row.totalCents - row.paidCents,
    poNo: row.purchaseOrder?.poNo ?? null,
    jobNo: row.lines.find((line) => line.job)?.job?.jobNo ?? null,
  }));

  const inBucket = (test: (bill: OpenBill) => boolean) =>
    sum(bills.filter(test).map((bill) => bill.balanceCents));

  return {
    bills,
    totalCents: sum(bills.map((bill) => bill.balanceCents)),
    overdueCents: inBucket((bill) => bill.daysOverdue > 0),
    dueThisWeekCents: inBucket((bill) => bill.daysOverdue <= 0 && bill.daysOverdue > -7),
    laterCents: inBucket((bill) => bill.daysOverdue <= -7),
  };
}
