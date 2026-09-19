import Link from 'next/link';
import { db } from '../../lib/db';
import { requireContext } from '../../server/session';
import { formatMoney } from '../../lib/money';
import { profitByLocation } from '../../lib/accounting/reports';
import {
  companySummary,
  flatRateReview,
  marginByBranchAndService,
  marginByServiceType,
  technicianScorecard,
  unappliedLabourByBranch,
  unbilledCompletedJobs,
} from '../../lib/reporting/dashboard';
import { Bar, Flag, Money, Panel, Percent, StatTile } from '../../components/office/primitives';
import { PERMISSIONS } from '../../lib/auth/permissions';

export const dynamic = 'force-dynamic';

/** "1 pt", not "1 pts" — a report that cannot count to one is not trusted with millions. */
function points(value: number): string {
  const rounded = Math.round(value);
  return `${rounded} ${rounded === 1 ? 'pt' : 'pts'}`;
}

export default async function DashboardPage() {
  const ctx = await requireContext();

  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1));
  const period = { from, to };

  const canSeeCost = ctx.permissions.has(PERMISSIONS.FINANCE_READ_COST);

  const [summary, byLocation, byService, byCell, unbilled, scorecard, application, flatRates] =
    await Promise.all([
      companySummary(db, ctx, period),
      profitByLocation(db, ctx, period).catch(() => []),
      marginByServiceType(db, ctx, period),
      marginByBranchAndService(db, ctx, period),
      unbilledCompletedJobs(db, ctx),
      canSeeCost ? technicianScorecard(db, ctx, period) : Promise.resolve([]),
      canSeeCost ? unappliedLabourByBranch(db, ctx, period) : Promise.resolve([]),
      canSeeCost ? flatRateReview(db, ctx, period) : Promise.resolve([]),
    ]);

  // The worst trade-at-a-branch, judged against the same trade elsewhere. A company-wide
  // average hides it: the healthy branches carry the number and nobody notices for a year.
  const worstCell = byCell[0] && byCell[0].pointsBelowTradeAverage > 10 ? byCell[0] : null;

  // A branch can price every trade exactly like its siblings and still finish well
  // behind them, because the gap is paid time that never reached a job. That shows up
  // nowhere in a margin-by-trade table — it is the difference between the two tables.
  const worstApplication =
    application[0] && application[0].pointsAboveBest >= 5 ? application[0] : null;

  // The flat rate that does not pay for itself. It hides inside a healthy-looking trade,
  // which is exactly why the trade table alone is not enough.
  const worstRate = flatRates[0] && flatRates[0].marginPercent < 30 ? flatRates[0] : null;

  const maxBranchRevenue = Math.max(1, ...byLocation.map((row) => Number(row.revenueCents)));
  const maxServiceRevenue = Math.max(1, ...byService.map((row) => Number(row.revenueCents)));
  const outlier = byService.find((row) => row.isOutlier);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          Trailing twelve months to {to.toLocaleDateString()}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Revenue" value={formatMoney(summary.revenueCents)} note="last 12 months" />
        <StatTile
          label="Gross margin"
          value={`${summary.grossMarginPercent.toFixed(1)}%`}
          note={`${formatMoney(summary.grossProfitCents)} gross profit`}
        />
        <StatTile
          label="Net income"
          value={formatMoney(summary.netIncomeCents)}
          note={`${summary.netMarginPercent.toFixed(1)}% of revenue`}
          tone={summary.netIncomeCents > 0n ? 'good' : 'critical'}
        />
        <StatTile
          label="Owed to us"
          value={formatMoney(summary.receivablesCents)}
          note={`${formatMoney(summary.cashCents)} in the bank`}
        />
      </div>

      {/* The most immediately actionable number: earned, unbilled, and ageing. */}
      {summary.unbilledJobCount > 0 && (
        <Link href="/office/jobs?filter=unbilled" className="panel block p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Flag tone="serious">
                {formatMoney(summary.unbilledCents)} of finished work is not invoiced
              </Flag>
              <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
                {summary.unbilledJobCount} completed {summary.unbilledJobCount === 1 ? 'job' : 'jobs'}
                {unbilled.jobs[0]
                  ? ` — the oldest has been waiting ${unbilled.jobs[0].daysWaiting} days`
                  : ''}
              </p>
            </div>
            <span className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
              Review →
            </span>
          </div>
        </Link>
      )}

      {worstCell && (
        <div className="panel p-4">
          <Flag tone="critical">
            {worstCell.serviceName} in {worstCell.locationName} is{' '}
            {worstCell.pointsBelowTradeAverage.toFixed(0)} points below the same work
            elsewhere
          </Flag>
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
            {formatMoney(worstCell.revenueCents)} of revenue at{' '}
            {worstCell.grossMarginPercent.toFixed(1)}% gross margin, against{' '}
            {(worstCell.grossMarginPercent + worstCell.pointsBelowTradeAverage).toFixed(1)}% for
            the same trade at the other branches. Usually a price that has not moved while
            costs did.
          </p>
        </div>
      )}

      {worstRate && (
        <Link href="/office/pricing" className="panel block p-4">
          <Flag tone="critical">
            {worstRate.name} returns {worstRate.marginPercent.toFixed(1)}% over what it costs
          </Flag>
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
            Sold {worstRate.timesSold} times in the last twelve months for{' '}
            {formatMoney(worstRate.revenueCents)}
            {worstRate.branches.length > 1 &&
              ` — ${worstRate.branches[0].locationName} sells it at ${worstRate.branches[0].marginPercent.toFixed(1)}%`}
            . The price has not moved while the cost has, and {worstRate.serviceName} looks
            healthy overall because the rest of the trade carries it.
          </p>
          <span className="mt-1 inline-block text-sm font-semibold" style={{ color: 'var(--seq)' }}>
            Review the price book →
          </span>
        </Link>
      )}

      {worstApplication && (
        <div className="panel p-4">
          <Flag tone="serious">
            {worstApplication.locationName} pays for{' '}
            {worstApplication.unappliedPercentOfRevenue.toFixed(1)}% of its revenue in hours
            that never reached a job
          </Flag>
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
            {formatMoney(worstApplication.unappliedCostCents)} of paid time with no job
            against it, {worstApplication.pointsAboveBest.toFixed(1)} points more of revenue
            than the best-run branch spends the same way. Its prices are in line with the
            other branches — the margin goes on hours nobody sold, which is a dispatch
            problem rather than a pricing one.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Branches"
          subtitle="All-in gross margin — every cost the branch carried, trailing twelve months"
        >
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
                  <td>
                    <div className="font-medium">{row.locationName}</div>
                    <div className="mt-1.5 max-w-44">
                      <Bar
                        value={Number(row.revenueCents)}
                        max={maxBranchRevenue}
                        label={`${row.locationName}: ${formatMoney(row.revenueCents)}`}
                      />
                    </div>
                  </td>
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

        <Panel
          title="Service lines"
          subtitle={
            outlier
              ? `${outlier.name} is running well under the rest — worth a look`
              : 'Margin on costs traced to the job — see branches for all-in'
          }
        >
          <table>
            <thead>
              <tr>
                <th>Service line</th>
                <th className="num">Revenue</th>
                <th className="num">Margin</th>
              </tr>
            </thead>
            <tbody>
              {byService.map((row) => (
                <tr key={row.serviceTypeId ?? 'none'}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.name}</span>
                      {/* Emphasis: one bar is the point, the rest are context. The colour
                          never stands alone — the flag names the problem. */}
                      {row.isOutlier && <Flag tone="critical">low margin</Flag>}
                    </div>
                    <div className="mt-1.5 max-w-44">
                      <Bar
                        value={Number(row.revenueCents)}
                        max={maxServiceRevenue}
                        emphasis={row.isOutlier ? 'critical' : undefined}
                        label={`${row.name}: ${formatMoney(row.revenueCents)}`}
                      />
                    </div>
                  </td>
                  <td className="num">
                    <Money cents={row.revenueCents} />
                  </td>
                  <td className="num font-semibold">
                    <Percent value={row.grossMarginPercent} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      {byCell.length > 0 && (
        <Panel
          title="Trade by branch"
          subtitle="Job-traced cost only. Each cell against the same trade at the other branches, worst first"
        >
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>Service line</th>
                  <th className="num">Revenue</th>
                  <th className="num">Margin</th>
                  <th className="num">Against the trade</th>
                </tr>
              </thead>
              <tbody>
                {byCell.slice(0, 8).map((row) => (
                  <tr key={`${row.locationId}-${row.serviceTypeId}`}>
                    <td className="font-medium">{row.locationName}</td>
                    <td>{row.serviceName}</td>
                    <td className="num">
                      <Money cents={row.revenueCents} />
                    </td>
                    <td className="num font-semibold">
                      <Percent value={row.grossMarginPercent} />
                    </td>
                    <td className="num">
                      {row.pointsBelowTradeAverage > 10 ? (
                        <Flag tone="critical">{points(row.pointsBelowTradeAverage)} below</Flag>
                      ) : row.pointsBelowTradeAverage > 0 ? (
                        <span style={{ color: 'var(--ink-2)' }}>
                          {points(row.pointsBelowTradeAverage)} below
                        </span>
                      ) : (
                        <span style={{ color: 'var(--good-ink)' }}>
                          {points(Math.abs(row.pointsBelowTradeAverage))} above
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {application.length > 0 && (
        <Panel
          title="Where the branch margin goes"
          subtitle="Paid cost that reached a job, against paid cost that did not"
        >
          <table>
            <thead>
              <tr>
                <th>Branch</th>
                <th className="num">Revenue</th>
                <th className="num">Cost on jobs</th>
                <th className="num">Cost on nothing</th>
                <th className="num">Share of revenue</th>
              </tr>
            </thead>
            <tbody>
              {application.map((row) => (
                <tr key={row.locationId}>
                  <td className="font-medium">{row.locationName}</td>
                  <td className="num">
                    <Money cents={row.revenueCents} />
                  </td>
                  <td className="num">
                    <Money cents={row.appliedCostCents} />
                  </td>
                  <td className="num">
                    <Money cents={row.unappliedCostCents} />
                  </td>
                  <td className="num font-semibold">
                    {row.pointsAboveBest >= 5 ? (
                      <Flag tone="serious">
                        {row.unappliedPercentOfRevenue.toFixed(1)}%
                      </Flag>
                    ) : (
                      <Percent value={row.unappliedPercentOfRevenue} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {scorecard.length > 0 && (
        <Panel
          title="Technicians"
          subtitle="Utilization is billable hours against paid hours, read from the ledger"
        >
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Technician</th>
                  <th className="num">Jobs</th>
                  <th className="num">Revenue</th>
                  <th className="num">Avg ticket</th>
                  <th className="num">Utilization</th>
                  <th className="num">Callbacks</th>
                </tr>
              </thead>
              <tbody>
                {scorecard.map((row) => (
                  <tr key={row.technicianId}>
                    <td className="font-medium">{row.name}</td>
                    <td className="num">{row.jobsCompleted}</td>
                    <td className="num">
                      <Money cents={row.revenueCents} />
                    </td>
                    <td className="num">
                      <Money cents={row.averageTicketCents} />
                    </td>
                    <td className="num">
                      <Percent value={row.utilizationPercent} decimals={0} />
                    </td>
                    <td className="num">
                      {row.callbackRatePercent >= 5 ? (
                        <Flag tone="serious">{row.callbackRatePercent.toFixed(1)}%</Flag>
                      ) : (
                        <Percent value={row.callbackRatePercent} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
