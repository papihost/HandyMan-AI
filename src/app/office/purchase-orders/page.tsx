import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney, sum } from '../../../lib/money';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import { Flag, Money, Panel, StatTile } from '../../../components/office/primitives';
import { ReceiveButton } from '../../../components/office/purchase-actions';

export const dynamic = 'force-dynamic';

/*
 * An order on its way is not a problem, so it gets no colour: a screen that flags the
 * normal state has nothing left to flag the abnormal one with. A short delivery does get
 * flagged — somebody has to chase the rest.
 */
const STATUS: Record<string, { text: string; tone: 'good' | 'warning' | 'critical' | null }> = {
  DRAFT: { text: 'draft', tone: null },
  SUBMITTED: { text: 'ordered', tone: null },
  PARTIALLY_RECEIVED: { text: 'part received', tone: 'warning' },
  RECEIVED: { text: 'received', tone: 'good' },
  CLOSED: { text: 'closed', tone: 'good' },
  CANCELLED: { text: 'cancelled', tone: null },
};

/**
 * What has been ordered and not yet arrived.
 *
 * Ordering is not a cost — nothing posts until the stock is on the shelf. So this screen
 * is about what is owed to the business rather than by it: parts a van is short of that
 * somebody has already done something about, and the ones they have not.
 */
export default async function PurchaseOrdersPage() {
  const ctx = await requireContext();
  /*
   * Ordering and receiving are different authorities, and the roles already say so: a
   * branch manager may order what their vans are short of, but receiving raises a payable
   * and moves the value of stock, which is the bookkeeper's side of the house. Showing a
   * button that will be refused is worse than not showing it.
   */
  const canReceive =
    ctx.permissions.has(PERMISSIONS.PO_WRITE) &&
    ctx.permissions.has(PERMISSIONS.BILL_WRITE) &&
    ctx.permissions.has(PERMISSIONS.INVENTORY_ADJUST);

  // The tiles are the whole company; the table below is the last forty. A stat tile that
  // silently means "of the rows you can see" is a number nobody can reconcile to anything.
  const [raisedCount, receivedCount, open] = await Promise.all([
    db.purchaseOrder.count({ where: { organizationId: ctx.organizationId } }),
    db.purchaseOrder.count({
      where: { organizationId: ctx.organizationId, status: { in: ['RECEIVED', 'CLOSED'] } },
    }),
    db.purchaseOrder.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: { in: ['SUBMITTED', 'PARTIALLY_RECEIVED'] },
      },
      select: { lines: { select: { quantity: true, receivedQty: true, unitCostCents: true } } },
    }),
  ]);

  const onOrderCents = sum(
    open.flatMap((order) =>
      order.lines.map((line) => {
        const left = Number(line.quantity) - Number(line.receivedQty);
        return left <= 0 ? 0n : (line.unitCostCents * BigInt(Math.round(left * 1000))) / 1000n;
      }),
    ),
  );

  const orders = await db.purchaseOrder.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 40,
    include: {
      vendor: { select: { name: true } },
      receiveTo: { select: { id: true, code: true, name: true } },
      lines: true,
      bills: { select: { id: true, billNo: true, totalCents: true } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Purchase orders</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          Ordering costs nothing — the money moves when the stock arrives
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="On order"
          value={formatMoney(onOrderCents)}
          note={`${open.length} ${open.length === 1 ? 'order' : 'orders'} not yet in`}
        />
        <StatTile label="Raised" value={String(raisedCount)} note="orders in all" />
        <StatTile
          label="Received"
          value={String(receivedCount)}
          note="stock on the shelf, payable raised"
        />
      </div>

      <Panel
        title="Orders"
        subtitle="Newest first. Receiving one puts the stock on the shelf and the money in payables, in the same posting"
      >
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Vendor</th>
                <th>Receiving into</th>
                <th>Status</th>
                <th className="num">Lines</th>
                <th className="num">Value</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ color: 'var(--ink-2)' }}>
                    Nothing ordered yet. The{' '}
                    <Link href="/office/inventory" style={{ color: 'var(--seq)' }}>
                      restock list
                    </Link>{' '}
                    is where these come from.
                  </td>
                </tr>
              ) : (
                orders.map((order) => {
                  const badge = STATUS[order.status] ?? { text: order.status, tone: null };
                  const receivable =
                    order.status === 'SUBMITTED' || order.status === 'PARTIALLY_RECEIVED';
                  return (
                    <tr key={order.id}>
                      <td>
                        <div className="font-medium">{order.poNo}</div>
                        <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                          {order.orderedAt
                            ? `ordered ${order.orderedAt.toLocaleDateString()}`
                            : 'not sent'}
                        </div>
                      </td>
                      <td>{order.vendor.name}</td>
                      <td>
                        {order.receiveTo ? (
                          <Link
                            href={`/office/inventory/${order.receiveTo.id}`}
                            style={{ color: 'var(--seq)' }}
                          >
                            {order.receiveTo.code}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        {badge.tone ? (
                          <Flag tone={badge.tone}>{badge.text}</Flag>
                        ) : (
                          <span className="text-sm" style={{ color: 'var(--ink-2)' }}>
                            {badge.text}
                          </span>
                        )}
                        {order.bills.length > 0 && (
                          <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                            {order.bills.map((bill) => bill.billNo).join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="num">{order.lines.length}</td>
                      <td className="num font-semibold">
                        <Money cents={order.totalCents} />
                      </td>
                      <td className="num">
                        {canReceive && receivable && (
                          <ReceiveButton purchaseOrderId={order.id} poNo={order.poNo} />
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
