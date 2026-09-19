import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { dispatchBoard } from '../../../lib/reporting/dashboard';
import { Flag, Panel, statusTone } from '../../../components/office/primitives';

export const dynamic = 'force-dynamic';

const COLUMN_TONE: Record<string, string> = {
  PAID: 'var(--good)',
  INVOICED: 'var(--good)',
  COMPLETED: 'var(--good)',
  IN_PROGRESS: 'var(--warning)',
  EN_ROUTE: 'var(--warning)',
  ON_HOLD: 'var(--critical)',
};

export default async function DispatchPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  const ctx = await requireContext();
  const { day } = await searchParams;

  const date = day ? new Date(day) : new Date();
  const board = await dispatchBoard(db, ctx, date);
  const total = board.reduce((count, column) => count + column.jobs.length, 0);

  const shift = (days: number) => {
    const moved = new Date(date.getTime() + days * 86_400_000);
    return `/office/dispatch?day=${moved.toISOString().slice(0, 10)}`;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dispatch</h1>
          <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
            {date.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}{' '}
            · {total} {total === 1 ? 'job' : 'jobs'} across {board.length} technicians
          </p>
        </div>

        <div className="flex gap-2 text-sm font-semibold">
          <Link href={shift(-1)} className="panel px-3 py-2">
            ← Previous
          </Link>
          <Link href="/office/dispatch" className="panel px-3 py-2">
            Today
          </Link>
          <Link href={shift(1)} className="panel px-3 py-2">
            Next →
          </Link>
        </div>
      </div>

      {board.length === 0 && (
        <Panel title="Nothing scheduled">
          <p className="px-4 pb-4 text-sm" style={{ color: 'var(--ink-2)' }}>
            No work is booked for this day.
          </p>
        </Panel>
      )}

      {/* A column per technician, in the order they will work it. Unassigned comes first,
          because it is the only column that needs a decision. */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {board.map((column) => (
          <section key={column.technicianId ?? 'unassigned'} className="panel p-3">
            <header className="flex items-baseline justify-between gap-2 px-1 pb-2">
              <h2 className="font-semibold">{column.name}</h2>
              <span className="text-sm" style={{ color: 'var(--ink-muted)' }}>
                {column.jobs.length}
              </span>
            </header>

            <ul className="space-y-2">
              {column.jobs.map((job) => {
                const tone = statusTone(job.status);
                return (
                  <li key={job.id}>
                    <Link
                      href={`/office/jobs/${job.id}`}
                      className="block rounded-lg p-2.5"
                      style={{ background: 'var(--plane)', borderLeft: `3px solid ${COLUMN_TONE[job.status] ?? 'var(--seq)'}` }}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold tabular-nums">
                          {job.scheduledStart?.toLocaleTimeString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>
                        <span className="text-xs font-bold" style={{ color: 'var(--ink-muted)' }}>
                          {job.status.replace('_', ' ')}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-sm font-medium">{job.title}</p>
                      <p className="truncate text-xs" style={{ color: 'var(--ink-2)' }}>
                        {job.customer.companyName ??
                          [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ')}
                        {' · '}
                        {job.property.city}
                      </p>
                      {job.isWarranty && <Flag tone="critical">callback</Flag>}
                      {tone === 'warning' && job.status === 'IN_PROGRESS' && (
                        <Flag tone="warning">on site now</Flag>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
