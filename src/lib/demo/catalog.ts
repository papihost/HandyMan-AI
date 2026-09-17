import type { LineCategory, PriceItemKind } from '@prisma/client';

/**
 * The demo company's reference data.
 *
 * Prices and costs are plausible for a handyman operation in the Phoenix metro: labor in
 * the $95–145/hr range, flat-rate tasks priced off roughly 2.5–3x loaded cost, parts
 * marked up 55–120% depending on how price-shoppable they are.
 */

export const COMPANY = {
  name: 'Apex Handyman Services',
  legalName: 'Apex Handyman Services, LLC',
  timezone: 'America/Phoenix',
} as const;

export interface LocationSeed {
  code: string;
  name: string;
  city: string;
  addressLine1: string;
  postalCode: string;
  phone: string;
  /** Combined state + county + city rate for the branch's service area. */
  taxRate: string;
  postalCodes: string[];
  /** Relative share of company volume. Phoenix is the original branch. */
  volumeWeight: number;
}

export const LOCATIONS: LocationSeed[] = [
  {
    code: 'PHX',
    name: 'Phoenix',
    city: 'Phoenix',
    addressLine1: '2140 W Buckeye Rd',
    postalCode: '85009',
    phone: '(602) 555-0110',
    taxRate: '0.0860',
    postalCodes: ['85003', '85004', '85006', '85008', '85009', '85012', '85014', '85015'],
    volumeWeight: 4,
  },
  {
    code: 'MES',
    name: 'Mesa',
    city: 'Mesa',
    addressLine1: '640 S Country Club Dr',
    postalCode: '85210',
    phone: '(480) 555-0120',
    taxRate: '0.0830',
    postalCodes: ['85201', '85202', '85203', '85204', '85205', '85206', '85210'],
    volumeWeight: 3,
  },
  {
    code: 'SCT',
    name: 'Scottsdale',
    city: 'Scottsdale',
    addressLine1: '7350 E Evans Rd',
    postalCode: '85260',
    phone: '(480) 555-0130',
    taxRate: '0.0805',
    postalCodes: ['85250', '85251', '85254', '85257', '85258', '85260'],
    volumeWeight: 2,
  },
];

export const SERVICE_TYPES = [
  { code: 'PLM', name: 'Plumbing' },
  { code: 'ELE', name: 'Electrical' },
  { code: 'CRP', name: 'Carpentry' },
  { code: 'DRY', name: 'Drywall & Paint' },
  { code: 'APL', name: 'Appliance' },
  { code: 'GEN', name: 'General Repairs' },
  { code: 'DRS', name: 'Doors & Windows' },
] as const;

export type ServiceCode = (typeof SERVICE_TYPES)[number]['code'];

export interface PriceItemSeed {
  sku: string;
  name: string;
  kind: PriceItemKind;
  category: LineCategory;
  serviceCode: ServiceCode | null;
  costCents: bigint;
  priceCents: bigint;
  unit?: string;
  estimatedHours?: string;
  isStocked?: boolean;
  reorderPoint?: string;
  reorderQty?: string;
  isTaxExempt?: boolean;
}

/** Labor rates by skill tier. Cost is the loaded hourly cost, not the wage. */
export const LABOR_ITEMS: PriceItemSeed[] = [
  { sku: 'LAB-APP', name: 'Apprentice labor', kind: 'LABOR', category: 'LABOR', serviceCode: null, costCents: 3120n, priceCents: 9500n, unit: 'hr' },
  { sku: 'LAB-STD', name: 'Technician labor', kind: 'LABOR', category: 'LABOR', serviceCode: null, costCents: 4056n, priceCents: 12500n, unit: 'hr' },
  { sku: 'LAB-SR', name: 'Senior technician labor', kind: 'LABOR', category: 'LABOR', serviceCode: null, costCents: 5210n, priceCents: 14500n, unit: 'hr' },
  { sku: 'LAB-OT', name: 'After-hours labor', kind: 'LABOR', category: 'LABOR', serviceCode: null, costCents: 6084n, priceCents: 18750n, unit: 'hr' },
];

