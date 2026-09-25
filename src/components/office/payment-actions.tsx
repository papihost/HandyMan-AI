'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Flag } from './primitives';

const money = (cents: string) =>
  (Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });

async function post(body: Record<string, unknown>) {
  const response = await fetch('/api/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
  return payload;
}

const METHODS = [
  { key: 'CHECK', label: 'Cheque', needsReference: true },
  { key: 'CARD', label: 'Card', needsReference: false },
  { key: 'ACH', label: 'Transfer', needsReference: true },
  { key: 'CASH', label: 'Cash', needsReference: false },
] as const;

/**
 * A cheque arrives in the post.
 *
 * The amount defaults to what the invoice still owes, because that is what nearly every
 * payment is, and a part payment is then one edit rather than a form to fill in. Where the
 * money lands is decided by how it came in — cash and cheques wait in undeposited funds
 * for a paying-in slip, card and transfer wait for the processor — and neither pretends to
 * be in the bank before it is.
 */
export function RecordPaymentButton({
  invoiceId,
  balanceCents,
}: {
  invoiceId: string;
  balanceCents: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<(typeof METHODS)[number]['key']>('CHECK');
  const [amount, setAmount] = useState((Number(balanceCents) / 100).toFixed(2));
  const [reference, setReference] = useState('');
  const [done, setDone] = useState<{ paymentNo: string } | null>(null);

  if (done) return <Flag tone="good">{done.paymentNo}</Flag>;

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
          Record a payment
        </button>
      </div>
    );
  }

  const cents = (() => {
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
  })();
  const selected = METHODS.find((option) => option.key === method)!;

  return (
    <div className="space-y-2 text-left text-sm">
      {error && <Flag tone="critical">{error}</Flag>}

      <div className="flex flex-wrap gap-1.5">
        {METHODS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setMethod(option.key)}
            className="rounded-lg border px-2.5 py-1 font-semibold"
            style={{
              borderColor: method === option.key ? 'var(--seq)' : 'var(--hairline)',
              color: method === option.key ? 'var(--seq)' : undefined,
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          className="w-28 rounded-lg border px-2 py-1 text-right tabular-nums"
          style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
          aria-label="Amount"
        />
        {selected.needsReference && (
          <input
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder={method === 'CHECK' ? 'Cheque number' : 'Reference'}
            className="w-40 rounded-lg border px-2 py-1"
            style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
          />
        )}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || cents <= 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const payload = await post({
                invoiceId,
                method,
                amountCents: String(cents),
                reference: reference.trim() || undefined,
              });
              setDone({ paymentNo: payload.paymentNo });
              router.refresh();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'That did not work');
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-lg px-3 py-1.5 font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--seq)' }}
        >
          {busy ? 'Recording…' : `Take ${money(String(cents))}`}
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

/**
 * The paying-in slip.
 *
 * One press, because the decision was made when somebody put the notes in an envelope:
 * everything in the drawer goes to the bank together, and the batch it makes is what the
 * statement line will be matched against.
 */
export function BankTakingsButton({
  count,
  totalCents,
}: {
  count: number;
  totalCents: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ depositNo: string; totalCents: string } | null>(null);

  if (done) {
    return (
      <Flag tone="good">
        {done.depositNo} · {money(done.totalCents)} banked
      </Flag>
    );
  }

  return (
    <div>
      {error && <Flag tone="critical">{error}</Flag>}
      <button
        type="button"
        disabled={busy || count === 0}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const payload = await post({ action: 'bank' });
            setDone({ depositNo: payload.depositNo, totalCents: payload.totalCents });
            router.refresh();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'That did not work');
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--seq)' }}
      >
        {busy ? 'Banking…' : `Bank ${money(totalCents)}`}
      </button>
    </div>
  );
}
