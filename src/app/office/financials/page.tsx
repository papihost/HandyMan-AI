import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney } from '../../../lib/money';
import { balanceSheet, incomeStatement, profitByLocation, trialBalance } from '../../../lib/accounting/reports';
import { Flag, Money, Panel, Percent } from '../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/**
 * The financial statements, off the same ledger everything else reads.
 *
 * The trial balance carries its own balanced/not-balanced verdict rather than leaving a
 * reader to add up two columns. It is the one assertion that makes the rest of the page
 * worth reading.
 */
export default async function FinancialsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requireContext();
  const { from: fromParam, to: toParam } = await searchParams;

  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam ? new Date(fromParam) : new Date(Date.UTC(to.getUTCFullYear(), 0, 1));
  const period = { from, to };

  const [pl, bs, tb, byLocation, periods] = await Promise.all([
    incomeStatement(db, ctx, period),
    balanceSheet(db, ctx, to),
    trialBalance(db, ctx, period),
    profitByLocation(db, ctx, period),
    db.accountingPeriod.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ fiscalYear: 'desc' }, { periodNumber: 'desc' }],
      take: 6,
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Financials</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {from.toLocaleDateString()} to {to.toLocaleDateString()}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {tb.isBalanced ? (
          <Flag tone="good">Trial balance is in balance at {formatMoney(tb.totalDebitsCents)}</Flag>
        ) : (
          <Flag tone="critical">Trial balance does not balance — investigate</Flag>
        )}
        {bs.isBalanced ? (
          <Flag tone="good">Balance sheet ties</Flag>
        ) : (
          <Flag tone="critical">Balance sheet does not tie</Flag>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Income statement" subtitle="Consolidated">
          <table>
            <tbody>
              <Section label="Revenue" rows={pl.revenue.rows} total={pl.revenue.totalCents} />
              <Section
                label="Cost of goods sold"
                rows={pl.costOfGoodsSold.rows}
                total={pl.costOfGoodsSold.totalCents}
              />
              <tr style={{ background: 'var(--plane)' }}>
                <td className="font-semibold">Gross profit</td>
                <td className="num font-semibold">
                  <Money cents={pl.grossProfitCents} bold />
                </td>
                <td className="num font-semibold">
                  <Percent value={pl.grossMarginPercent} />
                </td>
              </tr>
              <Section
                label="Operating expenses"
                rows={pl.operatingExpenses.rows}
                total={pl.operatingExpenses.totalCents}
              />
              <tr style={{ background: 'var(--plane)' }}>
                <td className="font-semibold">Net income</td>
                <td className="num font-semibold">
                  <Money cents={pl.netIncomeCents} bold />
                </td>
                <td className="num font-semibold">
                  {pl.revenue.totalCents === 0n
                    ? '—'
                    : `${(Number((pl.netIncomeCents * 1000n) / pl.revenue.totalCents) / 10).toFixed(1)}%`}
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>

        <div className="space-y-4">
          <Panel title="By branch" subtitle="Same period, segmented by the location on each journal line">
            <table>
              <thead>
                <tr>
                  <th>Branch</th>
                  <th className="num">Revenue</th>
                  <th className="num">Gross profit</th>
                  <th className="num">Margin</th>
                </tr>
              </thead>
              <tbody>
                {byLocation.map((row) => (
                  <tr key={row.locationId ?? 'none'}>
                    <td className="font-medium">{row.locationName}</td>
                    <td className="num">
                      <Money cents={row.revenueCents} />
                    </td>
                    <td className="num">
                      <Money cents={row.grossProfitCents} />
                    </td>
                    <td className="num font-semibold">
                      <Percent value={row.grossMarginPercent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Balance sheet" subtitle={`As at ${to.toLocaleDateString()}`}>
            <table>
              <tbody>
                <tr>
                  <td className="font-semibold">Assets</td>
                  <td className="num font-semibold">
                    <Money cents={bs.assets.totalCents} bold />
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--ink-2)' }}>Liabilities</td>
                  <td className="num">
                    <Money cents={bs.liabilities.totalCents} />
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--ink-2)' }}>Equity</td>
                  <td className="num">
                    <Money cents={bs.equity.totalCents} />
                  </td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--ink-2)' }}>Earnings this year</td>
                  <td className="num">
                    <Money cents={bs.currentEarningsCents} />
                  </td>
                </tr>
                <tr>
                  <td className="font-semibold">Liabilities and equity</td>
                  <td className="num font-semibold">
                    <Money cents={bs.totalLiabilitiesAndEquityCents} bold />
                  </td>
                </tr>
              </tbody>
            </table>
          </Panel>

          <Panel title="Periods" subtitle="A posting dated inside a closed period is refused">
            <table>
              <tbody>
                {periods.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.fiscalYear}-{String(row.periodNumber).padStart(2, '0')}
                    </td>
                    <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                      {row.startDate.toLocaleDateString()} – {row.endDate.toLocaleDateString()}
                    </td>
                    <td className="num">
                      {row.status === 'OPEN' ? (
                        <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
                          open
                        </span>
                      ) : (
                        <Flag tone="good">{row.status.toLowerCase()}</Flag>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      </div>

      <Panel title="Trial balance" subtitle="Every account with movement in the period">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Type</th>
                <th className="num">Debits</th>
                <th className="num">Credits</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((row) => (
                <tr key={row.accountId}>
                  <td>
                    <Link
                      href={`/office/financials/account/${row.accountId}?from=${from.toISOString().slice(0, 10)}&to=${to.toISOString().slice(0, 10)}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      <span className="tabular-nums">{row.code}</span> {row.name}
                    </Link>
                  </td>
                  <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                    {row.type.replace('_', ' ').toLowerCase()}
                  </td>
                  <td className="num">
                    <Money cents={row.debitsCents} />
                  </td>
                  <td className="num">
                    <Money cents={row.creditsCents} />
                  </td>
                  <td className="num font-semibold">
                    <Money cents={row.balanceCents} />
                  </td>
                </tr>
              ))}
              <tr style={{ background: 'var(--plane)' }}>
                <td colSpan={2} className="font-semibold">
                  Total
                </td>
                <td className="num font-semibold">
                  <Money cents={tb.totalDebitsCents} bold />
                </td>
                <td className="num font-semibold">
                  <Money cents={tb.totalCreditsCents} bold />
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Section({
  label,
  rows,
  total,
}: {
  label: string;
  rows: { accountId: string; code: string; name: string; balanceCents: bigint }[];
  total: bigint;
}) {
  return (
    <>
      <tr>
        <td colSpan={3} className="pt-4 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
          {label}
        </td>
      </tr>
      {rows.map((row) => (
        <tr key={row.accountId}>
          <td style={{ color: 'var(--ink-2)' }}>
            <span className="tabular-nums">{row.code}</span> {row.name}
          </td>
          <td className="num">
            <Money cents={row.balanceCents} />
          </td>
          <td />
        </tr>
      ))}
      <tr>
        <td className="font-medium">Total {label.toLowerCase()}</td>
        <td className="num font-medium">
          <Money cents={total} />
        </td>
        <td />
      </tr>
    </>
  );
}
