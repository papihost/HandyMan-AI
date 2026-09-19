/**
 * Build the sample exports the import wizard offers.
 *
 * Generated rather than hand-written so the figures tie: the trial balance's receivables
 * line is the sum of the open balances in the A/R aging, to the cent. A demo where the
 * reconciliation passes because nobody checked is worth nothing — the point of the screen
 * is that it would have caught the discrepancy, so the discrepancy has to be real and the
 * agreement has to be real.
 *
 *   node scripts/build-sample-exports.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'public', 'sample-exports');
mkdirSync(OUT, { recursive: true });

const money = (cents) =>
  (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** QuickBooks quotes anything containing a comma, and so do we. */
const cell = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const row = (cells) => cells.map(cell).join(',');

const TITLE = (report, asOf) => ['Apex Handyman Services', report, `As of ${asOf}`, ''];
const AS_OF = '31 December 2025';

// ------------------------------------------------------------------ customers
const CUSTOMERS = [
  ['Alvarez, Dana', '', 'Dana', 'Alvarez', 'dana.alvarez@example.com', '(480) 555-0142', '1420 E Broadway Rd, Apt 2', 'Mesa', 'AZ', '85204', '0'],
  ['Nakamura, Yui', '', 'Yui', 'Nakamura', 'yui.nakamura@example.com', '480.555.0188', '88 W Main St', 'Mesa', 'AZ', '85201', '0'],
  ['Saguaro Ridge Property Group', 'Saguaro Ridge Property Group', 'Marcus', 'Bell', 'ap@saguaroridge.example.com', '+1 (602) 555-0110', '2140 W Buckeye Rd', 'Phoenix', 'AZ', '85009', '30'],
  ['Okafor, Chidi', '', 'Chidi', 'Okafor', 'chidi.okafor@example.com', '(623) 555-0170', '9 Low Rd', 'Phoenix', 'AZ', '85012', '0'],
  ['Desert Bloom Apartments', 'Desert Bloom Apartments LLC', 'Renata', 'Kovacs', 'billing@desertbloom.example.com', '(480) 555-0311', '7700 E Camelback Rd', 'Scottsdale', 'AZ', '85251', '30'],
  ['Whitfield, Eleanor', '', 'Eleanor', 'Whitfield', 'e.whitfield@example.com', '(480) 555-0209', '3312 N Hayden Rd', 'Scottsdale', 'AZ', '85251', '0'],
  ['Ironwood Builders', 'Ironwood Builders Inc', 'Sam', 'Turano', 'accounts@ironwoodbuild.example.com', '(602) 555-0455', '515 S 7th Ave', 'Phoenix', 'AZ', '85007', '45'],
  ['Pham, Linh', '', 'Linh', 'Pham', 'linh.pham@example.com', '(480) 555-0166', '204 S Dobson Rd', 'Mesa', 'AZ', '85202', '0'],
  ['Copperleaf HOA', 'Copperleaf Community Association', 'Dolores', 'Amaya', 'manager@copperleafhoa.example.com', '(480) 555-0412', '1900 E Guadalupe Rd', 'Tempe', 'AZ', '85283', '30'],
  ['Brennan, Sean', '', 'Sean', 'Brennan', 'sean.brennan@example.com', '(602) 555-0129', '44 W Osborn Rd', 'Phoenix', 'AZ', '85013', '0'],
  ['Villanueva, Rosa', '', 'Rosa', 'Villanueva', 'rosa.v@example.com', '(480) 555-0277', '6621 E Baseline Rd', 'Mesa', 'AZ', '85206', '0'],
  ['Papago Dental Group', 'Papago Dental Group PLLC', 'Ruth', 'Ibarra', 'office@papagodental.example.com', '(602) 555-0388', '1201 N Scottsdale Rd', 'Scottsdale', 'AZ', '85257', '15'],
  ['Osei, Kwame', '', 'Kwame', 'Osei', 'kwame.osei@example.com', '(623) 555-0144', '822 W Glendale Ave', 'Phoenix', 'AZ', '85021', '0'],
  ['Lindgren, Britta', '', 'Britta', 'Lindgren', 'britta.l@example.com', '(480) 555-0355', '15 E Southern Ave', 'Tempe', 'AZ', '85282', '0'],
  ['Sunridge Self Storage', 'Sunridge Self Storage LP', 'Hal', 'Perreault', 'ap@sunridgestorage.example.com', '(602) 555-0422', '3400 W Indian School Rd', 'Phoenix', 'AZ', '85017', '30'],
  ['Castillo, Marisol', '', 'Marisol', 'Castillo', 'marisol.castillo@example.com', '(480) 555-0101', '901 N Gilbert Rd', 'Mesa', 'AZ', '85203', '0'],
  ['Redfern, Alice', '', 'Alice', 'Redfern', 'alice.redfern@example.com', '(480) 555-0233', '77 E Chandler Blvd', 'Chandler', 'AZ', '85225', '0'],
  ['Mesquite Grove Rentals', 'Mesquite Grove Rentals LLC', 'Curtis', 'Whately', 'curtis@mesquitegrove.example.com', '(480) 555-0499', '4402 E Main St', 'Mesa', 'AZ', '85205', '30'],
  ['Achterberg, Pieter', '', 'Pieter', 'Achterberg', 'p.achterberg@example.com', '(602) 555-0177', '1180 W Thomas Rd', 'Phoenix', 'AZ', '85013', '0'],
  ['Quintero, Ana', '', 'Ana', 'Quintero', 'ana.quintero@example.com', '(480) 555-0266', '250 S Power Rd', 'Mesa', 'AZ', '85206', '0'],
  // The mess every export carries: the same household twice, an address that is not an
  // email, and a row with nothing in it but a contact detail.
  ['Alvarez, Dana', '', 'Dana', 'Alvarez', 'dana.alvarez@example.com', '(480) 555-0142', '1420 E Broadway Rd, Apt 2', 'Mesa', 'AZ', '85204', '0'],
  ['Hollis, Jerome', '', 'Jerome', 'Hollis', 'jerome dot hollis at example dot com', '(602) 555-0198', '620 E Indian School Rd', 'Phoenix', 'AZ', '85012', '0'],
  ['', '', '', '', 'nobody@example.com', '', '', '', '', '', ''],
];

