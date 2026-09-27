'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Flag } from './primitives';

async function post(body: Record<string, unknown>) {
  const response = await fetch('/api/payroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
  return payload;
}

/**
 * Approving a technician's week.
 *
 * The unit is the person and the week, not the individual entry, because that is the
 * decision being made: a supervisor looks at forty-six hours with eleven of them drive
 * time and says yes or no to the lot. Individual entries can still be un-ticked below,
 * which is what the disagreements are actually about.
 */
export function ApproveWeek({
  entryIds,
  approved,
  label,
}: {
  entryIds: string[];
  /** True to approve, false to take the approval back. */
  approved: boolean;
  label: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (entryIds.length === 0) return null;

  return (
    <div className="space-y-1">
      {error && <Flag tone="critical">{error}</Flag>}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await post({ action: 'approve', entryIds, approved });
            router.refresh();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'That did not work');
          } finally {
            setBusy(false);
          }
        }}
        className="rounded-lg px-3 py-1.5 text-sm font-semibold"
        style={
          approved
            ? { background: 'var(--seq)', color: 'white', opacity: busy ? 0.6 : 1 }
            : {
                border: '1px solid var(--hairline)',
                color: 'var(--ink-2)',
                opacity: busy ? 0.6 : 1,
              }
        }
      >
        {busy ? 'Working…' : label}
      </button>
    </div>
  );
}

/**
 * Running payroll.
 *
 * This posts, so it asks twice. What it shows in between is not a summary of the form —
 * it is what the run will actually cost and relieve, because that is the number somebody
 * would want to have seen before finding it on the balance sheet.
 */
export function RunPayroll({
  periodStart,
  periodEnd,
  payDate,
  totalCostCents,
  people,
}: {
  periodStart: string;
  periodEnd: string;
  payDate: string;
  totalCostCents: string;
  people: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const money = (Number(totalCostCents) / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
  });

  if (done) {
    return <Flag tone="good">{done} posted</Flag>;
  }

  if (!confirming) {
    return (
      <div className="space-y-1">
        {error && <Flag tone="critical">{error}</Flag>}
        <button
          type="button"
          disabled={people === 0}
          onClick={() => setConfirming(true)}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
          style={{ background: 'var(--seq)', opacity: people === 0 ? 0.4 : 1 }}
        >
          Run payroll
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && <Flag tone="critical">{error}</Flag>}
      <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
        ${money} to {people} {people === 1 ? 'person' : 'people'}, paid {payDate}. This posts
        and cannot be edited afterwards.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const payload = await post({
                action: 'run',
                periodStart,
                periodEnd,
                payDate,
              });
              setDone(String(payload.runNo));
              router.refresh();
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : 'That did not work');
              setConfirming(false);
            } finally {
              setBusy(false);
            }
          }}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
          style={{ background: 'var(--seq)', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Posting…' : 'Yes, pay it'}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-sm"
          style={{ color: 'var(--ink-3)' }}
        >
          Not yet
        </button>
      </div>
    </div>
  );
}
