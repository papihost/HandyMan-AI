import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney } from '../../../lib/money';
import { flatRateReview } from '../../../lib/reporting/dashboard';
import { Flag, Money, Panel, Percent } from '../../../components/office/primitives';
import { PERMISSIONS } from '../../../lib/auth/permissions';

export const dynamic = 'force-dynamic';

/** Below this, a flat rate is not paying for the work. */
const THIN_MARGIN = 30;

export default async function PricingPage() {
  const ctx = await requireContext();

  if (!ctx.permissions.has(PERMISSIONS.FINANCE_READ_COST)) {
    return (
      <Panel title="Price book review">
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          This report compares prices against costs, so it needs a role that may see cost.
        </p>
      </Panel>
    );
  }

  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), 1));
  const rows = await flatRateReview(db, ctx, { from, to });

  const thin = rows.filter((row) => row.marginPercent < THIN_MARGIN);
  const exposure = thin.reduce(
    (total, row) => total + (row.revenueCents - row.standardCostCents),
    0n,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Price book review</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          Every flat rate billed in the last twelve months, against the standard cost it
          carried — thinnest first
        </p>
      </div>

      {thin.length > 0 && (
        <div className="panel p-4">
          <Flag tone="critical">
            {thin.length} flat {thin.length === 1 ? 'rate is' : 'rates are'} priced under{' '}
            {THIN_MARGIN}%
          </Flag>
          <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
            {formatMoney(thin.reduce((total, row) => total + row.revenueCents, 0n))} billed on
            them, leaving {formatMoney(exposure)} to cover everything the standard cost does
            not — overhead, warranty, and the drive there. A price set once and never
            revisited does not announce itself anywhere else.
          </p>
        </div>
      )}

      <Panel
        title="Flat rates"
        subtitle="Billed price against the standard cost on the line, by item and by branch"
      >
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Trade</th>
                <th className="num">Sold</th>
                <th className="num">Billed</th>
                <th className="num">Standard cost</th>
                <th className="num">Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.priceBookItemId}>
                  <td>
                    <div className="font-medium">{row.name}</div>
                    <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                      {row.sku}
                    </div>
                    {/* A branch selling the same item at its own price is where a company
                        average stops being the truth. Only shown when they disagree. */}
                    {row.branches.length > 1 &&
                      Math.round(row.branches[0].marginPercent) !==
                        Math.round(row.branches[row.branches.length - 1].marginPercent) && (
                        <div className="mt-1 text-xs" style={{ color: 'var(--ink-2)' }}>
                          {row.branches.map((branch) => (
                            <span key={branch.locationId} className="mr-3 whitespace-nowrap">
                              {branch.locationName} {branch.marginPercent.toFixed(1)}%
                            </span>
                          ))}
                        </div>
                      )}
                  </td>
                  <td>{row.serviceName}</td>
                  <td className="num">{row.timesSold}</td>
                  <td className="num">
                    <Money cents={row.revenueCents} />
                  </td>
                  <td className="num">
                    <Money cents={row.standardCostCents} />
                  </td>
                  <td className="num font-semibold">
                    {row.marginPercent < THIN_MARGIN ? (
                      <Flag tone={row.marginPercent < 10 ? 'critical' : 'serious'}>
                        {row.marginPercent.toFixed(1)}%
                      </Flag>
                    ) : (
                      <Percent value={row.marginPercent} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
