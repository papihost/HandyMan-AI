import {
  ENTITY_FIELDS,
  normalizeHeading,
  type ImportEntity,
  type TargetField,
} from './schema';
import { detectDateOrder, detectDecimalSeparator, type DateOrder } from './coerce';

/**
 * Proposing a column mapping.
 *
 * The office manager confirms it; they should not have to build it. Matching runs on the
 * heading first — an exact alias, then a normalised equality, then containment, then a
 * token overlap — and falls back to the shape of the data when the heading says nothing
 * useful, which is how a column called "Field7" full of currency still finds `amount`.
 *
 * Every proposal carries its confidence and the reason it was made, so the wizard can show
 * the uncertain ones for review instead of presenting thirty guesses as equally solid.
 */

export interface ColumnProposal {
  column: string;
  columnIndex: number;
  fieldKey: string | null;
  confidence: number;
  reason: string;
  alternatives: { fieldKey: string; confidence: number }[];
}

export interface MappingProposal {
  entity: ImportEntity;
  columns: ColumnProposal[];
  /** Field key → column index, for the columns that were matched. */
  fieldMap: Record<string, number>;
  missingRequired: string[];
  /** Column indexes nothing claimed. Usually harmless, occasionally the point. */
  unmapped: number[];
  dateOrder: DateOrder;
  dateOrderAmbiguous: boolean;
  decimalSeparator: '.' | ',';
}

const MIN_CONFIDENCE = 0.45;

export function proposeMapping(
  entity: ImportEntity,
  header: readonly string[],
  rows: readonly (readonly string[])[],
): MappingProposal {
  const fields = ENTITY_FIELDS[entity];
  const sample = rows.slice(0, 50);

  // Score every column against every field, then assign best-first so a strong match
  // cannot be stolen by a weaker one that happened to be considered earlier.
  const scores: { columnIndex: number; field: TargetField; score: number; reason: string }[] = [];

  for (const [columnIndex, heading] of header.entries()) {
    const values = sample.map((row) => row[columnIndex] ?? '');
    for (const field of fields) {
      const { score, reason } = scoreColumn(heading, values, field);
      if (score > 0) scores.push({ columnIndex, field, score, reason });
    }
  }

  scores.sort((a, b) => b.score - a.score);

  const takenColumns = new Set<number>();
  const takenFields = new Set<string>();
  const chosen = new Map<number, { field: TargetField; score: number; reason: string }>();

  for (const candidate of scores) {
    if (candidate.score < MIN_CONFIDENCE) break;
    if (takenColumns.has(candidate.columnIndex) || takenFields.has(candidate.field.key)) continue;
    takenColumns.add(candidate.columnIndex);
    takenFields.add(candidate.field.key);
    chosen.set(candidate.columnIndex, candidate);
  }

  const columns: ColumnProposal[] = header.map((heading, columnIndex) => {
    const pick = chosen.get(columnIndex);
    const alternatives = scores
      .filter((s) => s.columnIndex === columnIndex && s.field.key !== pick?.field.key)
      .slice(0, 3)
      .map((s) => ({ fieldKey: s.field.key, confidence: round(s.score) }));

    return {
      column: heading,
      columnIndex,
      fieldKey: pick?.field.key ?? null,
      confidence: pick ? round(pick.score) : 0,
      reason: pick?.reason ?? 'no confident match',
      alternatives,
    };
  });

  const fieldMap: Record<string, number> = {};
  for (const [columnIndex, pick] of chosen) fieldMap[pick.field.key] = columnIndex;

  const dateColumns = fields
    .filter((f) => f.type === 'date' && fieldMap[f.key] !== undefined)
    .map((f) => fieldMap[f.key]);
  const moneyColumns = fields
    .filter((f) => f.type === 'money' && fieldMap[f.key] !== undefined)
    .map((f) => fieldMap[f.key]);

  const dateSamples = sample.flatMap((row) => dateColumns.map((i) => row[i] ?? ''));
  const moneySamples = sample.flatMap((row) => moneyColumns.map((i) => row[i] ?? ''));
  const dateOrder = detectDateOrder(dateSamples);

  return {
    entity,
    columns,
    fieldMap,
    missingRequired: fields.filter((f) => f.required && fieldMap[f.key] === undefined).map((f) => f.key),
    unmapped: header.map((_, i) => i).filter((i) => !takenColumns.has(i)),
    dateOrder: dateOrder.order,
    dateOrderAmbiguous: dateOrder.ambiguous,
    decimalSeparator: detectDecimalSeparator(moneySamples),
  };
}

