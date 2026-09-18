/**
 * What each import target expects.
 *
 * Aliases are the column names real exports actually use. They are the difference between
 * a wizard that maps thirty columns automatically and one that makes an office manager do
 * it by hand — which is where migrations stall.
 */

export type FieldType = 'text' | 'email' | 'phone' | 'money' | 'number' | 'date' | 'boolean' | 'enum';

export interface TargetField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Lower-case column names seen in the wild, matched exactly after normalisation. */
  aliases: string[];
  enumValues?: string[];
  help?: string;
}

export type ImportEntity =
  | 'CUSTOMER'
  | 'PRICE_BOOK_ITEM'
  | 'CHART_OF_ACCOUNTS'
  | 'OPEN_INVOICE'
  | 'TRIAL_BALANCE';

export const ENTITY_LABELS: Record<ImportEntity, string> = {
  CUSTOMER: 'Customers and service addresses',
  PRICE_BOOK_ITEM: 'Price book',
  CHART_OF_ACCOUNTS: 'Chart of accounts',
  OPEN_INVOICE: 'Open invoices (accounts receivable)',
  TRIAL_BALANCE: 'Trial balance at cutover',
};

/**
 * Import order. Each entity depends on everything above it, and the wizard refuses to run
 * one whose prerequisites are missing — importing invoices before customers produces a
 * few hundred rows of "customer not found" and a wasted afternoon.
 */
export const IMPORT_ORDER: ImportEntity[] = [
  'CHART_OF_ACCOUNTS',
  'CUSTOMER',
  'PRICE_BOOK_ITEM',
  'OPEN_INVOICE',
  'TRIAL_BALANCE',
];

const T = (
  key: string,
  label: string,
  type: FieldType,
  aliases: string[],
  extra: Partial<TargetField> = {},
): TargetField => ({ key, label, type, aliases, ...extra });

