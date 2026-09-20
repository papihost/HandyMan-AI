import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../lib/db';
import { requireContext } from '../../../../server/session';
import { formatMoney, sum } from '../../../../lib/money';
import { PERMISSIONS } from '../../../../lib/auth/permissions';
import { stockOnHand } from '../../../../lib/inventory/reports';
import { Flag, Money, Panel, StatTile } from '../../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/** What one truck or one warehouse is carrying, dearest first. */
export default async function StockLocationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireContext();
  const { id } = await params;

  const location = await db.stockLocation.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: {
      id: true,
      code: true,
      name: true,
      kind: true,
      location: { select: { name: true } },
      technician: {
        select: { id: true, user: { select: { firstName: true, lastName: true } } },
      },
      inventoryAccount: { select: { id: true, code: true, name: true } },
    },
  });
  if (!location) notFound();

  const canSeeCost = ctx.permissions.has(PERMISSIONS.FINANCE_READ_COST);
  const rows = await stockOnHand(db, ctx, location.id);

  const totalValue = sum(rows.map((row) => row.valueCents));
  const low = rows.filter((row) => row.isLow);

  const who = location.technician
    ? `${location.technician.user.firstName} ${location.technician.user.lastName}`
    : null;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/office/inventory" className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
          ← Inventory
        </Link>
        <h1 className="mt-1 text-2xl font-bold">{location.code}</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {location.name} · {location.kind.toLowerCase()}
          {location.location ? ` · ${location.location.name}` : ''}
          {who ? ` · ${who}` : ''}
          {location.inventoryAccount ? (
            <>
              {' · posts to '}
              <Link
                href={`/office/financials/account/${location.inventoryAccount.id}`}
                style={{ color: 'var(--seq)' }}
              >
                {location.inventoryAccount.code} {location.inventoryAccount.name}
              </Link>
            </>
          ) : null}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Lines" value={String(rows.length)} note="part numbers carried" />
        {canSeeCost && (
          <StatTile label="Value" value={formatMoney(totalValue)} note="at moving average cost" />
        )}
        <StatTile
          label="Short"
          value={String(low.length)}
          tone={low.length > 0 ? 'warning' : 'good'}
          note={low.length > 0 ? 'at or under the working level' : 'nothing to restock'}
        />
      </div>

      <Panel
        title="On hand"
        subtitle={
          canSeeCost
            ? 'Dearest first — cost is a moving average, recomputed on every receipt'
            : 'Dearest first'
        }
      >
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">On hand</th>
                <th className="num">Works to</th>
                {canSeeCost && <th className="num">Avg cost</th>}
                {canSeeCost && <th className="num">Value</th>}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={canSeeCost ? 5 : 3} style={{ color: 'var(--ink-2)' }}>
                    Nothing on hand.
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.priceBookItemId}>
                    <td>
                      <Link
                        href={`/office/inventory/item/${row.priceBookItemId}`}
                        className="font-medium"
                        style={{ color: 'var(--seq)' }}
                      >
                        {row.name}
                      </Link>
                      <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                        {row.sku}
                        {row.binLocation ? ` · bin ${row.binLocation}` : ''}
                      </div>
                    </td>
                    <td className="num">
                      {row.isLow ? (
                        <Flag tone="serious">{Number(row.quantity)}</Flag>
                      ) : (
                        Number(row.quantity)
                      )}
                    </td>
                    <td className="num" style={{ color: 'var(--ink-2)' }}>
                      {row.reorderPoint === null ? '—' : Number(row.reorderPoint)}
                    </td>
                    {canSeeCost && (
                      <td className="num" style={{ color: 'var(--ink-2)' }}>
                        <Money cents={row.avgCostCents} />
                      </td>
                    )}
                    {canSeeCost && (
                      <td className="num font-semibold">
                        <Money cents={row.valueCents} />
                      </td>
                    )}
                  </tr>
                ))
              )}
              {canSeeCost && rows.length > 0 && (
                <tr>
                  <td className="font-semibold">Total</td>
                  <td colSpan={3} />
                  <td className="num font-semibold">
                    <Money cents={totalValue} bold />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
