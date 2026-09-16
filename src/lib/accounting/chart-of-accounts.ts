import type { AccountSubtype, AccountType } from '@prisma/client';

/**
 * The seeded chart of accounts.
 *
 * Accounts marked `isSystem` are referenced by posting rules, so they may be renamed but
 * never deleted or retyped. Everything else is the customer's to reorganize.
 *
 * Account codes are the stable identifier used by posting rules — see ACCOUNTS below for
 * the named references, so a rule says `ACCOUNTS.AR` rather than a bare "1200".
 */

export interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  isSystem?: boolean;
  description?: string;
}

/** Named references used by the posting rules. */
export const ACCOUNTS = {
  BANK_OPERATING: '1010',
  BANK_PAYROLL: '1020',
  UNDEPOSITED_FUNDS: '1050',
  CARD_CLEARING: '1060',
  AR: '1200',
  INVENTORY_WAREHOUSE: '1300',
  INVENTORY_VAN: '1310',
  WIP: '1350',
  PREPAID: '1400',
  FIXED_ASSETS: '1500',
  ACCUM_DEPRECIATION: '1590',

  AP: '2010',
  CREDIT_CARDS: '2050',
  SALES_TAX_PAYABLE: '2100',
  PAYROLL_LIABILITIES: '2200',
  CUSTOMER_DEPOSITS: '2300',
  DEFERRED_REVENUE: '2350',
  ACCRUED_EXPENSES: '2400',
  ACCRUED_COMMISSIONS: '2410',

  OWNERS_EQUITY: '3010',
  OWNERS_DRAW: '3020',
  RETAINED_EARNINGS: '3100',
  OPENING_BALANCE_EQUITY: '3900',

  REVENUE_LABOR: '4010',
  REVENUE_MATERIALS: '4020',
  REVENUE_AGREEMENTS: '4030',
  REVENUE_FEES: '4040',
  DISCOUNTS: '4900',

  COGS_LABOR: '5010',
  COGS_BURDEN: '5020',
  COGS_MATERIALS: '5030',
  COGS_SUBCONTRACTORS: '5040',
  COGS_EQUIPMENT: '5050',
  COGS_PERMITS: '5060',
  INVENTORY_SHRINKAGE: '5090',

  MERCHANT_FEES: '6300',
  DEPRECIATION: '6500',
  BAD_DEBT: '6900',
} as const;

export type AccountKey = (typeof ACCOUNTS)[keyof typeof ACCOUNTS];

const A = (
  code: string,
  name: string,
  type: AccountType,
  subtype: AccountSubtype,
  isSystem = false,
  description?: string,
): AccountSeed => ({ code, name, type, subtype, isSystem, description });

