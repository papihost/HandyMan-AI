import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney, sum } from '../../../lib/money';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import { openBills } from '../../../lib/purchasing/reports';
import { Flag, Money, Panel, StatTile } from '../../../components/office/primitives';
import { PayBillButton, PayRunButton } from '../../../components/office/payables-actions';

export const dynamic = 'force-dynamic';

/**
 * Payables.
 *
 * Receivables asks who owes us and how long they have taken; this asks the same of us. It
 * is read off the bills rather than off a balance, so what it says is owed is the set of
 * documents that say so — and the run that pays them leaves a payment record against each
 * one, which is what lets a bank line be matched to the bills it settled.
 */
export default async function PayablesPage() {
  const ctx = await requireContext();
  const canPay = ctx.permissions.has(PERMISSIONS.BILL_PAY);

  const payables = await openBills(db, ctx);

  /*
   * What the run would pay.
   *
   * Everything due, when anything is due. When nothing is yet — which is what a shop that
   * pays on time looks like on most days — the offer becomes the week ahead, because a
   * button that pays nothing is worse than no button. Either way it names the horizon it
   * is about to clear rather than leaving somebody to guess it.
   */
  const dueNow = payables.bills.filter((bill) => bill.daysOverdue >= 0);
  const run = dueNow.length > 0
    ? { bills: dueNow, days: 0, label: 'Pay everything due', horizon: 'due now' }
    : {
        bills: payables.bills.filter((bill) => bill.daysOverdue > -7),
        days: 7,
        label: 'Pay the week ahead',
        horizon: 'due within seven days',
      };
  const due = run.bills;
  const dueCents = sum(due.map((bill) => bill.balanceCents));
  const vendorCount = new Set(due.map((bill) => bill.vendorName)).size;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Payables</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          What the company owes, oldest due first
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Owed"
          value={formatMoney(payables.totalCents)}
          note={`${payables.bills.length} open ${payables.bills.length === 1 ? 'bill' : 'bills'}`}
        />
        <StatTile
          label="Late"
          value={formatMoney(payables.overdueCents)}
          tone={payables.overdueCents > 0n ? 'warning' : 'good'}
          note="past its terms"
        />
        <StatTile
          label="Due this week"
          value={formatMoney(payables.dueThisWeekCents)}
          note="within seven days"
        />
      </div>

      <Panel
        title="Open bills"
        subtitle={
          due.length > 0
            ? `${formatMoney(dueCents)} ${run.horizon}, across ${vendorCount} ${vendorCount === 1 ? 'supplier' : 'suppliers'}`
            : 'Nothing is due yet'
        }
        action={
          canPay ? (
            <PayRunButton
              dueCount={due.length}
              dueCents={dueCents.toString()}
              days={run.days}
              label={run.label}
            />
          ) : undefined
        }
      >
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Bill</th>
                <th>Supplier</th>
                <th>For</th>
                <th className="num">Due</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payables.bills.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ color: 'var(--ink-2)' }}>
                    Nothing outstanding. Bills arrive from{' '}
                    <Link href="/office/purchase-orders" style={{ color: 'var(--seq)' }}>
                      received orders
                    </Link>{' '}
                    and from receipts the technicians send in.
                  </td>
                </tr>
              ) : (
                payables.bills.map((bill) => (
                  <tr key={bill.id}>
                    <td>
                      <div className="font-medium">{bill.billNo}</div>
                      <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                        {bill.vendorInvoiceNo ? `their ${bill.vendorInvoiceNo}` : 'no invoice number'}
                      </div>
                    </td>
                    <td>
                      {bill.vendorName}
                      {bill.is1099Vendor && (
                        <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                          1099
                        </div>
                      )}
                    </td>
                    <td className="text-sm">
                      {bill.poNo ?? bill.jobNo ?? <span style={{ color: 'var(--ink-3)' }}>—</span>}
                    </td>
                    <td className="num">
                      {bill.daysOverdue > 0 ? (
                        <Flag tone={bill.daysOverdue > 30 ? 'critical' : 'warning'}>
                          {bill.daysOverdue === 1 ? '1 day late' : `${bill.daysOverdue} days late`}
                        </Flag>
                      ) : (
                        <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
                          {bill.daysOverdue === 0
                            ? 'today'
                            : bill.daysOverdue === -1
                              ? 'tomorrow'
                              : `in ${-bill.daysOverdue} days`}
                        </span>
                      )}
                    </td>
                    <td className="num font-semibold">
                      <Money cents={bill.balanceCents} />
                    </td>
                    <td className="num">{canPay && <PayBillButton billId={bill.id} />}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
