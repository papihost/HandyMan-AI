'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Flag, Panel } from './primitives';

/**
 * The migration wizard.
 *
 * The uploaded file stays in the browser and travels with each request, so an abandoned
 * migration leaves nothing on the server to expire or clean up, and there is no staged
 * copy of a customer's books sitting around between steps.
 *
 * The screen's job is to make the import boring. Everything it is about to do is shown
 * first — what it detected, what it mapped and why, what it could not read, and what a
 * complete run would produce — and the dry run proves it by really doing it and then
 * rolling the transaction back.
 */

type Entity = 'CHART_OF_ACCOUNTS' | 'CUSTOMER' | 'PRICE_BOOK_ITEM' | 'OPEN_INVOICE' | 'TRIAL_BALANCE';

const STEPS: { entity: Entity; label: string; blurb: string; sample: string; alternate?: string }[] = [
  {
    entity: 'CHART_OF_ACCOUNTS',
    label: 'Chart of accounts',
    blurb: 'The account numbers everything else posts to. Load this first.',
    sample: 'quickbooks-chart-of-accounts.csv',
  },
  {
    entity: 'CUSTOMER',
    label: 'Customers',
    blurb: 'Names, contact details and service addresses. Duplicates are detected, not doubled.',
    sample: 'quickbooks-customers.csv',
  },
  {
    entity: 'PRICE_BOOK_ITEM',
    label: 'Price book',
    blurb: 'Flat rates and stocked parts, with the cost behind each price.',
    sample: 'price-book.csv',
  },
  {
    entity: 'OPEN_INVOICE',
    label: 'Open invoices',
    blurb: 'What customers still owe. Each one is raised against opening equity.',
    sample: 'quickbooks-ar-aging.csv',
    alternate: 'quickbooks-ar-aging-corrected.csv',
  },
  {
    entity: 'TRIAL_BALANCE',
    label: 'Trial balance',
    blurb: 'Everything else at cutover, as one balanced opening entry.',
    sample: 'quickbooks-trial-balance.csv',
  },
];

interface FieldSpec {
  key: string;
  label: string;
  type: string;
  required: boolean;
  help: string | null;
  enumValues: string[] | null;
}

interface ColumnProposal {
  column: string;
  columnIndex: number;
  fieldKey: string | null;
  confidence: number;
  reason: string;
}

interface Analysis {
  entityLabel: string;
  delimiter: string;
  headerRow: number;
  header: string[];
  totalRows: number;
  raggedRows: { line: number; columns: number }[];
  headerOffset: number;
  preview: string[][];
  mapping: {
    columns: ColumnProposal[];
    fieldMap: Record<string, number>;
    missingRequired: string[];
    dateOrder: 'MDY' | 'DMY' | 'YMD';
    dateOrderAmbiguous: boolean;
    decimalSeparator: '.' | ',';
  };
  fields: FieldSpec[];
  validation: {
    totalRows: number;
    validRows: number;
    errorRows: number;
    warningRows: number;
    issues: { line: number; field?: string; severity: string; message: string; value?: string }[];
    sourceTotalCents: string;
    missingRequired: string[];
    canProceed: boolean;
  };
  existing: number;
  reconciles: boolean;
}

interface RunResult {
  batchId: string | null;
  dryRun: boolean;
  totalRows: number;
  imported: number;
  updated: number;
  skipped: number;
  errorRows: number;
  issues: { line: number; field?: string; severity: string; message: string; value?: string }[];
  notes: string[];
  reconciliation: {
    sourceTotalCents: string;
    importedTotalCents: string;
    matches: boolean;
    openingBalanceEquityCents: string;
    isBalanced: boolean;
    lines: string[];
  };
}

interface Batch {
  id: string;
  name: string;
  entityType: string;
  status: string;
  fileName: string | null;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  errorRows: number;
  isBalanced: boolean;
  createdAt: string;
  rolledBackAt: string | null;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? 'Something went wrong');
  return payload as T;
}

