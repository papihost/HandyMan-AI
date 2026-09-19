import { ValidationError } from '../lib/errors';
import { detectDelimiter, detectHeaderRow, parseFile, type ParsedFile } from '../lib/import/csv';
import { applyOverrides, proposeMapping, type MappingProposal } from '../lib/import/mapping';
import { ENTITY_LABELS, type ImportEntity } from '../lib/import/schema';
import type { DateOrder } from '../lib/import/coerce';

/**
 * Turning a wizard request back into the two things the engine takes.
 *
 * The wizard keeps the uploaded file in the browser and sends it with every step rather
 * than staging it server-side, so an abandoned migration leaves nothing behind and there
 * is no half-finished upload to clean up or expire. Re-parsing a few thousand rows costs
 * less than the round trip that carried them.
 *
 * Detection is redone on each call unless the caller states a delimiter or header row,
 * which is what happens once they have corrected a guess: the correction has to survive
 * every subsequent step, or the mapping screen silently un-fixes itself.
 */

/** Big enough for any export a handyman company has; small enough not to be a weapon. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export interface WizardRequest {
  entity: ImportEntity;
  text: string;
  delimiter?: string;
  headerRow?: number;
  overrides?: Record<string, number | null>;
  dateOrder?: DateOrder;
  decimalSeparator?: '.' | ',';
}

export interface PreparedImport {
  parsed: ParsedFile;
  mapping: MappingProposal;
  delimiter: string;
  headerRow: number;
}

const ENTITIES = new Set<string>(Object.keys(ENTITY_LABELS));

export function readWizardRequest(body: unknown): WizardRequest {
  const value = (body ?? {}) as Record<string, unknown>;

  const entity = String(value.entity ?? '');
  if (!ENTITIES.has(entity)) throw new ValidationError('Choose what this file holds');

  const text = typeof value.text === 'string' ? value.text : '';
  if (text.trim().length === 0) throw new ValidationError('That file is empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_UPLOAD_BYTES) {
    throw new ValidationError(
      `That file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB. Split it and import the parts — each one reconciles on its own.`,
    );
  }

  const headerRow =
    typeof value.headerRow === 'number' && Number.isInteger(value.headerRow) && value.headerRow >= 0
      ? value.headerRow
      : undefined;

  return {
    entity: entity as ImportEntity,
    text,
    delimiter: typeof value.delimiter === 'string' && value.delimiter.length === 1
      ? value.delimiter
      : undefined,
    headerRow,
    overrides: isOverrides(value.overrides) ? value.overrides : undefined,
    dateOrder:
      value.dateOrder === 'DMY' || value.dateOrder === 'MDY' || value.dateOrder === 'YMD'
        ? value.dateOrder
        : undefined,
    decimalSeparator: value.decimalSeparator === ',' ? ',' : value.decimalSeparator === '.' ? '.' : undefined,
  };
}

function isOverrides(value: unknown): value is Record<string, number | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => v === null || Number.isInteger(v));
}

export function prepareImport(request: WizardRequest): PreparedImport {
  const delimiter = request.delimiter ?? detectDelimiter(request.text);
  const headerRow = request.headerRow ?? detectHeaderRow(request.text, delimiter);
  const parsed = parseFile(request.text, { delimiter, skipRows: headerRow });

  if (parsed.header.length === 0) {
    throw new ValidationError('No column headings were found — check which row the headings are on');
  }

  let mapping = proposeMapping(request.entity, parsed.header, parsed.rows);
  if (request.overrides) mapping = applyOverrides(mapping, request.overrides);

  // A stated date order or decimal separator is the operator overruling the detector,
  // which they do when a file of 01/02/2026 dates is British and the sample could not
  // prove it. Their answer wins, and the ambiguity flag goes with it.
  if (request.dateOrder) {
    mapping = { ...mapping, dateOrder: request.dateOrder, dateOrderAmbiguous: false };
  }
  if (request.decimalSeparator) {
    mapping = { ...mapping, decimalSeparator: request.decimalSeparator };
  }

  return { parsed, mapping, delimiter, headerRow };
}
