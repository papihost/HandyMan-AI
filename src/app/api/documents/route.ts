import { db } from '../../../lib/db';
import { revokeShares, sendDocument, type DocumentType } from '../../../lib/documents/delivery';
import { errorResponse, jsonResponse } from '../../../server/json';
import { requireContext } from '../../../server/session';
import { ValidationError } from '../../../lib/errors';

/** Sending a document to the customer, and killing a link that went to the wrong place. */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    const body = (await request.json()) as Record<string, unknown>;

    const type = String(body.type ?? '').toUpperCase();
    if (type !== 'INVOICE' && type !== 'QUOTE') throw new ValidationError('Send what?');
    const documentId = typeof body.documentId === 'string' ? body.documentId : '';
    if (!documentId) throw new ValidationError('Which one?');

    if (body.action === 'revoke') {
      return jsonResponse(await revokeShares(db, ctx, type as DocumentType, documentId));
    }

    const result = await sendDocument(db, ctx, {
      type: type as DocumentType,
      documentId,
      to: typeof body.to === 'string' && body.to.trim() ? body.to.trim() : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    });

    return jsonResponse({
      to: result.to,
      subject: result.subject,
      path: result.path,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