function scoreColumn(
  heading: string,
  values: readonly string[],
  field: TargetField,
): { score: number; reason: string } {
  const normalized = normalizeHeading(heading);
  const fieldName = normalizeHeading(field.label);
  const keyName = normalizeHeading(field.key);

  if (!normalized) {
    const shape = scoreByShape(values, field);
    return shape > 0
      ? { score: shape * 0.5, reason: 'column has no heading; matched on the shape of its values' }
      : { score: 0, reason: '' };
  }

  if (field.aliases.some((alias) => normalizeHeading(alias) === normalized)) {
    return { score: 1, reason: `"${heading}" is a known name for this field` };
  }
  if (normalized === fieldName || normalized === keyName) {
    return { score: 0.95, reason: 'heading matches the field name' };
  }

  const alias = field.aliases.find(
    (a) => normalized.includes(normalizeHeading(a)) || normalizeHeading(a).includes(normalized),
  );
  if (alias) {
    return { score: 0.78, reason: `"${heading}" looks like "${alias}"` };
  }

  const overlap = tokenOverlap(normalized, `${fieldName} ${field.aliases.join(' ')}`);
  if (overlap >= 0.5) {
    return { score: 0.5 + overlap * 0.25, reason: 'heading shares wording with this field' };
  }

  // The heading is unhelpful, but the values may not be.
  const shape = scoreByShape(values, field);
  if (shape > 0.8) {
    return { score: 0.55, reason: `values look like ${field.type}` };
  }

  return { score: 0, reason: '' };
}

/** How many of the sampled values look like the field's type. */
function scoreByShape(values: readonly string[], field: TargetField): number {
  const populated = values.filter((v) => v.trim() !== '');
  if (populated.length < 3) return 0;

  const matcher = SHAPE_MATCHERS[field.type];
  if (!matcher) return 0;

  const hits = populated.filter((v) => matcher(v.trim())).length;
  return hits / populated.length;
}

const SHAPE_MATCHERS: Partial<Record<TargetField['type'], (value: string) => boolean>> = {
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  phone: (v) => /^[+(]?[\d\s().-]{7,}$/.test(v) && (v.replace(/\D/g, '').length >= 7),
  money: (v) => /^-?[$€£]?\(?-?[\d,.]+\)?$/.test(v) && /\d/.test(v),
  date: (v) => /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(v) || /^\d{1,2}\s*[A-Za-z]{3,}/.test(v),
  number: (v) => /^-?[\d,]+(\.\d+)?$/.test(v),
  boolean: (v) => /^(yes|no|y|n|true|false|0|1|t|f|x)$/i.test(v),
};

function tokenOverlap(a: string, b: string): number {
  const left = new Set(a.split(' ').filter((t) => t.length > 2));
  const right = new Set(b.split(' ').filter((t) => t.length > 2));
  if (left.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / left.size;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Apply a user's corrections on top of a proposal. */
export function applyOverrides(
  proposal: MappingProposal,
  overrides: Record<string, number | null>,
): MappingProposal {
  const fieldMap = { ...proposal.fieldMap };

  for (const [fieldKey, columnIndex] of Object.entries(overrides)) {
    if (columnIndex === null) {
      delete fieldMap[fieldKey];
      continue;
    }
    // A column can only feed one field, so claiming it releases whoever held it.
    for (const [key, index] of Object.entries(fieldMap)) {
      if (index === columnIndex && key !== fieldKey) delete fieldMap[key];
    }
    fieldMap[fieldKey] = columnIndex;
  }

  const taken = new Set(Object.values(fieldMap));

  return {
    ...proposal,
    fieldMap,
    columns: proposal.columns.map((column) => {
      const fieldKey =
        Object.entries(fieldMap).find(([, index]) => index === column.columnIndex)?.[0] ?? null;
      if (fieldKey === column.fieldKey) return column;
      return { ...column, fieldKey, confidence: fieldKey ? 1 : 0, reason: 'set by hand' };
    }),
    missingRequired: ENTITY_FIELDS[proposal.entity]
      .filter((f) => f.required && fieldMap[f.key] === undefined)
      .map((f) => f.key),
    unmapped: proposal.columns.map((c) => c.columnIndex).filter((i) => !taken.has(i)),
  };
}
