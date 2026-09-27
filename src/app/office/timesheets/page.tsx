import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import { weeklyTimesheets, weekStartOf } from '../../../lib/payroll/service';
import { Flag, Panel, StatTile } from '../../../components/office/primitives';
import { ApproveWeek } from '../../../components/office/payroll-actions';

export const dynamic = 'force-dynamic';

const hours = (value: number) => value.toFixed(2);
const iso = (date: Date) => date.toISOString().slice(0, 10);

const KIND_LABEL: Record<string, string> = {
  WORK: 'On the job',
  TRAVEL: 'Driving',
  BREAK: 'Break',
  SHOP: 'Shop and van',
  TRAINING: 'Training',
};

/**
 * Time approval.
 *
 * The hours on this screen have already cost the company money: every one of them posted
 * labour to a job and credited Payroll Liabilities when it was logged, which is why job
 * margin is honest. Approving is not what makes an hour real — it is what makes it
 * payable. The difference matters when a week is wrong: un-ticking an entry stops it
 * being paid, and the job keeps the cost it was always carrying.
 */
export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const ctx = await requireContext();
  const canApprove = ctx.permissions.has(PERMISSIONS.TIME_APPROVE);

  const { week } = await searchParams;
  const asked = week ? new Date(`${week}T00:00:00.000Z`) : new Date();
  const weekStart = weekStartOf(Number.isNaN(asked.getTime()) ? new Date() : asked);
  const weekEnd = new Date(weekStart.getTime() + 6 * 86_400_000);

  const rows = await weeklyTimesheets(db, ctx, weekStart);

  const previous = iso(new Date(weekStart.getTime() - 7 * 86_400_000));
  const next = iso(new Date(weekStart.getTime() + 7 * 86_400_000));

  const totalHours = rows.reduce((total, row) => total + row.hours, 0);
  const approvedHours = rows.reduce((total, row) => total + row.approvedHours, 0);
  const waiting = totalHours - approvedHours;
  const overtimePeople = rows.filter((row) => row.hours > 40);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Timesheets</h1>
          <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
            {weekStart.toLocaleDateString()} – {weekEnd.toLocaleDateString()} — what the week
            cost, and what of it is payable
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm font-medium">
          <Link href={`/office/timesheets?week=${previous}`} style={{ color: 'var(--seq)' }}>
            ← Week before
          </Link>
          <Link href={`/office/timesheets?week=${next}`} style={{ color: 'var(--seq)' }}>
            Week after →
          </Link>
          <Link href="/office/payroll" className="font-semibold" style={{ color: 'var(--seq)' }}>
            Payroll →
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Hours logged" value={hours(totalHours)} note={`${rows.length} people`} />
        <StatTile label="Approved" value={hours(approvedHours)} note="payable on the next run" />
        <StatTile
          label="Waiting on somebody"
          value={hours(waiting)}
          note={waiting > 0 ? 'not payable yet' : 'nothing outstanding'}
          tone={waiting > 0 ? 'warning' : 'good'}
        />
        <StatTile
          label="Over forty hours"
          value={String(overtimePeople.length)}
          note="paid at time and a half beyond it"
          tone={overtimePeople.length > 0 ? 'warning' : undefined}
        />
      </div>

      {rows.length === 0 ? (
        <Panel title="Nobody worked that week" subtitle="Or the week has not happened yet">
          <p className="p-4 text-sm" style={{ color: 'var(--ink-2)' }}>
            No time was logged between {weekStart.toLocaleDateString()} and{' '}
            {weekEnd.toLocaleDateString()}.
          </p>
        </Panel>
      ) : (
        rows.map((row) => {
          const unapproved = row.entries.filter((entry) => !entry.isApproved).map((entry) => entry.id);
          const revocable = row.entries
            .filter((entry) => entry.isApproved && !entry.paid)
            .map((entry) => entry.id);
          const overtime = Math.max(0, row.hours - 40);

          return (
            <Panel
              key={row.technicianId}
              title={row.technicianName}
              subtitle={`${hours(row.hours)} hours over ${row.entryCount} ${
                row.entryCount === 1 ? 'entry' : 'entries'
              }${overtime > 0 ? ` — ${hours(overtime)} of them overtime` : ''}`}
            >
              <div className="flex flex-wrap items-center gap-4 border-b px-4 py-3 text-sm" style={{ borderColor: 'var(--hairline)' }}>
                <span>
                  <span style={{ color: 'var(--ink-3)' }}>Billable </span>
                  <span className="font-semibold">{hours(row.billableHours)}</span>
                </span>
                <span>
                  <span style={{ color: 'var(--ink-3)' }}>Approved </span>
                  <span className="font-semibold">{hours(row.approvedHours)}</span>
                </span>
                {row.paidHours > 0 && (
                  <span>
                    <span style={{ color: 'var(--ink-3)' }}>Already paid </span>
                    <span className="font-semibold">{hours(row.paidHours)}</span>
                  </span>
                )}
                {row.hours - row.billableHours > 0.01 && (
                  <Flag tone="warning">
                    {hours(row.hours - row.billableHours)} unbillable
                  </Flag>
                )}
                {canApprove && (
                  <div className="ml-auto flex items-center gap-2">
                    <ApproveWeek
                      entryIds={unapproved}
                      approved
                      label={`Approve ${hours(
                        row.entries
                          .filter((entry) => !entry.isApproved)
                          .reduce((total, entry) => total + entry.hours, 0),
                      )} hours`}
                    />
                    <ApproveWeek entryIds={revocable} approved={false} label="Take it back" />
                  </div>
                )}
              </div>

              <details>
                <summary
                  className="cursor-pointer px-4 py-2 text-sm"
                  style={{ color: 'var(--ink-3)' }}
                >
                  {row.entryCount} {row.entryCount === 1 ? 'entry' : 'entries'}
                </summary>
                <div className="overflow-x-auto">
                  <table>
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>What</th>
                      <th>Job</th>
                      <th className="num">Hours</th>
                      <th>Billable</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.entries.map((entry) => (
                      <tr key={entry.id}>
                        <td className="text-sm">
                          {entry.startedAt.toLocaleDateString(undefined, {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </td>
                        <td className="text-sm">{KIND_LABEL[entry.kind] ?? entry.kind}</td>
                        <td className="text-sm">
                          {entry.jobNo ? (
                            <span style={{ color: 'var(--ink-2)' }}>{entry.jobNo}</span>
                          ) : (
                            <span style={{ color: 'var(--ink-3)' }}>—</span>
                          )}
                        </td>
                        <td className="num">{hours(entry.hours)}</td>
                        <td className="text-sm">
                          {entry.isBillable ? (
                            <span style={{ color: 'var(--ink-2)' }}>yes</span>
                          ) : (
                            <span style={{ color: 'var(--ink-3)' }}>no</span>
                          )}
                        </td>
                        <td>
                          {entry.paid ? (
                            <Flag tone="good">paid</Flag>
                          ) : entry.isApproved ? (
                            <Flag tone="good">approved</Flag>
                          ) : (
                            <Flag tone="warning">waiting</Flag>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  </table>
                </div>
              </details>
            </Panel>
          );
        })
      )}

      <p className="text-sm" style={{ color: 'var(--ink-3)' }}>
        Every hour here already posted its loaded cost to the job it was worked on, whether or
        not it has been approved. Approving decides what payroll pays, not what the job cost —
        which is why un-ticking a bad entry does not quietly make a job look more profitable
        than it was.
      </p>
    </div>
  );
}
