import { ValidationError } from '../errors';

/**
 * A delimited-text parser.
 *
 * Written rather than pulled in, because the interesting cases here are the ones a
 * general-purpose parser treats as edge cases and a customer's export treats as Tuesday:
 * a quoted field containing the delimiter, a newline inside an address, doubled quotes,
 * a UTF-8 BOM from Excel, mixed line endings, and rows with the wrong number of columns.
 *
 * It parses to rows of strings and nothing more. Deciding what a string means — a date, a
 * negative amount in parentheses, an empty cell that should be null — belongs in `coerce`,
 * where the rules can be seen and tested on their own.
 */

export interface ParseOptions {
  delimiter?: string;
  /** Rows to skip before the header — reports often carry a title block. */
  skipRows?: number;
  /** Cap for previewing a large file without reading all of it. */
  maxRows?: number;
}

export interface ParsedFile {
  header: string[];
  rows: string[][];
  /** Rows whose column count did not match the header, with the line number. */
  raggedRows: { line: number; columns: number }[];
  totalRows: number;
  /**
   * Lines skipped before the header. Every reported line number adds this back, so an
   * error points at the line the office manager will actually find when they open the
   * file — a report with a title block on top would otherwise be off by four.
   */
  headerOffset: number;
}

const BOM = '﻿';

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/** Split delimited text into raw rows, honouring quotes and embedded newlines. */
export function parseRows(text: string, delimiter: string, maxRows?: number): string[][] {
  if (delimiter.length !== 1) {
    throw new ValidationError('Delimiter must be a single character');
  }

  const input = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < input.length) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === delimiter) {
      endField();
      i++;
      continue;
    }

    if (char === '\r' || char === '\n') {
      endRow();
      // Treat CRLF as one break.
      i += char === '\r' && input[i + 1] === '\n' ? 2 : 1;
      if (maxRows !== undefined && rows.length >= maxRows) return rows;
      continue;
    }

    field += char;
    i++;
  }

  // A file that does not end in a newline still has a last row.
  if (field !== '' || row.length > 0) endRow();

  return rows;
}

export function parseFile(text: string, options: ParseOptions = {}): ParsedFile {
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const skip = options.skipRows ?? 0;
  const all = parseRows(text, delimiter, options.maxRows ? options.maxRows + skip + 1 : undefined);

  const meaningful = all.slice(skip).filter((r) => r.some((cell) => cell.trim() !== ''));
  if (meaningful.length === 0) {
    throw new ValidationError('The file has no rows');
  }

  const header = meaningful[0].map((h) => h.trim());
  const body = meaningful.slice(1);
  const ragged: { line: number; columns: number }[] = [];

  const rows = body.map((row, index) => {
    if (row.length !== header.length) {
      ragged.push({ line: skip + index + 2, columns: row.length });
    }
    // Pad short rows and drop overflow, so one malformed line cannot shift every
    // subsequent column by one.
    const normalized = row.slice(0, header.length);
    while (normalized.length < header.length) normalized.push('');
    return normalized;
  });

  return { header, rows, raggedRows: ragged, totalRows: rows.length, headerOffset: skip };
}

/**
 * Guess the delimiter.
 *
 * Whichever candidate appears the same number of times on most lines is the one splitting
 * columns; a delimiter that appears erratically is text. Commas inside quoted fields are
 * skipped, or an address column would make every file look comma-delimited.
 */
export function detectDelimiter(text: string): string {
  const candidates = [',', '\t', ';', '|'];
  const sample = stripBom(text).split(/\r\n|\r|\n/).filter((l) => l.trim() !== '').slice(0, 20);
  if (sample.length === 0) return ',';

  let best = ',';
  let bestScore = -1;

  for (const candidate of candidates) {
    const counts = sample.map((line) => countOutsideQuotes(line, candidate));
    const nonZero = counts.filter((c) => c > 0);
    if (nonZero.length === 0) continue;

    // Consistency matters more than volume: a file with exactly three tabs on every line
    // is tab-delimited even if it also contains more commas.
    const modal = mode(nonZero);
    const consistent = counts.filter((c) => c === modal).length;
    const score = consistent * 10 + modal;

    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function countOutsideQuotes(line: string, char: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && line[i] === char) count++;
  }
  return count;
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Find the header row.
 *
 * Exports from accounting packages routinely begin with a title, a date range and a blank
 * line before the actual columns. The header is the first row where most cells are
 * non-empty, distinct, and not numbers — a row of figures is data, however far up it sits.
 */
export function detectHeaderRow(text: string, delimiter?: string, searchLimit = 12): number {
  const d = delimiter ?? detectDelimiter(text);
  const rows = parseRows(text, d, searchLimit);

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const cells = row.map((c) => c.trim()).filter((c) => c !== '');
    if (cells.length < 2) continue;

    const distinct = new Set(cells.map((c) => c.toLowerCase()));
    if (distinct.size !== cells.length) continue;

    const numeric = cells.filter((c) => /^-?[$(]?[\d,.]+\)?$/.test(c)).length;
    if (numeric > cells.length / 2) continue;

    // Most of the row's cells should be populated, or it is a stray label.
    if (cells.length < row.length / 2) continue;

    return index;
  }

  return 0;
}
