import { describe, expect, it } from 'vitest';
import { detectDelimiter, detectHeaderRow, parseFile, parseRows, stripBom } from './csv';

describe('parseRows', () => {
  it('handles quoted fields containing the delimiter', () => {
    const rows = parseRows('a,"b,c",d', ',');
    expect(rows).toEqual([['a', 'b,c', 'd']]);
  });

  it('handles a newline inside a quoted field, which is how addresses arrive', () => {
    const rows = parseRows('name,address\n"Acme","12 High St\nSuite 4"', ',');
    expect(rows).toEqual([
      ['name', 'address'],
      ['Acme', '12 High St\nSuite 4'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    const rows = parseRows('a,"say ""hello""",c', ',');
    expect(rows[0][1]).toBe('say "hello"');
  });

  it('treats CRLF, LF and CR alike', () => {
    expect(parseRows('a,b\r\nc,d', ',')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseRows('a,b\rc,d', ',')).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('keeps a final row with no trailing newline', () => {
    expect(parseRows('a,b\nc,d', ',')).toHaveLength(2);
  });

  it('preserves empty fields rather than collapsing them', () => {
    expect(parseRows('a,,c', ',')).toEqual([['a', '', 'c']]);
  });

  it('strips a byte order mark, which Excel adds', () => {
    expect(stripBom('﻿Name')).toBe('Name');
    expect(parseRows('﻿a,b', ',')[0][0]).toBe('a');
  });
});

describe('detectDelimiter', () => {
  it('finds commas, tabs, semicolons and pipes', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|');
  });

  it('is not fooled by commas inside quoted addresses', () => {
    const text = [
      'name\taddress',
      'Acme\t"12 High St, Suite 4, Phoenix, AZ"',
      'Beta\t"9 Low Rd, Unit 2, Mesa, AZ"',
    ].join('\n');
    expect(detectDelimiter(text)).toBe('\t');
  });

  it('prefers the delimiter that appears consistently', () => {
    // Semicolons are consistent at two per line; commas are erratic prose.
    const text = ['a;b;c', 'one, two;three;four', 'five;six, seven, eight;nine'].join('\n');
    expect(detectDelimiter(text)).toBe(';');
  });
});

describe('detectHeaderRow', () => {
  it('skips the title block accounting exports put on top', () => {
    const text = [
      'Apex Handyman Services',
      'A/R Aging Summary',
      'As of 31 December 2025',
      '',
      'Customer,Invoice,Date,Amount',
      'Acme,1001,01/15/2025,1200.00',
    ].join('\n');

    const headerRow = detectHeaderRow(text);
    const parsed = parseFile(text, { skipRows: headerRow });
    expect(parsed.header).toEqual(['Customer', 'Invoice', 'Date', 'Amount']);
    expect(parsed.rows).toHaveLength(1);
  });

  it('uses the first row when the file is already clean', () => {
    expect(detectHeaderRow('Customer,Amount\nAcme,10.00')).toBe(0);
  });

  it('does not mistake a row of figures for a header', () => {
    const text = ['1001,2002,3003', 'Customer,Invoice,Amount', 'Acme,1,10.00'].join('\n');
    expect(detectHeaderRow(text)).toBe(1);
  });
});

describe('parseFile', () => {
  it('pads a short row instead of shifting every column after it', () => {
    const text = 'a,b,c\n1,2,3\n4,5\n6,7,8';
    const parsed = parseFile(text);

    expect(parsed.rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', ''],
      ['6', '7', '8'],
    ]);
    expect(parsed.raggedRows).toEqual([{ line: 3, columns: 2 }]);
  });

  it('reports a row with too many columns and truncates it', () => {
    const parsed = parseFile('a,b\n1,2,3');
    expect(parsed.rows[0]).toEqual(['1', '2']);
    expect(parsed.raggedRows).toHaveLength(1);
  });

  it('ignores blank lines in the body', () => {
    expect(parseFile('a,b\n1,2\n\n3,4').rows).toHaveLength(2);
  });

  it('refuses an empty file rather than importing nothing quietly', () => {
    expect(() => parseFile('')).toThrow(/no rows/);
  });
});
