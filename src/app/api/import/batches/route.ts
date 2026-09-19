import { db } from '../../../../lib/db';
import { requirePermission } from '../../../../lib/auth/context';
import { PERMISSIONS } from '../../../../lib/auth/permissions';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { requireContext } from '../../../../server/session';

/** What has been loaded so far, newest first — the migration's own audit trail. */
export async function GET() {
  try {
    const ctx = await requireContext();
    requirePermission(ctx, PERMISSIONS.IMPORT_RUN);

    const batches = await db.importBatch.findMany({
      // Rehearsals are recorded — the engine writes a batch for every dry run, and the
      // audit log keeps them — but they are not listed here. This panel answers "what is
      // in the system", and a run that wrote nothing is not an answer to that.
      where: { organizationId: ctx.organizationId, status: { not: 'DRY_RUN' } },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        name: true,
        entityType: true,
        sourceSystem: true,
        status: true,
        fileName: true,
        totalRows: true,
        importedRows: true,
        skippedRows: true,
        errorRows: true,
        sourceTotalCents: true,
        importedTotalCents: true,
        isBalanced: true,
        createdAt: true,
        completedAt: true,
        rolledBackAt: true,
      },
    });

    return jsonResponse({ batches });
  } catch (error) {
    return errorResponse(error);
  }
}