export const FEE_ITEMS: PriceItemSeed[] = [
  { sku: 'FEE-TRIP', name: 'Trip charge', kind: 'FEE', category: 'FEE', serviceCode: null, costCents: 0n, priceCents: 8900n },
  { sku: 'FEE-DIAG', name: 'Diagnostic fee', kind: 'FEE', category: 'FEE', serviceCode: null, costCents: 0n, priceCents: 12500n },
  { sku: 'FEE-EMER', name: 'Emergency call-out', kind: 'FEE', category: 'FEE', serviceCode: null, costCents: 0n, priceCents: 24900n },
  { sku: 'FEE-DISP', name: 'Debris disposal', kind: 'FEE', category: 'FEE', serviceCode: null, costCents: 3500n, priceCents: 7500n },
  { sku: 'FEE-PMT', name: 'Permit (pass-through at cost)', kind: 'FEE', category: 'FEE', serviceCode: null, costCents: 15000n, priceCents: 15000n, isTaxExempt: true },
];

/**
 * Flat-rate tasks. These are what a technician actually presents on the tablet, and what
 * the margin conversation is really about.
 */
export const TASK_ITEMS: PriceItemSeed[] = [
  { sku: 'PLM-TOIL-R', name: 'Replace standard toilet', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'PLM', costCents: 14200n, priceCents: 48500n, estimatedHours: '2.5' },
  { sku: 'PLM-FAUC-R', name: 'Replace kitchen faucet', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'PLM', costCents: 9800n, priceCents: 32500n, estimatedHours: '1.5' },
  { sku: 'PLM-DISP-R', name: 'Replace garbage disposal', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'PLM', costCents: 11500n, priceCents: 37500n, estimatedHours: '1.5' },
  { sku: 'PLM-LEAK-R', name: 'Repair under-sink leak', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'PLM', costCents: 6400n, priceCents: 24500n, estimatedHours: '1.5' },
  { sku: 'PLM-WH-R', name: 'Replace 50 gal water heater', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'PLM', costCents: 62000n, priceCents: 168000n, estimatedHours: '4' },
  { sku: 'ELE-OUTL-R', name: 'Replace outlet or switch', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'ELE', costCents: 3900n, priceCents: 16500n, estimatedHours: '1' },
  { sku: 'ELE-FAN-I', name: 'Install ceiling fan', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'ELE', costCents: 9200n, priceCents: 31500n, estimatedHours: '2' },
  { sku: 'ELE-GFCI-I', name: 'Install GFCI circuit', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'ELE', costCents: 11800n, priceCents: 39500n, estimatedHours: '2.5' },
  { sku: 'ELE-FIXT-R', name: 'Replace light fixture', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'ELE', costCents: 6100n, priceCents: 22500n, estimatedHours: '1.5' },
  { sku: 'CRP-TRIM-R', name: 'Baseboard and trim repair', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'CRP', costCents: 8800n, priceCents: 29500n, estimatedHours: '2.5' },
  { sku: 'CRP-SHLF-I', name: 'Install shelving run', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'CRP', costCents: 10400n, priceCents: 34500n, estimatedHours: '3' },
  { sku: 'CRP-CAB-R', name: 'Cabinet door and hinge repair', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'CRP', costCents: 5600n, priceCents: 21500n, estimatedHours: '1.5' },
  { sku: 'CRP-DECK-R', name: 'Deck board replacement', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'CRP', costCents: 22000n, priceCents: 68500n, estimatedHours: '6' },
  // Priced in 2023 and never revisited while board and compound costs climbed. This is
  // the margin anomaly the demo surfaces on the owner dashboard.
  { sku: 'DRY-PATCH-S', name: 'Drywall patch — small', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'DRY', costCents: 13900n, priceCents: 15500n, estimatedHours: '2' },
  { sku: 'DRY-PATCH-L', name: 'Drywall patch — large', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'DRY', costCents: 24800n, priceCents: 27500n, estimatedHours: '4' },
  { sku: 'DRY-ROOM-P', name: 'Paint single room', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'DRY', costCents: 18500n, priceCents: 54500n, estimatedHours: '5' },
  { sku: 'APL-DISH-I', name: 'Install dishwasher', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'APL', costCents: 10900n, priceCents: 34500n, estimatedHours: '2' },
  { sku: 'APL-RANG-I', name: 'Install range hood', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'APL', costCents: 12600n, priceCents: 39500n, estimatedHours: '2.5' },
  { sku: 'DRS-LOCK-R', name: 'Rekey or replace lockset', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'DRS', costCents: 5200n, priceCents: 19500n, estimatedHours: '1' },
  { sku: 'DRS-DOOR-A', name: 'Door adjustment and hardware', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'DRS', costCents: 6900n, priceCents: 24500n, estimatedHours: '1.5' },
  { sku: 'DRS-SCRN-R', name: 'Rescreen patio door', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'DRS', costCents: 7400n, priceCents: 26500n, estimatedHours: '2' },
  { sku: 'GEN-HONEY', name: 'Honey-do list — half day', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'GEN', costCents: 16200n, priceCents: 49500n, estimatedHours: '4' },
  { sku: 'GEN-MOUNT', name: 'TV or mirror mounting', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'GEN', costCents: 5800n, priceCents: 21500n, estimatedHours: '1.5' },
  { sku: 'GEN-GRAB-I', name: 'Install grab bars (pair)', kind: 'FLAT_RATE', category: 'LABOR', serviceCode: 'GEN', costCents: 7100n, priceCents: 25500n, estimatedHours: '1.5' },
];

