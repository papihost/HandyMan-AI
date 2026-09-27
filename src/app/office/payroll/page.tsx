import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import { formatMoney } from '../../../lib/money';
import {
  accrualVariance,
  nextPayrollPeriod,
  payrollPreview,
  payrollRuns,
} from '../../../lib/payroll/service';
import { Flag, Money, Panel, StatTile } from '../../../components/office/primitives';
import { RunPayroll } from '../../../components/office/payroll-actions';

export const dynamic = 'force-dynamic';

const hours = (value: number) => value.toFixed(2);
const iso = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Payroll.
 *
 * Every costed hour in this system credits Payroll Liabilities at the technician's loaded
 * rate, which is what makes job margin mean something. A run is what settles that account,
 * and the residue left in it afterwards is the most useful number on this page: it is the
 * loaded rate being wrong, measured in dollars, rather than argued about.
 */
export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requireContext();
  const canRun = ctx.permissions.has(PERMISSIONS.PAYROLL_MANAGE);

  const { from, to } = await searchParams;
  const suggested = await nextPayrollPeriod(db, ctx);

  const parse = (value: string | undefined, fallback: Date) => {
    if (!value) return fallback;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  };

  const periodStart = parse(from, suggested.periodStart);
  const periodEnd = parse(to, suggested.periodEnd);

  const [preview, variance, runs] = await Promise.all([
    payrollPreview(db, ctx, { periodStart, periodEnd }),
    accrualVariance(db, ctx),
    payrollRuns(db, ctx, 12),
  ]);

  const lastDay = new Date(periodEnd.getTime() - 86_400_000);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Payroll</h1>
          <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
            {periodStart.toLocaleDateString()} – {lastDay.toLocaleDateString()} — what the
            approved hours cost, and what the accrual was expecting
          </p>
        </div>
        <Link href="/office/timesheets" className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
          ← Timesheets
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile
          label="This run"
          value={formatMoney(preview.totalCostCents)}
          note={`${preview.lines.length} ${preview.lines.length === 1 ? 'person' : 'people'}, ${hours(
            preview.regularHours + preview.overtimeHours,
          )} hours`}
        />
        <StatTile
          label="Overtime in it"
          value={hours(preview.overtimeHours)}
          note="counted per week, at time and a half"
          tone={preview.overtimeHours > 0 ? 'warning' : undefined}
        />
        <StatTile
          label="Still accrued"
          value={formatMoney(variance.outstandingCents)}
          note="what the jobs charged and payroll has not settled"
          tone={variance.outstandingCents > 0n ? 'warning' : 'good'}
        />
        <StatTile
          label="Not approved"
          value={hours(preview.unapprovedHours)}
          note={
            preview.unapprovedHours > 0
              ? 'hours in this period nobody has signed off'
              : 'every hour in the period is signed off'
          }
          tone={preview.unapprovedHours > 0 ? 'warning' : 'good'}
        />
      </div>

      <Panel
        title="Period"
        subtitle="Fortnightly from wherever the last run stopped — the only boundary that cannot leave a gap"
      >
        <form className="flex flex-wrap items-end gap-3 p-4 text-sm" method="get">
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--ink-2)' }}>From</span>
            <input
              type="date"
              name="from"
              defaultValue={iso(periodStart)}
              className="rounded-lg border px-2 py-1.5"
              style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span style={{ color: 'var(--ink-2)' }}>Up to (exclusive)</span>
            <input
              type="date"
              name="to"
              defaultValue={iso(periodEnd)}
              className="rounded-lg border px-2 py-1.5"
              style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
            />
          </label>
          <button
            type="submit"
            className="rounded-lg border px-3 py-1.5 font-semibold"
            style={{ borderColor: 'var(--hairline)', color: 'var(--ink-1)' }}
          >
            Preview
          </button>
          {canRun && (
            <div className="ml-auto">
              <RunPayroll
                periodStart={iso(periodStart)}
                periodEnd={iso(periodEnd)}
                payDate={iso(lastDay)}
                totalCostCents={preview.totalCostCents.toString()}
                people={preview.lines.length}
              />
            </div>
          )}
        </form>
      </Panel>

      <Panel
        title="What it pays"
        subtitle="Gross, employer tax and benefits — the same loaded rate the jobs were costed at"
      >
        {preview.lines.length === 0 ? (
          <p className="p-4 text-sm" style={{ color: 'var(--ink-2)' }}>
            No approved hours in that period.{' '}
            {preview.unapprovedHours > 0 ? (
              <>
                There are {hours(preview.unapprovedHours)} hours waiting on{' '}
                <Link href="/office/timesheets" style={{ color: 'var(--seq)' }}>
                  approval
                </Link>
                .
              </>
            ) : (
              'Nobody logged time between those dates.'
            )}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Technician</th>
                  <th className="num">Regular</th>
                  <th className="num">Overtime</th>
                  <th className="num">Rate</th>
                  <th className="num">Gross</th>
                  <th className="num">Employer tax</th>
                  <th className="num">Benefits</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((line) => (
                  <tr key={line.technicianId}>
                    <td className="font-medium">{line.technicianName}</td>
                    <td className="num">{hours(line.regularHours)}</td>
                    <td className="num">
                      {line.overtimeHours > 0 ? (
                        <span style={{ color: 'var(--warning)' }}>{hours(line.overtimeHours)}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">
                      <Money cents={line.baseHourlyCents} />
                    </td>
                    <td className="num">
                      <Money cents={line.grossCents} />
                    </td>
                    <td className="num">
                      <Money cents={line.employerTaxCents} />
                    </td>
                    <td className="num">
                      <Money cents={line.benefitsCents} />
                    </td>
                    <td className="num font-semibold">
                      <Money cents={line.totalCostCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="font-semibold">Total</td>
                  <td className="num">{hours(preview.regularHours)}</td>
                  <td className="num">{hours(preview.overtimeHours)}</td>
                  <td />
                  <td className="num">
                    <Money cents={preview.grossCents} />
                  </td>
                  <td className="num">
                    <Money cents={preview.employerTaxCents} />
                  </td>
                  <td className="num">
                    <Money cents={preview.benefitsCents} />
                  </td>
                  <td className="num font-semibold">
                    <Money cents={preview.totalCostCents} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="Accrual against payroll"
        subtitle="What the jobs charged themselves for labour, against what payroll actually paid"
      >
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <div>
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--ink-3)' }}>
              Accrued by jobs
            </div>
            <div className="text-lg font-semibold">{formatMoney(variance.accruedCents)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--ink-3)' }}>
              Paid by runs
            </div>
            <div className="text-lg font-semibold">{formatMoney(variance.paidCents)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--ink-3)' }}>
              Left in the account
            </div>
            <div className="text-lg font-semibold">{formatMoney(variance.outstandingCents)}</div>
            <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
              {variance.percentOff.toFixed(1)}% of what was accrued
            </div>
          </div>
        </div>
        <p className="border-t px-4 py-3 text-sm" style={{ borderColor: 'var(--hairline)', color: 'var(--ink-2)' }}>
          A residue here is not an error to be cleared. It is the loaded rate being wrong:
          approved hours are what people are paid for, costed hours are what the jobs were
          charged, and the gap between them is how far the rate used for margin is from the
          truth. A period that has not been run yet accounts for most of it; what is left
          after the last run is the number worth arguing about.
        </p>
      </Panel>

      <Panel title="Runs" subtitle="Each one relieved the accrual and moved money out of the payroll account">
        {runs.length === 0 ? (
          <p className="p-4 text-sm" style={{ color: 'var(--ink-2)' }}>
            Nothing has been run yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Period</th>
                  <th>Paid</th>
                  <th className="num">People</th>
                  <th className="num">Regular</th>
                  <th className="num">Overtime</th>
                  <th className="num">Cost</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="font-medium">{run.runNo}</td>
                    <td className="text-sm">
                      {run.periodStart.toLocaleDateString()} –{' '}
                      {new Date(run.periodEnd.getTime() - 86_400_000).toLocaleDateString()}
                    </td>
                    <td className="text-sm">{run.payDate.toLocaleDateString()}</td>
                    <td className="num">{run._count.lines}</td>
                    <td className="num">{Number(run.regularHours).toFixed(2)}</td>
                    <td className="num">{Number(run.overtimeHours).toFixed(2)}</td>
                    <td className="num font-semibold">
                      <Money cents={run.totalCostCents} />
                    </td>
                    <td>
                      <Flag tone={run.status === 'POSTED' ? 'good' : 'warning'}>
                        {run.status.toLowerCase()}
                      </Flag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="text-sm" style={{ color: 'var(--ink-3)' }}>
        This is a register and an entry, not a payroll processor: it does not file returns or
        calculate withholding, and the employer tax and benefits figures are the same loaded
        rate the jobs were costed at. What it does do is settle the liability those jobs
        created, which is the part a general ledger cannot be honest without.
      </p>
    </div>
  );
}