writeFileSync(
  join(OUT, 'quickbooks-customers.csv'),
  [
    ...TITLE('Customer Contact List', AS_OF),
    'Customer,Company Name,First Name,Last Name,Main Email,Main Phone,Bill Addr Line1,Bill Addr City,Bill Addr State,Bill Addr Postal Code,Terms',
    ...CUSTOMERS.map(row),
  ].join('\n') + '\n',
);

// ------------------------------------------------------------ chart of accounts
const ACCOUNTS = [
  ['1010', 'Operating Bank Account', 'Bank', 'Main checking'],
  ['1020', 'Payroll Bank Account', 'Bank', ''],
  ['1100', 'Undeposited Funds', 'Other Current Asset', ''],
  ['1200', 'Accounts Receivable', 'Accounts Receivable', ''],
  ['1300', 'Inventory — Warehouse', 'Other Current Asset', ''],
  ['1310', 'Inventory — Vans', 'Other Current Asset', ''],
  ['1500', 'Vehicles & Equipment', 'Fixed Asset', ''],
  ['1590', 'Accumulated Depreciation', 'Fixed Asset', 'Contra'],
  ['2010', 'Accounts Payable', 'Accounts Payable', ''],
  ['2100', 'Sales Tax Payable', 'Other Current Liability', ''],
  ['2200', 'Payroll Liabilities', 'Other Current Liability', ''],
  ['2300', 'Customer Deposits', 'Other Current Liability', 'Held until earned'],
  ['3010', 'Owner’s Equity', 'Equity', ''],
  ['3900', 'Opening Balance Equity', 'Equity', ''],
  ['4010', 'Labor Income', 'Income', ''],
  ['4020', 'Materials Income', 'Income', ''],
  ['4030', 'Trip & Service Fees', 'Income', ''],
  ['5010', 'Direct Labor', 'Cost of Goods Sold', ''],
  ['5020', 'Labor Burden', 'Cost of Goods Sold', 'Taxes, comp, benefits, vehicle'],
  ['5030', 'Materials & Parts', 'Cost of Goods Sold', ''],
  ['5040', 'Subcontracted Work', 'Cost of Goods Sold', ''],
  ['6010', 'Rent', 'Expense', ''],
  ['6020', 'Insurance', 'Expense', ''],
  ['6030', 'Advertising', 'Expense', ''],
  ['6040', 'Office & Software', 'Expense', ''],
  ['6050', 'Vehicle Expense', 'Expense', ''],
  ['6060', 'Merchant Fees', 'Expense', ''],
  ['6900', 'Depreciation', 'Expense', ''],
];

