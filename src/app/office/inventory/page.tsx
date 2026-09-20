import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney } from '../../../lib/money';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import {
  inventoryValuation,
  negativeStock,
  reorderSuggestions,
  valuationAgainstLedger,
} from '../../../lib/inventory/reports';
import { Bar, Flag, Money, Panel, StatTile } from '../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/**
 * Inventory.
 *
 * The number at the top is the one worth the screen: what the vans and the warehouse are
 * carrying, against what the balance sheet says inventory is worth. In most shops those
 * two figures have never met, and the difference is found once a year by a stocktake.
 * Here every movement posts, so they agree — and the page says so out loud rather than
 * quietly assuming it, because a reconciliation that can only ever pass is decoration.
 */
export default async function InventoryPage() {
  const ctx = await requireContext();
  const canSeeCost = ctx.permissions.has(PERMISSIONS.FINANCE_READ_COST);

  const [valuation, reconciliation, reorders, negatives] = await Promise.all([
    canSeeCost ? inventoryValuation(db, ctx) : Promise.resolve(null),
    canSeeCost ? valuationAgainstLedger(db, ctx) : Promise.resolve(null),
    reorderSuggestions(db, ctx),
    negativeStock(db, ctx),
  ]);

  const rows = valuation?.rows ?? [];
  const maxValue = Math.max(1, ...rows.map((row) => Number(row.valueCents)));
  const vans = rows.filter((row) => row.kind === 'VAN');
  const warehouses = rows.filter((row) => row.kind !== 'VAN');

  // Which vans are short of something, so a dispatcher can load one truck rather than
  // reading a list of part numbers.
  const shortByLocation = new Map<string, number>();
  for (const suggestion of reorders) {
    shortByLocation.set(
      suggestion.stockLocationCode,
      (shortByLocation.get(suggestion.stockLocationCode) ?? 0) + 1,
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Inventory</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          Every van is a stock location, and every movement posts to the ledger
        </p>
      </div>

      {valuation && reconciliation && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="On hand"
              value={formatMoney(valuation.totalCents)}
              note="warehouse and vans"
            />
            <StatTile
              label="On the vans"
              value={formatMoney(vans.reduce((total, row) => total + row.valueCents, 0n))}
              note={`${vans.length} trucks`}
            />
            <StatTile
              label="Needs restocking"
              value={String(reorders.length)}
              tone={reorders.length > 0 ? 'warning' : 'good'}
              note={`across ${shortByLocation.size} stock ${shortByLocation.size === 1 ? 'location' : 'locations'}`}
            />
            <StatTile
              label="Negative stock"
              value={String(negatives.count)}
              tone={negatives.count > 0 ? 'critical' : 'good'}
              note={negatives.count > 0 ? 'receipts nobody entered' : 'nothing owed to the shelves'}
            />
          </div>

          <div className="panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                {reconciliation.ties ? (
                  <Flag tone="good">
                    The stock on the trucks and the stock on the balance sheet are the same
                    number
                  </Flag>
                ) : (
                  <Flag tone="critical">
                    The subledger and the balance sheet disagree by{' '}
                    {formatMoney(
                      reconciliation.differenceCents < 0n
                        ? -reconciliation.differenceCents
                        : reconciliation.differenceCents,
                    )}
                  </Flag>
                )}
                <p className="mt-1 text-sm" style={{ color: 'var(--ink-2)' }}>
                  {formatMoney(reconciliation.subledgerCents)} counted across the stock
                  locations, {formatMoney(reconciliation.ledgerCents)} in{' '}
                  {reconciliation.accounts.map((account) => account.code).join(' and ')}. Every
                  part that moves posts as it moves, so the count and the books cannot drift
                  apart between stocktakes.
                </p>
              </div>
              <div className="text-sm" style={{ color: 'var(--ink-2)' }}>
                {reconciliation.accounts.map((account) => (
                  <div key={account.code} className="whitespace-nowrap tabular-nums">
                    <Link
                      href={`/office/financials/account/${account.accountId}`}
                      style={{ color: 'var(--seq)' }}
                    >
                      {account.code}
                    </Link>{' '}
                    {account.name} <Money cents={account.balanceCents} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {valuation && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Warehouses" subtitle="What the shelves are carrying">
            <StockTable rows={warehouses} max={maxValue} short={shortByLocation} />
          </Panel>
          <Panel title="Vans" subtitle="Each truck is a stock location of its own">
            <StockTable rows={vans} max={maxValue} short={shortByLocation} />
          </Panel>
        </div>
      )}

      {reorders.length > 0 && (
        <Panel
          title="Needs restocking"
          subtitle={`${reorders.length} lines at or under the level their stock location works to — a van carries a different working stock than the warehouse, and a busy month empties one faster`}
        >
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Stock location</th>
                  <th>Item</th>
                  <th className="num">On hand</th>
                  <th className="num">Works to</th>
                  <th className="num">Suggest</th>
                </tr>
              </thead>
              <tbody>
                {reorders.slice(0, 20).map((suggestion) => (
                  <tr key={`${suggestion.stockLocationId}-${suggestion.priceBookItemId}`}>
                    <td className="font-medium">{suggestion.stockLocationCode}</td>
                    <td>
                      <Link
                        href={`/office/inventory/item/${suggestion.priceBookItemId}`}
                        style={{ color: 'var(--seq)' }}
                      >
                        {suggestion.name}
                      </Link>
                      <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                        {suggestion.sku}
                      </div>
                    </td>
                    <td className="num">
                      <Flag tone="serious">{Number(suggestion.onHand)}</Flag>
                    </td>
                    <td className="num" style={{ color: 'var(--ink-2)' }}>
                      {Number(suggestion.reorderPoint)}
                    </td>
                    <td className="num font-semibold">{Number(suggestion.suggestedQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {reorders.length > 20 && (
            <p className="px-4 py-3 text-sm" style={{ color: 'var(--ink-2)' }}>
              and {reorders.length - 20} more — open a van to load that truck rather than
              working down a list of part numbers.
            </p>
          )}
        </Panel>
      )}

      {negatives.count > 0 && (
        <Panel
          title="Negative stock"
          subtitle="Parts consumed that were never recorded as received — each line is a receipt somebody did not enter, and a material cost that was estimated rather than known"
        >
          <table>
            <thead>
              <tr>
                <th>Stock location</th>
                <th>Item</th>
                <th className="num">On hand</th>
              </tr>
            </thead>
            <tbody>
              {negatives.rows.map((row) => (
                <tr key={`${row.stockLocation.id}-${row.priceBookItem.id}`}>
                  <td className="font-medium">{row.stockLocation.code}</td>
                  <td>
                    <Link
                      href={`/office/inventory/item/${row.priceBookItem.id}`}
                      style={{ color: 'var(--seq)' }}
                    >
                      {row.priceBookItem.name}
                    </Link>
                  </td>
                  <td className="num">
                    <Flag tone="critical">{Number(row.quantity)}</Flag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {!canSeeCost && (
        <Panel title="Valuation">
          <p className="px-4 pb-4 text-sm" style={{ color: 'var(--ink-2)' }}>
            What stock is worth is a cost figure, so it needs a role that may see cost. What
            needs restocking is above, and does not.
          </p>
        </Panel>
      )}
    </div>
  );
}

function StockTable({
  rows,
  max,
  short,
}: {
  rows: { stockLocationId: string; stockLocationCode: string; stockLocationName: string; itemCount: number; valueCents: bigint }[];
  max: number;
  short: Map<string, number>;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-4 pb-4 text-sm" style={{ color: 'var(--ink-2)' }}>
        Nothing here.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>Stock location</th>
            <th className="num">Lines</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const shortCount = short.get(row.stockLocationCode) ?? 0;
            return (
              <tr key={row.stockLocationId}>
                <td>
                  <Link
                    href={`/office/inventory/${row.stockLocationId}`}
                    className="font-medium"
                    style={{ color: 'var(--seq)' }}
                  >
                    {row.stockLocationCode}
                  </Link>
                  <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                    {row.stockLocationName}
                  </div>
                  <div className="mt-1.5 max-w-44">
                    <Bar
                      value={Number(row.valueCents)}
                      max={max}
                      label={`${row.stockLocationCode}: ${formatMoney(row.valueCents)}`}
                    />
                  </div>
                  {shortCount > 0 && (
                    <div className="mt-1">
                      <Flag tone="serious">
                        {shortCount} short
                      </Flag>
                    </div>
                  )}
                </td>
                <td className="num">{row.itemCount}</td>
                <td className="num font-semibold">
                  <Money cents={row.valueCents} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
