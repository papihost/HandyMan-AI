'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, type SessionUser } from '../../client/api';
import { startAutoSync, refreshQueueDepth } from '../../client/sync';
import { SyncBadge } from '../../components/SyncBadge';

export default function FieldLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // No service worker means no offline shell, but the app still runs — worth
        // degrading quietly rather than blocking a technician's morning.
      });
    }

    const stop = startAutoSync();
    void refreshQueueDepth();
    return stop;
  }, []);

  useEffect(() => {
    let cancelled = false;

    api
      .me()
      .then(({ user: signedIn }) => {
        if (cancelled) return;
        if (!signedIn) {
          router.replace('/sign-in');
          return;
        }
        setUser(signedIn);
        setChecked(true);
      })
      .catch(() => {
        // Offline at launch. The device already holds the day's work, so it opens on what
        // it has rather than bouncing a technician to a sign-in page they cannot complete.
        if (!cancelled) setChecked(true);
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!checked) {
    return (
      <div className="flex min-h-dvh items-center justify-center text-[var(--color-ink-soft)]">
        Loading your day…
      </div>
    );
  }

  const onJob = pathname?.startsWith('/field/jobs/');

  return (
    <div className="flex min-h-dvh flex-col">
      <header
        className="sticky top-0 z-30 border-b px-4 py-3 backdrop-blur"
        style={{ borderColor: 'var(--color-line)', background: 'color-mix(in oklch, var(--color-surface) 88%, transparent)' }}
      >
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          {onJob ? (
            <Link href="/field" className="tap -ml-2 flex items-center rounded-lg px-2 font-semibold">
              ‹ My day
            </Link>
          ) : (
            <span className="font-bold">{user ? user.name.split(' ')[0] : 'Apex'}’s day</span>
          )}
          <div className="ml-auto">
            <SyncBadge />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-24 pt-4">{children}</main>
    </div>
  );
}
