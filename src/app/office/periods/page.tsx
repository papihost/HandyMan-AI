import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney } from '../../../lib/money';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import { periodAuditTrail, periodReadiness } from '../../../lib/accounting/periods';
import { Flag, Money, Panel, StatTile } from '../../../components/office/primitives';
import { PeriodActions } from '../../../components/office/period-actions';

export const dynamic = 'force-dynamic';

const name = (fiscalYear: number, periodNumber: number) =>
  `${fiscalYear}-${String(periodNumber).padStart(2, '0')}`;

const ACTION_LABEL: Record<string, { text: string; tone: 'good' | 'serious' | 'critical' }> = {
  CLOSE_PERIOD: { text: 'closed', tone: 'good' },
  REOPEN_PERIOD: { text: 'reopened', tone: 'serious' },
  LOCK_PERIOD: { text: 'locked', tone: 'good' },
  REFUSED_POSTING: { text: 'posting refused', tone: 'critical' },
};

/**
 * Closing the month.
 *
 * The lock is the oldest promise in accounting: once a month is signed off, the figures
 * reported for it cannot quietly change. Everything on this screen is in service of that
 * one sentence — what is in the month, what is worth finishing first, the button, and the
 * record of every time anyone has closed, reopened, or tried to post into a closed month
 * since.
 *
 * That last one matters more than it looks. A refused posting is not an error to shrug at;
 * a run of them is somebody backdating, and the first time anyone notices should not be
 * the audit.
 */
