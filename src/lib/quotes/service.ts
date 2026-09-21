import type { PrismaClient } from '@prisma/client';
import { requireLocation, requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { ZERO, type Cents } from '../money';
import { nextDocumentNumber } from '../accounting/sequences';
import { computeDocumentTotals, type DocumentTotals, type DraftLine } from '../documents/line-totals';
import { resolvePrice } from '../pricing/price-book';
import { resolveTaxRuleForProperty } from '../pricing/tax';
import { createJob } from '../jobs/service';

/**
 * Quoting.
 *
 * Quotes carry option sets — good, better, best — because presenting one price invites a
 * yes or a no, while presenting three invites a choice. The customer picks an option and
 * signs on the technician's tablet; that acceptance is what converts the quote into a job.
 *
 * A quote is a proposal and nothing more. It posts nothing to the ledger. Revenue is
 * recognized when the work is invoiced, not when it is offered.
 */

export interface QuoteLineInput {
  priceBookItemId?: string;
  description?: string;
  quantity: string | number;
  unitPriceCents?: Cents;
  unitCostCents?: Cents;
  discountCents?: Cents;
  category?: import('@prisma/client').LineCategory;
}

export interface QuoteOptionInput {
  name: string;
  description?: string;
  isRecommended?: boolean;
  lines: QuoteLineInput[];
}

export interface CreateQuoteInput {
  locationId: string;
  customerId: string;
  propertyId: string;
  title?: string;
  scopeOfWork?: string;
  validForDays?: number;
  depositRequiredCents?: Cents;
  presentedByTechnicianId?: string;
  /** Either a set of options, or a single flat list of lines. */
  options?: QuoteOptionInput[];
  lines?: QuoteLineInput[];
  /**
   * When the quote was raised. Defaults to now, which is right for somebody typing one.
   * An import or a backdated seed knows better, and a pipeline whose every quote was
   * raised at the same instant cannot tell anybody what has been sitting unanswered.
   */
  createdAt?: Date;
}

export async function createQuote(db: PrismaClient, ctx: AuthContext, input: CreateQuoteInput) {
  requirePermission(ctx, PERMISSIONS.QUOTE_WRITE);
  requireLocation(ctx, input.locationId);

  const optionInputs: QuoteOptionInput[] = input.options?.length
    ? input.options
    : [{ name: 'Proposed work', isRecommended: true, lines: input.lines ?? [] }];

  if (optionInputs.every((o) => o.lines.length === 0)) {
    throw new ValidationError('A quote needs at least one line');
  }

  return db.$transaction(async (tx) => {
    const property = await tx.property.findFirst({
      where: {
        id: input.propertyId,
        customerId: input.customerId,
        customer: { organizationId: ctx.organizationId },
      },
      select: { id: true, customer: { select: { priceTier: true, isTaxExempt: true } } },
    });
    if (!property) throw new ValidationError('That property does not belong to this customer');

    const now = input.createdAt ?? new Date();
    const taxRule = await resolveTaxRuleForProperty(tx, ctx.organizationId, input.propertyId, now);

    // Resolve every option's pricing before writing, so a bad line fails the whole quote
    // rather than leaving a half-built one behind.
    const priced: { input: QuoteOptionInput; totals: DocumentTotals }[] = [];
    for (const option of optionInputs) {
      const draft = await resolveLines(
        tx,
        ctx.organizationId,
        option.lines,
        input.locationId,
        property.customer.priceTier,
      );
      priced.push({
        input: option,
        totals: computeDocumentTotals(draft, taxRule, {
          customerIsTaxExempt: property.customer.isTaxExempt,
        }),
      });
    }

    const location = await tx.location.findUniqueOrThrow({
      where: { id: input.locationId },
      select: { code: true },
    });
    const quoteNo = await nextDocumentNumber(tx, ctx.organizationId, 'QUOTE', location.code);

    // Headline figures show the recommended option until the customer chooses.
    const headline = priced.find((p) => p.input.isRecommended) ?? priced[0];

    const quote = await tx.quote.create({
      data: {
        organizationId: ctx.organizationId,
        locationId: input.locationId,
        quoteNo,
        customerId: input.customerId,
        propertyId: input.propertyId,
        status: 'DRAFT',
        title: input.title ?? null,
        scopeOfWork: input.scopeOfWork ?? null,
        createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
        presentedByTechnicianId: input.presentedByTechnicianId ?? null,
        subtotalCents: headline.totals.subtotalCents,
        discountCents: headline.totals.discountCents,
        taxCents: headline.totals.taxCents,
        totalCents: headline.totals.totalCents,
        estimatedCostCents: headline.totals.costCents,
        depositRequiredCents: input.depositRequiredCents ?? ZERO,
        validUntil: new Date(now.getTime() + (input.validForDays ?? 30) * 86_400_000),
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      },
    });

    for (const [index, { input: option, totals }] of priced.entries()) {
      const createdOption = await tx.quoteOption.create({
        data: {
          quoteId: quote.id,
          name: option.name,
          description: option.description ?? null,
          sortOrder: index,
          isRecommended: option.isRecommended ?? false,
          subtotalCents: totals.subtotalCents,
          totalCents: totals.totalCents,
        },
      });

      await tx.quoteLine.createMany({
        data: totals.lines.map((line, lineIndex) => ({
          quoteId: quote.id,
          quoteOptionId: createdOption.id,
          priceBookItemId: line.priceBookItemId ?? null,
          sortOrder: lineIndex,
          category: line.category,
          description: line.description,
          quantity: line.quantity.toString(),
          unitPriceCents: line.unitPriceCents,
          unitCostCents: line.unitCostCents ?? ZERO,
          discountCents: line.discountCents ?? ZERO,
          isTaxable: line.taxCents > ZERO,
          taxCents: line.taxCents,
          totalCents: line.totalCents,
        })),
      });
    }

    return tx.quote.findUniqueOrThrow({
      where: { id: quote.id },
      include: { options: { orderBy: { sortOrder: 'asc' } }, lines: true },
    });
  });
}

type TxLike = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

async function resolveLines(
  tx: TxLike,
  organizationId: string,
  lines: QuoteLineInput[],
  locationId: string,
  priceTier: string | null,
): Promise<DraftLine[]> {
  const resolved: DraftLine[] = [];

  for (const line of lines) {
    if (line.priceBookItemId) {
      const price = await resolvePrice(tx, organizationId, line.priceBookItemId, {
        locationId,
        priceTier,
      });
      resolved.push({
        category: line.category ?? price.category,
        description: line.description ?? price.name,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents ?? price.priceCents,
        unitCostCents: line.unitCostCents ?? price.costCents,
        discountCents: line.discountCents,
        isTaxExempt: price.isTaxExempt,
        priceBookItemId: price.priceBookItemId,
        serviceTypeId: price.serviceTypeId,
      });
      continue;
    }

    if (!line.description || line.unitPriceCents === undefined) {
      throw new ValidationError(
        'A quote line needs either a price book item, or a description and a unit price',
      );
    }
    resolved.push({
      category: line.category ?? 'MATERIAL',
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      unitCostCents: line.unitCostCents,
      discountCents: line.discountCents,
    });
  }

  return resolved;
}

export async function sendQuote(
  db: PrismaClient,
  ctx: AuthContext,
  quoteId: string,
  options: { at?: Date } = {},
) {
  requirePermission(ctx, PERMISSIONS.QUOTE_WRITE);

  const quote = await db.quote.findFirst({
    where: { id: quoteId, organizationId: ctx.organizationId },
    select: { id: true, status: true, quoteNo: true, locationId: true },
  });
  if (!quote) throw new NotFoundError('Quote', quoteId);
  requireLocation(ctx, quote.locationId);

  if (quote.status !== 'DRAFT') {
    throw new ValidationError(`Quote ${quote.quoteNo} is ${quote.status} and cannot be sent again`);
  }

  return db.quote.update({
    where: { id: quoteId },
    data: { status: 'SENT', sentAt: options.at ?? new Date() },
  });
}

export interface ApproveQuoteInput {
  quoteOptionId?: string;
  signerName: string;
  signerRole?: string;
  signatureStorageKey: string;
  ipAddress?: string;
  deviceInfo?: string;
  /**
   * When the customer signed. Defaults to now.
   *
   * Expiry is judged against this rather than against today, because a quote accepted in
   * March was not expired in March — and a backdated import or seed that compared it to
   * the present would refuse every acceptance older than the validity window.
   */
  approvedAt?: Date;
}

/**
 * Customer acceptance.
 *
 * The selected option's figures become the quote's figures, and the signature records who
 * agreed to what, when, and from where. That record is the difference between a payment
 * dispute you win and one you do not.
 */
export async function approveQuote(
  db: PrismaClient,
  ctx: AuthContext,
  quoteId: string,
  input: ApproveQuoteInput,
) {
  requirePermission(ctx, PERMISSIONS.QUOTE_APPROVE);

  return db.$transaction(async (tx) => {
    const quote = await tx.quote.findFirst({
      where: { id: quoteId, organizationId: ctx.organizationId },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!quote) throw new NotFoundError('Quote', quoteId);
    requireLocation(ctx, quote.locationId);

    if (quote.status === 'APPROVED' || quote.status === 'CONVERTED') {
      throw new ValidationError(`Quote ${quote.quoteNo} has already been approved`);
    }
    if (quote.status === 'DECLINED' || quote.status === 'EXPIRED') {
      throw new ValidationError(`Quote ${quote.quoteNo} is ${quote.status}`);
    }
    const decidedAt = input.approvedAt ?? new Date();
    if (quote.validUntil && quote.validUntil < decidedAt) {
      throw new ValidationError(
        `Quote ${quote.quoteNo} expired on ${quote.validUntil.toISOString().slice(0, 10)}`,
      );
    }

    const selected = input.quoteOptionId
      ? quote.options.find((o) => o.id === input.quoteOptionId)
      : (quote.options.find((o) => o.isRecommended) ?? quote.options[0]);
    if (!selected) throw new ValidationError('That option does not belong to this quote');

    const signature = await tx.signature.create({
      data: {
        kind: 'QUOTE_APPROVAL',
        signerName: input.signerName,
        signerRole: input.signerRole ?? null,
        storageKey: input.signatureStorageKey,
        signedAt: decidedAt,
        ipAddress: input.ipAddress ?? null,
        deviceInfo: input.deviceInfo ?? null,
      },
    });

    await tx.quoteOption.updateMany({ where: { quoteId }, data: { isSelected: false } });
    await tx.quoteOption.update({ where: { id: selected.id }, data: { isSelected: true } });

    // The chosen option's numbers become the quote's numbers.
    const lines = await tx.quoteLine.findMany({ where: { quoteOptionId: selected.id } });
    const taxCents = lines.reduce((t, l) => t + l.taxCents, ZERO);
    const discountCents = lines.reduce((t, l) => t + l.discountCents, ZERO);
    const costCents = lines.reduce(
      (t, l) => t + (l.unitCostCents * BigInt(Math.round(Number(l.quantity) * 1000))) / 1000n,
      ZERO,
    );

    return tx.quote.update({
      where: { id: quoteId },
      data: {
        status: 'APPROVED',
        approvedAt: decidedAt,
        signatureId: signature.id,
        subtotalCents: selected.subtotalCents,
        discountCents,
        taxCents,
        totalCents: selected.totalCents,
        estimatedCostCents: costCents,
      },
      include: { options: true },
    });
  });
}

export async function declineQuote(
  db: PrismaClient,
  ctx: AuthContext,
  quoteId: string,
  reason: string,
  options: { at?: Date } = {},
) {
  requirePermission(ctx, PERMISSIONS.QUOTE_WRITE);

  const quote = await db.quote.findFirst({
    where: { id: quoteId, organizationId: ctx.organizationId },
    select: { id: true, locationId: true },
  });
  if (!quote) throw new NotFoundError('Quote', quoteId);
  requireLocation(ctx, quote.locationId);

  return db.quote.update({
    where: { id: quoteId },
    data: { status: 'DECLINED', declinedAt: options.at ?? new Date(), declineReason: reason },
  });
}

/**
 * Turn an approved quote into a job, copying the selected option's lines across.
 *
 * The lines are copied rather than referenced: from here on the job records what is
 * actually done, which will diverge from what was quoted the moment anything changes on
 * site. Keeping both is what makes quoted-versus-actual margin answerable.
 */
export async function convertQuoteToJob(
  db: PrismaClient,
  ctx: AuthContext,
  quoteId: string,
  options: { scheduledStart?: Date; scheduledEnd?: Date; serviceTypeId?: string } = {},
) {
  requirePermission(ctx, PERMISSIONS.JOB_WRITE);

  const quote = await db.quote.findFirst({
    where: { id: quoteId, organizationId: ctx.organizationId },
    include: { options: true },
  });
  if (!quote) throw new NotFoundError('Quote', quoteId);
  requireLocation(ctx, quote.locationId);

  // Checked before the status test so a second conversion attempt says what actually
  // happened, rather than the less useful "is CONVERTED".
  if (quote.jobId) {
    throw new ValidationError(
      `Quote ${quote.quoteNo} has already been converted to a job`,
    );
  }
  if (quote.status !== 'APPROVED') {
    throw new ValidationError(
      `Quote ${quote.quoteNo} is ${quote.status}; only an approved quote becomes a job`,
    );
  }

  const selected = quote.options.find((o) => o.isSelected);
  if (!selected) throw new ValidationError('No option was selected on this quote');

  const job = await createJob(db, ctx, {
    locationId: quote.locationId,
    customerId: quote.customerId,
    propertyId: quote.propertyId,
    title: quote.title ?? `Work from quote ${quote.quoteNo}`,
    description: quote.scopeOfWork ?? undefined,
    serviceTypeId: options.serviceTypeId,
    scheduledStart: options.scheduledStart,
    scheduledEnd: options.scheduledEnd,
    sourceQuoteId: quote.id,
  });

  return db.$transaction(async (tx) => {
    const quoteLines = await tx.quoteLine.findMany({
      where: { quoteOptionId: selected.id },
      orderBy: { sortOrder: 'asc' },
    });

    await tx.jobLine.createMany({
      data: quoteLines.map((l, index) => ({
        jobId: job.id,
        priceBookItemId: l.priceBookItemId,
        sortOrder: index,
        category: l.category,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        unitCostCents: l.unitCostCents,
        discountCents: l.discountCents,
        isTaxable: l.isTaxable,
        totalCents: l.totalCents - l.taxCents,
      })),
    });

    await tx.quote.update({
      where: { id: quoteId },
      data: { status: 'CONVERTED', jobId: job.id },
    });

    return tx.job.findUniqueOrThrow({
      where: { id: job.id },
      include: { lines: { orderBy: { sortOrder: 'asc' } } },
    });
  });
}

export interface QuotePipeline {
  openCount: number;
  openCents: Cents;
  /** Of the quotes decided in the window, the share that were accepted. */
  closeRatePercent: number;
  decidedCount: number;
  wonCount: number;
  wonCents: Cents;
  averageQuoteCents: Cents;
  /** Presented on site by a technician rather than raised in the office. */
  fromTheFieldCount: number;
}

/**
 * The pipeline.
 *
 * Close rate is measured against quotes that were actually decided — accepted or declined
 * — rather than against everything ever sent. Counting the undecided as losses makes the
 * number sink a little every week whatever anybody does, which is how a metric stops being
 * watched.
 */
export async function quotePipeline(
  db: PrismaClient,
  ctx: AuthContext,
  period: { from: Date; to: Date },
): Promise<QuotePipeline> {
  requirePermission(ctx, PERMISSIONS.QUOTE_READ);

  const quotes = await db.quote.findMany({
    where: {
      organizationId: ctx.organizationId,
      createdAt: { gte: period.from, lte: period.to },
      ...(ctx.scope !== 'ALL' && ctx.locationIds.length
        ? { locationId: { in: ctx.locationIds } }
        : {}),
    },
    select: {
      status: true,
      totalCents: true,
      presentedByTechnicianId: true,
    },
  });

  const open = quotes.filter((q) => q.status === 'DRAFT' || q.status === 'SENT');
  const won = quotes.filter((q) => q.status === 'APPROVED' || q.status === 'CONVERTED');
  const lost = quotes.filter((q) => q.status === 'DECLINED' || q.status === 'EXPIRED');
  const decided = won.length + lost.length;

  const total = quotes.reduce((sum, q) => sum + q.totalCents, ZERO);

  return {
    openCount: open.length,
    openCents: open.reduce((sum, q) => sum + q.totalCents, ZERO),
    closeRatePercent: decided === 0 ? 0 : Math.round((won.length / decided) * 1000) / 10,
    decidedCount: decided,
    wonCount: won.length,
    wonCents: won.reduce((sum, q) => sum + q.totalCents, ZERO),
    averageQuoteCents: quotes.length === 0 ? ZERO : total / BigInt(quotes.length),
    fromTheFieldCount: quotes.filter((q) => q.presentedByTechnicianId !== null).length,
  };
}
