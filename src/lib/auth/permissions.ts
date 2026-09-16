/**
 * Capabilities are strings of the form `domain:action`. Roles are bags of capabilities,
 * stored per organization so a customer can build their own roles without a code change.
 *
 * Two capabilities are load-bearing beyond ordinary access control:
 *
 *   finance:read_cost   — may see item cost, labor cost, and anything derived from them
 *   finance:read_margin — may see margin and profitability
 *
 * These drive the redaction layer in `redaction.ts`. A dispatcher or technician quoting
 * work must never receive cost in an API payload, not merely be prevented from seeing a
 * column in the UI.
 */

export const PERMISSIONS = {
  // --- CRM -----------------------------------------------------------------
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_WRITE: 'customer:write',
  CUSTOMER_DELETE: 'customer:delete',

  // --- Sales ---------------------------------------------------------------
  QUOTE_READ: 'quote:read',
  QUOTE_WRITE: 'quote:write',
  QUOTE_APPROVE: 'quote:approve',

  // --- Jobs & dispatch -----------------------------------------------------
  JOB_READ: 'job:read',
  JOB_WRITE: 'job:write',
  JOB_DISPATCH: 'job:dispatch',
  JOB_CLOSE: 'job:close',
  CHANGE_ORDER_WRITE: 'change_order:write',

  // --- Field ---------------------------------------------------------------
  FIELD_APP: 'field:app',
  TIME_SELF: 'time:self',
  TIME_APPROVE: 'time:approve',

  // --- Price book ----------------------------------------------------------
  PRICEBOOK_READ: 'pricebook:read',
  PRICEBOOK_WRITE: 'pricebook:write',

  // --- Inventory -----------------------------------------------------------
  INVENTORY_READ: 'inventory:read',
  INVENTORY_TRANSFER: 'inventory:transfer',
  INVENTORY_ADJUST: 'inventory:adjust',
  INVENTORY_COUNT: 'inventory:count',

  // --- Purchasing & AP -----------------------------------------------------
  PO_READ: 'po:read',
  PO_WRITE: 'po:write',
  PO_APPROVE: 'po:approve',
  BILL_READ: 'bill:read',
  BILL_WRITE: 'bill:write',
  BILL_PAY: 'bill:pay',
  VENDOR_WRITE: 'vendor:write',

  // --- Invoicing & AR ------------------------------------------------------
  INVOICE_READ: 'invoice:read',
  INVOICE_WRITE: 'invoice:write',
  INVOICE_VOID: 'invoice:void',
  INVOICE_WRITE_OFF: 'invoice:write_off',
  PAYMENT_READ: 'payment:read',
  PAYMENT_RECORD: 'payment:record',
  PAYMENT_REFUND: 'payment:refund',

  // --- General ledger ------------------------------------------------------
  GL_READ: 'gl:read',
  GL_POST: 'gl:post',
  GL_REVERSE: 'gl:reverse',
  COA_MANAGE: 'coa:manage',
  PERIOD_CLOSE: 'period:close',
  PERIOD_REOPEN: 'period:reopen',
  BANK_RECONCILE: 'bank:reconcile',
  TAX_MANAGE: 'tax:manage',

  // --- Cost & margin visibility (the redaction switches) -------------------
  FINANCE_READ_COST: 'finance:read_cost',
  FINANCE_READ_MARGIN: 'finance:read_margin',

  // --- Payroll -------------------------------------------------------------
  PAYROLL_READ: 'payroll:read',
  PAYROLL_MANAGE: 'payroll:manage',

  // --- Reporting -----------------------------------------------------------
  REPORT_FINANCIAL: 'report:financial',
  REPORT_OPERATIONAL: 'report:operational',

  // --- Administration ------------------------------------------------------
  USER_MANAGE: 'user:manage',
  ROLE_MANAGE: 'role:manage',
  LOCATION_MANAGE: 'location:manage',
  ORG_MANAGE: 'org:manage',
  IMPORT_RUN: 'import:run',
  AUDIT_READ: 'audit:read',
  DEMO_RESET: 'demo:reset',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/**
 * How wide a user's view of jobs and customers is. Computed from role, not stored,
 * so it cannot drift out of sync with the role definition.
 */
export type AccessScope = 'ALL' | 'LOCATION' | 'SELF';