/** Stocked parts. These live on the vans and get consumed against jobs. */
export const PART_ITEMS: PriceItemSeed[] = [
  { sku: 'P-WAXRING', name: 'Wax ring kit', kind: 'PART', category: 'MATERIAL', serviceCode: 'PLM', costCents: 420n, priceCents: 1800n, isStocked: true, reorderPoint: '4', reorderQty: '12' },
  { sku: 'P-SUPPLY', name: 'Braided supply line', kind: 'PART', category: 'MATERIAL', serviceCode: 'PLM', costCents: 680n, priceCents: 2400n, isStocked: true, reorderPoint: '6', reorderQty: '18' },
  { sku: 'P-PTRAP', name: 'P-trap assembly', kind: 'PART', category: 'MATERIAL', serviceCode: 'PLM', costCents: 940n, priceCents: 3200n, isStocked: true, reorderPoint: '4', reorderQty: '10' },
  { sku: 'P-ANGSTOP', name: 'Quarter-turn angle stop', kind: 'PART', category: 'MATERIAL', serviceCode: 'PLM', costCents: 1150n, priceCents: 3800n, isStocked: true, reorderPoint: '4', reorderQty: '12' },
  { sku: 'P-FLAPPER', name: 'Toilet flapper and fill valve', kind: 'PART', category: 'MATERIAL', serviceCode: 'PLM', costCents: 1380n, priceCents: 4500n, isStocked: true, reorderPoint: '4', reorderQty: '10' },
  { sku: 'P-OUTLET', name: 'Standard outlet', kind: 'PART', category: 'MATERIAL', serviceCode: 'ELE', costCents: 210n, priceCents: 950n, isStocked: true, reorderPoint: '10', reorderQty: '40' },
  { sku: 'P-GFCI', name: 'GFCI receptacle', kind: 'PART', category: 'MATERIAL', serviceCode: 'ELE', costCents: 1720n, priceCents: 4900n, isStocked: true, reorderPoint: '4', reorderQty: '12' },
  { sku: 'P-SWITCH', name: 'Decora switch', kind: 'PART', category: 'MATERIAL', serviceCode: 'ELE', costCents: 340n, priceCents: 1250n, isStocked: true, reorderPoint: '10', reorderQty: '30' },
  { sku: 'P-WIRENUT', name: 'Wire connector pack', kind: 'PART', category: 'MATERIAL', serviceCode: 'ELE', costCents: 580n, priceCents: 1600n, isStocked: true, reorderPoint: '5', reorderQty: '15' },
  { sku: 'P-DRYSHT', name: 'Drywall sheet 4x8', kind: 'PART', category: 'MATERIAL', serviceCode: 'DRY', costCents: 2180n, priceCents: 4900n, isStocked: true, reorderPoint: '4', reorderQty: '10' },
  { sku: 'P-JOINT', name: 'Joint compound — 5 gal', kind: 'PART', category: 'MATERIAL', serviceCode: 'DRY', costCents: 2640n, priceCents: 5900n, isStocked: true, reorderPoint: '2', reorderQty: '6' },
  { sku: 'P-PAINT', name: 'Interior paint — gallon', kind: 'PART', category: 'MATERIAL', serviceCode: 'DRY', costCents: 3890n, priceCents: 8900n, isStocked: true, reorderPoint: '3', reorderQty: '8' },
  { sku: 'P-CAULK', name: 'Paintable caulk', kind: 'PART', category: 'MATERIAL', serviceCode: 'DRY', costCents: 490n, priceCents: 1400n, isStocked: true, reorderPoint: '8', reorderQty: '24' },
  { sku: 'P-SCREWS', name: 'Screw assortment box', kind: 'PART', category: 'MATERIAL', serviceCode: 'CRP', costCents: 1240n, priceCents: 3200n, isStocked: true, reorderPoint: '3', reorderQty: '8' },
  { sku: 'P-HINGE', name: 'Cabinet hinge set', kind: 'PART', category: 'MATERIAL', serviceCode: 'CRP', costCents: 860n, priceCents: 2700n, isStocked: true, reorderPoint: '5', reorderQty: '15' },
  { sku: 'P-TRIM', name: 'Baseboard trim — 8ft', kind: 'PART', category: 'MATERIAL', serviceCode: 'CRP', costCents: 1470n, priceCents: 3900n, unit: 'ea', isStocked: true, reorderPoint: '6', reorderQty: '20' },
  { sku: 'P-LOCKSET', name: 'Entry lockset', kind: 'PART', category: 'MATERIAL', serviceCode: 'DRS', costCents: 3420n, priceCents: 8900n, isStocked: true, reorderPoint: '3', reorderQty: '8' },
  { sku: 'P-SCREEN', name: 'Screen mesh roll', kind: 'PART', category: 'MATERIAL', serviceCode: 'DRS', costCents: 2250n, priceCents: 5500n, isStocked: true, reorderPoint: '2', reorderQty: '6' },
  { sku: 'P-ANCHOR', name: 'Heavy-duty wall anchors', kind: 'PART', category: 'MATERIAL', serviceCode: 'GEN', costCents: 640n, priceCents: 1900n, isStocked: true, reorderPoint: '8', reorderQty: '24' },
  { sku: 'P-MOUNT', name: 'Universal TV mount', kind: 'PART', category: 'MATERIAL', serviceCode: 'GEN', costCents: 4180n, priceCents: 10900n, isStocked: true, reorderPoint: '2', reorderQty: '6' },
];

