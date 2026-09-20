import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '../../../../../lib/db';
import { requireContext } from '../../../../../server/session';
import { formatMoney, sum, ZERO } from '../../../../../lib/money';
import { PERMISSIONS } from '../../../../../lib/auth/permissions';
import { itemMovements } from '../../../../../lib/inventory/reports';
import { Flag, Money, Panel, StatTile } from '../../../../../components/office/primitives';

export const dynamic = 'force-dynamic';

/**
 * What an inventory figure is made of.
 *
 * Kinds in plain words, because RECEIPT and CONSUMPTION are the database's vocabulary and
 * "came in" and "used on a job" are everybody else's.
 */
const KIND: Record<string, { label: string; inbound: boolean }> = {
  RECEIPT: { label: 'Received', inbound: true },
  TRANSFER: { label: 'Moved', inbound: true },
  CONSUMPTION: { label: 'Used on a job', inbound: false },
  RETURN: { label: 'Returned unused', inbound: true },
  ADJUSTMENT: { label: 'Counted', inbound: true },
  SHRINKAGE: { label: 'Shrinkage', inbound: false },
  OPENING: { label: 'Opening balance', inbound: true },
};

export default async function ItemLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;

  const item = await db.priceBookItem.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      isStocked: true,
      costCents: true,
      priceCents: true,
      stockLevels: {
        select: {
          quantity: true,
          avgCostCents: true,
          valueCents: true,
          stockLocation: { select: { id: true, code: true, name: true, kind: true } },
        },
      },
    },
  });
  if (!item) notFound();

  const canSeeCost = ctx.permissions.has(PERMISSIONS.FINANCE_READ_COST);
  const movements = await itemMovements(db, ctx, item.id);

  const held = item.stockLevels.filter((level) => Number(level.quantity) !== 0);
  const totalQty = held.reduce((total, level) => total + Number(level.quantity), 0);
  const totalValue = sum(held.map((level) => level.valueCents));

  return (
    <div className="space-y-5">
      <div>
        <Link href="/office/inventory" className="text-sm font-semibold" style={{ color: 'var(--seq)' }}>
          ← Inventory
        </Link>
        <h1 className="mt-1 text-2xl font-bold">{item.name}</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          {item.sku} · per {item.unit}
          {item.isStocked ? ' · stocked' : ' · not stocked'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="On hand"
          value={`${totalQty.toLocaleString()} ${item.unit}`}
          note={`across ${held.length} stock ${held.length === 1 ? 'location' : 'locations'}`}
        />
        {canSeeCost && (
          <StatTile label="Value" value={formatMoney(totalValue)} note="at moving average cost" />
        )}
        <StatTile
          label="Sells for"
          value={formatMoney(item.priceCents)}
          note={canSeeCost ? `costs ${formatMoney(item.costCents)} on the price book` : undefined}
        />
      </div>

      {held.length > 0 && (
        <Panel title="Where it is" subtitle="Each van and warehouse holding any">
          <table>
            <thead>
              <tr>
                <th>Stock location</th>
                <th className="num">On hand</th>
                {canSeeCost && <th className="num">Avg cost</th>}
                {canSeeCost && <th className="num">Value</th>}
              </tr>
            </thead>
            <tbody>
              {held
                .slice()
                .sort((a, b) => Number(b.valueCents - a.valueCents))
                .map((level) => (
                  <tr key={level.stockLocation.id}>
                    <td>
                      <Link
                        href={`/office/inventory/${level.stockLocation.id}`}
                        className="font-medium"
                        style={{ color: 'var(--seq)' }}
                      >
                        {level.stockLocation.code}
                      </Link>
                      <span className="ml-2 text-sm" style={{ color: 'var(--ink-2)' }}>
                        {level.stockLocation.name}
                      </span>
                    </td>
                    <td className="num">{Number(level.quantity)}</td>
                    {canSeeCost && (
                      <td className="num" style={{ color: 'var(--ink-2)' }}>
                        <Money cents={level.avgCostCents} />
                      </td>
                    )}
                    {canSeeCost && (
                      <td className="num font-semibold">
                        <Money cents={level.valueCents} />
                      </td>
                    )}
                  </tr>
                ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel
        title="Every movement"
        subtitle="Newest first. Cost is captured as it moves, so a later change to the average never restates what a job was charged"
      >
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>What happened</th>
                <th>From → to</th>
                <th>Job</th>
                <th className="num">Qty</th>
                {canSeeCost && <th className="num">Unit cost</th>}
                {canSeeCost && <th className="num">Value</th>}
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 ? (
                <tr>
                  <td colSpan={canSeeCost ? 7 : 5} style={{ color: 'var(--ink-2)' }}>
                    Nothing has moved.
                  </td>
                </tr>
              ) : (
                movements.map((movement) => {
                  const kind = KIND[movement.kind] ?? { label: movement.kind, inbound: true };
                  return (
                    <tr key={movement.id}>
                      <td className="text-sm whitespace-nowrap">
                        {movement.occurredAt.toLocaleDateString()}
                      </td>
                      <td>
                        {kind.inbound ? (
                          <span>{kind.label}</span>
                        ) : (
                          <Flag tone="serious">{kind.label}</Flag>
                        )}
                        {movement.notes && (
                          <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                            {movement.notes}
                          </div>
                        )}
                      </td>
                      <td className="text-sm" style={{ color: 'var(--ink-2)' }}>
                        {movement.fromStockLocation?.code ?? '—'} →{' '}
                        {movement.toStockLocation?.code ?? 'the job'}
                      </td>
                      <td className="text-sm">
                        {movement.jobId && movement.job ? (
                          <Link
                            href={`/office/jobs/${movement.jobId}`}
                            style={{ color: 'var(--seq)' }}
                          >
                            {movement.job.jobNo}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num">
                        {kind.inbound ? '' : '−'}
                        {Math.abs(Number(movement.quantity))}
                      </td>
                      {canSeeCost && (
                        <td className="num" style={{ color: 'var(--ink-2)' }}>
                          <Money cents={movement.unitCostCents} />
                        </td>
                      )}
                      {canSeeCost && (
                        <td className="num">
                          {movement.totalCostCents === ZERO ? (
                            '—'
                          ) : (
                            <Money cents={movement.totalCostCents} />
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {movements.length >= 200 && (
          <p className="px-4 py-3 text-sm" style={{ color: 'var(--ink-2)' }}>
            The most recent 200 movements.
          </p>
        )}
      </Panel>
    </div>
  );
}