const money = (cents: string) => {
  const value = BigInt(cents || '0');
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = (absolute / 100n).toLocaleString('en-US');
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
};

export function ImportWizard({ cutoverDefault }: { cutoverDefault: string }) {
  const [entity, setEntity] = useState<Entity>('CHART_OF_ACCOUNTS');
  const [fileName, setFileName] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  const [headerRow, setHeaderRow] = useState<number | undefined>();
  const [overrides, setOverrides] = useState<Record<string, number | null>>({});
  const [dateOrder, setDateOrder] = useState<'MDY' | 'DMY' | 'YMD' | undefined>();

  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [dry, setDry] = useState<RunResult | null>(null);
  const [committed, setCommitted] = useState<RunResult | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cutover, setCutover] = useState(cutoverDefault);
  const fileInput = useRef<HTMLInputElement>(null);

  const step = STEPS.find((s) => s.entity === entity)!;

  const refreshBatches = useCallback(async () => {
    const response = await fetch('/api/import/batches');
    if (!response.ok) return;
    const payload = (await response.json()) as { batches: Batch[] };
    setBatches(payload.batches);
  }, []);

  useEffect(() => {
    void refreshBatches();
  }, [refreshBatches]);

  const analyze = useCallback(
    async (options: {
      text: string;
      entity: Entity;
      headerRow?: number;
      overrides?: Record<string, number | null>;
      dateOrder?: string;
    }) => {
      setBusy('Reading the file');
      setError(null);
      try {
        const result = await post<Analysis>('/api/import/analyze', options);
        setAnalysis(result);
        // Any change to what the import would do invalidates the rehearsal of it.
        setDry(null);
        setCommitted(null);
      } catch (cause) {
        setAnalysis(null);
        setError(cause instanceof Error ? cause.message : 'Could not read that file');
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const load = useCallback(
    async (contents: string, name: string) => {
      setText(contents);
      setFileName(name);
      setHeaderRow(undefined);
      setOverrides({});
      setDateOrder(undefined);
      await analyze({ text: contents, entity });
    },
    [analyze, entity],
  );

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    await load(await file.text(), file.name);
  };

  const loadSample = async (name: string) => {
    setBusy('Fetching the sample');
    try {
      const response = await fetch(`/sample-exports/${name}`);
      await load(await response.text(), name);
    } catch {
      setError('Could not fetch that sample');
      setBusy(null);
    }
  };

  const reanalyze = (next: {
    headerRow?: number;
    overrides?: Record<string, number | null>;
    dateOrder?: string;
  }) => {
    if (!text) return;
    void analyze({
      text,
      entity,
      headerRow: next.headerRow ?? headerRow,
      overrides: next.overrides ?? overrides,
      dateOrder: next.dateOrder ?? dateOrder,
    });
  };

  const setMapping = (fieldKey: string, columnIndex: number | null) => {
    const next = { ...overrides, [fieldKey]: columnIndex };
    setOverrides(next);
    reanalyze({ overrides: next });
  };

  const run = async (dryRun: boolean) => {
    if (!text) return;
    setBusy(dryRun ? 'Rehearsing the import' : 'Importing');
    setError(null);
    try {
      const result = await post<RunResult>('/api/import/run', {
        text,
        entity,
        headerRow,
        overrides,
        dateOrder,
        dryRun,
        fileName,
        sourceSystem: 'QUICKBOOKS',
        cutoverDate: cutover,
      });
      if (dryRun) setDry(result);
      else {
        setCommitted(result);
        await refreshBatches();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import failed');
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (batchId: string) => {
    setBusy('Reversing');
    setError(null);
    try {
      await post('/api/import/rollback', { batchId });
      await refreshBatches();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reverse that batch');
    } finally {
      setBusy(null);
    }
  };

  const chooseEntity = (next: Entity) => {
    setEntity(next);
    setText(null);
    setFileName(null);
    setAnalysis(null);
    setDry(null);
    setCommitted(null);
    setOverrides({});
    setHeaderRow(undefined);
    setDateOrder(undefined);
    setError(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const doneEntities = new Set(
    batches.filter((b) => b.status === 'COMPLETED').map((b) => b.entityType),
  );

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------- the order */}
      <Panel
        title="What comes across, and in what order"
        subtitle="Each one needs the ones above it — invoices need customers, and everything needs accounts"
      >
        <ol className="grid gap-2 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-5">
          {STEPS.map((item, index) => {
            const done = doneEntities.has(item.entity);
            const active = item.entity === entity;
            return (
              <li key={item.entity}>
                <button
                  type="button"
                  onClick={() => chooseEntity(item.entity)}
                  className="w-full rounded-xl border p-3 text-left"
                  style={{
                    borderColor: active ? 'var(--seq)' : 'var(--hairline)',
                    background: active ? 'var(--plane)' : 'transparent',
                  }}
                >
                  <span className="text-xs font-bold" style={{ color: 'var(--ink-muted)' }}>
                    {index + 1}
                  </span>
                  <span className="mt-0.5 block font-semibold">{item.label}</span>
                  {done ? (
                    <span className="mt-1 block">
                      <Flag tone="good">loaded</Flag>
                    </span>
                  ) : (
                    <span className="mt-1 block text-xs" style={{ color: 'var(--ink-2)' }}>
                      {item.blurb}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </Panel>

      {error && (
        <div className="panel p-4">
          <Flag tone="critical">{error}</Flag>
        </div>
      )}

      {/* --------------------------------------------------------------- the file */}
      <Panel title={step.label} subtitle={step.blurb}>
        <div className="flex flex-wrap items-center gap-3 px-4 pb-4">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="text-sm"
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
          <button
            type="button"
            className="rounded-lg border px-3 py-1.5 text-sm font-semibold"
            style={{ borderColor: 'var(--hairline)' }}
            onClick={() => void loadSample(step.sample)}
          >
            Use the sample export
          </button>
          {step.alternate && (
            <button
              type="button"
              className="rounded-lg border px-3 py-1.5 text-sm font-semibold"
              style={{ borderColor: 'var(--hairline)' }}
              onClick={() => void loadSample(step.alternate!)}
            >
              Use the corrected export
            </button>
          )}
          {busy && (
            <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
              {busy}…
            </span>
          )}
        </div>
      </Panel>

      {analysis && (
        <>
          <Detected
            analysis={analysis}
            fileName={fileName}
            onHeaderRow={(row) => {
              setHeaderRow(row);
              reanalyze({ headerRow: row });
            }}
            onDateOrder={(order) => {
              setDateOrder(order);
              reanalyze({ dateOrder: order });
            }}
          />

          <Mapping analysis={analysis} onChange={setMapping} />

          {analysis.validation.issues.length > 0 && (
            <Issues
              issues={analysis.validation.issues}
              title="What we could not read"
              subtitle="Line numbers are the file's own, so they match what you see when you open it"
            />
          )}

          <Preview analysis={analysis} />

          {/* ------------------------------------------------------- dry run */}
          <Panel
            title="Rehearse it"
            subtitle="The whole import runs inside a transaction that is then rolled back, so these are the real numbers rather than an estimate"
          >
            <div className="flex flex-wrap items-end gap-4 px-4 pb-4">
              <label className="text-sm">
                <span className="block font-medium">Cutover date</span>
                <span className="block text-xs" style={{ color: 'var(--ink-2)' }}>
                  Opening balances post on this day
                </span>
                <input
                  type="date"
                  value={cutover}
                  onChange={(event) => {
                    setCutover(event.target.value);
                    setDry(null);
                  }}
                  className="mt-1 rounded-lg border px-2 py-1.5"
                  style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
                />
              </label>

              <button
                type="button"
                disabled={!analysis.validation.canProceed || busy !== null}
                onClick={() => void run(true)}
                className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: 'var(--seq)' }}
              >
                Dry run
              </button>

              {!analysis.validation.canProceed && (
                <span className="text-sm">
                  <Flag tone="critical">
                    {analysis.validation.missingRequired.length > 0
                      ? `Map a column to ${analysis.validation.missingRequired.join(', ')} first`
                      : 'Too many rows could not be read'}
                  </Flag>
                </span>
              )}
            </div>
          </Panel>

          {dry && !committed && (
            <Outcome
              result={dry}
              reconciles={analysis.reconciles}
              title="What a real run would do"
              footer={
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void run(false)}
                    className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: 'var(--seq)' }}
                  >
                    Import for real
                  </button>
                  <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
                    Nothing has been written yet. This is reversible afterwards too.
                  </span>
                </div>
              }
            />
          )}

          {committed && (
            <Outcome result={committed} reconciles={analysis.reconciles} title="Imported" />
          )}
        </>
      )}

      {batches.length > 0 && (
        <Panel
          title="Batches"
          subtitle="What has actually been loaded. Reversing a batch removes what it created and reverses what it posted"
        >
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Status</th>
                  <th className="num">Rows</th>
                  <th className="num">Imported</th>
                  <th className="num">Skipped</th>
                  <th className="num">Errors</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td>
                      <div className="font-medium">{batch.name}</div>
                      <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                        {batch.fileName ?? '—'} · {new Date(batch.createdAt).toLocaleString()}
                      </div>
                    </td>
                    <td>
                      {batch.status === 'COMPLETED' ? (
                        <Flag tone="good">completed</Flag>
                      ) : batch.status === 'ROLLED_BACK' ? (
                        <span style={{ color: 'var(--ink-2)' }}>reversed</span>
                      ) : batch.status === 'DRY_RUN' ? (
                        <span style={{ color: 'var(--ink-2)' }}>dry run</span>
                      ) : (
                        <Flag tone="serious">{batch.status.toLowerCase()}</Flag>
                      )}
                    </td>
                    <td className="num">{batch.totalRows}</td>
                    <td className="num">{batch.importedRows}</td>
                    <td className="num">{batch.skippedRows}</td>
                    <td className="num">{batch.errorRows}</td>
                    <td className="num">
                      {batch.status === 'COMPLETED' && (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void rollback(batch.id)}
                          className="rounded-lg border px-2.5 py-1 text-sm font-semibold disabled:opacity-40"
                          style={{ borderColor: 'var(--hairline)' }}
                        >
                          Reverse
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

/** What the file turned out to be, and the two guesses worth letting someone overrule. */
function Detected({
  analysis,
  fileName,
  onHeaderRow,
  onDateOrder,
}: {
  analysis: Analysis;
  fileName: string | null;
  onHeaderRow: (row: number) => void;
  onDateOrder: (order: 'MDY' | 'DMY' | 'YMD') => void;
}) {
  // A customer list has no dates and no amounts in it. Telling an operator how its dates
  // were read — and asking them to settle an ambiguity that cannot affect anything — is
  // noise that teaches them to skip this panel, which is where the real questions are.
  const mapped = new Set(Object.keys(analysis.mapping.fieldMap));
  const hasDates = analysis.fields.some((f) => f.type === 'date' && mapped.has(f.key));
  const hasMoney = analysis.fields.some((f) => f.type === 'money' && mapped.has(f.key));

  const delimiterName =
    analysis.delimiter === ','
      ? 'comma'
      : analysis.delimiter === '\t'
        ? 'tab'
        : analysis.delimiter === ';'
          ? 'semicolon'
          : analysis.delimiter === '|'
            ? 'pipe'
            : analysis.delimiter;

  return (
    <Panel title={`What we found in ${fileName ?? 'the file'}`} subtitle={analysis.entityLabel}>
      <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Rows" value={analysis.totalRows.toLocaleString()} note={`${delimiterName}-separated`} />
        <Fact
          label="Headings on line"
          value={String(analysis.headerOffset + 1)}
          note={analysis.headerOffset > 0 ? 'a title block was skipped' : 'first line'}
          control={
            <label className="mt-1 block text-xs" style={{ color: 'var(--ink-2)' }}>
              Wrong line?{' '}
              <input
                type="number"
                min={0}
                defaultValue={analysis.headerRow}
                onBlur={(event) => onHeaderRow(Number(event.target.value))}
                className="w-16 rounded border px-1"
                style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
              />
            </label>
          }
        />
        {hasDates && (
          <Fact
            label="Dates read as"
            value={
              analysis.mapping.dateOrder === 'MDY'
                ? 'month/day/year'
                : analysis.mapping.dateOrder === 'DMY'
                  ? 'day/month/year'
                  : 'year-month-day'
            }
            note={analysis.mapping.dateOrderAmbiguous ? undefined : 'proved by the data'}
            control={
              analysis.mapping.dateOrderAmbiguous ? (
                <div className="mt-1">
                  {/* Every date in the sample is under the thirteenth, so the file cannot
                      say which way round it is. Guessing silently is how an invoice dated
                      the third of April lands in March. */}
                  <Flag tone="serious">the file cannot say — choose</Flag>
                  <div className="mt-1 flex gap-2 text-xs">
                    {(['MDY', 'DMY', 'YMD'] as const).map((order) => (
                      <button
                        key={order}
                        type="button"
                        onClick={() => onDateOrder(order)}
                        className="rounded border px-2 py-0.5 font-semibold"
                        style={{
                          borderColor:
                            analysis.mapping.dateOrder === order ? 'var(--seq)' : 'var(--hairline)',
                        }}
                      >
                        {order === 'MDY' ? 'M/D/Y' : order === 'DMY' ? 'D/M/Y' : 'Y-M-D'}
                      </button>
                    ))}
                  </div>
                </div>
              ) : undefined
            }
          />
        )}
        {hasMoney && (
          <Fact
            label="Decimals"
            value={analysis.mapping.decimalSeparator === ',' ? '1.234,56' : '1,234.56'}
            note="from the money columns"
          />
        )}
      </div>

      {(analysis.raggedRows.length > 0 || analysis.existing > 0) && (
        <div className="space-y-1 px-4 pb-4 text-sm">
          {analysis.raggedRows.length > 0 && (
            <Flag tone="serious">
              {analysis.raggedRows.length} row
              {analysis.raggedRows.length === 1 ? ' has' : 's have'} a different number of columns
              — first at line {analysis.raggedRows[0].line}
            </Flag>
          )}
          {analysis.existing > 0 && (
            <p style={{ color: 'var(--ink-2)' }}>
              {analysis.existing.toLocaleString()} record
              {analysis.existing === 1 ? ' is' : 's are'} already here. Rows carrying a source
              system id update the matching record instead of adding a second one.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

function Fact({
  label,
  value,
  note,
  control,
}: {
  label: string;
  value: string;
  note?: string;
  control?: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </p>
      <p className="mt-0.5 text-lg font-semibold">{value}</p>
      {note && (
        <p className="text-xs" style={{ color: 'var(--ink-2)' }}>
          {note}
        </p>
      )}
      {control}
    </div>
  );
}

/**
 * The mapping table, listed by target field rather than by source column.
 *
 * The question an operator is answering is "where does the invoice number come from",
 * not "what shall I do with column 7" — and a required field nothing feeds has to be
 * visible as a gap, which a list of source columns cannot show.
 */
function Mapping({
  analysis,
  onChange,
}: {
  analysis: Analysis;
  onChange: (fieldKey: string, columnIndex: number | null) => void;
}) {
  const byIndex = new Map(analysis.mapping.columns.map((column) => [column.columnIndex, column]));
  const unmapped = analysis.header
    .map((heading, index) => ({ heading, index }))
    .filter(({ index }) => !Object.values(analysis.mapping.fieldMap).includes(index));

  return (
    <Panel
      title="Columns"
      subtitle="Matched automatically, with the reason. Change anything that looks wrong and the checks below rerun"
    >
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Comes from</th>
              <th>How we matched it</th>
              <th>First values</th>
            </tr>
          </thead>
          <tbody>
            {analysis.fields.map((field) => {
              const columnIndex = analysis.mapping.fieldMap[field.key];
              const proposal = columnIndex === undefined ? null : byIndex.get(columnIndex);
              const missing = field.required && columnIndex === undefined;
              const samples =
                columnIndex === undefined
                  ? []
                  : analysis.preview
                      .slice(0, 3)
                      .map((row) => row[columnIndex] ?? '')
                      .filter((value) => value !== '');

              return (
                <tr key={field.key}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{field.label}</span>
                      {field.required && (
                        <span className="text-xs" style={{ color: 'var(--ink-muted)' }}>
                          required
                        </span>
                      )}
                    </div>
                    {field.help && (
                      <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                        {field.help}
                      </div>
                    )}
                  </td>
                  <td>
                    <select
                      value={columnIndex ?? ''}
                      onChange={(event) =>
                        onChange(field.key, event.target.value === '' ? null : Number(event.target.value))
                      }
                      className="max-w-56 rounded-lg border px-2 py-1 text-sm"
                      style={{
                        borderColor: missing ? 'var(--critical)' : 'var(--hairline)',
                        background: 'var(--surface)',
                      }}
                    >
                      <option value="">— nothing —</option>
                      {analysis.header.map((heading, index) => (
                        <option key={index} value={index}>
                          {heading || `Column ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                    {missing ? (
                      <Flag tone="critical">nothing feeds this</Flag>
                    ) : proposal ? (
                      // Confidence is shown as words, because a number between 0 and 1 is
                      // not a thing anyone can act on.
                      <>
                        {proposal.confidence >= 0.9
                          ? 'certain'
                          : proposal.confidence >= 0.7
                            ? 'likely'
                            : 'worth checking'}{' '}
                        — {proposal.reason}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                    {samples.join(' · ') || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {unmapped.length > 0 && (
        <p className="px-4 py-3 text-sm" style={{ color: 'var(--ink-2)' }}>
          Not used: {unmapped.map((column) => column.heading || `Column ${column.index + 1}`).join(', ')}.
          Nothing is lost — the file stays as it is.
        </p>
      )}
    </Panel>
  );
}

function Issues({
  issues,
  title,
  subtitle,
}: {
  issues: { line: number; field?: string; severity: string; message: string; value?: string }[];
  title: string;
  subtitle?: string;
}) {
  const errors = issues.filter((issue) => issue.severity === 'ERROR');
  const warnings = issues.filter((issue) => issue.severity !== 'ERROR');

  /*
   * One row per distinct problem, not per occurrence. A column the file spells its own way
   * produces the same note on every line, and twenty identical rows bury the one thing on
   * the screen that actually needs somebody's attention. The line number of the first is
   * enough to find it; the count says how much of the file it is.
   */
  const grouped: {
    issue: (typeof issues)[number];
    count: number;
    lastLine: number;
  }[] = [];
  const seen = new Map<string, number>();

  for (const issue of [...errors, ...warnings]) {
    const key = `${issue.severity}|${issue.field ?? ''}|${issue.message}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, grouped.length);
      grouped.push({ issue, count: 1, lastLine: issue.line });
    } else {
      grouped[at].count++;
      grouped[at].lastLine = issue.line;
    }
  }

  const shown = grouped.slice(0, 40);

  return (
    <Panel
      title={title}
      subtitle={
        subtitle ??
        `${errors.length} would be skipped, ${warnings.length} would come across with a note`
      }
    >
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th className="num">Line</th>
              <th>Field</th>
              <th>What is wrong</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ issue, count, lastLine }, index) => (
              <tr key={`${issue.line}-${issue.field ?? ''}-${index}`}>
                <td className="num">
                  {issue.line}
                  {count > 1 && (
                    <span className="block text-xs" style={{ color: 'var(--ink-3)' }}>
                      to {lastLine}
                    </span>
                  )}
                </td>
                <td className="text-sm">{issue.field ?? '—'}</td>
                <td>
                  {issue.severity === 'ERROR' ? (
                    <Flag tone="critical">{issue.message}</Flag>
                  ) : (
                    <span style={{ color: 'var(--ink-2)' }}>{issue.message}</span>
                  )}
                  {count > 1 && (
                    <span className="ml-2 text-xs" style={{ color: 'var(--ink-3)' }}>
                      on {count} rows
                    </span>
                  )}
                </td>
                <td className="text-sm" style={{ color: 'var(--ink-3)' }}>
                  {issue.value ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {grouped.length > shown.length && (
        <p className="px-4 py-3 text-sm" style={{ color: 'var(--ink-2)' }}>
          and {grouped.length - shown.length} more kinds of problem.
        </p>
      )}
    </Panel>
  );
}

function Preview({ analysis }: { analysis: Analysis }) {
  const mapped = Object.entries(analysis.mapping.fieldMap).sort((a, b) => a[1] - b[1]);
  const labelOf = (key: string) => analysis.fields.find((f) => f.key === key)?.label ?? key;

  return (
    <Panel
      title="What it will look like"
      subtitle="The first rows, under the names this system uses rather than the file's"
    >
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              {mapped.map(([key]) => (
                <th key={key}>{labelOf(key)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {analysis.preview.map((row, index) => (
              <tr key={index}>
                {mapped.map(([key, columnIndex]) => (
                  <td key={key} className="whitespace-nowrap text-sm">
                    {row[columnIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** The outcome of a run, real or rehearsed, and the proof that the totals agree. */
function Outcome({
  result,
  reconciles,
  title,
  footer,
}: {
  result: RunResult;
  reconciles: boolean;
  title: string;
  footer?: React.ReactNode;
}) {
  const reconciliation = result.reconciliation;
  const difference = BigInt(reconciliation.sourceTotalCents) - BigInt(reconciliation.importedTotalCents);

  return (
    <Panel
      title={title}
      subtitle={result.dryRun ? 'Nothing was written — the transaction was rolled back' : undefined}
    >
      <div className="grid gap-4 px-4 pb-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label={result.dryRun ? 'Would add' : 'Added'} value={result.imported.toLocaleString()} />
        <Fact label={result.dryRun ? 'Would update' : 'Updated'} value={result.updated.toLocaleString()} />
        <Fact
          label="Skipped"
          value={result.skipped.toLocaleString()}
          note={result.errorRows > 0 ? `${result.errorRows} could not be read` : undefined}
        />
        <Fact label="Rows in file" value={result.totalRows.toLocaleString()} />
      </div>

      {reconciles && (
        <div className="px-4 pb-4">
          <div className="rounded-xl border p-3" style={{ borderColor: 'var(--hairline)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">Does it tie?</h3>
              {reconciliation.matches && reconciliation.isBalanced ? (
                <Flag tone="good">the totals agree</Flag>
              ) : (
                <Flag tone="critical">
                  {reconciliation.matches
                    ? 'does not balance'
                    : `out by ${money(difference.toString())}`}
                </Flag>
              )}
            </div>
            <ul className="mt-2 space-y-0.5 text-sm" style={{ color: 'var(--ink-2)' }}>
              {reconciliation.lines.map((line, index) => (
                <li key={index} className="tabular-nums">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {result.notes.length > 0 && (
        <ul className="space-y-0.5 px-4 pb-4 text-sm" style={{ color: 'var(--ink-2)' }}>
          {result.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}

      {result.issues.length > 0 && (
        <div className="px-4 pb-4">
          <Issues issues={result.issues} title="Rows that did not come across" />
        </div>
      )}

      {footer && <div className="px-4 pb-4">{footer}</div>}
    </Panel>
  );
}
