import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { scopedDb } from '../../../lib/auth/scoped-db';
import { sum } from '../../../lib/money';
import { Flag, Money, Panel } from '../../../components/office/primitives';
import { unbilledCompletedJobs } from '../../../lib/reporting/dashboard';

export const dynamic = 'force-dynamic';

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  const ctx = await requireContext();
  const { filter, q } = await searchParams;

  if (filter === 'unbilled') {
    const unbilled = await unbilledCompletedJobs(db, ctx);

    return (
      <div className="space-y-5">
        <Header title="Finished, not invoiced" subtitle="Work already earned and waiting to be billed" />

        <Panel title={`${unbilled.jobs.length} jobs`} subtitle={`worth ${money(unbilled.totalCents)}`}>
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Customer</th>
                <th>Branch</th>
                <th className="num">Waiting</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {unbilled.jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <Link href={`/office/jobs/${job.id}`} className="font-medium underline-offset-2 hover:underline">
                      {job.jobNo}
                    </Link>
                    <div className="text-sm" style={{ color: 'var(--ink-2)' }}>
                      {job.title}
                    </div>
                  </td>
                  <td>{job.customerName}</td>
                  <td>{job.locationName}</td>
                  <td className="num">
                    {job.daysWaiting > 14 ? (
                      <Flag tone="critical">{job.daysWaiting} days</Flag>
                    ) : (
                      `${job.daysWaiting} days`
                    )}
                  </td>
                  <td className="num">
                    <Money cents={job.valueCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    );
  }

  const scoped = scopedDb(db, ctx);
  const jobs = await scoped.job.findMany({
    where: q
      ? {
          OR: [
            { jobNo: { contains: q, mode: 'insensitive' } },
            { title: { contains: q, mode: 'insensitive' } },
          ],
        }
      : {},
    orderBy: { scheduledStart: 'desc' },
    take: 60,
    select: {
      id: true,
      jobNo: true,
      title: true,
      status: true,
      isWarranty: true,
      scheduledStart: true,
      revenueCents: true,
      location: { select: { name: true } },
      customer: { select: { companyName: true, firstName: true, lastName: true } },
      lines: { select: { totalCents: true } },
    },
  });

  return (
    <div className="space-y-5">
      <Header title="Jobs" subtitle="Most recently scheduled first" />

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search by job number or title"
          className="panel w-full max-w-md px-3 py-2 text-sm"
          style={{ color: 'var(--ink)' }}
        />
        <button type="submit" className="panel px-4 text-sm font-semibold">
          Search
        </button>
      </form>

      <Panel title={`${jobs.length} jobs`}>
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Customer</th>
              <th>Branch</th>
              <th>Status</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td>
                  <Link href={`/office/jobs/${job.id}`} className="font-medium underline-offset-2 hover:underline">
                    {job.jobNo}
                  </Link>
                  <div className="text-sm" style={{ color: 'var(--ink-2)' }}>
                    {job.title}
                    {job.isWarranty && ' · callback'}
                  </div>
                </td>
                <td>
                  {job.customer.companyName ??
                    [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ')}
                </td>
                <td>{job.location.name}</td>
                <td className="text-sm">{job.status.replace('_', ' ')}</td>
                <td className="num">
                  <Money cents={sum(job.lines.map((l) => l.totalCents))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
        {subtitle}
      </p>
    </div>
  );
}

function money(cents: bigint): string {
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}
