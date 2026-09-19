import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../../lib/db';
import { requireContext } from '../../../../../server/session';
import { generalLedgerDetail } from '../../../../../lib/accounting/reports';
import { Money, Panel } from '../../../../../components/office/primitives';
import { ZERO } from '../../../../../lib/money';

export const dynamic = 'force-dynamic';

/** Every line that made up an account's balance — the end of the drill-down. */
export default async function AccountDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const ctx = await requireContext();
  const { id } = await params;
  const { from: fromParam, to: toParam } = await searchParams;

  const account = await db.account.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, code: true, name: true, type: true },
  });
  if (!account) notFound();

  const to = toParam ? new Date(toParam) : new Date();
  const from = fromParam ? new Date(fromParam) : new Date(Date.UTC(to.getUTCFullYear(), 0, 1));

  const all = await generalLedgerDetail(db, ctx, { from, to });
  const lines = all.filter((line) => line.account.code === account.code).slice(0, 300);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/office/financials" className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
          ← Financials
        </Link>
        <h1 className="mt-1 text-2xl font-bold">
          <span className="tabular-nums">{account.code}</span> {account.name}
        </h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {from.toLocaleDateString()} to {to.toLocaleDateString()} · {lines.length} lines
        </p>
      </div>

      <Panel title="Ledger detail">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Entry</th>
                <th>Date</th>
                <th>Memo</th>
                <th>Job</th>
                <th className="num">Debit</th>
                <th className="num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <span className="font-medium">{line.journalEntry.entryNo}</span>
                  </td>
                  <td>{line.journalEntry.entryDate.toLocaleDateString()}</td>
                  <td className="text-sm">{line.memo ?? line.journalEntry.memo ?? '—'}</td>
                  <td className="text-sm">
                    {line.jobId ? (
                      <Link href={`/office/jobs/${line.jobId}`} className="underline-offset-2 hover:underline">
                        open
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{line.debitCents > ZERO ? <Money cents={line.debitCents} /> : ''}</td>
                  <td className="num">{line.creditCents > ZERO ? <Money cents={line.creditCents} /> : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
