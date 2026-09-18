import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Apex Field',
  description: 'Field service app for handyman technicians',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'Apex Field' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // A technician taps a signature pad and a quantity stepper; a stray double-tap must not
  // zoom the page out from under them.
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#2563eb',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
