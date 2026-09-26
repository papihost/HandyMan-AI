import Link from 'next/link';
import { db } from '../../../lib/db';
import { requireContext } from '../../../server/session';
import { formatMoney } from '../../../lib/money';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import { bankAccounts } from '../../../lib/accounting/reconciliation';
import { Flag, Money, Panel, StatTile } from '../../../components/office/primitives';
import { StartReconciliation } from '../../../components/office/reconcile-actions';

export const dynamic = 'force-dynamic';

/**
 * Reconciliation.
 *
 * Every other report in this system is a query over the postings, so it agrees with the
 * ledger by construction and proves nothing about whether the money is really there. This
 * is the one screen that checks the books against something outside them.
 */
export default async function ReconcilePage() {
  const ctx = await requireContext();
  const canReconcile = ctx.permissions.has(PERMISSIONS.BANK_RECONCILE);
  const accounts = await bankAccounts(db, ctx);

  const history = await db.bankReconciliation.findMany({
    where: { organizationId: ctx.organizationId, status: 'COMPLETE' },
    orderBy: { statementDate: 'desc' },
    take: 12,
    include: { account: { select: { code: true, name: true } }, _count: { select: { lines: true } } },
  });

  const behind = accounts.filter((account) => account.unclearedCount > 0);
  const today = new Date();
  const suggested = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0))
    .toISOString()
    .slice(0, 10);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Reconciliation</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          The books against the bank — the only check in here that comes from outside
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Accounts"
          value={String(accounts.length)}
          note="that a statement arrives for"
        />
        <StatTile
          label="Not yet on a statement"
          value={String(behind.reduce((total, account) => total + account.unclearedCount, 0))}
          note="postings waiting to clear"
        />
        <StatTile
          label="Statements reconciled"
          value={String(history.length)}
          note="most recent twelve"
        />
      </div>

      <Panel title="Accounts" subtitle="Where each one has been reconciled to, and what has happened since">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Reconciled to</th>
                <th className="num">Agreed at</th>
                <th className="num">Since then</th>
                <th className="num">Books say</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.accountId}>
                  <td>
                    <div className="font-medium">{account.name}</div>
                    <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                      {account.code}
                    </div>
                  </td>
                  <td className="text-sm">
                    {account.lastStatementDate ? (
                      account.lastStatementDate.toLocaleDateString()
                    ) : (
                      <span style={{ color: 'var(--ink-3)' }}>never</span>
                    )}
                  </td>
                  <td className="num">
                    {account.lastReconciledCents === null ? (
                      '—'
                    ) : (
                      <Money cents={account.lastReconciledCents} />
                    )}
                  </td>
                  <td className="num">
                    {account.unclearedCount === 0 ? (
                      <Flag tone="good">nothing</Flag>
                    ) : (
                      <>
                        <Money cents={account.unclearedCents} />
                        <div className="text-xs" style={{ color: 'var(--ink-3)' }}>
                          {account.unclearedCount}{' '}
                          {account.unclearedCount === 1 ? 'posting' : 'postings'}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="num font-semibold">
                    <Money cents={account.ledgerCents} />
                  </td>
                  <td className="num">
                    {account.openReconciliationId ? (
                      <Link
                        href={`/office/reconcile/${account.openReconciliationId}`}
                        className="font-semibold"
                        style={{ color: 'var(--seq)' }}
                      >
                        Carry on →
                      </Link>
                    ) : (
                      canReconcile && (
                        <StartReconciliation
                          accountId={account.accountId}
                          suggestedDate={suggested}
                          ledgerCents={account.ledgerCents.toString()}
                        />
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {history.length > 0 && (
        <Panel
          title="Reconciled"
          subtitle="Each one is a statement that agreed, and the postings it accounted for"
        >
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr>
                  <th>Statement</th>
                  <th>Account</th>
                  <th className="num">Opening</th>
                  <th className="num">Closing</th>
                  <th className="num">Lines</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/office/reconcile/${row.id}`} style={{ color: 'var(--seq)' }}>
                        {row.statementDate.toLocaleDateString()}
                      </Link>
                    </td>
                    <td className="text-sm">{row.account.name}</td>
                    <td className="num">
                      <Money cents={row.openingBalanceCents} />
                    </td>
                    <td className="num font-semibold">
                      <Money cents={row.closingBalanceCents} />
                    </td>
                    <td className="num">{row._count.lines}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <p className="text-sm" style={{ color: 'var(--ink-3)' }}>
        Statements are typed in rather than imported. A feed or a CSV would match most lines
        automatically; what it would not change is the arithmetic, which is the part worth
        having right first. Total in the accounts today:{' '}
        {formatMoney(accounts.reduce((total, account) => total + account.ledgerCents, 0n))}.
      </p>
    </div>
  );
}
