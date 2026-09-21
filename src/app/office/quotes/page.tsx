import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney } from '../../../lib/money';
import { quotePipeline } from '../../../lib/quotes/service';
import { Flag, Money, Panel, StatTile } from '../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/**
 * The pipeline.
 *
 * Quotes are the only part of this business that is still a decision when you look at it.
 * Everything else on these screens has already happened — the work was done, the parts
 * went out, the money came in or did not. These are the ones somebody can still pick up
 * the phone about, which is why the oldest are at the top.
 */
export default async function QuotesPage() {
  const ctx = await requireContext();

  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1));

  const [pipeline, open, recent] = await Promise.all([
    quotePipeline(db, ctx, { from, to }),
    db.quote.findMany({
      where: { organizationId: ctx.organizationId, status: { in: ['DRAFT', 'SENT'] } },
      orderBy: { createdAt: 'asc' },
      take: 40,
      select: {
        id: true,
        quoteNo: true,
        title: true,
        status: true,
        totalCents: true,
        createdAt: true,
        validUntil: true,
        presentedByTechnicianId: true,
        customer: { select: { companyName: true, firstName: true, lastName: true } },
        location: { select: { name: true } },
      },
    }),
    db.quote.findMany({
      where: { organizationId: ctx.organizationId, status: { in: ['APPROVED', 'CONVERTED'] } },
      orderBy: { approvedAt: 'desc' },
      take: 12,
      select: {
        id: true,
        quoteNo: true,
        title: true,
        status: true,
        totalCents: true,
        approvedAt: true,
        jobId: true,
        presentedByTechnicianId: true,
        customer: { select: { companyName: true, firstName: true, lastName: true } },
      },
    }),
  ]);

  /*
   * Looked up rather than joined: `Quote.presentedByTechnicianId` is a bare column with no
   * relation behind it, so Prisma cannot include it. Worth fixing in the schema — a
   * foreign key with nothing enforcing it is a foreign key that will eventually point at
   * another organization's technician — but not from here.
   */
  const technicianIds = [
    ...new Set(
      [...open, ...recent]
        .map((quote) => quote.presentedByTechnicianId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const technicians = await db.technician.findMany({
    where: { id: { in: technicianIds }, organizationId: ctx.organizationId },
    select: { id: true, user: { select: { firstName: true, lastName: true } } },
  });
  const presenter = new Map(
    technicians.map((t) => [t.id, `${t.user.firstName} ${t.user.lastName}`]),
  );

  const nameOf = (customer: { companyName: string | null; firstName: string | null; lastName: string | null }) =>
    customer.companyName ?? [customer.firstName, customer.lastName].filter(Boolean).join(' ');

  const days = (from: Date) => Math.floor((Date.now() - from.getTime()) / 86_400_000);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Quotes</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          The only work on these screens that has not happened yet
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Out there"
          value={formatMoney(pipeline.openCents)}
          note={`${pipeline.openCount} quotes waiting on an answer`}
        />
        <StatTile
          label="Close rate"
          value={`${pipeline.closeRatePercent.toFixed(1)}%`}
          note={`of ${pipeline.decidedCount.toLocaleString()} that got an answer`}
        />
        <StatTile
          label="Won"
          value={formatMoney(pipeline.wonCents)}
          note={`${pipeline.wonCount.toLocaleString()} accepted, last 12 months`}
        />
        <StatTile
          label="Quoted on site"
          value={pipeline.fromTheFieldCount.toLocaleString()}
          note="written by a technician in front of the customer"
        />
      </div>

      <Panel
        title="Waiting on an answer"
        subtitle="Oldest first — a quote nobody has chased is the cheapest work in the building"
      >
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Quote</th>
                <th>Customer</th>
                <th>Presented by</th>
                <th>Waiting</th>
                <th className="num">Value</th>
              </tr>
            </thead>
            <tbody>
              {open.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ color: 'var(--ink-2)' }}>
                    Nothing outstanding.
                  </td>
                </tr>
              ) : (
                open.map((quote) => {
                  const waiting = days(quote.createdAt);
                  return (
                    <tr key={quote.id}>
                      <td>
                        <Link
                          href={`/office/quotes/${quote.id}`}
                          className="font-medium"
                          style={{ color: 'var(--seq)' }}
                        >
                          {quote.quoteNo}
                        </Link>
                        <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                          {quote.title ?? '—'}
                        </div>
                      </td>
                      <td>
                        {nameOf(quote.customer)}
                        <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                          {quote.location.name}
                        </div>
                      </td>
                      <td className="text-sm">
                        {(quote.presentedByTechnicianId
                          ? presenter.get(quote.presentedByTechnicianId)
                          : null) ?? 'the office'}
                      </td>
                      <td>
                        {waiting > 30 ? (
                          <Flag tone="critical">{waiting} days</Flag>
                        ) : waiting > 14 ? (
                          <Flag tone="serious">{waiting} days</Flag>
                        ) : (
                          <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
                            {waiting} days
                          </span>
                        )}
                      </td>
                      <td className="num font-semibold">
                        <Money cents={quote.totalCents} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Recently accepted" subtitle="And whether the work has been booked in yet">
        <table>
          <thead>
            <tr>
              <th>Quote</th>
              <th>Customer</th>
              <th>Accepted</th>
              <th>Booked in</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((quote) => (
              <tr key={quote.id}>
                <td>
                  <Link
                    href={`/office/quotes/${quote.id}`}
                    className="font-medium"
                    style={{ color: 'var(--seq)' }}
                  >
                    {quote.quoteNo}
                  </Link>
                  <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                    {quote.title ?? '—'}
                  </div>
                </td>
                <td>{nameOf(quote.customer)}</td>
                <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                  {quote.approvedAt ? quote.approvedAt.toLocaleDateString() : '—'}
                </td>
                <td>
                  {quote.jobId ? (
                    <Link href={`/office/jobs/${quote.jobId}`} style={{ color: 'var(--seq)' }}>
                      scheduled →
                    </Link>
                  ) : (
                    <Flag tone="serious">not yet</Flag>
                  )}
                </td>
                <td className="num">
                  <Money cents={quote.totalCents} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