export const ALL_PRICE_ITEMS = [...LABOR_ITEMS, ...FEE_ITEMS, ...TASK_ITEMS, ...PART_ITEMS];

/** Parts a given service line plausibly consumes. */
export const PARTS_BY_SERVICE: Record<ServiceCode, string[]> = {
  PLM: ['P-WAXRING', 'P-SUPPLY', 'P-PTRAP', 'P-ANGSTOP', 'P-FLAPPER'],
  ELE: ['P-OUTLET', 'P-GFCI', 'P-SWITCH', 'P-WIRENUT'],
  DRY: ['P-DRYSHT', 'P-JOINT', 'P-PAINT', 'P-CAULK'],
  CRP: ['P-SCREWS', 'P-HINGE', 'P-TRIM'],
  DRS: ['P-LOCKSET', 'P-SCREEN', 'P-HINGE'],
  APL: ['P-SUPPLY', 'P-WIRENUT', 'P-ANCHOR'],
  GEN: ['P-ANCHOR', 'P-MOUNT', 'P-SCREWS'],
};

export interface TechSeed {
  first: string;
  last: string;
  locationCode: string;
  tier: 'APPRENTICE' | 'TECHNICIAN' | 'SENIOR';
  baseHourlyCents: bigint;
  /** Drives how often this technician's work comes back as a callback. */
  callbackRate: number;
  skills: ServiceCode[];
}

