import { notFound } from 'next/navigation';
import { db } from '../../../lib/db';
import { formatMoney } from '../../../lib/money';
import { resolveShare } from '../../../lib/documents/delivery';
import { PrintButton } from '../../../components/document-print';

export const dynamic = 'force-dynamic';

/**
 * The document a customer actually sees.
 *
 * No account, no navigation, no application chrome — a link from an email opens the one
 * thing it was sent about. Authorization is the token and nothing else: it is looked up
 * by hash, and a wrong, expired or revoked one is a plain not-found rather than a hint
 * about what would have been there.
 *
 * It is built to print. There is no PDF generator in this build and adding one would put
 * a second renderer in the way of the truth — the page is the document, and the browser
 * turns it into a PDF that says exactly what this says.
 */
export default async function SharedDocumentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await resolveShare(db, token);
  if (!share) notFound();

  const organization = await db.organization.findUniqueOrThrow({
    where: { id: share.organizationId },
    select: { name: true, legalName: true },
  });

  if (share.documentType === 'INVOICE') {
    const invoice = await db.invoice.findUnique({
      where: { id: share.documentId },
      include: {
        customer: true,
        location: true,
        lines: { orderBy: { sortOrder: 'asc' } },
        taxLines: { include: { taxJurisdiction: { select: { name: true } } } },
        job: { select: { jobNo: true, title: true } },
      },
    });
    if (!invoice) notFound();

    const customerName =
      invoice.customer.companyName ??
      [invoice.customer.firstName, invoice.customer.lastName].filter(Boolean).join(' ');

    return (
      <Document
        organization={organization}
        location={invoice.location}
        title="Invoice"
        number={invoice.invoiceNo}
        dated={invoice.issueDate}
        customerName={customerName}
        meta={[
          ['Due', invoice.dueDate.toLocaleDateString()],
          ...(invoice.poNumber ? ([['Your PO', invoice.poNumber]] as [string, string][]) : []),
          ...(invoice.job ? ([['Job', invoice.job.jobNo]] as [string, string][]) : []),
        ]}
        lines={invoice.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity.toString(),
          unitPriceCents: line.unitPriceCents,
          totalCents: line.totalCents - line.taxCents,
        }))}
        subtotalCents={invoice.subtotalCents - invoice.discountCents}
        taxes={invoice.taxLines.map((line) => ({
          name: line.taxJurisdiction?.name ?? 'Sales tax',
          taxCents: line.taxCents,
        }))}
        totalCents={invoice.totalCents}
        paidCents={invoice.paidCents + invoice.depositAppliedCents}
        balanceCents={invoice.balanceCents}
        footer={
          invoice.balanceCents > 0n
            ? `Please pay ${formatMoney(invoice.balanceCents)} by ${invoice.dueDate.toLocaleDateString()}.`
            : 'Paid in full — thank you.'
        }
        memo={invoice.memo}
      />
    );
  }

  const quote = await db.quote.findUnique({
    where: { id: share.documentId },
    include: {
      customer: true,
      location: true,
      options: { orderBy: { sortOrder: 'asc' }, include: { lines: { orderBy: { sortOrder: 'asc' } } } },
      lines: { orderBy: { sortOrder: 'asc' } },
    },
  });
  if (!quote) notFound();

  const customerName =
    quote.customer.companyName ??
    [quote.customer.firstName, quote.customer.lastName].filter(Boolean).join(' ');
  const chosen = quote.options.find((option) => option.isSelected);
  const showing = chosen ?? quote.options.find((option) => option.isRecommended) ?? quote.options[0];
  const lines = showing ? showing.lines : quote.lines;

  return (
    <Document
      organization={organization}
      location={quote.location}
      title="Quote"
      number={quote.quoteNo}
      dated={quote.createdAt}
      customerName={customerName}
      meta={[
        ...(quote.validUntil
          ? ([['Valid until', quote.validUntil.toLocaleDateString()]] as [string, string][])
          : []),
        ...(showing ? ([['Option', showing.name]] as [string, string][]) : []),
      ]}
      lines={lines.map((line) => ({
        description: line.description,
        quantity: line.quantity.toString(),
        unitPriceCents: line.unitPriceCents,
        totalCents: line.totalCents,
      }))}
      subtotalCents={showing ? showing.subtotalCents : quote.subtotalCents}
      // An option carries a subtotal and a total; the difference is its tax, which is how
      // the quote screens read it too.
      taxes={[
        {
          name: 'Sales tax',
          taxCents: showing ? showing.totalCents - showing.subtotalCents : quote.taxCents,
        },
      ]}
      totalCents={showing ? showing.totalCents : quote.totalCents}
      footer={
        quote.status === 'APPROVED' || quote.status === 'CONVERTED'
          ? 'Accepted — thank you. We will be in touch to book it in.'
          : 'Reply to this email to accept, and we will book it in.'
      }
      memo={quote.scopeOfWork}
      options={
        quote.options.length > 1
          ? quote.options.map((option) => ({
              name: option.name,
              totalCents: option.totalCents,
              isShowing: option.id === showing?.id,
            }))
          : undefined
      }
    />
  );
}