export default async function PeriodsPage() {
  const ctx = await requireContext();

  const canClose = ctx.permissions.has(PERMISSIONS.PERIOD_CLOSE);
  const canReopen = ctx.permissions.has(PERMISSIONS.PERIOD_REOPEN);
  const canAudit = ctx.permissions.has(PERMISSIONS.AUDIT_READ);

  // Fiscal years are generated ahead, so most periods on file are months nobody has
  // reached yet. A close screen listing December 2027 is a close screen nobody reads.
  const nextMonthEnd = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 2, 0, 23, 59, 59),
  );
  const periods = await db.accountingPeriod.findMany({
    where: { organizationId: ctx.organizationId, startDate: { lte: nextMonthEnd } },
    orderBy: [{ fiscalYear: 'desc' }, { periodNumber: 'desc' }],
    take: 18,
  });

  // The oldest month still open is the one that has to close next, so it gets the detail.
  const nextToClose = [...periods]
    .reverse()
    .find((period) => period.status === 'OPEN' && period.startDate <= new Date());

  const [readiness, trail] = await Promise.all([
    nextToClose ? periodReadiness(db, ctx, nextToClose.id) : Promise.resolve(null),
    canAudit ? periodAuditTrail(db, ctx) : Promise.resolve([]),
  ]);

  const closed = periods.filter((period) => period.status !== 'OPEN').length;
  const refusals = trail.filter((row) => row.action === 'REFUSED_POSTING');
  const changes = trail.filter((row) => row.action !== 'REFUSED_POSTING');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Closing the month</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          A posting dated inside a closed month is refused — which is what makes a reported
          figure stay the figure that was reported
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Next to close"
          value={readiness ? name(readiness.fiscalYear, readiness.periodNumber) : '—'}
          note={readiness ? `${readiness.entryCount.toLocaleString()} entries posted` : 'nothing open'}
        />
        <StatTile label="Closed" value={String(closed)} note="of the last 18 months" />
        <StatTile
          label="Refused postings"
          value={canAudit ? String(refusals.length) : '—'}
          tone={refusals.length > 0 ? 'warning' : 'good'}
          note={canAudit ? 'attempts to post into a closed month' : 'needs audit access'}
        />
      </div>

      {readiness && (
        <Panel
          title={`${name(readiness.fiscalYear, readiness.periodNumber)} — ${readiness.startDate.toLocaleDateString()} to ${readiness.endDate.toLocaleDateString()}`}
          subtitle="The oldest month still open, and what stands between it and being signed off"
        >
          <div className="space-y-4 px-4 pb-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  In this month
                </p>
                <p className="mt-0.5 text-lg font-semibold">
                  {readiness.entryCount.toLocaleString()} entries ·{' '}
                  <Money cents={readiness.postedCents} />
                </p>
                <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
                  total debits posted
                </p>
              </div>

              <div>
                <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  Before you sign it off
                </p>
                {readiness.blockedBy.length === 0 && readiness.warnings.length === 0 ? (
                  <div className="mt-1">
                    <Flag tone="good">Nothing outstanding</Flag>
                  </div>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {readiness.blockedBy.map((earlier) => (
                      <li key={earlier.id}>
                        <Flag tone="critical">
                          {name(earlier.fiscalYear, earlier.periodNumber)} is still open and
                          must close first
                        </Flag>
                      </li>
                    ))}
                    {readiness.warnings.map((warning) => (
                      <li key={warning.kind}>
                        <Flag tone="serious">{warning.message}</Flag>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {canClose ? (
              <PeriodActions
                periodId={readiness.periodId}
                label={name(readiness.fiscalYear, readiness.periodNumber)}
                status={readiness.status}
                canClose={canClose}
                canReopen={canReopen}
                blocked={
                  readiness.blockedBy[0]
                    ? name(readiness.blockedBy[0].fiscalYear, readiness.blockedBy[0].periodNumber)
                    : null
                }
                warnings={readiness.warnings.length}
              />
            ) : (
              <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
                Closing a month needs a role that may close periods.
              </p>
            )}
          </div>
        </Panel>
      )}

      <Panel title="Every month" subtitle="Newest first">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Dates</th>
                <th>Status</th>
                <th>Closed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.id}>
                  <td className="font-medium tabular-nums">
                    {name(period.fiscalYear, period.periodNumber)}
                  </td>
                  <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                    {period.startDate.toLocaleDateString()} –{' '}
                    {period.endDate.toLocaleDateString()}
                  </td>
                  <td>
                    {period.status === 'OPEN' ? (
                      <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
                        open
                      </span>
                    ) : (
                      <Flag tone="good">{period.status.toLowerCase()}</Flag>
                    )}
                  </td>
                  <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                    {period.closedAt ? period.closedAt.toLocaleDateString() : '—'}
                    {period.reopenedAt && (
                      <span className="block text-xs" style={{ color: 'var(--serious)' }}>
                        reopened {period.reopenedAt.toLocaleDateString()}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    {period.status === 'CLOSED' && canReopen && (
                      <PeriodActions
                        periodId={period.id}
                        label={name(period.fiscalYear, period.periodNumber)}
                        status={period.status}
                        canClose={canClose}
                        canReopen={canReopen}
                        blocked={null}
                        warnings={0}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {canAudit && (
        <Panel
          title="Postings the lock turned away"
          subtitle={
            refusals.length === 0
              ? 'Nothing has been dated into a closed month. This is the panel you want empty'
              : 'Somebody tried to put a figure into a month that had already been signed off'
          }
        >
          {refusals.length === 0 ? (
            <p className="px-4 pb-4 text-sm" style={{ color: 'var(--ink-2)' }}>
              A refusal on its own is a mistake. A run of them from one person, always into
              the same month, is something else, which is why they are counted here rather
              than left in a log nobody opens.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Dated</th>
                  <th className="num">Amount</th>
                  <th>What it was</th>
                </tr>
              </thead>
              <tbody>
                {refusals.map((row) => {
                  const after = (row.after ?? {}) as Record<string, unknown>;
                  return (
                    <tr key={row.id}>
                      <td className="text-sm whitespace-nowrap">
                        {row.createdAt.toLocaleString()}
                      </td>
                      <td className="text-sm">
                        {row.user ? `${row.user.firstName} ${row.user.lastName}` : 'the system'}
                      </td>
                      <td className="text-sm">
                        <Flag tone="critical">{row.entityId}</Flag>
                      </td>
                      <td className="num">
                        {typeof after.amountCents === 'string'
                          ? formatMoney(BigInt(after.amountCents))
                          : '—'}
                      </td>
                      <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                        {typeof after.memo === 'string' && after.memo
                          ? after.memo
                          : typeof after.source === 'string'
                            ? after.source.toLowerCase()
                            : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {canAudit && (
        <Panel
          title="Closes and reopenings"
          subtitle="Who signed off which month, and why any of them were opened again"
        >
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>Who</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {changes.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ color: 'var(--ink-2)' }}>
                      Nothing yet.
                    </td>
                  </tr>
                ) : (
                  changes.map((row) => {
                    const label = ACTION_LABEL[row.action] ?? {
                      text: row.action.toLowerCase(),
                      tone: 'serious' as const,
                    };
                    const after = (row.after ?? {}) as Record<string, unknown>;
                    return (
                      <tr key={row.id}>
                        <td className="text-sm whitespace-nowrap">
                          {row.createdAt.toLocaleString()}
                        </td>
                        <td>
                          <Flag tone={label.tone}>{label.text}</Flag>
                        </td>
                        <td className="text-sm">
                          {row.user ? `${row.user.firstName} ${row.user.lastName}` : 'the system'}
                        </td>
                        <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                          {typeof after.reason === 'string' ? after.reason : '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
        Looking for the figures rather than the lock?{' '}
        <Link href="/office/financials" style={{ color: 'var(--seq)' }}>
          Financials
        </Link>{' '}
        has the trial balance, the income statement and the balance sheet for any period.
      </p>
    </div>
  );
}