export const TECHNICIANS: TechSeed[] = [
  { first: 'Marcus', last: 'Deleon', locationCode: 'MES', tier: 'SENIOR', baseHourlyCents: 3600n, callbackRate: 0.02, skills: ['PLM', 'GEN', 'DRS'] },
  { first: 'Priya', last: 'Raghunathan', locationCode: 'PHX', tier: 'SENIOR', baseHourlyCents: 3750n, callbackRate: 0.015, skills: ['ELE', 'APL', 'GEN'] },
  { first: 'Dwayne', last: 'Okoro', locationCode: 'PHX', tier: 'TECHNICIAN', baseHourlyCents: 2800n, callbackRate: 0.04, skills: ['CRP', 'DRS', 'GEN'] },
  { first: 'Lena', last: 'Castellanos', locationCode: 'PHX', tier: 'TECHNICIAN', baseHourlyCents: 2900n, callbackRate: 0.03, skills: ['DRY', 'CRP', 'GEN'] },
  { first: 'Teddy', last: 'Brasch', locationCode: 'PHX', tier: 'TECHNICIAN', baseHourlyCents: 2750n, callbackRate: 0.09, skills: ['PLM', 'GEN'] },
  { first: 'Hollis', last: 'Vance', locationCode: 'PHX', tier: 'APPRENTICE', baseHourlyCents: 2100n, callbackRate: 0.07, skills: ['GEN', 'DRY'] },
  { first: 'Ingrid', last: 'Solberg', locationCode: 'MES', tier: 'TECHNICIAN', baseHourlyCents: 2850n, callbackRate: 0.025, skills: ['ELE', 'GEN', 'APL'] },
  { first: 'Rashad', last: 'Kemp', locationCode: 'MES', tier: 'TECHNICIAN', baseHourlyCents: 2800n, callbackRate: 0.035, skills: ['DRY', 'CRP'] },
  { first: 'Nora', last: 'Fitzgibbon', locationCode: 'MES', tier: 'APPRENTICE', baseHourlyCents: 2050n, callbackRate: 0.06, skills: ['GEN', 'DRS'] },
  { first: 'Curtis', last: 'Mbeki', locationCode: 'MES', tier: 'TECHNICIAN', baseHourlyCents: 2950n, callbackRate: 0.03, skills: ['PLM', 'APL'] },
  { first: 'Sabine', last: 'Toussaint', locationCode: 'SCT', tier: 'SENIOR', baseHourlyCents: 3800n, callbackRate: 0.01, skills: ['CRP', 'DRS', 'GEN'] },
  { first: 'Odell', last: 'Pruitt', locationCode: 'SCT', tier: 'TECHNICIAN', baseHourlyCents: 2900n, callbackRate: 0.045, skills: ['DRY', 'GEN'] },
  { first: 'Yuki', last: 'Tanabe', locationCode: 'SCT', tier: 'TECHNICIAN', baseHourlyCents: 3000n, callbackRate: 0.02, skills: ['ELE', 'APL', 'PLM'] },
  { first: 'Beau', last: 'Lindqvist', locationCode: 'SCT', tier: 'APPRENTICE', baseHourlyCents: 2150n, callbackRate: 0.055, skills: ['GEN', 'CRP'] },
];