function Document({
  organization,
  location,
  title,
  number,
  dated,
  customerName,
  meta,
  lines,
  subtotalCents,
  taxes,
  totalCents,
  paidCents,
  balanceCents,
  footer,
  memo,
  options,
}: {
  organization: { name: string; legalName: string | null };
  location: {
    name: string;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    phone: string | null;
    email: string | null;
  };
  title: string;
  number: string;
  dated: Date;
  customerName: string;
  meta: [string, string][];
  lines: { description: string; quantity: string; unitPriceCents: bigint; totalCents: bigint }[];
  subtotalCents: bigint;
  taxes: { name: string; taxCents: bigint }[];
  totalCents: bigint;
  paidCents?: bigint;
  balanceCents?: bigint;
  footer: string;
  memo?: string | null;
  options?: { name: string; totalCents: bigint; isShowing: boolean }[];
}) {
  const address = [location.addressLine1, [location.city, location.state, location.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(' · ');

  return (
    <main className="doc">
      <style>{`
        .doc { max-width: 52rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; color: #111827; background: #fff; font-size: 15px; }
        .doc h1 { font-size: 1.9rem; font-weight: 700; letter-spacing: -0.01em; }
        .doc table { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
        .doc th { text-align: left; font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding: 0.5rem 0.25rem; }
        .doc td { padding: 0.6rem 0.25rem; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
        .doc .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .doc .rule { border-top: 2px solid #111827; }
        .doc .muted { color: #6b7280; }
        @media print {
          .no-print { display: none !important; }
          .doc { padding: 0; max-width: none; font-size: 12px; }
          @page { margin: 18mm; }
        }
      `}</style>

      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <div className="text-xl font-bold">{organization.legalName ?? organization.name}</div>
          <div className="muted text-sm">
            {location.name}
            {address ? ` · ${address}` : ''}
          </div>
          {(location.phone || location.email) && (
            <div className="muted text-sm">
              {[location.phone, location.email].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        <div className="text-right">
          <h1>{title}</h1>
          <div className="font-semibold">{number}</div>
          <div className="muted text-sm">{dated.toLocaleDateString()}</div>
        </div>
      </header>

      <section className="mt-8 flex flex-wrap justify-between gap-6">
        <div>
          <div className="muted text-xs uppercase tracking-wide">To</div>
          <div className="font-semibold">{customerName}</div>
        </div>
        <div className="text-right text-sm">
          {meta.map(([label, value]) => (
            <div key={label}>
              <span className="muted">{label} </span>
              <span className="font-medium">{value}</span>
            </div>
          ))}
        </div>
      </section>

      {memo && <p className="muted mt-6 text-sm">{memo}</p>}

      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th className="num">Qty</th>
            <th className="num">Each</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td>{line.description}</td>
              <td className="num">{Number(line.quantity).toLocaleString()}</td>
              <td className="num">{formatMoney(line.unitPriceCents)}</td>
              <td className="num">{formatMoney(line.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="mt-4 flex justify-end">
        <table style={{ width: '18rem', marginTop: 0 }}>
          <tbody>
            <tr>
              <td className="muted">Subtotal</td>
              <td className="num">{formatMoney(subtotalCents)}</td>
            </tr>
            {taxes
              .filter((tax) => tax.taxCents > 0n)
              .map((tax) => (
                <tr key={tax.name}>
                  <td className="muted">{tax.name}</td>
                  <td className="num">{formatMoney(tax.taxCents)}</td>
                </tr>
              ))}
            <tr className="rule">
              <td className="font-semibold">Total</td>
              <td className="num font-semibold">{formatMoney(totalCents)}</td>
            </tr>
            {paidCents !== undefined && paidCents > 0n && (
              <tr>
                <td className="muted">Already paid</td>
                <td className="num">−{formatMoney(paidCents)}</td>
              </tr>
            )}
            {balanceCents !== undefined && (
              <tr>
                <td className="font-semibold">Due</td>
                <td className="num font-semibold">{formatMoney(balanceCents)}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {options && (
        <section className="mt-8">
          <div className="muted text-xs uppercase tracking-wide">The options we quoted</div>
          <table>
            <tbody>
              {options.map((option) => (
                <tr key={option.name}>
                  <td className={option.isShowing ? 'font-semibold' : 'muted'}>
                    {option.name}
                    {option.isShowing ? ' — shown above' : ''}
                  </td>
                  <td className={`num ${option.isShowing ? 'font-semibold' : 'muted'}`}>
                    {formatMoney(option.totalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="mt-10 text-sm">{footer}</p>

      <div className="no-print mt-8">
        <PrintButton />
      </div>
    </main>
  );
}