export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // --- Assets --------------------------------------------------------------
  A('1010', 'Operating Bank Account', 'ASSET', 'BANK', true),
  A('1020', 'Payroll Bank Account', 'ASSET', 'BANK'),
  A('1050', 'Undeposited Funds', 'ASSET', 'UNDEPOSITED_FUNDS', true,
    'Payments received but not yet deposited. Cleared by a bank deposit.'),
  A('1060', 'Credit Card Clearing', 'ASSET', 'OTHER_CURRENT_ASSET', true,
    'Card payments held by the processor until payout, net of fees.'),
  A('1200', 'Accounts Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', true),
  A('1300', 'Inventory — Warehouse', 'ASSET', 'INVENTORY', true),
  A('1310', 'Inventory — Van Stock', 'ASSET', 'INVENTORY', true,
    'Parts on trucks. Relieved to COGS when consumed on a job.'),
  A('1350', 'Work in Process', 'ASSET', 'WIP', true,
    'Job costs held until invoicing, when WIP accounting is enabled.'),
  A('1400', 'Prepaid Expenses', 'ASSET', 'OTHER_CURRENT_ASSET'),
  A('1500', 'Vehicles & Equipment', 'ASSET', 'FIXED_ASSET'),
  A('1590', 'Accumulated Depreciation', 'ASSET', 'FIXED_ASSET', false,
    'Contra-asset. Carries a credit balance.'),

  // --- Liabilities ---------------------------------------------------------
  A('2010', 'Accounts Payable', 'LIABILITY', 'ACCOUNTS_PAYABLE', true),
  A('2050', 'Credit Cards Payable', 'LIABILITY', 'CREDIT_CARD'),
  A('2100', 'Sales Tax Payable', 'LIABILITY', 'SALES_TAX_PAYABLE', true,
    'Parent account. Each tax jurisdiction posts to its own sub-account.'),
  A('2200', 'Payroll Liabilities', 'LIABILITY', 'PAYROLL_LIABILITY', true),
  A('2300', 'Customer Deposits', 'LIABILITY', 'CUSTOMER_DEPOSITS', true,
    'Money collected before the work is earned. Not revenue.'),
  A('2350', 'Deferred Revenue', 'LIABILITY', 'DEFERRED_REVENUE', true,
    'Service agreements billed up front, recognized as visits are performed.'),
  A('2400', 'Accrued Expenses', 'LIABILITY', 'OTHER_CURRENT_LIABILITY'),
  A('2410', 'Accrued Commissions', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', true,
    'Technician commission and spiffs earned but not yet paid.'),

  // --- Equity --------------------------------------------------------------
  A('3010', "Owner's Equity", 'EQUITY', 'EQUITY'),
  A('3020', "Owner's Draw", 'EQUITY', 'EQUITY'),
  A('3100', 'Retained Earnings', 'EQUITY', 'RETAINED_EARNINGS', true),
  A('3900', 'Opening Balance Equity', 'EQUITY', 'OPENING_BALANCE_EQUITY', true,
    'Migration offset account. Must net to zero once the trial balance is loaded.'),

  // --- Revenue -------------------------------------------------------------
  A('4010', 'Service Revenue — Labor', 'REVENUE', 'INCOME', true),
  A('4020', 'Service Revenue — Materials', 'REVENUE', 'INCOME', true),
  A('4030', 'Service Agreement Revenue', 'REVENUE', 'INCOME', true),
  A('4040', 'Trip & Diagnostic Fees', 'REVENUE', 'INCOME', true),
  A('4900', 'Discounts & Allowances', 'REVENUE', 'CONTRA_INCOME', true,
    'Contra-revenue. Carries a debit balance.'),

  // --- Cost of goods sold --------------------------------------------------
  A('5010', 'COGS — Direct Labor', 'COGS', 'COST_OF_GOODS_SOLD', true),
  A('5020', 'COGS — Labor Burden', 'COGS', 'COST_OF_GOODS_SOLD', true,
    'Payroll taxes, workers comp, benefits and vehicle cost loaded onto billable hours.'),
  A('5030', 'COGS — Materials & Parts', 'COGS', 'COST_OF_GOODS_SOLD', true),
  A('5040', 'COGS — Subcontractors', 'COGS', 'COST_OF_GOODS_SOLD', true),
  A('5050', 'COGS — Equipment Rental', 'COGS', 'COST_OF_GOODS_SOLD'),
  A('5060', 'COGS — Permits', 'COGS', 'COST_OF_GOODS_SOLD'),
  A('5090', 'Inventory Shrinkage', 'COGS', 'COST_OF_GOODS_SOLD', true),

  // --- Operating expenses --------------------------------------------------
  A('6010', 'Advertising & Marketing', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6020', 'Office Salaries', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6030', 'Payroll Taxes — Administrative', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6040', 'Rent — Facilities', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6050', 'Utilities', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6060', 'Software & Subscriptions', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6070', 'Licenses & Permits — Company', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6080', 'Training & Certification', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6110', 'Vehicle — Fuel', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6120', 'Vehicle — Maintenance', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6200', 'Insurance — General Liability', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6210', "Insurance — Workers' Compensation", 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6300', 'Merchant Processing Fees', 'EXPENSE', 'OPERATING_EXPENSE', true),
  A('6400', 'Professional Fees', 'EXPENSE', 'OPERATING_EXPENSE'),
  A('6500', 'Depreciation Expense', 'EXPENSE', 'OPERATING_EXPENSE', true),
  A('6900', 'Bad Debt Expense', 'EXPENSE', 'OPERATING_EXPENSE', true),
];

/** Account types whose balance increases on the debit side. */
export const DEBIT_NORMAL_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'ASSET',
  'COGS',
  'EXPENSE',
  'OTHER_EXPENSE',
]);

export function isDebitNormal(type: AccountType): boolean {
  return DEBIT_NORMAL_TYPES.has(type);
}

/**
 * Signed balance in the account's natural direction: positive means the account holds
 * what it is supposed to hold. Revenue of 10,000 reads +10,000, not -10,000.
 */
export function naturalBalance(type: AccountType, debits: bigint, credits: bigint): bigint {
  return isDebitNormal(type) ? debits - credits : credits - debits;
}

/** Accounts that roll into the income statement rather than the balance sheet. */
export const INCOME_STATEMENT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'REVENUE',
  'COGS',
  'EXPENSE',
  'OTHER_INCOME',
  'OTHER_EXPENSE',
]);
