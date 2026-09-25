'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Flag } from './primitives';

interface PaidBill {
  billId: string;
  billNo: string;
  paymentNo: string;
  vendorName: string;
  amountCents: string;
}

const money = (cents: string) =>
  (Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });

async function pay(body: Record<string, unknown>) {
  const response = await fetch('/api/bills', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
  return payload as { paidCount: number; totalCents: string; bills: PaidBill[] };
}

/** Paying one bill, early or on its own. */
export function PayBillButton({ billId }: { billId: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<PaidBill | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done) {
    return (
      <div className="text-sm">
        <Flag tone="good">{done.paymentNo}</Flag>
      </div>
    );
  }

  return (
    <div>
      {error && <Flag tone="critical">{error}</Flag>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const payload = await pay({ billId });
            setDone(payload.bills[0]);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'That did not work');
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-lg border px-2.5 py-1 text-sm font-semibold"
        style={{ borderColor: 'var(--hairline)' }}
      >
        {busy ? 'Paying…' : 'Pay it'}
      </button>
    </div>
  );
}

/**
 * The Friday run.
 *
 * It says what it is about to spend before it spends it, and how many suppliers that
 * reaches. One press moves real money out of the operating account, so the number it
 * quotes is the number that leaves.
 */
export function PayRunButton({
  dueCount,
  dueCents,
  days,
  label,
}: {
  dueCount: number;
  dueCents: string;
  /** How far ahead this run reaches: today, or the week. */
  days: number;
  label: string;
}) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ paidCount: number; totalCents: string } | null>(null);

  if (done) {
    return (
      <Flag tone="good">
        {done.paidCount} {done.paidCount === 1 ? 'bill' : 'bills'} paid · {money(done.totalCents)}
      </Flag>
    );
  }

  if (!asking) {
    return (
      <div>
        {error && <Flag tone="critical">{error}</Flag>}
        <button
          type="button"
          disabled={dueCount === 0}
          onClick={() => setAsking(true)}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--seq)' }}
        >
          {label}
        </button>
      </div>
    );
  }

  return (
    <div className="text-right text-sm">
      <p style={{ color: 'var(--ink-2)' }}>
        {money(dueCents)} leaves the operating account, across {dueCount}{' '}
        {dueCount === 1 ? 'bill' : 'bills'}.
      </p>
      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const payload = await pay({ action: 'payRun', days });
              setDone({ paidCount: payload.paidCount, totalCents: payload.totalCents });
              router.refresh();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : 'That did not work');
              setAsking(false);
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--seq)' }}
        >
          {busy ? 'Paying…' : 'Yes, pay them'}
        </button>
        <button
          type="button"
          onClick={() => setAsking(false)}
          className="rounded-lg border px-3 py-1.5 text-sm font-semibold"
          style={{ borderColor: 'var(--hairline)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
