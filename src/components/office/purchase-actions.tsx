'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Flag } from './primitives';

/**
 * Turning the restock list into orders, and receiving them when they turn up.
 *
 * Both are one button. There is nothing to configure: what to buy is on the screen above,
 * and who to buy it from is on the part. The interesting decisions were made earlier.
 */
export function RaiseOrdersButton({ shortCount }: { shortCount: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ count: number; unassigned: number } | null>(null);

  const raise = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/purchase-orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'raiseFromReorder' }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
      setDone({ count: payload.created.length, unassigned: payload.unassigned.length });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="text-sm">
        <Flag tone="good">
          {done.count} purchase {done.count === 1 ? 'order' : 'orders'} raised and sent
        </Flag>
        {done.unassigned > 0 && (
          <p className="mt-1" style={{ color: 'var(--ink-2)' }}>
            {done.unassigned} {done.unassigned === 1 ? 'part has' : 'parts have'} no supplier on
            the price book, so {done.unassigned === 1 ? 'it was' : 'they were'} left out rather
            than guessed at.
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      {error && <Flag tone="critical">{error}</Flag>}
      <button
        type="button"
        disabled={busy || shortCount === 0}
        onClick={() => void raise()}
        className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--seq)' }}
      >
        {busy ? 'Raising…' : 'Raise the orders'}
      </button>
    </div>
  );
}

export function ReceiveButton({ purchaseOrderId, poNo }: { purchaseOrderId: string; poNo: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [asking, setAsking] = useState(false);

  const receive = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/purchase-orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'receive',
          purchaseOrderId,
          vendorInvoiceNo: invoiceNo.trim() || undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
      setAsking(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  if (!asking) {
    return (
      <div>
        {error && <Flag tone="critical">{error}</Flag>}
        <button
          type="button"
          onClick={() => setAsking(true)}
          className="rounded-lg border px-2.5 py-1 text-sm font-semibold"
          style={{ borderColor: 'var(--hairline)' }}
        >
          Receive
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5 text-left">
      {error && <Flag tone="critical">{error}</Flag>}
      <input
        value={invoiceNo}
        onChange={(event) => setInvoiceNo(event.target.value)}
        placeholder="Their invoice number"
        className="w-40 rounded-lg border px-2 py-1 text-sm"
        style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void receive()}
          className="rounded-lg px-2.5 py-1 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--seq)' }}
        >
          {busy ? 'Receiving…' : `Receive ${poNo}`}
        </button>
        <button
          type="button"
          onClick={() => {
            setAsking(false);
            setError(null);
          }}
          className="rounded-lg border px-2.5 py-1 text-sm font-semibold"
          style={{ borderColor: 'var(--hairline)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
