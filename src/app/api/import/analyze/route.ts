import { db } from '../../../../lib/db';
import { requirePermission } from '../../../../lib/auth/context';
import { PERMISSIONS } from '../../../../lib/auth/permissions';
import { validateImport } from '../../../../lib/import/runner';
import { RECONCILING_FIELD } from '../../../../lib/import/rows';
import { ENTITY_FIELDS, ENTITY_LABELS } from '../../../../lib/import/schema';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { prepareImport, readWizardRequest } from '../../../../server/import';
import { requireContext } from '../../../../server/session';

const PREVIEW_ROWS = 12;

/**
 * Detect, map and validate — the three things the review screen shows at once.
 *
 * Called again on every change to the mapping, so the issue list and the preview always
 * describe the mapping currently on screen. A wizard that validates once, at the start,
 * teaches an operator to distrust it the first time they fix a column and the errors do
 * not move.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();
    requirePermission(ctx, PERMISSIONS.IMPORT_RUN);

    const wizard = readWizardRequest(await request.json());
    const { parsed, mapping, delimiter, headerRow } = prepareImport(wizard);
    const validation = validateImport(wizard.entity, parsed, mapping);

    const preview = parsed.rows.slice(0, PREVIEW_ROWS);

    // Which fields exist at all, so the operator can reassign a column by hand without
    // the client shipping its own copy of the schema.
    const fields = ENTITY_FIELDS[wizard.entity].map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required ?? false,
      help: field.help ?? null,
      enumValues: field.enumValues ?? null,
    }));

    // Counted here rather than in the browser: the database already knows whether this
    // entity has been loaded before, which is the difference between "import" and
    // "import again over the top of what is there".
    const existing = await existingCount(ctx.organizationId, wizard.entity);

    return jsonResponse({
      entityLabel: ENTITY_LABELS[wizard.entity],
      delimiter,
      headerRow,
      header: parsed.header,
      totalRows: parsed.totalRows,
      raggedRows: parsed.raggedRows,
      headerOffset: parsed.headerOffset,
      preview,
      mapping,
      fields,
      validation,
      existing,
      // Whether this entity carries a money total at all. A customer list does not, and a
      // reconciliation panel reading 0.00 against 0.00 and declaring itself satisfied
      // teaches an operator to stop reading the one that matters.
      reconciles: RECONCILING_FIELD[wizard.entity] !== undefined,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function existingCount(organizationId: string, entity: string): Promise<number> {
  const where = { organizationId };
  switch (entity) {
    case 'CUSTOMER':
      return db.customer.count({ where });
    case 'PRICE_BOOK_ITEM':
      return db.priceBookItem.count({ where });
    case 'CHART_OF_ACCOUNTS':
      return db.account.count({ where });
    case 'OPEN_INVOICE':
      return db.invoice.count({ where });
    default:
      return 0;
  }
}
