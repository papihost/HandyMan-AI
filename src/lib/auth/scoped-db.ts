import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthContext } from './context';
import { modelIsRedacted, redactedFieldsFor } from './redaction';

/**
 * A Prisma client bound to one caller.
 *
 * Two guarantees, applied to every query that goes through it:
 *
 *   1. Tenant isolation — `organizationId` is injected into the filter of every read and
 *      write on every model that has the column, and stamped onto every create. A missing
 *      `where` clause can no longer leak another company's data.
 *   2. Cost redaction — columns listed in `redaction.ts` are removed from the query's
 *      selection for callers without `finance:read_cost` / `finance:read_margin`, so the
 *      values are never fetched, never serialized, and never appear in a query log.
 *
 * This is the backstop, not the only control. Handlers still check permissions explicitly;
 * this exists so that a route that forgets to is contained rather than catastrophic.
 */

/** Models carrying an `organizationId` column, derived from the schema rather than a hand list. */
const ORG_SCOPED_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
    .map((m) => m.name),
);

/**
 * The stored columns of each model. The redaction map also names derived fields such as
 * `grossMarginCents`, which exist on assembled DTOs but not in the database — Prisma
 * rejects an `omit` naming a column it does not have, so the query-level filter is
 * narrowed to real columns. `redactRecord` still strips the derived ones from any object
 * that carries them.
 */
const SCALAR_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    new Set(m.fields.filter((f) => f.kind !== 'object').map((f) => f.name)),
  ]),
);

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const WHERE_OPERATIONS = new Set([
  ...READ_OPERATIONS,
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn', 'upsert']);

export function isOrgScoped(model: string): boolean {
  return ORG_SCOPED_MODELS.has(model);
}

export function scopedDb(client: PrismaClient, ctx: AuthContext) {
  return client.$extends({
    name: 'handyman-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const nextArgs = (args ?? {}) as Record<string, unknown>;

          if (ORG_SCOPED_MODELS.has(model)) {
            if (WHERE_OPERATIONS.has(operation)) {
              nextArgs.where = {
                ...((nextArgs.where as object) ?? {}),
                organizationId: ctx.organizationId,
              };
            }
            if (CREATE_OPERATIONS.has(operation)) {
              stampOrganization(nextArgs, ctx.organizationId, operation);
            }
          }

          if (READ_OPERATIONS.has(operation) && modelIsRedacted(model)) {
            applyRedaction(nextArgs, model, ctx);
          }

          return query(nextArgs);
        },
      },
    },
  });
}

export type ScopedClient = ReturnType<typeof scopedDb>;

function stampOrganization(
  args: Record<string, unknown>,
  organizationId: string,
  operation: string,
): void {
  if (operation === 'upsert') {
    if (args.create && typeof args.create === 'object') {
      args.create = { ...(args.create as object), organizationId };
    }
    return;
  }

  const data = args.data;
  if (Array.isArray(data)) {
    args.data = data.map((row) => ({ ...(row as object), organizationId }));
  } else if (data && typeof data === 'object') {
    args.data = { ...(data as object), organizationId };
  }
}

/**
 * Prisma rejects `select` and `omit` used together, so honour whichever the caller chose:
 * strip redacted keys out of an explicit `select`, otherwise add them to `omit`.
 */
function applyRedaction(args: Record<string, unknown>, model: string, ctx: AuthContext): void {
  const columns = SCALAR_FIELDS.get(model);
  const fields = redactedFieldsFor(model, ctx).filter((f) => columns?.has(f) ?? false);
  if (fields.length === 0) return;

  const select = args.select as Record<string, unknown> | undefined;
  if (select) {
    for (const field of fields) delete select[field];
    // A select that named nothing but cost fields would become empty and error; keep the id.
    if (Object.keys(select).length === 0) select.id = true;
    return;
  }

  args.omit = {
    ...((args.omit as object) ?? {}),
    ...Object.fromEntries(fields.map((f) => [f, true])),
  };
}
