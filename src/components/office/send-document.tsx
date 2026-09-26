'use client';

import { useState } from 'react';
import { Flag } from './primitives';

/**
 * Sending it.
 *
 * No mail provider is connected in this build, and the button says so rather than
 * claiming to have sent something. What it does do is real: it makes the link, records
 * who it was addressed to and what it said, and hands the link over so somebody can paste
 * it into their own email in the meantime.
 */
export function SendDocument({
  type,
  documentId,
  defaultTo,
  state,
}: {
  type: 'INVOICE' | 'QUOTE';
  documentId: string;
  defaultTo: string | null;
  state: {
    sendCount: number;
    lastSentTo: string | null;
    lastSentAt: string | null;
    viewedAt: string | null;
    viewCount: number;
  };
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState(defaultTo ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ to: string; path: string } | null>(null);

  const noun = type === 'INVOICE' ? 'invoice' : 'quote';

  return (
    <div className="space-y-2 text-sm">
      {state.sendCount > 0 && !sent && (
        <div>
          {state.viewedAt ? (
            <Flag tone="good">
              Opened {new Date(state.viewedAt).toLocaleDateString()}
              {state.viewCount > 1 ? ` · ${state.viewCount} times` : ''}
            </Flag>
          ) : (
            <span style={{ color: 'var(--ink-2)' }}>
              Sent to {state.lastSentTo} · not opened yet
            </span>
          )}
        </div>
      )}

      {sent && (
        <div className="space-y-1">
          <Flag tone="good">Queued for {sent.to}</Flag>
          <p style={{ color: 'var(--ink-2)' }}>
            No mail provider is connected in this build, so it is waiting in the outbox with
            the address and the body it would go out with. The customer&apos;s link:
          </p>
          <code
            className="block truncate rounded-lg border px-2 py-1 text-xs"
            style={{ borderColor: 'var(--hairline)' }}
          >
            {typeof window !== 'undefined' ? window.location.origin : ''}
            {sent.path}
          </code>
          <a
            href={sent.path}
            target="_blank"
            rel="noreferrer"
            className="font-semibold"
            style={{ color: 'var(--seq)' }}
          >
            Open it as the customer →
          </a>
        </div>
      )}

      {!open && !sent && (
        <div>
          {error && <Flag tone="critical">{error}</Flag>}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border px-2.5 py-1 font-semibold"
            style={{ borderColor: 'var(--hairline)' }}
          >
            {state.sendCount > 0 ? 'Send again' : `Send the ${noun}`}
          </button>
        </div>
      )}

      {open && !sent && (
        <div className="space-y-2">
          {error && <Flag tone="critical">{error}</Flag>}
          <input
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="name@example.com"
            className="w-64 rounded-lg border px-2 py-1"
            style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const response = await fetch('/api/documents', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ type, documentId, to: to.trim() || undefined }),
                  });
                  const payload = await response.json();
                  if (!response.ok) {
                    throw new Error(payload?.error?.message ?? 'That did not work');
                  }
                  setSent({ to: payload.to, path: payload.path });
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'That did not work');
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-lg px-3 py-1.5 font-semibold text-white disabled:opacity-40"
              style={{ background: 'var(--seq)' }}
            >
              {busy ? 'Sending…' : 'Send'}
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
      )}
    </div>
  );
}
