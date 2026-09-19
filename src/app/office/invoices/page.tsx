import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney } from '../../../lib/money';
import { agingReport } from '../../../lib/invoices/service';
import { Flag, Money, Panel, StatTile } from '../../../components/office/primitives';

export const dynamic = 'force-dynamic';

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
                      <td className="font-medium">{invoice.invoiceNo}</td>
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
