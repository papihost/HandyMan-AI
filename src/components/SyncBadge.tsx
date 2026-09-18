'use client';

import { useEffect, useState } from 'react';
import { subscribe, syncNow, type SyncState } from '../client/sync';

/**
 * Sync status, always visible.
 *
 * A technician has to be able to tell, at a glance and without asking, whether their
 * morning is safely on the server. "3 waiting" is reassuring; a silent app that might or
 * might not have saved anything is what makes people photograph their own tablet screen
 * as a backup.
 */
export function SyncBadge() {
  const [state, setState] = useState<SyncState | null>(null);

  useEffect(() => subscribe(setState), []);
  if (!state) return null;

  const { online, syncing, pendingCount, unresolvedCount } = state;

  const tone = !online
    ? 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]'
    : unresolvedCount > 0
      ? 'bg-[var(--color-stop)]/15 text-[var(--color-stop)]'
      : pendingCount > 0
        ? 'bg-[var(--color-brand)]/12 text-[var(--color-brand)]'
        : 'bg-[var(--color-go)]/12 text-[var(--color-go)]';

  const label = !online
    ? pendingCount > 0
      ? `Offline · ${pendingCount} waiting`
      : 'Offline'
    : syncing
      ? 'Syncing…'
      : unresolvedCount > 0
        ? `${unresolvedCount} need${unresolvedCount === 1 ? 's' : ''} attention`
        : pendingCount > 0
          ? `${pendingCount} waiting`
          : 'All saved';

  return (
    <button
      type="button"
      onClick={() => void syncNow()}
      className={`tap inline-flex items-center gap-2 rounded-full px-4 text-sm font-semibold ${tone}`}
      aria-live="polite"
    >
      <span
        className={`size-2.5 rounded-full ${online ? 'bg-current' : 'bg-current opacity-60'} ${syncing ? 'animate-pulse' : ''}`}
        aria-hidden
      />
      {label}
    </button>
  );
}