writeFileSync(
  join(OUT, 'quickbooks-chart-of-accounts.csv'),
  [
    ...TITLE('Account Listing', AS_OF),
    'Account Number,Account,Type,Description',
    ...ACCOUNTS.map(row),
  ].join('\n') + '\n',
);

// ------------------------------------------------------------------ price book
// A different shape on purpose: a column called "Field7" that the heading cannot explain
// and only the data can, which is what the mapping screen exists to show.
const ITEMS = [
  ['PLM-TOIL-R', 'Replace standard toilet', 'Service', 24282, 48500, 'ea', 'N', ''],
  ['PLM-FAUC-R', 'Replace kitchen faucet', 'Service', 9800, 32500, 'ea', 'N', ''],
  ['PLM-DISP-R', 'Replace garbage disposal', 'Service', 11500, 37500, 'ea', 'N', ''],
  ['PLM-LEAK-R', 'Repair under-sink leak', 'Service', 6400, 24500, 'ea', 'N', ''],
  ['PLM-WH-R', 'Replace 50 gal water heater', 'Service', 62000, 168000, 'ea', 'N', ''],
  ['ELE-OUTL-R', 'Replace outlet or switch', 'Service', 3900, 16500, 'ea', 'N', ''],
  ['ELE-FAN-I', 'Install ceiling fan', 'Service', 9200, 31500, 'ea', 'N', ''],
  ['ELE-GFCI-I', 'Install GFCI circuit', 'Service', 11800, 39500, 'ea', 'N', ''],
  ['DRY-PATCH-S', 'Drywall patch — small', 'Service', 13900, 15500, 'ea', 'N', 'Priced 2023'],
  ['DRY-PATCH-L', 'Drywall patch — large', 'Service', 24800, 27500, 'ea', 'N', 'Priced 2023'],
  ['DRY-ROOM-P', 'Paint single room', 'Service', 18500, 54500, 'ea', 'N', ''],
  ['CRP-TRIM-R', 'Baseboard and trim repair', 'Service', 8800, 29500, 'ea', 'N', ''],
  ['CRP-CAB-R', 'Cabinet door and hinge repair', 'Service', 5600, 21500, 'ea', 'N', ''],
  ['DRS-LOCK-R', 'Rekey or replace lockset', 'Service', 5200, 19500, 'ea', 'N', ''],
  ['GEN-HONEY', 'Honey-do list — half day', 'Service', 16200, 49500, 'ea', 'N', ''],
  ['GEN-MOUNT', 'TV or mirror mounting', 'Service', 5800, 21500, 'ea', 'N', ''],
  ['PRT-WAX-RING', 'Wax ring kit', 'Inventory Part', 380, 1200, 'ea', 'Y', '24'],
  ['PRT-SUP-LINE', 'Braided supply line', 'Inventory Part', 420, 1400, 'ea', 'Y', '36'],
  ['PRT-GFCI-15', 'GFCI receptacle 15A', 'Inventory Part', 1180, 3400, 'ea', 'Y', '20'],
  ['PRT-CAULK', 'Paintable caulk', 'Inventory Part', 310, 1400, 'tube', 'Y', '48'],
  ['PRT-DW-SHEET', 'Drywall sheet 4x8', 'Inventory Part', 1450, 3800, 'ea', 'Y', '16'],
  ['PRT-HINGE', 'Cabinet hinge pair', 'Inventory Part', 460, 1600, 'pr', 'Y', '30'],
];

writeFileSync(
  join(OUT, 'price-book.csv'),
  [
    'Item Name/Number,Sales Description,Item Type,Purchase Cost,Sales Price,U/M,Field7,Notes',
    ...ITEMS.map(([sku, name, type, cost, price, unit, stocked, notes]) =>
      row([sku, name, type, money(cost), money(price), unit, stocked, notes]),
    ),
  ].join('\n') + '\n',
);

