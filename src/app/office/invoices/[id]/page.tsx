import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../lib/db';
import { requireContext } from '../../../../server/session';
import { formatMoney, sum, ZERO } from '../../../../lib/money';
import { PERMISSIONS } from '../../../../lib/auth/permissions';
import { Flag, Money, Panel, Percent, StatTile } from '../../../../components/office/primitives';
import { RecordPaymentButton } from '../../../../components/office/payment-actions';
import { UndoSaleActions } from '../../../../components/office/credit-actions';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL: Record<string, string> = {
  LABOR: 'Labour',
  MATERIAL: 'Materials',
  AGREEMENT: 'Agreement',
  FEE: 'Fee',
  SUBCONTRACT: 'Subcontract',
};

/**
 * One invoice, and the entry it posted.
 *
 * The question this page exists to answer is "where did that number come from", asked
 * twice: once about the tax, which is the line customers query and offices guess at, and
 * once about the ledger, which is the line a controller queries. Both are shown rather
 * than asserted — the jurisdictions with their rates and the base each was applied to, and
 * a link into the journal entry itself.
 *
 * Nothing here is editable. An issued invoice has posted to the general ledger, and the
 * way to change one is a credit memo, not a correction typed over the top.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;

  const invoice = await db.invoice.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      customer: true,
      location: { select: { name: true } },
      job: { select: { id: true, jobNo: true, title: true } },
      lines: { orderBy: { sortOrder: 'asc' } },
      taxLines: {
        include: { taxJurisdiction: { select: { name: true, level: true } } },
      },
      journalEntry: { select: { id: true, entryNo: true, entryDate: true } },
      applications: {
        orderBy: { appliedAt: 'asc' },
        include: {
          payment: {
            select: {
              id: true,
              paymentNo: true,
              method: true,
              receivedAt: true,
              cardBrand: true,
              cardLast4: true,
              reference: true,
              journalEntry: { select: { id: true, entryNo: true } },
            },
          },
        },
      },
      creditMemos: {
        select: {
          id: true,
          creditMemoNo: true,
          reason: true,
          amountCents: true,
          issuedAt: true,
          journalEntry: { select: { id: true, entryNo: true } },
        },
      },
    },
  });
  if (!invoice) notFound();

  const canSeeCost = ctx.permissions.has(PERMISSIONS.FINANCE_READ_COST);

  const customerName =
    invoice.customer.companyName ??
    [invoice.customer.firstName, invoice.customer.lastName].filter(Boolean).join(' ');

  const daysLate = Math.floor((Date.now() - invoice.dueDate.getTime()) / 86_400_000);
  const isOpen = invoice.balanceCents > ZERO && invoice.status !== 'VOID';

  // Cost travels on the line as it was at the time of billing, so the margin here is the
  // margin that was actually earned rather than what today's price book would imply.
  const costCents = canSeeCost
    ? sum(
        invoice.lines.map(
          (line) => (line.unitCostCents * BigInt(Math.round(Number(line.quantity) * 1000))) / 1000n,
        ),
      )
    : ZERO;
  const netCents = invoice.subtotalCents - invoice.discountCents;
  const marginCents = netCents - costCents;
  const marginPercent = netCents === ZERO ? 0 : Number((marginCents * 1000n) / netCents) / 10;

  // Everything this invoice caused the ledger to do: the issue, each payment, each credit.
  const postings = [
    invoice.journalEntry && {
      id: invoice.journalEntry.id,
      entryNo: invoice.journalEntry.entryNo,
      date: invoice.journalEntry.entryDate,
      what: `Issued — receivable, revenue and tax`,
    },
    ...invoice.applications.map((application) =>
      application.payment.journalEntry
        ? {
            id: application.payment.journalEntry.id,
            entryNo: application.payment.journalEntry.entryNo,
            date: application.payment.receivedAt,
            what: `Payment ${application.payment.paymentNo} — ${application.payment.method.toLowerCase()}`,
          }
        : null,
    ),
    ...invoice.creditMemos.map((memo) =>
      memo.journalEntry
        ? {
            id: memo.journalEntry.id,
            entryNo: memo.journalEntry.entryNo,
            date: memo.issuedAt,
            what: `Credit ${memo.creditMemoNo} — ${memo.reason}`,
          }
        : null,
    ),
  ].filter(Boolean) as { id: string; entryNo: string; date: Date; what: string }[];

  const taxTotal = sum(invoice.taxLines.map((line) => line.taxCents));

  /*
   * What can still be undone, and how.
   *
   * A void is only available while nothing has been paid and nothing credited — after
   * that it would be taking away revenue that the customer's money, or an earlier credit,
   * is already sitting against. The screen decides this rather than offering both and
   * refusing afterwards.
   */
  const creditedCents = sum(invoice.creditMemos.map((memo) => memo.amountCents));
  const settled = invoice.status === 'VOID' || invoice.status === 'DRAFT';
  const canVoid =
    !settled &&
    invoice.paidCents === ZERO &&
    creditedCents === ZERO &&
    ctx.permissions.has(PERMISSIONS.INVOICE_VOID);
  const canCredit =
    !settled &&
    creditedCents < invoice.totalCents &&
    ctx.permissions.has(PERMISSIONS.INVOICE_WRITE_OFF);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/office/invoices" className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
          ← Receivables
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-bold">{invoice.invoiceNo}</h1>
          {invoice.status === 'PAID' ? (
            <Flag tone="good">paid</Flag>
          ) : invoice.status === 'VOID' ? (
            <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
              void
            </span>
          ) : daysLate > 90 ? (
            <Flag tone="critical">{daysLate} days late</Flag>
          ) : daysLate > 0 ? (
            <Flag tone="serious">{daysLate} days late</Flag>
          ) : (
            <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
              {invoice.status.replace('_', ' ').toLowerCase()}
            </span>
          )}
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {customerName} · {invoice.location.name} · issued{' '}
          {invoice.issueDate.toLocaleDateString()} · due {invoice.dueDate.toLocaleDateString()}
          {invoice.terms ? ` · ${invoice.terms}` : ''}
          {invoice.poNumber ? ` · PO ${invoice.poNumber}` : ''}
        </p>
        {invoice.job && (
          <p className="mt-1 text-sm">
            <Link
              href={`/office/jobs/${invoice.job.id}`}
              className="font-semibold"
              style={{ color: 'var(--seq)' }}
            >
              {invoice.job.jobNo}
            </Link>{' '}
            <span style={{ color: 'var(--ink-2)' }}>{invoice.job.title}</span>
          </p>
        )}

        {(canVoid || canCredit) && (
          <div className="mt-3">
            <UndoSaleActions
              invoiceId={invoice.id}
              balanceCents={invoice.balanceCents.toString()}
              canVoid={canVoid}
              canCredit={canCredit}
            />
          </div>
        )}

        {invoice.status === 'VOID' && (
          <p className="mt-2 text-sm" style={{ color: 'var(--ink-2)' }}>
            Reversed, not deleted — the original posting is still in the ledger with its
            reversal beside it, and the work went back to the job unbilled.
          </p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total" value={formatMoney(invoice.totalCents)} note="including tax" />
        <StatTile label="Paid" value={formatMoney(invoice.paidCents)} />
        <StatTile
          label="Balance"
          value={formatMoney(invoice.balanceCents)}
          tone={isOpen ? (daysLate > 0 ? 'critical' : 'warning') : 'good'}
          note={isOpen ? 'still owed' : 'settled'}
        />
        {canSeeCost ? (
          <StatTile
            label="Margin"
            value={`${marginPercent.toFixed(1)}%`}
            note={`${formatMoney(marginCents)} on ${formatMoney(netCents)} of work`}
          />
        ) : (
          <StatTile label="Tax" value={formatMoney(invoice.taxCents)} note="collected, owed on" />
        )}
      </div>

      {/* The link Act 3 turns on: from the document to the entry it posted. */}
      {invoice.journalEntry && (
        <Link href={`/office/entries/${invoice.journalEntry.id}`} className="panel block p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="font-semibold">View journal entry {invoice.journalEntry.entryNo}</span>
              <p className="mt-0.5 text-sm" style={{ color: 'var(--ink-2)' }}>
                Receivable, revenue split by what was sold, and sales tax — posted when this
                invoice was issued, by the invoice rather than by anybody typing
              </p>
            </div>
            <span className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
              Open →
            </span>
          </div>
        </Link>
      )}

      <Panel
        title="What was billed"
        subtitle={`${invoice.lines.length} ${invoice.lines.length === 1 ? 'line' : 'lines'}${
          canSeeCost ? ' — cost as it stood when the work was done' : ''
        }`}
      >
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Kind</th>
                <th className="num">Qty</th>
                <th className="num">Price</th>
                {canSeeCost && <th className="num">Cost</th>}
                <th className="num">Amount</th>
                <th className="num">Tax</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <div className="font-medium">{line.description}</div>
                    {!line.isTaxable && (
                      <div className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                        not taxable
                      </div>
                    )}
                  </td>
                  <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                    {CATEGORY_LABEL[line.category] ?? line.category}
                  </td>
                  <td className="num">{Number(line.quantity).toLocaleString()}</td>
                  <td className="num">
                    <Money cents={line.unitPriceCents} />
                  </td>
                  {canSeeCost && (
                    <td className="num" style={{ color: 'var(--ink-2)' }}>
                      <Money cents={line.unitCostCents} />
                    </td>
                  )}
                  {/* Ex-tax, so the column adds up to the subtotal underneath it. The
                      line's own totalCents is tax-inclusive, which is the right thing to
                      store and the wrong thing to put in a column above a subtotal. */}
                  <td className="num">
                    <Money cents={line.unitPriceCents * BigInt(Math.round(Number(line.quantity) * 1000)) / 1000n - line.discountCents} />
                  </td>
                  <td className="num" style={{ color: 'var(--ink-2)' }}>
                    {line.taxCents > ZERO ? <Money cents={line.taxCents} /> : '—'}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="font-semibold">Subtotal</td>
                <td colSpan={canSeeCost ? 4 : 3} />
                <td className="num font-semibold">
                  <Money cents={invoice.subtotalCents} bold />
                </td>
                <td />
              </tr>
              {invoice.discountCents > ZERO && (
                <tr>
                  <td>Discount</td>
                  <td colSpan={canSeeCost ? 4 : 3} />
                  <td className="num">
                    −<Money cents={invoice.discountCents} />
                  </td>
                  <td />
                </tr>
              )}
              <tr>
                <td>Sales tax</td>
                <td colSpan={canSeeCost ? 4 : 3} />
                <td />
                <td className="num">
                  <Money cents={invoice.taxCents} />
                </td>
              </tr>
              {/* The grand total belongs under the money column, not under the tax
                  column it happens to be nearest. */}
              <tr>
                <td className="font-semibold">Total</td>
                <td colSpan={canSeeCost ? 4 : 3} />
                <td className="num font-semibold">
                  <Money cents={invoice.totalCents} bold />
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>

      {invoice.taxLines.length > 0 && (
        <Panel
          title="How the tax was worked out"
          subtitle="Resolved on the service address, not on the customer's billing address"
        >
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Jurisdiction</th>
                  <th>Level</th>
                  <th className="num">Taxable</th>
                  <th className="num">Rate</th>
                  <th className="num">Tax</th>
                </tr>
              </thead>
              <tbody>
                {invoice.taxLines.map((line) => (
                  <tr key={line.id}>
                    <td className="font-medium">{line.taxJurisdiction.name}</td>
                    <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                      {line.taxJurisdiction.level.toLowerCase()}
                    </td>
                    <td className="num">
                      <Money cents={line.taxableCents} />
                    </td>
                    <td className="num">
                      <Percent value={Number(line.rate) * 100} decimals={3} />
                    </td>
                    <td className="num">
                      <Money cents={line.taxCents} />
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="font-semibold">Collected</td>
                  <td colSpan={3} />
                  <td className="num font-semibold">
                    <Money cents={taxTotal} bold />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 text-sm" style={{ color: 'var(--ink-2)' }}>
            Sales tax is somebody else&apos;s money held for a while. It posts to a liability,
            never to income, so it cannot flatter a month&apos;s revenue on its way to the state.
          </p>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Paid"
          subtitle={
            invoice.applications.length === 0
              ? 'Nothing has been received against this invoice'
              : 'Applied to this invoice, newest last'
          }
          action={
            isOpen && ctx.permissions.has(PERMISSIONS.PAYMENT_RECORD) ? (
              <RecordPaymentButton
                invoiceId={invoice.id}
                balanceCents={invoice.balanceCents.toString()}
              />
            ) : undefined
          }
        >
          {invoice.applications.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Payment</th>
                  <th>Method</th>
                  <th>Received</th>
                  <th className="num">Applied</th>
                </tr>
              </thead>
              <tbody>
                {invoice.applications.map((application) => (
                  <tr key={application.id}>
                    <td className="font-medium">{application.payment.paymentNo}</td>
                    <td className="text-sm">
                      {application.payment.method.toLowerCase()}
                      {application.payment.cardLast4 && (
                        <span style={{ color: 'var(--ink-2)' }}>
                          {' '}
                          {application.payment.cardBrand} ····{application.payment.cardLast4}
                        </span>
                      )}
                      {application.payment.reference && (
                        <span style={{ color: 'var(--ink-2)' }}> {application.payment.reference}</span>
                      )}
                    </td>
                    <td className="text-sm">
                      {application.payment.receivedAt.toLocaleDateString()}
                    </td>
                    <td className="num">
                      <Money cents={application.amountCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Everything this invoice posted"
          subtitle="Issuing it, and everything that has happened to it since"
        >
          <table>
            <thead>
              <tr>
                <th>Entry</th>
                <th>Date</th>
                <th>What happened</th>
              </tr>
            </thead>
            <tbody>
              {postings.length === 0 ? (
                <tr>
                  <td colSpan={3} style={{ color: 'var(--ink-2)' }}>
                    Nothing has posted — a draft invoice is not yet in the books.
                  </td>
                </tr>
              ) : (
                postings.map((posting) => (
                  <tr key={posting.id}>
                    <td>
                      <Link
                        href={`/office/entries/${posting.id}`}
                        className="font-medium"
                        style={{ color: 'var(--seq)' }}
                      >
                        {posting.entryNo}
                      </Link>
                    </td>
                    <td className="text-sm">{posting.date.toLocaleDateString()}</td>
                    <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                      {posting.what}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>
      </div>

      {invoice.memo && (
        <Panel title="Memo">
          <p className="px-4 pb-4 text-sm">{invoice.memo}</p>
        </Panel>
      )}
    </div>
  );
}
