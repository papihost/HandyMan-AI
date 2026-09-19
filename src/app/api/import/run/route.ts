import { db } from '../../../../lib/db';
import { runImport } from '../../../../lib/import/runner';
import { errorResponse, jsonResponse } from '../../../../server/json';
import { prepareImport, readWizardRequest } from '../../../../server/import';
import { requireContext } from '../../../../server/session';
import { ValidationError } from '../../../../lib/errors';

/**
 * The dry run and the commit are the same call with one flag different.
 *
 * Deliberately: if the rehearsal took a different path from the performance, it would not
 * be a rehearsal. The dry run executes every write inside a transaction that is then
 * rolled back, so the counts, the errors and the ledger impact it reports are the real
 * ones — which is the only reason an office manager should believe them.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireContext();

    const body = (await request.json()) as Record<string, unknown>;
    const wizard = readWizardRequest(body);
    const { parsed, mapping } = prepareImport(wizard);

    const dryRun = body.dryRun !== false;

    const cutoverDate = readDate(body.cutoverDate);
    const declared = readMoney(body.declaredTotalCents);

    const result = await runImport(
      db,
      ctx,
      {
        entity: wizard.entity,
        parsed,
        mapping,
        fileName: typeof body.fileName === 'string' ? body.fileName.slice(0, 200) : undefined,
        sourceSystem: typeof body.sourceSystem === 'string' ? body.sourceSystem : undefined,
        ...(cutoverDate ? { cutoverDate } : {}),
        ...(declared === null ? {} : { declaredTotalCents: declared }),
      },
      { dryRun },
    );

    return jsonResponse(result);
  } catch (error) {
    return errorResponse(error);
  }
}

function readDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  // A date-only string is read as UTC midnight, not as the server's midnight: a cutover
  // posted a day early lands in the wrong period, and the wrong period may be closed.
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError('That cutover date is not a date');
  return parsed;
}

function readMoney(value: unknown): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return BigInt(String(value));
  } catch {
    throw new ValidationError('That declared total is not an amount');
  }
}
