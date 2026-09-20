import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../lib/db';
import { requireContext } from '../../../../server/session';
import { formatMoney, sum, ZERO } from '../../../../lib/money';
import { Flag, Money, Panel } from '../../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/**
 * One journal entry, both sides.
 *
 * This is where a drill-down ends, and it is the page that decides whether a controller
 * believes the rest of the product. It shows what posted, what caused it, and — if
 * somebody has tried — that it cannot be edited.
 */
export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;

  const entry = await db.journalEntry.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      period: true,
      reverses: { select: { id: true, entryNo: true } },
      reversedBy: { select: { id: true, entryNo: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: {
          account: { select: { code: true, name: true, type: true } },
          location: { select: { name: true } },
          job: { select: { id: true, jobNo: true } },
          serviceType: { select: { name: true } },
        },
      },
    },
  });
  if (!entry) notFound();

  const debits = sum(entry.lines.map((line) => line.debitCents));
  const credits = sum(entry.lines.map((line) => line.creditCents));

  /*
   * Back to whatever caused this.
   *
   * A drill-down that only goes one way leaves a controller holding a number with no way
   * to ask what it was for. Every posting names the document it came from, so the trip
   * back is a lookup rather than a search.
   */
  const source =
    entry.sourceType === 'Invoice' && entry.sourceId
      ? await db.invoice
          .findFirst({
            where: { id: entry.sourceId, organizationId: ctx.organizationId },
            select: { id: true, invoiceNo: true },
          })
          .then((invoice) =>
            invoice ? { href: `/office/invoices/${invoice.id}`, label: invoice.invoiceNo } : null,
          )
      : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">{entry.entryNo}</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {entry.entryDate.toLocaleDateString()} · {entry.source.replace('_', ' ').toLowerCase()}
          {entry.period ? ` · period ${entry.period.fiscalYear}-${String(entry.period.periodNumber).padStart(2, '0')} (${entry.period.status.toLowerCase()})` : ''}
        </p>
        {entry.memo && <p className="mt-1">{entry.memo}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {/* A posted entry is immutable. Saying so here is cheaper than explaining it. */}
        {entry.postedAt && (
          <Flag tone="good">
            Posted {entry.postedAt.toLocaleString()} — cannot be edited
          </Flag>
        )}
        {entry.isReversal && <Flag tone="serious">This entry reverses another</Flag>}
        {entry.reverses && (
          <Link href={`/office/entries/${entry.reverses.id}`} className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
            Reverses {entry.reverses.entryNo} →
          </Link>
        )}
        {source && (
          <Link href={source.href} className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
            {source.label} →
          </Link>
        )}
        {entry.reversedBy.map((reversal) => (
          <Link
            key={reversal.id}
            href={`/office/entries/${reversal.id}`}
            className="text-sm font-semibold"
            style={{ color: 'var(--seq)' }}
          >
            Reversed by {reversal.entryNo} →
          </Link>
        ))}
      </div>

      <Panel
        title="Lines"
        subtitle={
          entry.sourceType
            ? `Posted by ${entry.sourceType.toLowerCase()}, not keyed by hand`
            : 'Manual entry'
        }
      >
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Branch</th>
                <th>Job</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {entry.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <span className="font-medium tabular-nums">{line.account.code}</span>{' '}
                    {line.account.name}
                    {line.memo && (
                      <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                        {line.memo}
                      </div>
                    )}
                  </td>
                  <td className="text-sm">{line.location?.name ?? '—'}</td>
                  <td className="text-sm">
                    {line.job ? (
                      <Link href={`/office/jobs/${line.job.id}`} className="underline-offset-2 hover:underline">
                        {line.job.jobNo}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{line.debitCents > ZERO ? <Money cents={line.debitCents} /> : ''}</td>
                  <td className="num">{line.creditCents > ZERO ? <Money cents={line.creditCents} /> : ''}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="font-semibold">
                  {debits === credits ? 'In balance' : 'OUT OF BALANCE'}
                </td>
                <td className="num font-semibold">
                  <Money cents={debits} bold />
                </td>
                <td className="num font-semibold">
                  <Money cents={credits} bold />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
        Total {formatMoney(debits)}. Corrections are made by posting a reversing entry, never
        by changing this one.
      </p>
    </div>
  );
}
