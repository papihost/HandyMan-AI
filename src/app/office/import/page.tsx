import { requireContext } from '../../../server/session';
import { PERMISSIONS } from '../../../lib/auth/permissions';
import { ImportWizard } from '../../../components/office/import-wizard';
import { Panel } from '../../../components/office/primitives';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const ctx = await requireContext();

  if (!ctx.permissions.has(PERMISSIONS.IMPORT_RUN)) {
    return (
      <Panel title="Data migration">
        <p className="px-4 pb-4 text-sm" style={{ color: 'var(--ink-2)' }}>
          Bringing a company across writes to the ledger, so it needs a role that may post.
          Ask a controller or the owner to run it.
        </p>
      </Panel>
    );
  }

  // The cutover defaults to today, which is right for a migration done on the day. It is
  // the field most likely to be changed, so it is a date input rather than an assumption.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Data migration</h1>
        <p className="text-sm" style={{ color: 'var(--ink-2)' }}>
          Bring a company across from its old system. Every step shows what it is about to
          do before it does it, and nothing is written until you say so
        </p>
      </div>

      <ImportWizard cutoverDefault={today} />
    </div>
  );
}
