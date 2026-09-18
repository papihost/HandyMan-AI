'use client';

import { useEffect } from 'react';

/** A bottom sheet: reachable with a thumb, unlike a centred dialog on a 10-inch screen. */
export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card relative z-10 flex max-h-[88dvh] w-full max-w-2xl flex-col rounded-b-none sm:rounded-b-2xl"
      >
        <header className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: 'var(--color-line)' }}>
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="tap rounded-lg px-3 text-2xl leading-none" aria-label="Close">
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <footer className="border-t px-5 py-4" style={{ borderColor: 'var(--color-line)' }}>
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
