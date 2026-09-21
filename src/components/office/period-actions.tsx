'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Flag } from './primitives';

/**
 * Closing a month, and reopening one.
 *
 * Closing is one button, because there is nothing to say: the checks are on the screen
 * above it. Reopening asks for a reason first and will not proceed without one — it is
 * the rarer and more serious of the two, and the reason is the whole record.
 */
export function PeriodActions({
  periodId,
  label,
  status,
  canClose,
  canReopen,
  blocked,
  warnings,
}: {
  periodId: string;
  label: string;
  status: string;
  canClose: boolean;
  canReopen: boolean;
  blocked: string | null;
  warnings: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');

  const send = async (action: 'close' | 'reopen', body: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/periods', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ periodId, action, ...body }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'That did not work');
      setAsking(false);
      setReason('');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'LOCKED') {
    return (
      <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
        Locked — this month can never be reopened
      </span>
    );
  }

  return (
    <div className="space-y-2">
      {error && <Flag tone="critical">{error}</Flag>}

      {status === 'OPEN' && canClose && (
        <button
          type="button"
          disabled={busy || blocked !== null}
          onClick={() => void send('close')}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--seq)' }}
        >
          {busy ? 'Closing…' : `Close ${label}`}
        </button>
      )}

      {status === 'OPEN' && blocked && <Flag tone="serious">{blocked} is still open</Flag>}

      {status === 'OPEN' && canClose && warnings > 0 && !blocked && (
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {warnings === 1
            ? 'You can close over the warning above. It will not go away, it will just be harder to fix.'
            : 'You can close over the warnings above. They will not go away, they will just be harder to fix.'}
        </p>
      )}

      {status === 'CLOSED' && canReopen && !asking && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setAsking(true)}
          className="rounded-lg border px-3 py-1.5 text-sm font-semibold disabled:opacity-40"
          style={{ borderColor: 'var(--hairline)' }}
        >
          Reopen {label}
        </button>
      )}

      {status === 'CLOSED' && canReopen && asking && (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="font-medium">Why is this month being reopened?</span>
            <span className="block text-xs" style={{ color: 'var(--ink-2)' }}>
              Recorded against your name, and kept
            </span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Missed vendor bill from the 28th"
              className="mt-1 w-full rounded-lg border px-2 py-1.5 text-sm"
              style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || reason.trim().length === 0}
              onClick={() => void send('reopen', { reason })}
              className="rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: 'var(--serious)' }}
            >
              {busy ? 'Reopening…' : 'Reopen'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                setReason('');
                setError(null);
              }}
              className="rounded-lg border px-3 py-1.5 text-sm font-semibold"
              style={{ borderColor: 'var(--hairline)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
