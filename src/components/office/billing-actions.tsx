'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Flag } from './primitives';

interface BillResult {
  jobId: string;
  jobNo: string;
  invoiceNo?: string;
  totalCents?: string;
  depositAppliedCents?: string;
  balanceCents?: string;
  error?: string;
}

const money = (cents?: string) =>
  cents === undefined
    ? ''
    : (Number(cents) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 });

async function bill(body: Record<string, unknown>) {
  const response = await fetch('/api/invoices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
  return payload as { results: BillResult[]; billedCount: number; totalCents: string };
}

/**
 * Billing one job.
 *
 * The outcome replaces the button rather than sitting beside it: the row has been dealt
 * with, and the next thing anyone wants from it is the invoice number.
 */
export function BillJobButton({ jobId }: { jobId: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<BillResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (done?.invoiceNo) {
    return (
      <div className="text-sm">
        <Flag tone="good">{done.invoiceNo}</Flag>
        {done.depositAppliedCents && Number(done.depositAppliedCents) > 0 && (
          <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
            {money(done.depositAppliedCents)} already collected · {money(done.balanceCents)} to
            collect
          </div>
        )}
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
            const payload = await bill({ jobId });
            const row = payload.results[0];
            if (row?.error) setError(row.error);
            // Deliberately no refresh: refreshing drops this row from the list, taking
            // the invoice number it just produced with it. The row stays, showing what it
            // became, and the list is right again the next time anyone loads it.
            else setDone(row);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'That did not work');
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-lg border px-2.5 py-1 text-sm font-semibold"
        style={{ borderColor: 'var(--hairline)' }}
      >
        {busy ? 'Billing…' : 'Bill it'}
      </button>
    </div>
  );
}

/**
 * Billing the lot.
 *
 * It asks first, and it says how many and how much before it does anything, because this
 * one press posts an invoice per job to the general ledger and puts them all on a
 * customer's account. Undoing it is a void per invoice — possible, but nobody wants to
 * discover that afterwards.
 */
export function BillAllButton({ count, valueCents }: { count: number; valueCents: string }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ billedCount: number; totalCents: string; failed: BillResult[] } | null>(
    null,
  );

  if (done) {
    return (
      <div className="text-sm">
        <Flag tone="good">
          {done.billedCount} {done.billedCount === 1 ? 'invoice' : 'invoices'} issued ·{' '}
          {money(done.totalCents)}
        </Flag>
        {done.failed.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs" style={{ color: 'var(--ink-2)' }}>
            {done.failed.slice(0, 4).map((row) => (
              <li key={row.jobId}>
                {row.jobNo} — {row.error}
              </li>
            ))}
            {done.failed.length > 4 && <li>and {done.failed.length - 4} more</li>}
          </ul>
        )}
      </div>
    );
  }

  if (!asking) {
    return (
      <div>
        {error && <Flag tone="critical">{error}</Flag>}
        <button
          type="button"
          disabled={count === 0}
          onClick={() => setAsking(true)}
          className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--seq)' }}
        >
          Bill all {count}
        </button>
      </div>
    );
  }

  return (
    <div className="text-right text-sm">
      <p style={{ color: 'var(--ink-2)' }}>
        This issues {count} {count === 1 ? 'invoice' : 'invoices'} worth {money(valueCents)}{' '}
        before tax and posts {count === 1 ? 'it' : 'them'} to the ledger.
      </p>
      <div className="mt-1.5 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const payload = await bill({ action: 'billAllUnbilled' });
              setDone({
                billedCount: payload.billedCount,
                totalCents: payload.totalCents,
                failed: payload.results.filter((row) => row.error),
              });
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
          {busy ? 'Billing…' : 'Yes, bill them'}
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
