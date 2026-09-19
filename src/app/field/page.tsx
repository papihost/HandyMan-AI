'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { loadJobs, money, jobTotal, type ClientJob } from '../../client/store';
import { subscribe, syncNow } from '../../client/sync';

const STATUS_TONE: Record<string, string> = {
  SCHEDULED: 'bg-[var(--color-brand)]/12 text-[var(--color-brand)]',
  DISPATCHED: 'bg-[var(--color-brand)]/12 text-[var(--color-brand)]',
  EN_ROUTE: 'bg-[var(--color-warn)]/18 text-[var(--color-warn)]',
  IN_PROGRESS: 'bg-[var(--color-warn)]/18 text-[var(--color-warn)]',
  ON_HOLD: 'bg-[var(--color-stop)]/12 text-[var(--color-stop)]',
  COMPLETED: 'bg-[var(--color-go)]/12 text-[var(--color-go)]',
  INVOICED: 'bg-[var(--color-go)]/12 text-[var(--color-go)]',
  PAID: 'bg-[var(--color-go)]/12 text-[var(--color-go)]',
};

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayLabel(iso: string | null): string {
  if (!iso) return 'Unscheduled';

  const date = new Date(iso);
  const today = startOfDay(new Date());
  const days = Math.round((startOfDay(date) - today) / 86_400_000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function timeLabel(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function MyDayPage() {
  const [jobs, setJobs] = useState<ClientJob[] | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);

  const reload = () => void loadJobs().then(setJobs);

  useEffect(() => {
    reload();
    // Re-read after every sync: a pull may have brought new work or taken some away.
    return subscribe(() => reload());
  }, []);

  if (!jobs) return <p className="py-12 text-center text-[var(--color-ink-soft)]">Loading…</p>;

  /*
   * Today first, then what is coming, then what is behind.
   *
   * Sorting the whole list by time puts last week at the top and a technician has to
   * scroll past finished work to find the job they are standing outside. The device
   * carries a week of history because it is useful on site — not because it belongs at
   * the top of the morning.
   */
  const today = startOfDay(new Date());
  const todays: ClientJob[] = [];
  const upcoming: ClientJob[] = [];
  const earlier: ClientJob[] = [];

  for (const job of jobs) {
    if (!job.scheduledStart) {
      upcoming.push(job);
      continue;
    }
    const day = startOfDay(new Date(job.scheduledStart));
    if (day === today) todays.push(job);
    else if (day > today) upcoming.push(job);
    else earlier.push(job);
  }

  earlier.reverse(); // most recent first

  const remaining = todays.filter(
    (job) => !['COMPLETED', 'INVOICED', 'PAID', 'CLOSED'].includes(job.status),
  ).length;

  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <h2 className="px-1 text-sm font-bold uppercase tracking-wide text-[var(--color-ink-soft)]">
          Today ·{' '}
          {todays.length === 0
            ? 'nothing booked'
            : remaining === 0
              ? 'all done'
              : `${remaining} to go`}
        </h2>

        {todays.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="font-semibold">Nothing booked for today</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              Anything dispatch assigns will appear here.
            </p>
            <button type="button" onClick={() => void syncNow()} className="btn btn-quiet mt-4">
              Check again
            </button>
          </div>
        ) : (
          <JobList jobs={todays} />
        )}
      </section>

      {upcoming.length > 0 && <DayGroups jobs={upcoming} />}

      {earlier.length > 0 && (
        <section className="space-y-3">
          <button
            type="button"
            onClick={() => setShowEarlier((open) => !open)}
            className="tap flex w-full items-center justify-between px-1 text-sm font-bold uppercase tracking-wide text-[var(--color-ink-soft)]"
          >
            <span>Earlier · {earlier.length} finished</span>
            <span aria-hidden>{showEarlier ? '▾' : '▸'}</span>
          </button>
          {showEarlier && <JobList jobs={earlier} />}
        </section>
      )}
    </div>
  );
}

function DayGroups({ jobs }: { jobs: ClientJob[] }) {
  const groups = new Map<string, ClientJob[]>();
  for (const job of jobs) {
    const key = dayLabel(job.scheduledStart);
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }

  return (
    <>
      {[...groups.entries()].map(([day, dayJobs]) => (
        <section key={day} className="space-y-3">
          <h2 className="px-1 text-sm font-bold uppercase tracking-wide text-[var(--color-ink-soft)]">
            {day} · {dayJobs.length} {dayJobs.length === 1 ? 'job' : 'jobs'}
          </h2>
          <JobList jobs={dayJobs} />
        </section>
      ))}
    </>
  );
}

function JobList({ jobs }: { jobs: ClientJob[] }) {
  return (
    <ul className="space-y-3">
      {jobs.map((job) => (
        <li key={job.id}>
          <Link href={`/field/jobs/${job.id}`} className="card block p-4 active:scale-[0.995]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold tabular-nums text-[var(--color-ink-soft)]">
                    {timeLabel(job.scheduledStart)}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_TONE[job.status] ?? 'bg-black/5'}`}
                  >
                    {job.status.replace('_', ' ')}
                  </span>
                  {job.isWarranty && (
                    <span className="rounded-full bg-[var(--color-stop)]/12 px-2.5 py-0.5 text-xs font-bold text-[var(--color-stop)]">
                      CALLBACK
                    </span>
                  )}
                  {job.priority === 'HIGH' || job.priority === 'EMERGENCY' ? (
                    <span className="rounded-full bg-[var(--color-warn)]/18 px-2.5 py-0.5 text-xs font-bold text-[var(--color-warn)]">
                      {job.priority}
                    </span>
                  ) : null}
                </div>

                <p className="mt-1.5 truncate text-lg font-semibold">{job.title}</p>
                <p className="truncate text-[var(--color-ink-soft)]">{job.customer.name}</p>
                <p className="truncate text-sm text-[var(--color-ink-soft)]">
                  {job.property.addressLine1}, {job.property.city}
                </p>
              </div>

              <div className="shrink-0 text-right">
                <p className="font-semibold tabular-nums">{money(jobTotal(job))}</p>
                <p className="text-xs text-[var(--color-ink-soft)]">{job.jobNo}</p>
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
