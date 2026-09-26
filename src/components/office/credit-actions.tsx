'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Flag } from './primitives';

const money = (cents: string) =>
  (Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });

async function post(body: Record<string, unknown>) {
  const response = await fetch('/api/invoices/credits', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
  return payload;
}

/**
 * Undoing a sale, from the invoice it happened on.
 *
 * Both of these ask for a reason before they will do anything, and neither is behind a
 * menu: the reason is the whole value of the record afterwards, and hiding the action
 * does not stop it happening, it just means somebody does it in a spreadsheet instead.
 *
 * Which one the screen offers is decided by the invoice, not by the operator — a paid
 * invoice offers only a credit, because voiding it would take away revenue the customer's
 * money is sitting against.
 */
export function UndoSaleActions({
  invoiceId,
  balanceCents,
  canVoid,
  canCredit,
}: {
  invoiceId: string;
  balanceCents: string;
  /** False once anything has been paid or credited: then a credit is the only honest move. */
  canVoid: boolean;
  canCredit: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<'none' | 'void' | 'credit'>('none');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState((Number(balanceCents) / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (done) return <Flag tone="good">{done}</Flag>;

  if (mode === 'none') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {error && <Flag tone="critical">{error}</Flag>}
        {canCredit && (
          <button
            type="button"
            onClick={() => setMode('credit')}
            className="rounded-lg border px-2.5 py-1 text-sm font-semibold"
            style={{ borderColor: 'var(--hairline)' }}
          >
            Credit it
          </button>
        )}
        {canVoid && (
          <button
            type="button"
            onClick={() => setMode('void')}
            className="rounded-lg border px-2.5 py-1 text-sm font-semibold"
            style={{ borderColor: 'var(--hairline)' }}
          >
            Void it
          </button>
        )}
      </div>
    );
  }

  const cents = (() => {
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
  })();

  return (
    <div className="space-y-2 text-left text-sm">
      {error && <Flag tone="critical">{error}</Flag>}

      <p style={{ color: 'var(--ink-2)' }}>
        {mode === 'void'
          ? 'Voiding reverses the posting and puts the work back on the job, unbilled. The invoice number stays, so the gap in the sequence has an explanation.'
          : 'A credit leaves the invoice as it was and posts a second document against it, taking the sales tax back out in proportion.'}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {mode === 'credit' && (
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            className="w-28 rounded-lg border px-2 py-1 text-right tabular-nums"
            style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
            aria-label="Amount to credit"
          />
        )}
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={mode === 'void' ? 'Why is this void?' : 'Why is this being credited?'}
          className="w-64 rounded-lg border px-2 py-1"
          style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
        />
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !reason.trim() || (mode === 'credit' && cents <= 0)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const payload = await post(
                mode === 'void'
                  ? { action: 'void', invoiceId, reason: reason.trim() }
                  : {
                      action: 'credit',
                      invoiceId,
                      reason: reason.trim(),
                      amountCents: String(cents),
                    },
              );
              setDone(
                mode === 'void'
                  ? `Voided · reversed by ${payload.reversalEntryNo}`
                  : `${payload.creditMemoNo} · ${money(payload.amountCents)} credited`,
              );
              router.refresh();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'That did not work');
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-lg px-3 py-1.5 font-semibold text-white disabled:opacity-40"
          style={{ background: mode === 'void' ? 'var(--critical)' : 'var(--seq)' }}
        >
          {busy
            ? 'Working…'
            : mode === 'void'
              ? 'Void this invoice'
              : `Credit ${money(String(cents))}`}
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('none');
            setError(null);
          }}
          className="rounded-lg border px-3 py-1.5 font-semibold"
          style={{ borderColor: 'var(--hairline)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
