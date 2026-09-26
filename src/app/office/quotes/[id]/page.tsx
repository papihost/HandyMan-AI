import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../lib/db';
import { requireContext } from '../../../../server/session';
import { formatMoney } from '../../../../lib/money';
import { SendDocument } from '../../../../components/office/send-document';
import { deliveryState } from '../../../../lib/documents/delivery';
import { PERMISSIONS } from '../../../../lib/auth/permissions';
import { Flag, Money, Panel, StatTile } from '../../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/**
 * One quote, and which of its options the customer took.
 *
 * The options are shown side by side because that is how they were shown to the customer.
 * Reading them back one at a time hides the thing that actually happened: three prices
 * were offered and a person chose one, and which one they chose is worth more to a pricing
 * decision than the total ever is.
 */
export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;

  const quote = await db.quote.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      customer: true,
      property: true,
      location: { select: { name: true } },
      job: { select: { id: true, jobNo: true, status: true } },
      signature: { select: { signerName: true, signedAt: true, kind: true } },
      presentedBy: { select: { user: { select: { firstName: true, lastName: true } } } },
      options: {
        orderBy: { sortOrder: 'asc' },
        include: { lines: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  });
  if (!quote) notFound();

  const canSeeCost = ctx.permissions.has(PERMISSIONS.FINANCE_READ_COST);

  const customerName =
    quote.customer.companyName ??
    [quote.customer.firstName, quote.customer.lastName].filter(Boolean).join(' ');

  const selected = quote.options.find((option) => option.isSelected);
  const decided = quote.status === 'APPROVED' || quote.status === 'CONVERTED';
  const delivery = await deliveryState(db, ctx, 'QUOTE', quote.id);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/office/quotes" className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
          ← Quotes
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-bold">{quote.quoteNo}</h1>
          {decided ? (
            <Flag tone="good">{quote.status.toLowerCase()}</Flag>
          ) : quote.status === 'DECLINED' || quote.status === 'EXPIRED' ? (
            <Flag tone="critical">{quote.status.toLowerCase()}</Flag>
          ) : (
            <Flag tone="serious">waiting on an answer</Flag>
          )}
        </div>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {customerName} · {quote.property.addressLine1}, {quote.property.city} ·{' '}
          {quote.location.name} · raised {quote.createdAt.toLocaleDateString()}
          {quote.presentedBy
            ? ` · presented on site by ${quote.presentedBy.user.firstName} ${quote.presentedBy.user.lastName}`
            : ' · raised in the office'}
        </p>
        {quote.title && <p className="mt-1 font-medium">{quote.title}</p>}

        <div className="mt-3">
          <SendDocument
            type="QUOTE"
            documentId={quote.id}
            defaultTo={quote.customer.email}
            state={{
              sendCount: delivery.sendCount,
              lastSentTo: delivery.lastSentTo,
              lastSentAt: delivery.lastSentAt?.toISOString() ?? null,
              viewedAt: delivery.viewedAt?.toISOString() ?? null,
              viewCount: delivery.viewCount,
            }}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label={decided ? 'Accepted' : 'Quoted'}
          value={formatMoney(quote.totalCents)}
          note={selected ? `${selected.name} of ${quote.options.length}` : 'including tax'}
        />
        <StatTile
          label="Signed"
          value={quote.signature ? quote.signature.signerName : '—'}
          note={
            quote.approvedAt
              ? `on the glass, ${quote.approvedAt.toLocaleDateString()}`
              : 'nobody has signed it yet'
          }
        />
        <StatTile
          label="Booked in"
          value={quote.job ? quote.job.jobNo : '—'}
          tone={decided && !quote.job ? 'warning' : 'neutral'}
          note={
            quote.job
              ? quote.job.status.replace('_', ' ').toLowerCase()
              : decided
                ? 'accepted but not yet scheduled'
                : 'nothing to book yet'
          }
        />
      </div>

      {decided && !quote.job && (
        <div className="panel p-4">
          <Flag tone="serious">This was accepted and the work is not on the board</Flag>
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
            A customer who said yes and then heard nothing is the most expensive kind of
            customer there is — the work was won and then given away.
          </p>
        </div>
      )}

      <div className={`grid gap-4 ${quote.options.length > 1 ? 'lg:grid-cols-3' : ''}`}>
        {quote.options.map((option) => (
          <Panel
            key={option.id}
            title={option.name}
            subtitle={
              option.isSelected
                ? 'the one they took'
                : option.isRecommended
                  ? 'recommended'
                  : undefined
            }
          >
            <div className="px-4 pb-4">
              {option.isSelected && (
                <div className="mb-2">
                  <Flag tone="good">chosen</Flag>
                </div>
              )}
              <table>
                <tbody>
                  {option.lines.map((line) => (
                    <tr key={line.id}>
                      <td>
                        <div className="text-sm">{line.description}</div>
                        <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                          {Number(line.quantity)} × {formatMoney(line.unitPriceCents)}
                          {canSeeCost && line.unitCostCents > 0n
                            ? ` · costs ${formatMoney(line.unitCostCents)}`
                            : ''}
                        </div>
                      </td>
                      <td className="num">
                        <Money cents={line.totalCents} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="font-semibold">Total</td>
                    <td className="num font-semibold">
                      <Money cents={option.totalCents} bold />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Panel>
        ))}
      </div>

      {quote.scopeOfWork && (
        <Panel title="Scope">
          <p className="px-4 pb-4 text-sm">{quote.scopeOfWork}</p>
        </Panel>
      )}
    </div>
  );
}
