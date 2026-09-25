import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney } from '../../../lib/money';
import { agingReport } from '../../../lib/invoices/service';
import { undepositedPayments } from '../../../lib/invoices/banking';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import { BankTakingsButton } from '../../../components/office/payment-actions';
import { Flag, Money, Panel, StatTile } from '../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/** How the money came in, in the words a person would use for it. */
const METHOD_LABEL: Record<string, string> = {
  CASH: 'cash',
  CHECK: 'cheque',
  CARD: 'card',
  ACH: 'bank transfer',
  FINANCING: 'finance',
  OTHER: 'other',
};

/**
 * Receivables.
 *
 * The buckets are an ordered scale, so the bars use one hue getting darker as the debt
 * gets older — the darkest bar is the oldest money, without needing a legend to say so.
 */
const BUCKETS = [
  { key: 'current', label: 'Not yet due', ramp: 'var(--ord-1)' },
  { key: 'days30', label: '1–30 days', ramp: 'var(--ord-2)' },
  { key: 'days60', label: '31–60 days', ramp: 'var(--ord-3)' },
  { key: 'days90', label: '61–90 days', ramp: 'var(--ord-4)' },
  { key: 'over90', label: 'Over 90 days', ramp: 'var(--ord-5)' },
] as const;

export default async function InvoicesPage() {
  const ctx = await requireContext();
  const aging = await agingReport(db, ctx);

  /*
   * Money the field has already collected that no invoice has claimed yet.
   *
   * It is not a receivable — it is the opposite, a liability, because the work has not
   * been billed and the money is owed back until it is. It belongs on this screen anyway:
   * whoever is chasing debt needs to know which of these calls has already been paid for,
   * or they will ring a customer who settled on the doorstep last Tuesday.
   */
  /*
   * What has been collected and has not reached the bank.
   *
   * Cash and cheques are not in the bank when they are taken; they are in a van, a drawer,
   * an envelope. Undeposited Funds is where they sit until somebody makes the trip, and
   * the gap is both a real risk — this is the money that goes missing — and the reason a
   * bank reconciliation can be done at all.
   */
  const inHand = await undepositedPayments(db, ctx);

  const collected = await db.payment.findMany({
    where: { organizationId: ctx.organizationId, isDeposit: true, unappliedCents: { gt: 0 } },
    orderBy: { receivedAt: 'desc' },
    take: 25,
    select: {
      id: true,
      paymentNo: true,
      method: true,
      unappliedCents: true,
      receivedAt: true,
      reference: true,
      customer: { select: { companyName: true, firstName: true, lastName: true } },
      job: { select: { id: true, jobNo: true, title: true, status: true } },
      collectedBy: { select: { user: { select: { firstName: true, lastName: true } } } },
    },
  });
  const collectedCents = collected.reduce((total, row) => total + row.unappliedCents, 0n);

  const values = BUCKETS.map((bucket) => aging.buckets[bucket.key]);
  const max = Math.max(1, ...values.map(Number));
  const overdue = aging.totalCents - aging.buckets.current;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Receivables</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          As at {aging.asOf.toLocaleDateString()}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Owed to us" value={formatMoney(aging.totalCents)} note={`${aging.invoices.length} open invoices`} />
        <StatTile
          label="Overdue"
          value={formatMoney(overdue)}
          tone={overdue > 0n ? 'warning' : 'good'}
          note="past its due date"
        />
        <StatTile label="Over 90 days" value={formatMoney(aging.buckets.over90)} tone={aging.buckets.over90 > 0n ? 'critical' : 'good'} />
      </div>

      {(inHand.payments.length > 0 || !inHand.matches) && (
        <Panel
          title="In hand, not yet banked"
          subtitle={`${formatMoney(inHand.totalCents)} in cash and cheques, the oldest taken ${inHand.oldest ? Math.floor((Date.now() - inHand.oldest.getTime()) / 86_400_000) : 0} days ago. Card takings are not here — they settle from the processor on its own schedule`}
          action={
            ctx.permissions.has(PERMISSIONS.PAYMENT_RECORD) && inHand.matches ? (
              <BankTakingsButton
                count={inHand.payments.length}
                totalCents={inHand.totalCents.toString()}
              />
            ) : undefined
          }
        >
          {!inHand.matches && (
            <div className="px-4 pb-1">
              <Flag tone="critical">
                The ledger says {formatMoney(inHand.ledgerCents)} is undeposited, and these
                payments add up to {formatMoney(inHand.totalCents)}
              </Flag>
              <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
                Something moved the balance without a paying-in slip behind it. Until that is
                found, banking from this screen would post the difference twice.
              </p>
            </div>
          )}
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Taken</th>
                  <th>Payment</th>
                  <th>Customer</th>
                  <th>Who took it</th>
                  <th>How</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {inHand.payments.slice(0, 12).map((payment) => (
                  <tr key={payment.id}>
                    <td>{payment.receivedAt.toLocaleDateString()}</td>
                    <td className="font-medium">{payment.paymentNo}</td>
                    <td>{payment.customerName}</td>
                    <td className="text-sm">{payment.collectedByName ?? 'the office'}</td>
                    <td className="text-sm">
                      {payment.method === 'CHECK' ? 'cheque' : 'cash'}
                      {payment.reference ? ` ${payment.reference}` : ''}
                    </td>
                    <td className="num font-semibold">
                      <Money cents={payment.amountCents} />
                    </td>
                  </tr>
                ))}
                {inHand.payments.length > 12 && (
                  <tr>
                    <td colSpan={6} style={{ color: 'var(--ink-3)' }}>
                      and {inHand.payments.length - 12} more
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {collected.length > 0 && (
        <Panel
          title="Taken in the field, not yet billed"
          subtitle={`${formatMoney(collectedCents)} collected on site against work nobody has invoiced. It is held as a customer deposit — a liability — and the invoice picks it up automatically when it is raised`}
        >
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Taken</th>
                  <th>Customer</th>
                  <th>Job</th>
                  <th>By</th>
                  <th>How</th>
                  <th className="num">Held</th>
                </tr>
              </thead>
              <tbody>
                {collected.map((row) => (
                  <tr key={row.id}>
                    <td>{row.receivedAt.toLocaleDateString()}</td>
                    <td>
                      {row.customer.companyName ??
                        [row.customer.firstName, row.customer.lastName].filter(Boolean).join(' ')}
                    </td>
                    <td>
                      {row.job ? (
                        <Link href={`/office/jobs/${row.job.id}`} style={{ color: 'var(--seq)' }}>
                          {row.job.jobNo}
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--ink-3)' }}>on account</span>
                      )}
                      <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                        {row.job?.title ?? '—'}
                      </div>
                    </td>
                    <td className="text-sm">
                      {row.collectedBy
                        ? `${row.collectedBy.user.firstName} ${row.collectedBy.user.lastName}`
                        : 'the office'}
                    </td>
                    <td className="text-sm">
                      {METHOD_LABEL[row.method] ?? row.method.toLowerCase()}
                      {row.reference ? ` ${row.reference}` : ''}
                    </td>
                    <td className="num font-semibold">
                      <Money cents={row.unappliedCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title="Ageing" subtitle="Older debt is darker">
        <table>
          <tbody>
            {BUCKETS.map((bucket) => {
              const value = aging.buckets[bucket.key];
              return (
                <tr key={bucket.key}>
                  <td style={{ width: '30%' }} className="font-medium">
                    {bucket.label}
                  </td>
                  <td>
                    <div
                      className="h-2.5 w-full overflow-hidden rounded-full"
                      style={{ background: 'var(--grid)' }}
                      role="img"
                      aria-label={`${bucket.label}: ${formatMoney(value)}`}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, (Number(value) / max) * 100)}%`,
                          background: bucket.ramp,
                        }}
                      />
                    </div>
                  </td>
                  <td className="num font-semibold">
                    <Money cents={value} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

      <Panel title="Open invoices" subtitle="Oldest first">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Customer</th>
                <th>Due</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {aging.invoices
                .slice()
                .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())
                .slice(0, 60)
                .map((invoice) => {
                  const daysLate = Math.floor(
                    (aging.asOf.getTime() - invoice.dueDate.getTime()) / 86_400_000,
                  );
                  return (
                    <tr key={invoice.id}>
                      <td>
                        <Link
                          href={`/office/invoices/${invoice.id}`}
                          className="font-medium"
                          style={{ color: 'var(--seq)' }}
                        >
                          {invoice.invoiceNo}
                        </Link>
                      </td>
                      <td>
                        {invoice.customer.companyName ??
                          [invoice.customer.firstName, invoice.customer.lastName]
                            .filter(Boolean)
                            .join(' ')}
                      </td>
                      <td>
                        {daysLate > 90 ? (
                          <Flag tone="critical">{daysLate} days late</Flag>
                        ) : daysLate > 0 ? (
                          <Flag tone="serious">{daysLate} days late</Flag>
                        ) : (
                          <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
                            {invoice.dueDate.toLocaleDateString()}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        <Money cents={invoice.balanceCents} />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
