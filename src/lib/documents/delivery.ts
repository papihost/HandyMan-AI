import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { requireLocation, requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { NotFoundError, ValidationError } from '../errors';
import { formatMoney } from '../money';

/**
 * Getting the document to the customer.
 *
 * This product could quote, invoice, cost and reconcile, and had no way to tell the
 * customer any of it. What it needs is not a mail server so much as the two records
 * around one: the link that was sent, and whether anybody opened it. A bill that has been
 * read and not paid is a different conversation from one that never arrived, and the
 * office has no way to tell those apart otherwise.
 *
 * No mail provider is connected in this build. Rather than pretend, the message is queued
 * with the address and the body it would go out with, and the screen says plainly that it
 * is waiting for a transport. When one is wired in, it sends what is already there.
 */

export type DocumentType = 'INVOICE' | 'QUOTE';

const SHARE_TTL_DAYS = 60;

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface DocumentSummary {
  id: string;
  number: string;
  locationId: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  totalCents: bigint;
}

async function loadDocument(
  db: PrismaClient,
  ctx: AuthContext,
  type: DocumentType,
  id: string,
): Promise<DocumentSummary> {
  if (type === 'INVOICE') {
    const invoice = await db.invoice.findFirst({
      where: { id, organizationId: ctx.organizationId },
      select: {
        id: true,
        invoiceNo: true,
        locationId: true,
        customerId: true,
        totalCents: true,
        status: true,
        customer: {
          select: { companyName: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!invoice) throw new NotFoundError('Invoice', id);
    if (invoice.status === 'DRAFT') {
      throw new ValidationError(`Invoice ${invoice.invoiceNo} has not been issued yet`);
    }
    return {
      id: invoice.id,
      number: invoice.invoiceNo,
      locationId: invoice.locationId,
      customerId: invoice.customerId,
      customerName:
        invoice.customer.companyName ??
        [invoice.customer.firstName, invoice.customer.lastName].filter(Boolean).join(' '),
      customerEmail: invoice.customer.email,
      totalCents: invoice.totalCents,
    };
  }

  const quote = await db.quote.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: {
      id: true,
      quoteNo: true,
      locationId: true,
      customerId: true,
      totalCents: true,
      customer: { select: { companyName: true, firstName: true, lastName: true, email: true } },
    },
  });
  if (!quote) throw new NotFoundError('Quote', id);
  return {
    id: quote.id,
    number: quote.quoteNo,
    locationId: quote.locationId,
    customerId: quote.customerId,
    customerName:
      quote.customer.companyName ??
      [quote.customer.firstName, quote.customer.lastName].filter(Boolean).join(' '),
    customerEmail: quote.customer.email,
    totalCents: quote.totalCents,
  };
}

export interface SendDocumentInput {
  type: DocumentType;
  documentId: string;
  /** Defaults to the address on the customer record. */
  to?: string;
  message?: string;
  expiresInDays?: number;
}

/**
 * Send it.
 *
 * One link per send, because the point of a link is that it can be revoked: a bill sent
 * to the wrong address should be killable without breaking the one sent to the right one.
 * The token is returned exactly once, here, and is never readable again.
 */
export async function sendDocument(
  db: PrismaClient,
  ctx: AuthContext,
  input: SendDocumentInput,
) {
  requirePermission(
    ctx,
    input.type === 'INVOICE' ? PERMISSIONS.INVOICE_READ : PERMISSIONS.QUOTE_READ,
  );

  const document = await loadDocument(db, ctx, input.type, input.documentId);
  requireLocation(ctx, document.locationId);

  const to = (input.to ?? document.customerEmail ?? '').trim();
  if (!to) {
    throw new ValidationError(
      `${document.customerName} has no email address on file — add one, or copy the link and send it yourself`,
    );
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    throw new ValidationError(`${to} does not look like an email address`);
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    Date.now() + (input.expiresInDays ?? SHARE_TTL_DAYS) * 86_400_000,
  );

  const share = await db.documentShare.create({
    data: {
      organizationId: ctx.organizationId,
      documentType: input.type,
      documentId: document.id,
      tokenHash: hashShareToken(token),
      expiresAt,
      createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
    },
  });

  const noun = input.type === 'INVOICE' ? 'Invoice' : 'Quote';
  const subject = `${noun} ${document.number} — ${formatMoney(document.totalCents)}`;

  const notification = await db.notification.create({
    data: {
      organizationId: ctx.organizationId,
      channel: 'EMAIL',
      template: input.type === 'INVOICE' ? 'INVOICE_SENT' : 'QUOTE_SENT',
      recipient: to,
      subject,
      body: [
        input.message?.trim(),
        `${noun} ${document.number} for ${formatMoney(document.totalCents)}.`,
        `View it here: /d/${token}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      entityType: input.type,
      entityId: document.id,
      // No transport is connected, so it waits rather than claiming to have gone.
      status: 'QUEUED',
    },
  });

  if (input.type === 'INVOICE') {
    await db.invoice.update({ where: { id: document.id }, data: { sentAt: new Date() } });
  } else {
    const quote = await db.quote.findUniqueOrThrow({
      where: { id: document.id },
      select: { status: true },
    });
    // Sending a draft is what makes it a live quote; sending one again is just another copy.
    if (quote.status === 'DRAFT') {
      const { sendQuote } = await import('../quotes/service');
      await sendQuote(db, ctx, document.id);
    }
  }

  return {
    shareId: share.id,
    notificationId: notification.id,
    to,
    subject,
    /** The only time this is ever returned. */
    path: `/d/${token}`,
    expiresAt,
  };
}

/** Everything the office needs to know about whether this document got there. */
export async function deliveryState(
  db: PrismaClient,
  ctx: AuthContext,
  type: DocumentType,
  documentId: string,
) {
  const [shares, messages] = await Promise.all([
    db.documentShare.findMany({
      where: { organizationId: ctx.organizationId, documentType: type, documentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    db.notification.findMany({
      where: {
        organizationId: ctx.organizationId,
        entityType: type,
        entityId: documentId,
        channel: 'EMAIL',
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const live = shares.filter((share) => !share.revokedAt && share.expiresAt > new Date());
  const viewed = shares.filter((share) => share.viewedAt !== null);

  return {
    sendCount: messages.length,
    lastSentTo: messages[0]?.recipient ?? null,
    lastSentAt: messages[0]?.createdAt ?? null,
    lastStatus: messages[0]?.status ?? null,
    liveLinkCount: live.length,
    viewedAt: viewed[0]?.viewedAt ?? null,
    viewCount: shares.reduce((total, share) => total + share.viewCount, 0),
  };
}

export async function revokeShares(
  db: PrismaClient,
  ctx: AuthContext,
  type: DocumentType,
  documentId: string,
) {
  requirePermission(
    ctx,
    type === 'INVOICE' ? PERMISSIONS.INVOICE_READ : PERMISSIONS.QUOTE_READ,
  );

  const { count } = await db.documentShare.updateMany({
    where: {
      organizationId: ctx.organizationId,
      documentType: type,
      documentId,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  return { revoked: count };
}

/**
 * Open a link.
 *
 * Deliberately not organization-scoped by a caller, because there is no caller — this is
 * a customer with a URL and no account. The token is the whole of the authorization, so
 * it is looked up by hash, checked for expiry and revocation, and nothing else about the
 * request is trusted.
 */
export async function resolveShare(db: PrismaClient, token: string) {
  if (!token || token.length < 16) return null;

  const share = await db.documentShare.findUnique({
    where: { tokenHash: hashShareToken(token) },
  });
  if (!share) return null;
  if (share.revokedAt) return null;
  if (share.expiresAt < new Date()) return null;

  await db.documentShare.update({
    where: { id: share.id },
    data: { viewedAt: share.viewedAt ?? new Date(), viewCount: { increment: 1 } },
  });

  // The document carries the fact too, so the office sees it without going looking.
  if (share.documentType === 'INVOICE') {
    await db.invoice.updateMany({
      where: { id: share.documentId, viewedAt: null },
      data: { viewedAt: new Date() },
    });
  } else {
    await db.quote.updateMany({
      where: { id: share.documentId, viewedAt: null },
      data: { viewedAt: new Date() },
    });
  }

  return share;
}
