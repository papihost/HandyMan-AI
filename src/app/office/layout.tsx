import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentContext } from '../../server/session';
import { PERMISSIONS } from '../../lib/auth/permissions';

const NAV = [
  { href: '/office', label: 'Dashboard' },
  { href: '/office/dispatch', label: 'Dispatch' },
  { href: '/office/jobs', label: 'Jobs' },
  { href: '/office/invoices', label: 'Receivables' },
  { href: '/office/pricing', label: 'Pricing' },
  { href: '/office/financials', label: 'Financials' },
  { href: '/office/import', label: 'Migration' },
];

export default async function OfficeLayout({ children }: { children: React.ReactNode }) {
  const ctx = await currentContext();
  if (!ctx) redirect('/sign-in');

  // The office is not for the field. A technician who reaches this URL goes to their day
  // rather than to a permissions error they can do nothing about.
  if (!ctx.permissions.has(PERMISSIONS.REPORT_OPERATIONAL)) redirect('/field');

  return (
    <div className="office min-h-dvh">
      <header className="border-b" style={{ borderColor: 'var(--hairline)', background: 'var(--surface)' }}>
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
          <Link href="/office" className="font-bold">
            Apex Handyman
          </Link>

          <nav className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm font-medium">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} style={{ color: 'var(--ink-2)' }}>
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto text-sm" style={{ color: 'var(--ink-2)' }}>
            {ctx.displayName} · {ctx.roleKeys[0]?.replace('_', ' ').toLowerCase()}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-6">{children}</main>
    </div>
  );
}
