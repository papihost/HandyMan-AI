import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../lib/db';
import { requireContext } from '../../../../server/session';
import { formatMoney } from '../../../../lib/money';
import { reconciliationWorksheet } from '../../../../lib/accounting/reconciliation';
import { Flag, Panel } from '../../../../components/office/primitives';
import { ReconcileSheet } from '../../../../components/office/reconcile-actions';

export const dynamic = 'force-dynamic';

export default async function WorksheetPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;

  let sheet;
  try {
    sheet = await reconciliationWorksheet(db, ctx, id);
  } catch {
    notFound();
  }

  const finished = sheet.status === 'COMPLETE';

  return (
    <div className="space-y-5">
      <div>
        <Link href="/office/reconcile" className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
          ← Reconciliation
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-bold">
            {sheet.accountName} · {sheet.statementDate.toLocaleDateString()}
          </h1>
          {finished && <Flag tone="good">reconciled</Flag>}
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          Opening {formatMoney(sheet.openingBalanceCents)} — what the last statement closed on —
          against a closing balance of {formatMoney(sheet.closingBalanceCents)}. Tick what the
          bank has also seen.
        </p>
      </div>

      <Panel
        title={finished ? 'What this statement accounted for' : 'On the statement'}
        subtitle={
          finished
            ? 'Ticked lines are the ones the bank saw; the rest were still in transit when it was printed'
            : 'Everything posted to this account up to the statement date that no statement has claimed yet'
        }
      >
        <div className="px-4 pb-4 pt-1">
          <ReconcileSheet
            reconciliationId={sheet.id}
            openingCents={sheet.openingBalanceCents.toString()}
            closingCents={sheet.closingBalanceCents.toString()}
            finished={finished}
            lines={sheet.lines.map((line) => ({
              journalLineId: line.journalLineId,
              entryNo: line.entryNo,
              entryDate: line.entryDate.toISOString(),
              memo: line.memo,
              amountCents: line.amountCents.toString(),
              cleared: line.cleared,
            }))}
          />
        </div>
      </Panel>
    </div>
  );
}
