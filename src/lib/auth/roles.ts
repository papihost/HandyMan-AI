import { ALL_PERMISSIONS, PERMISSIONS as P, type AccessScope, type Permission } from './permissions';

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  /** Job/customer visibility: everything, their assigned locations, or only their own work. */
  scope: AccessScope;
  permissions: Permission[];
}

/** Permissions every signed-in user has, whatever their role. */
const BASE: Permission[] = [P.CUSTOMER_READ, P.JOB_READ];

/** Read-only operational access without any cost or margin visibility. */
const FIELD_OPS: Permission[] = [
  ...BASE,
  P.CUSTOMER_WRITE,
  P.QUOTE_READ,
  P.QUOTE_WRITE,
  P.JOB_WRITE,
  P.CHANGE_ORDER_WRITE,
  P.PRICEBOOK_READ,
  P.INVENTORY_READ,
  P.INVOICE_READ,
];

export const SYSTEM_ROLES: RoleDefinition[] = [
  {
    key: 'OWNER',
    name: 'Owner',
    description: 'Unrestricted access to every location and every book.',
    scope: 'ALL',
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'CONTROLLER',
    name: 'Controller',
    description:
      'Full accounting authority: general ledger, period close, bank reconciliation, payroll and all financial reporting.',
    scope: 'ALL',
    permissions: [
      ...FIELD_OPS,
      P.QUOTE_APPROVE,
      P.JOB_DISPATCH,
      P.JOB_CLOSE,
      P.TIME_APPROVE,
      P.PRICEBOOK_WRITE,
      P.INVENTORY_TRANSFER,
      P.INVENTORY_ADJUST,
      P.INVENTORY_COUNT,
      P.PO_READ,
      P.PO_WRITE,
      P.PO_APPROVE,
      P.BILL_READ,
      P.BILL_WRITE,
      P.BILL_PAY,
      P.VENDOR_WRITE,
      P.INVOICE_WRITE,
      P.INVOICE_VOID,
      P.INVOICE_WRITE_OFF,
      P.PAYMENT_READ,
      P.PAYMENT_RECORD,
      P.PAYMENT_REFUND,
      P.GL_READ,
      P.GL_POST,
      P.GL_REVERSE,
      P.COA_MANAGE,
      P.PERIOD_CLOSE,
      P.PERIOD_REOPEN,
      P.BANK_RECONCILE,
      P.TAX_MANAGE,
      P.FINANCE_READ_COST,
      P.FINANCE_READ_MARGIN,
      P.PAYROLL_READ,
      P.PAYROLL_MANAGE,
      P.REPORT_FINANCIAL,
      P.REPORT_OPERATIONAL,
      P.IMPORT_RUN,
      P.AUDIT_READ,
    ],
  },
  {
    key: 'BOOKKEEPER',
    name: 'Bookkeeper',
    description:
      'Day-to-day AP and AR entry. Cannot close periods, edit the chart of accounts, reverse entries, or see payroll.',
    scope: 'ALL',
    permissions: [
      ...FIELD_OPS,
      P.PO_READ,
      P.PO_WRITE,
      P.BILL_READ,
      P.BILL_WRITE,
      P.BILL_PAY,
      P.VENDOR_WRITE,
      P.INVOICE_WRITE,
      P.PAYMENT_READ,
      P.PAYMENT_RECORD,
      P.GL_READ,
      P.BANK_RECONCILE,
      P.FINANCE_READ_COST,
      P.REPORT_FINANCIAL,
    ],
  },
  {
    key: 'BRANCH_MANAGER',
    name: 'Branch Manager',
    description:
      'Runs one or more branches: scheduling, jobs, people, and the margin on their own work. No general ledger access.',
    scope: 'LOCATION',
    permissions: [
      ...FIELD_OPS,
      P.CUSTOMER_DELETE,
      P.QUOTE_APPROVE,
      P.JOB_DISPATCH,
      P.JOB_CLOSE,
      P.TIME_APPROVE,
      P.PRICEBOOK_READ,
      P.INVENTORY_TRANSFER,
      P.INVENTORY_COUNT,
      P.PO_READ,
      P.PO_WRITE,
      P.INVOICE_WRITE,
      P.PAYMENT_READ,
      P.PAYMENT_RECORD,
      P.FINANCE_READ_COST,
      P.FINANCE_READ_MARGIN,
      P.REPORT_OPERATIONAL,
    ],
  },
  {
    key: 'DISPATCHER',
    name: 'Dispatcher / CSR',
    description:
      'Books and dispatches work and quotes at sell price. Never sees cost, margin, or the ledger.',
    scope: 'LOCATION',
    permissions: [...FIELD_OPS, P.JOB_DISPATCH, P.PAYMENT_RECORD, P.QUOTE_APPROVE],
  },
  {
    key: 'TECHNICIAN',
    name: 'Technician',
    description:
      'Field app. Sees only their own assigned work, and the price book at sell price only.',
    scope: 'SELF',
    permissions: [
      ...BASE,
      P.FIELD_APP,
      P.TIME_SELF,
      P.QUOTE_READ,
      P.QUOTE_WRITE,
      P.JOB_WRITE,
      P.CHANGE_ORDER_WRITE,
      P.PRICEBOOK_READ,
      P.INVENTORY_READ,
      P.INVENTORY_TRANSFER,
      P.PAYMENT_RECORD,
    ],
  },
  {
    key: 'SUBCONTRACTOR',
    name: 'Subcontractor',
    description: 'Field app, restricted to the jobs explicitly assigned to them.',
    scope: 'SELF',
    permissions: [...BASE, P.FIELD_APP, P.TIME_SELF, P.JOB_WRITE, P.CHANGE_ORDER_WRITE],
  },
  {
    key: 'CUSTOMER',
    name: 'Customer Portal',
    description: 'Approve quotes, view appointments and photos, pay invoices.',
    scope: 'SELF',
    permissions: [P.QUOTE_READ, P.QUOTE_APPROVE, P.INVOICE_READ, P.PAYMENT_RECORD],
  },
];

export const SYSTEM_ROLE_BY_KEY = new Map(SYSTEM_ROLES.map((r) => [r.key, r]));

/** Widest scope wins when a user holds several roles. */
const SCOPE_RANK: Record<AccessScope, number> = { SELF: 0, LOCATION: 1, ALL: 2 };

export function widestScope(scopes: AccessScope[]): AccessScope {
  return scopes.reduce<AccessScope>(
    (widest, s) => (SCOPE_RANK[s] > SCOPE_RANK[widest] ? s : widest),
    'SELF',
  );
}