// ------------------------------------------------------------------- A/R aging
const OPEN = [
  ['1041', 'Alvarez, Dana', '11/18/2025', '12/18/2025', 128450, 128450, ''],
  ['1052', 'Nakamura, Yui', '12/02/2025', '12/02/2025', 64200, 64200, ''],
  ['1063', 'Saguaro Ridge Property Group', '12/14/2025', '01/13/2026', 418075, 218075, 'PO-8841'],
  ['1070', 'Okafor, Chidi', '12/28/2025', '12/28/2025', 31000, 31000, ''],
  ['1074', 'Desert Bloom Apartments', '12/05/2025', '01/04/2026', 294500, 294500, 'DB-2291'],
  ['1078', 'Ironwood Builders', '12/09/2025', '01/23/2026', 612300, 612300, 'IW-4417'],
  ['1081', 'Copperleaf HOA', '12/11/2025', '01/10/2026', 187650, 187650, ''],
  ['1084', 'Whitfield, Eleanor', '12/15/2025', '12/15/2025', 42500, 42500, ''],
  ['1088', 'Papago Dental Group', '12/18/2025', '01/02/2026', 96300, 96300, 'PD-1120'],
  ['1090', 'Sunridge Self Storage', '12/19/2025', '01/18/2026', 233900, 233900, 'SS-7734'],
  ['1093', 'Mesquite Grove Rentals', '12/22/2025', '01/21/2026', 145200, 145200, ''],
  ['1095', 'Pham, Linh', '12/23/2025', '12/23/2025', 58700, 58700, ''],
  ['1097', 'Brennan, Sean', '12/27/2025', '12/27/2025', 39900, 39900, ''],
  ['1099', 'Castillo, Marisol', '12/30/2025', '12/30/2025', 71400, 71400, ''],
  // The row the reconciliation is for: a customer who is not on the customer list,
  // because in the old system this invoice was raised against a name somebody typed.
  ['1100', 'Ghost Customer Ltd', '12/29/2025', '01/28/2026', 50000, 50000, ''],
];

const agingCsv = (rows) =>
  [
    ...TITLE('A/R Aging Detail', AS_OF),
    'Num,Customer,Date,Due Date,Amount,Open Balance,P.O. #',
    ...rows.map(([num, customer, date, due, amount, balance, po]) =>
      row([num, customer, date, due, money(amount), money(balance), po]),
    ),
  ].join('\n') + '\n';

writeFileSync(join(OUT, 'quickbooks-ar-aging.csv'), agingCsv(OPEN));

// The same report after the office manager corrects the row the dry run flagged.
const CORRECTED = OPEN.map((r) =>
  r[1] === 'Ghost Customer Ltd' ? [...r.slice(0, 1), 'Redfern, Alice', ...r.slice(2)] : r,
);
writeFileSync(join(OUT, 'quickbooks-ar-aging-corrected.csv'), agingCsv(CORRECTED));

// --------------------------------------------------------------- trial balance
// Receivables is the aging's own total, to the cent, so the two files agree and the
// reconciliation on screen is checking something real.
const receivable = OPEN.reduce((total, r) => total + r[5], 0);

const TB = [
  ['1010', 'Operating Bank Account', 5240000, 0],
  ['1200', 'Accounts Receivable', receivable, 0],
  ['1300', 'Inventory — Warehouse', 1825000, 0],
  ['1310', 'Inventory — Vans', 684000, 0],
  ['1500', 'Vehicles & Equipment', 9600000, 0],
  ['1590', 'Accumulated Depreciation', 0, 3120000],
  ['2010', 'Accounts Payable', 0, 1488000],
  ['2100', 'Sales Tax Payable', 0, 391200],
  ['2200', 'Payroll Liabilities', 0, 264500],
  ['2300', 'Customer Deposits', 0, 175000],
];

const debits = TB.reduce((t, r) => t + r[2], 0);
const credits = TB.reduce((t, r) => t + r[3], 0);
TB.push(['3010', 'Owner’s Equity', 0, debits - credits]);

const finalDebits = TB.reduce((t, r) => t + r[2], 0);
const finalCredits = TB.reduce((t, r) => t + r[3], 0);
if (finalDebits !== finalCredits) {
  throw new Error(`trial balance does not balance: ${finalDebits} vs ${finalCredits}`);
}

writeFileSync(
  join(OUT, 'quickbooks-trial-balance.csv'),
  [
    ...TITLE('Trial Balance', AS_OF),
    'Account Number,Account,Debit,Credit',
    ...TB.map(([code, name, debit, credit]) =>
      row([code, name, debit ? money(debit) : '', credit ? money(credit) : '']),
    ),
  ].join('\n') + '\n',
);

console.log(`Sample exports written to ${OUT}`);
console.log(`  A/R open balance total  ${money(receivable)}`);
console.log(`  Trial balance           ${money(finalDebits)} / ${money(finalCredits)} — balanced`);
