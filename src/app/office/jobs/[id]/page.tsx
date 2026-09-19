import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../lib/db';
import { requireContext } from '../../../../server/session';
import { formatMoney, sum } from '../../../../lib/money';
import { jobCosting, labourRateForJob } from '../../../../lib/jobs/costing';
import { PERMISSIONS } from '../../../../lib/auth/permissions';
import { Bar, Flag, Money, Panel, StatTile } from '../../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/**
 * A job, with what it actually made.
 *
 * The figures here are read from posted journal lines, not from the job's cached columns,
 * and every one of them links to the entry that produced it. That trail is the difference
 * between a margin number a controller believes and one they have to take on faith.
 */
export default async function OfficeJobPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;

  const job = await db.job.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      customer: true,
      property: true,
      location: true,
      serviceType: true,
      lines: { orderBy: { sortOrder: 'asc' } },
      invoices: { orderBy: { issueDate: 'asc' } },
      changeOrders: true,
      photos: { select: { id: true, stage: true } },
      signatures: { select: { id: true, kind: true, signerName: true, signedAt: true } },
      assignments: {
        select: { isLead: true, technician: { select: { user: { select: { firstName: true, lastName: true } } } } },
      },
      parentJob: { select: { id: true, jobNo: true } },
      callbacks: { select: { id: true, jobNo: true, title: true } },
    },
  });
  if (!job) notFound();

  const canSeeCost = ctx.permissions.has(PERMISSIONS.FINANCE_READ_COST);
  const costing = canSeeCost ? await jobCosting(db, ctx, job.id) : null;
  const labour = canSeeCost ? await labourRateForJob(db, ctx, job.id) : null;

  const entries = await db.journalEntry.findMany({
    where: {
      organizationId: ctx.organizationId,
      postedAt: { not: null },
      lines: { some: { jobId: job.id } },
    },
    orderBy: { entryDate: 'asc' },
    select: {
      id: true,
      entryNo: true,
      entryDate: true,
      source: true,
      memo: true,
      isReversal: true,
      lines: {
        where: { jobId: job.id },
        select: { debitCents: true, creditCents: true, account: { select: { code: true, name: true } } },
      },
    },
  });

  const lead = job.assignments.find((a) => a.isLead)?.technician.user;
  const quoted = sum(job.lines.map((line) => line.totalCents));
  const maxCost = costing
    ? Math.max(
        1,
        Number(costing.laborCents + costing.burdenCents),
        Number(costing.materialCents),
        Number(costing.subcontractorCents),
        Number(costing.otherCents),
      )
    : 1;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/office/jobs" className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
          ← Jobs
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{job.jobNo}</h1>
          <span className="text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>
            {job.status.replace('_', ' ')}
          </span>
          {job.isWarranty && <Flag tone="critical">callback — not billable</Flag>}
        </div>
        <p className="mt-1 text-lg">{job.title}</p>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {job.customer.companyName ??
            [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ')}
          {' · '}
          {job.property.addressLine1}, {job.property.city}
          {' · '}
          {job.location.name}
          {lead ? ` · ${lead.firstName} ${lead.lastName}` : ''}
        </p>
      </div>

      {costing && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Revenue" value={formatMoney(costing.revenueCents)} note="net of tax" />
            <StatTile label="Cost" value={formatMoney(costing.totalCostCents)} note="labour, burden, materials" />
            <StatTile
              label="Gross margin"
              value={formatMoney(costing.grossMarginCents)}
              tone={costing.grossMarginCents > 0n ? 'good' : 'critical'}
            />
            <StatTile label="Margin" value={`${costing.grossMarginPercent.toFixed(1)}%`} />
          </div>

          <Panel
            title="What it cost"
            subtitle="Read from posted journal lines, not from a summary column"
          >
            <table>
              <tbody>
                <CostRow
                  label="Direct labour"
                  cents={costing.laborCents}
                  max={maxCost}
                  note={
                    labour
                      ? `${labour.hours.toFixed(2)} hrs at ${formatMoney(labour.baseHourlyCents)}/hr — ${labour.technicianName}'s wage`
                      : undefined
                  }
                />
                <CostRow
                  label="Labour burden"
                  cents={costing.burdenCents}
                  max={maxCost}
                  note="payroll taxes, workers' comp, benefits, vehicle"
                />
                <CostRow label="Materials and parts" cents={costing.materialCents} max={maxCost} />
                {costing.subcontractorCents > 0n && (
                  <CostRow label="Subcontractors" cents={costing.subcontractorCents} max={maxCost} />
                )}
                {costing.otherCents > 0n && (
                  <CostRow label="Other" cents={costing.otherCents} max={maxCost} />
                )}
                <tr>
                  <td className="font-semibold">Total cost</td>
                  <td />
                  <td className="num font-semibold">
                    <Money cents={costing.totalCostCents} bold />
                  </td>
                </tr>
                {labour && (
                  <tr>
                    <td colSpan={3} className="text-sm" style={{ color: 'var(--ink-2)' }}>
                      An hour of {labour.technicianName}&apos;s time is paid at{' '}
                      {formatMoney(labour.baseHourlyCents)} and costs{' '}
                      <strong>{formatMoney(labour.loadedHourlyCents)}</strong> —{' '}
                      {labour.multiple.toFixed(2)}× the wage. A price set against the wage is a
                      price set against about{' '}
                      {Math.round((1 / labour.multiple) * 100)}% of what the hour costs.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>
        </>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Work performed" subtitle={`${job.lines.length} lines · ${formatMoney(quoted)} before tax`}>
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {job.lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.description}</td>
                  <td className="num">{line.quantity.toString()}</td>
                  <td className="num">
                    <Money cents={line.unitPriceCents} />
                  </td>
                  <td className="num">
                    <Money cents={line.totalCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <div className="space-y-4">
          <Panel title="Documents">
            <table>
              <tbody>
                {job.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <span className="font-medium">{invoice.invoiceNo}</span>
                      <span className="ml-2 text-sm" style={{ color: 'var(--ink-2)' }}>
                        {invoice.status.replace('_', ' ').toLowerCase()}
                      </span>
                    </td>
                    <td className="num">
                      <Money cents={invoice.totalCents} />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={{ color: 'var(--ink-2)' }}>Photos</td>
                  <td className="num">{job.photos.length}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--ink-2)' }}>Signatures</td>
                  <td className="num">{job.signatures.length}</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--ink-2)' }}>Change orders</td>
                  <td className="num">{job.changeOrders.length}</td>
                </tr>
              </tbody>
            </table>
          </Panel>

          {(job.parentJob || job.callbacks.length > 0) && (
            <Panel title="Rework">
              <table>
                <tbody>
                  {job.parentJob && (
                    <tr>
                      <td style={{ color: 'var(--ink-2)' }}>Callback on</td>
                      <td>
                        <Link href={`/office/jobs/${job.parentJob.id}`} className="font-medium underline-offset-2 hover:underline">
                          {job.parentJob.jobNo}
                        </Link>
                      </td>
                    </tr>
                  )}
                  {job.callbacks.map((callback) => (
                    <tr key={callback.id}>
                      <td style={{ color: 'var(--ink-2)' }}>Came back as</td>
                      <td>
                        <Link href={`/office/jobs/${callback.id}`} className="font-medium underline-offset-2 hover:underline">
                          {callback.jobNo}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </div>
      </div>

      <Panel
        title="Everything this job posted"
        subtitle="Every figure above comes from these entries. Open one to see both sides."
      >
        <table>
          <thead>
            <tr>
              <th>Entry</th>
              <th>Date</th>
              <th>What happened</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: 'var(--ink-2)' }}>
                  Nothing has posted for this job yet.
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>
                  <Link href={`/office/entries/${entry.id}`} className="font-medium underline-offset-2 hover:underline">
                    {entry.entryNo}
                  </Link>
                  {entry.isReversal && (
                    <span className="ml-2 text-xs font-bold" style={{ color: 'var(--serious)' }}>
                      REVERSAL
                    </span>
                  )}
                </td>
                <td>{entry.entryDate.toLocaleDateString()}</td>
                <td>
                  <div className="text-sm">{entry.memo ?? entry.source}</div>
                  <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                    {entry.lines.map((line) => line.account.code).join(' · ')}
                  </div>
                </td>
                <td className="num">
                  <Money cents={sum(entry.lines.map((line) => line.debitCents))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function CostRow({
  label,
  cents,
  max,
  note,
}: {
  label: string;
  cents: bigint;
  max: number;
  note?: string;
}) {
  return (
    <tr>
      <td style={{ width: '40%' }}>
        <div className="font-medium">{label}</div>
        {note && (
          <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>
            {note}
          </div>
        )}
      </td>
      <td>
        <Bar value={Number(cents)} max={max} label={`${label}: ${formatMoney(cents)}`} />
      </td>
      <td className="num">
        <Money cents={cents} />
      </td>
    </tr>
  );
}

