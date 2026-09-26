'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Flag } from './primitives';

const money = (cents: bigint | string) =>
  (Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });

async function post(body: Record<string, unknown>) {
  const response = await fetch('/api/reconciliations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
  return payload;
}

/**
 * Starting one.
 *
 * Two figures off the statement and nothing else: the date it was printed and what it
 * says was in the account. The opening balance is not asked for — it is whatever the last
 * statement closed on, and letting somebody type it would let them make the difference
 * come out at zero from the wrong end.
 */
export function StartReconciliation({
  accountId,
  suggestedDate,
  ledgerCents,
}: {
  accountId: string;
  suggestedDate: string;
  /** What the books say, offered as a sanity check — not as the answer. */
  ledgerCents: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [statementDate, setStatementDate] = useState(suggestedDate);
  const [closing, setClosing] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <div>
        {error && <Flag tone="critical">{error}</Flag>}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
          style={{ background: 'var(--seq)' }}
        >
          Reconcile
        </button>
      </div>
    );
  }

  const cents = (() => {
    const value = Number(closing.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(value) ? Math.round(value * 100) : 0;
  })();

  return (
    <div className="space-y-2 text-left text-sm">
      {error && <Flag tone="critical">{error}</Flag>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span style={{ color: 'var(--ink-2)' }}>Statement date</span>
          <input
            type="date"
            value={statementDate}
            onChange={(event) => setStatementDate(event.target.value)}
            className="rounded-lg border px-2 py-1"
            style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
          />
        </label>
        <label className="flex items-center gap-1.5">
          <span style={{ color: 'var(--ink-2)' }}>Closing balance</span>
          <input
            inputMode="decimal"
            value={closing}
            onChange={(event) => setClosing(event.target.value)}
            placeholder="0.00"
            className="w-32 rounded-lg border px-2 py-1 text-right tabular-nums"
            style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
          />
        </label>
      </div>
      <p style={{ color: 'var(--ink-3)' }}>
        The books say {money(ledgerCents)} is in this account today. Use the statement, not
        that — the point is to find out whether they agree.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !statementDate}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const payload = await post({
                action: 'open',
                accountId,
                statementDate,
                closingBalanceCents: String(cents),
              });
              router.push(`/office/reconcile/${payload.id}`);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'That did not work');
              setBusy(false);
            }
          }}
          className="rounded-lg px-3 py-1.5 font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--seq)' }}
        >
          {busy ? 'Opening…' : 'Start'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border px-3 py-1.5 font-semibold"
          style={{ borderColor: 'var(--hairline)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface SheetLine {
  journalLineId: string;
  entryNo: string;
  entryDate: string;
  memo: string;
  amountCents: string;
  cleared: boolean;
}

/**
 * The worksheet.
 *
 * The difference is the only number that matters and it is the largest thing on the
 * screen, because the job is finished when it reads nothing and not before. Ticking is
 * optimistic — a statement has forty lines on it and waiting for a round trip per tick
 * would make the work unbearable — and the server's answer replaces the local one.
 */
export function ReconcileSheet({
  reconciliationId,
  lines,
  openingCents,
  closingCents,
  finished,
}: {
  reconciliationId: string;
  lines: SheetLine[];
  openingCents: string;
  closingCents: string;
  finished: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, boolean>>(
    Object.fromEntries(lines.map((line) => [line.journalLineId, line.cleared])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ outstandingCount: number } | null>(null);

  const clearedMovement = lines
    .filter((line) => state[line.journalLineId])
    .reduce((total, line) => total + BigInt(line.amountCents), 0n);
  const clearedBalance = BigInt(openingCents) + clearedMovement;
  const difference = BigInt(closingCents) - clearedBalance;
  const clearedCount = lines.filter((line) => state[line.journalLineId]).length;

  const send = async (ids: string[], cleared: boolean) => {
    setError(null);
    try {
      await post({ action: 'clear', reconciliationId, journalLineIds: ids, cleared });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not save');
      // Put the ticks back the way the server has them.
      setState((current) => {
        const reverted = { ...current };
        for (const id of ids) reverted[id] = !cleared;
        return reverted;
      });
    }
  };

  if (done) {
    return (
      <div className="space-y-2">
        <Flag tone="good">
          Reconciled · {clearedCount} {clearedCount === 1 ? 'line' : 'lines'} cleared
        </Flag>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {done.outstandingCount === 0
            ? 'Nothing outstanding — the statement and the books saw exactly the same things.'
            : `${done.outstandingCount} ${done.outstandingCount === 1 ? 'item is' : 'items are'} still in transit and carry forward to the next statement.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <Flag tone="critical">{error}</Flag>}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm" style={{ color: 'var(--ink-2)' }}>
            Difference
          </div>
          <div
            className="text-3xl font-bold tabular-nums"
            style={{ color: difference === 0n ? 'var(--good)' : 'var(--critical)' }}
          >
            {money(difference)}
          </div>
          <div className="text-sm" style={{ color: 'var(--ink-3)' }}>
            {money(openingCents)} opening + {money(clearedMovement)} cleared ={' '}
            {money(clearedBalance)} · statement says {money(closingCents)}
          </div>
        </div>

        {!finished && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => {
                const ids = lines.filter((l) => !state[l.journalLineId]).map((l) => l.journalLineId);
                if (ids.length === 0) return;
                setState((current) => ({
                  ...current,
                  ...Object.fromEntries(ids.map((id) => [id, true])),
                }));
                await send(ids, true);
              }}
              className="rounded-lg border px-3 py-1.5 text-sm font-semibold"
              style={{ borderColor: 'var(--hairline)' }}
            >
              Tick everything
            </button>
            <button
              type="button"
              disabled={busy || difference !== 0n}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const payload = await post({ action: 'complete', reconciliationId });
                  setDone({ outstandingCount: payload.outstandingCount });
                  router.refresh();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'That did not work');
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: 'var(--seq)' }}
              title={difference === 0n ? undefined : 'It has to agree first'}
            >
              {busy ? 'Finishing…' : 'Finish'}
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th style={{ width: '3rem' }}>On it</th>
              <th>Date</th>
              <th>Entry</th>
              <th>What</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.journalLineId}>
                <td>
                  <input
                    type="checkbox"
                    checked={state[line.journalLineId] ?? false}
                    disabled={finished}
                    aria-label={`${line.entryNo} on the statement`}
                    onChange={async (event) => {
                      const cleared = event.target.checked;
                      setState((current) => ({ ...current, [line.journalLineId]: cleared }));
                      await send([line.journalLineId], cleared);
                    }}
                  />
                </td>
                <td>{new Date(line.entryDate).toLocaleDateString()}</td>
                <td className="text-sm">{line.entryNo}</td>
                <td className="text-sm">{line.memo}</td>
                <td className="num font-semibold tabular-nums">{money(line.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
