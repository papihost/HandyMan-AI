'use client';

/** The browser is the PDF writer: what it prints is exactly what the page says. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg px-4 py-2 text-sm font-semibold text-white"
      style={{ background: '#2563eb' }}
    >
      Print or save as PDF
    </button>
  );
}