export const ENTITY_FIELDS: Record<ImportEntity, TargetField[]> = {
  CUSTOMER: [
    T('externalId', 'Source system ID', 'text', ['id', 'customer id', 'customerid', 'client id', 'record id', 'ref'], {
      help: 'Kept so a second import updates rather than duplicates.',
    }),
    T('companyName', 'Company name', 'text', ['company', 'company name', 'business name', 'organization', 'account name']),
    T('firstName', 'First name', 'text', ['first', 'first name', 'firstname', 'given name']),
    T('lastName', 'Last name', 'text', ['last', 'last name', 'lastname', 'surname', 'family name']),
    T('email', 'Email', 'email', ['email', 'e-mail', 'email address', 'primary email']),
    T('phone', 'Phone', 'phone', ['phone', 'phone number', 'telephone', 'mobile', 'cell', 'primary phone']),
    T('billingAddress1', 'Billing address', 'text', ['address', 'address 1', 'address line 1', 'bill addr line1', 'street']),
    T('billingCity', 'Billing city', 'text', ['city', 'bill addr city', 'town']),
    T('billingState', 'Billing state', 'text', ['state', 'province', 'bill addr state', 'region']),
    T('billingPostal', 'Billing postal code', 'text', ['zip', 'zip code', 'postal', 'postal code', 'postcode', 'bill addr postal code']),
    T('serviceAddress1', 'Service address', 'text', ['service address', 'job address', 'ship addr line1', 'site address', 'property address']),
    T('serviceCity', 'Service city', 'text', ['service city', 'ship addr city', 'job city']),
    T('serviceState', 'Service state', 'text', ['service state', 'ship addr state', 'job state']),
    T('servicePostal', 'Service postal code', 'text', ['service zip', 'ship addr postal code', 'job zip']),
    T('type', 'Customer type', 'enum', ['type', 'customer type', 'category'], {
      enumValues: ['RESIDENTIAL', 'COMMERCIAL', 'PROPERTY_MANAGER', 'BUILDER'],
    }),
    T('paymentTermsDays', 'Payment terms (days)', 'number', ['terms', 'payment terms', 'net terms', 'terms days']),
    T('isTaxExempt', 'Tax exempt', 'boolean', ['tax exempt', 'taxable', 'exempt', 'sales tax exempt']),
    T('notes', 'Notes', 'text', ['notes', 'note', 'comments', 'memo', 'description']),
  ],

  PRICE_BOOK_ITEM: [
    T('sku', 'SKU or item code', 'text', ['sku', 'item', 'item code', 'code', 'part number', 'part #', 'item name/number'], { required: true }),
    T('name', 'Name', 'text', ['name', 'item name', 'description', 'title'], { required: true }),
    T('description', 'Long description', 'text', ['long description', 'sales description', 'details', 'notes']),
    T('category', 'Category', 'enum', ['category', 'type', 'item type', 'line type'], {
      enumValues: ['LABOR', 'MATERIAL', 'AGREEMENT', 'FEE', 'SUBCONTRACT'],
    }),
    T('costCents', 'Cost', 'money', ['cost', 'unit cost', 'purchase cost', 'our cost', 'purchase price']),
    T('priceCents', 'Price', 'money', ['price', 'sell price', 'unit price', 'retail', 'sales price', 'rate']),
    T('unit', 'Unit', 'text', ['unit', 'uom', 'unit of measure', 'each']),
    T('isStocked', 'Stocked', 'boolean', ['stocked', 'inventory', 'is inventory', 'track inventory']),
    T('reorderPoint', 'Reorder point', 'number', ['reorder point', 'min qty', 'minimum', 'reorder level']),
  ],

  CHART_OF_ACCOUNTS: [
    T('code', 'Account number', 'text', ['account number', 'number', 'acct no', 'code', 'account code'], { required: true }),
    T('name', 'Account name', 'text', ['account', 'account name', 'name', 'description'], { required: true }),
    T('type', 'Account type', 'enum', ['type', 'account type', 'classification'], {
      required: true,
      enumValues: ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE'],
    }),
    T('description', 'Description', 'text', ['description', 'notes', 'memo']),
  ],

  OPEN_INVOICE: [
    T('externalId', 'Source system ID', 'text', ['id', 'invoice id', 'transaction id', 'txn id']),
    T('invoiceNo', 'Invoice number', 'text', ['invoice', 'invoice no', 'invoice number', 'num', 'doc number', 'reference'], { required: true }),
    T('customerRef', 'Customer', 'text', ['customer', 'customer name', 'client', 'account', 'bill to', 'customer id'], { required: true }),
    T('issueDate', 'Invoice date', 'date', ['date', 'invoice date', 'issue date', 'txn date', 'transaction date'], { required: true }),
    T('dueDate', 'Due date', 'date', ['due', 'due date', 'date due']),
    T('totalCents', 'Invoice total', 'money', ['amount', 'total', 'invoice total', 'amount due', 'original amount'], { required: true }),
    T('balanceCents', 'Open balance', 'money', ['balance', 'open balance', 'outstanding', 'balance due', 'remaining'], {
      help: 'Defaults to the invoice total when the export does not carry it.',
    }),
    T('poNumber', 'Customer PO', 'text', ['po', 'po number', 'p.o. #', 'purchase order']),
    T('memo', 'Memo', 'text', ['memo', 'description', 'notes']),
  ],

  TRIAL_BALANCE: [
    T('accountCode', 'Account number', 'text', ['account number', 'number', 'acct no', 'code', 'account code'], { required: true }),
    T('accountName', 'Account name', 'text', ['account', 'account name', 'name', 'description']),
    T('debitCents', 'Debit', 'money', ['debit', 'debits', 'dr'], { required: true }),
    T('creditCents', 'Credit', 'money', ['credit', 'credits', 'cr'], { required: true }),
  ],
};

/** Normalise a column heading for comparison: lower case, no punctuation, single spaces. */
export function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[_\-./#]+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
