import { describe, expect, it } from 'vitest';
import { applyOverrides, proposeMapping } from './mapping';

describe('proposeMapping', () => {
  it('maps a QuickBooks-style customer export without help', () => {
    const header = [
      'Customer',
      'Company Name',
      'First Name',
      'Last Name',
      'Main Email',
      'Main Phone',
      'Bill Addr Line1',
      'Bill Addr City',
      'Bill Addr State',
      'Bill Addr Postal Code',
      'Terms',
    ];
    const rows = [
      ['Alvarez, Dana', '', 'Dana', 'Alvarez', 'dana@example.com', '(480) 555-0142', '1420 E Broadway Rd', 'Mesa', 'AZ', '85204', '30'],
    ];

    const proposal = proposeMapping('CUSTOMER', header, rows);

    expect(proposal.fieldMap.firstName).toBe(2);
    expect(proposal.fieldMap.lastName).toBe(3);
    expect(proposal.fieldMap.billingAddress1).toBe(6);
    expect(proposal.fieldMap.billingPostal).toBe(9);
    expect(proposal.fieldMap.paymentTermsDays).toBe(10);
    expect(proposal.missingRequired).toEqual([]);
  });

  it('gives every proposal a reason, so the uncertain ones can be reviewed', () => {
    const proposal = proposeMapping('CUSTOMER', ['Main Email'], [['a@b.com']]);
    const email = proposal.columns.find((c) => c.fieldKey === 'email')!;

    expect(email.confidence).toBeGreaterThan(0.7);
    expect(email.reason).toMatch(/known name|looks like/);
  });

  it('never assigns one column to two fields', () => {
    const header = ['Name', 'Description', 'Price', 'Cost'];
    const rows = [['Wax ring', 'Standard kit', '18.00', '4.20']];
    const proposal = proposeMapping('PRICE_BOOK_ITEM', header, rows);

    const used = Object.values(proposal.fieldMap);
    expect(new Set(used).size).toBe(used.length);
  });

  it('falls back to the shape of the values when a heading says nothing', () => {
    const header = ['Field1', 'Field2', 'Field3'];
    const rows = [
      ['ACME-1', 'a@b.com', '(480) 555-0101'],
      ['ACME-2', 'c@d.com', '(480) 555-0102'],
      ['ACME-3', 'e@f.com', '(602) 555-0103'],
      ['ACME-4', 'g@h.com', '(602) 555-0104'],
    ];

    const proposal = proposeMapping('CUSTOMER', header, rows);
    expect(proposal.fieldMap.email).toBe(1);
    expect(proposal.fieldMap.phone).toBe(2);
  });

  it('reports what is required and still unmapped', () => {
    const proposal = proposeMapping('PRICE_BOOK_ITEM', ['Widget Label'], [['thing']]);
    expect(proposal.missingRequired).toContain('sku');
  });

  it('carries the detected date order and decimal separator', () => {
    const header = ['Invoice', 'Customer', 'Date', 'Amount'];
    const rows = [
      ['1001', 'Acme', '15/04/2025', '1.234,56'],
      ['1002', 'Beta', '20/04/2025', '99,00'],
    ];

    const proposal = proposeMapping('OPEN_INVOICE', header, rows);
    expect(proposal.dateOrder).toBe('DMY');
    expect(proposal.decimalSeparator).toBe(',');
  });
});

describe('applyOverrides', () => {
  it('lets the user correct a mapping', () => {
    const header = ['Code', 'Label', 'Amount A', 'Amount B'];
    const rows = [['X1', 'Widget', '10.00', '4.00']];
    const proposal = proposeMapping('PRICE_BOOK_ITEM', header, rows);

    const corrected = applyOverrides(proposal, { priceCents: 2, costCents: 3 });
    expect(corrected.fieldMap.priceCents).toBe(2);
    expect(corrected.fieldMap.costCents).toBe(3);
    expect(corrected.columns[2].reason).toBe('set by hand');
  });

  it('releases a column when it is claimed by another field', () => {
    const proposal = proposeMapping('PRICE_BOOK_ITEM', ['SKU', 'Name'], [['A1', 'Widget']]);
    const corrected = applyOverrides(proposal, { description: 1 });

    expect(corrected.fieldMap.description).toBe(1);
    expect(corrected.fieldMap.name).toBeUndefined();
  });

  it('lets the user unmap a column entirely', () => {
    const proposal = proposeMapping('PRICE_BOOK_ITEM', ['SKU', 'Name'], [['A1', 'Widget']]);
    const corrected = applyOverrides(proposal, { name: null });

    expect(corrected.fieldMap.name).toBeUndefined();
    expect(corrected.missingRequired).toContain('name');
  });
});
