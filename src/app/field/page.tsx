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
};

function dayLabel(iso: string | null): string {
  if (!iso) return 'Unscheduled';

  const date = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();

  if (same(date, today)) return 'Today';
  if (same(date, tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function timeLabel(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function MyDayPage() {
  const [jobs, setJobs] = useState<ClientJob[] | null>(null);

  const reload = () => void loadJobs().then(setJobs);

  useEffect(() => {
    reload();
    // Re-read after every sync: a pull may have brought new work or taken some away.
    return subscribe(() => reload());
  }, []);

  if (!jobs) return <p className="py-12 text-center text-[var(--color-ink-soft)]">Loading…</p>;

  if (jobs.length === 0) {
    return (
      <div className="card p-8 text-center">
        <p className="text-lg font-semibold">Nothing assigned yet</p>
        <p className="mt-1 text-[var(--color-ink-soft)]">
          Work will appear here as soon as dispatch assigns it.
        </p>
        <button type="button" onClick={() => void syncNow()} className="btn btn-quiet mt-5">
          Check again
        </button>
      </div>
    );
  }

  const groups = new Map<string, ClientJob[]>();
  for (const job of jobs) {
    const key = dayLabel(job.scheduledStart);
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }

  return (
    <div className="space-y-7">
      {[...groups.entries()].map(([day, dayJobs]) => (
        <section key={day} className="space-y-3">
          <h2 className="px-1 text-sm font-bold uppercase tracking-wide text-[var(--color-ink-soft)]">
            {day} · {dayJobs.length} {dayJobs.length === 1 ? 'job' : 'jobs'}
          </h2>

          <ul className="space-y-3">
            {dayJobs.map((job) => (
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
        </section>
      ))}
    </div>
  );
}