export const OFFICE_STAFF = [
  { first: 'Rosalind', last: 'Achebe', role: 'OWNER', locationCode: null },
  { first: 'Diane', last: 'Kowalczyk', role: 'CONTROLLER', locationCode: null },
  { first: 'Avi', last: 'Bernstein', role: 'BOOKKEEPER', locationCode: null },
  { first: 'Marisol', last: 'Duarte', role: 'BRANCH_MANAGER', locationCode: 'PHX' },
  { first: 'Grant', last: 'Whitfield', role: 'BRANCH_MANAGER', locationCode: 'MES' },
  { first: 'Fatima', last: 'Zidane', role: 'BRANCH_MANAGER', locationCode: 'SCT' },
  { first: 'Corey', last: 'Nakashima', role: 'DISPATCHER', locationCode: 'PHX' },
  { first: 'Bev', last: 'Ashworth', role: 'DISPATCHER', locationCode: 'MES' },
  { first: 'Tomas', last: 'Iglesias', role: 'DISPATCHER', locationCode: 'SCT' },
] as const;

export const FIRST_NAMES = [
  'Amara', 'Benedict', 'Camila', 'Desmond', 'Elowen', 'Ferran', 'Giselle', 'Hamza',
  'Ingeborg', 'Jarrah', 'Kwame', 'Lucia', 'Mateo', 'Niamh', 'Osric', 'Paloma',
  'Quentin', 'Rosalie', 'Soren', 'Thandiwe', 'Ulises', 'Verity', 'Wendell', 'Xiomara',
  'Yannick', 'Zora', 'Alistair', 'Bianca', 'Cormac', 'Delphine', 'Emeka', 'Freya',
  'Gideon', 'Hyacinth', 'Idris', 'Juniper', 'Kirra', 'Leopold', 'Marisol', 'Nikolai',
];

export const LAST_NAMES = [
  'Abernathy', 'Bellweather', 'Castaneda', 'Dhillon', 'Espinoza', 'Fairbanks', 'Grimaldi',
  'Halvorsen', 'Ibarra', 'Jankowski', 'Kalinowski', 'Lindgren', 'Moretti', 'Nakagawa',
  'Oyelaran', 'Pemberton', 'Quiroga', 'Rasmussen', 'Sandoval', 'Thibodeaux', 'Ustinov',
  'Villanueva', 'Wojciechowski', 'Xavier', 'Yamamoto', 'Zielinski', 'Ashford', 'Brennan',
  'Cavanaugh', 'Delacroix', 'Eriksen', 'Fontaine', 'Guerrero', 'Haversham', 'Ingersoll',
];

export const COMMERCIAL_NAMES = [
  'Saguaro Ridge Property Group', 'Cactus Wren Apartments', 'Camelback Dental Partners',
  'Desert Bloom Assisted Living', 'Papago Park Offices', 'Roosevelt Row Lofts',
  'Tempe Butte Management', 'Sonoran Self Storage', 'Arcadia Commons HOA',
  'Ironwood Retail Partners', 'Verde Valley Realty', 'Copper State Restaurants',
];

export const STREET_NAMES = [
  'E Camelback Rd', 'N Central Ave', 'W Indian School Rd', 'E Thomas Rd', 'S Dobson Rd',
  'E University Dr', 'N Scottsdale Rd', 'W Southern Ave', 'E Baseline Rd', 'N 7th St',
  'E McDowell Rd', 'W Van Buren St', 'E Shea Blvd', 'N Hayden Rd', 'S Alma School Rd',
  'E Guadalupe Rd', 'W Bethany Home Rd', 'N 44th St', 'E Broadway Rd', 'S Gilbert Rd',
];

export const LEAD_SOURCES = [
  'Google search', 'Repeat customer', 'Referral', 'Nextdoor', 'Yelp', 'Truck signage',
  'Property manager contract', 'Direct mail', 'Facebook',
];

/**
 * Seasonal demand multiplier by calendar month (0 = January).
 *
 * Phoenix: plumbing and AC-adjacent work spikes through the summer, remodel and interior
 * work picks up in the mild months, and the last two weeks of December are dead.
 */
export const SEASONALITY = [0.88, 0.92, 1.05, 1.1, 1.12, 1.22, 1.3, 1.26, 1.08, 1.0, 0.9, 0.76];
