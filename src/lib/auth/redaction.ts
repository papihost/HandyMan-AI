import type { AuthContext } from './context';

/**
 * Field-level redaction.
 *
 * Row-level scoping decides which records a caller may see. This decides which *columns*
 * come back. A technician building a quote on a tablet must not receive `unitCostCents`
 * in the JSON payload — not merely be prevented from seeing it in the interface. Anyone
 * can open dev tools.
 *
 * The map is maintained by hand on purpose. Deciding that a field is commercially
 * sensitive is a judgement call, and a reviewer should see it change in a diff.
 */

/** Fields readable only with `finance:read_cost`. */
export const COST_FIELDS: Record<string, readonly string[]> = {
  PriceBookItem: ['costCents', 'markupPercent'],
  PriceBookKitComponent: [],
  Quote: ['estimatedCostCents'],
  QuoteLine: ['unitCostCents'],
  Job: ['laborCostCents', 'materialCostCents', 'subCostCents', 'otherCostCents'],
  JobLine: ['unitCostCents'],
  ChangeOrder: ['costCents'],
  InvoiceLine: ['unitCostCents'],
  StockLevel: ['avgCostCents'],
  InventoryTransaction: ['unitCostCents', 'totalCostCents'],
  CycleCount: ['varianceCents'],
  CycleCountLine: ['unitCostCents', 'varianceCents'],
  PurchaseOrder: ['subtotalCents', 'taxCents', 'shippingCents', 'totalCents'],
  PurchaseOrderLine: ['unitCostCents', 'totalCents'],
  VendorBill: ['subtotalCents', 'taxCents', 'totalCents', 'paidCents'],
  VendorBillLine: ['unitCostCents', 'totalCents'],
  TimeEntry: ['loadedHourlyCents', 'costCents'],
  Technician: [],
  TechnicianRate: [
    'baseHourlyCents',
    'payrollTaxRate',
    'workersCompRate',
    'benefitsRate',
    'vehicleMonthlyCents',
    'phoneMonthlyCents',
    'loadedHourlyCents',
    'commissionRate',
  ],
};

/**
 * Derived profitability fields, gated separately. Someone may be trusted with part cost
 * (a warehouse manager) without being trusted with company margin.
 */
export const MARGIN_FIELDS: Record<string, readonly string[]> = {
  Job: ['grossMarginCents', 'grossMarginPercent'],
  Invoice: ['grossMarginCents', 'grossMarginPercent'],
  Quote: ['grossMarginCents', 'grossMarginPercent'],
};

const REDACTED_MODELS = new Set([...Object.keys(COST_FIELDS), ...Object.keys(MARGIN_FIELDS)]);

export function modelIsRedacted(model: string): boolean {
  return REDACTED_MODELS.has(model);
}

/** Which fields must be stripped from `model` for this caller. Empty means nothing. */
export function redactedFieldsFor(model: string, ctx: AuthContext): string[] {
  const fields: string[] = [];
  if (!ctx.canReadCost) fields.push(...(COST_FIELDS[model] ?? []));
  if (!ctx.canReadMargin) fields.push(...(MARGIN_FIELDS[model] ?? []));
  return fields;
}

/**
 * Delete sensitive keys from a result object in place of returning a copy with them set
 * to null — a null cost is still a signal, and `"unitCostCents": null` invites a client
 * to render a zero. The field simply is not there.
 */
export function redactRecord<T>(model: string, record: T, ctx: AuthContext): T {
  if (record === null || typeof record !== 'object') return record;
  const fields = redactedFieldsFor(model, ctx);
  if (fields.length === 0) return record;

  const clone: Record<string, unknown> = { ...(record as Record<string, unknown>) };
  for (const field of fields) delete clone[field];
  return clone as T;
}

export function redactMany<T>(model: string, records: T[], ctx: AuthContext): T[] {
  const fields = redactedFieldsFor(model, ctx);
  if (fields.length === 0) return records;
  return records.map((r) => redactRecord(model, r, ctx));
}

/**
 * Build a Prisma `select`/`omit` fragment so redacted columns are never fetched at all.
 * Cheaper than stripping afterwards, and it keeps sensitive values out of query logs.
 */
export function omitForContext(model: string, ctx: AuthContext): Record<string, true> | undefined {
  const fields = redactedFieldsFor(model, ctx);
  if (fields.length === 0) return undefined;
  return Object.fromEntries(fields.map((f) => [f, true as const]));
}
