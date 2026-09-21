import type { JournalSource, PrismaClient } from '@prisma/client';
import type { Tx } from '../db';
import {
  ClosedPeriodError,
  ImmutableLedgerError,
  NotFoundError,
  UnbalancedEntryError,
  ValidationError,
} from '../errors';
import { requirePermission, type AuthContext } from '../auth/context';
import { PERMISSIONS } from '../auth/permissions';
import { sum, ZERO, type Cents } from '../money';
import { assertPostingAllowed } from './periods';
import { nextDocumentNumber } from './sequences';

/**
 * The posting engine.
 *
 * Every financial event in the system ends up here. Nothing writes to JournalEntry or
 * JournalLine directly. That single choke point is what makes the guarantees hold:
 * balanced, in an open period, numbered without gaps, attributed to a source document,
 * and immutable once written.
 *
 * The database enforces the same invariants independently (see the ledger_guards
 * migration). These checks exist to produce good error messages; those exist to make the
 * guarantee unconditional.
 */

export interface PostingLine {
  /** Either an account code ("1200") or an account id. Code is preferred in posting rules. */
  accountCode?: string;
  accountId?: string;
  debitCents?: Cents;
  creditCents?: Cents;
  memo?: string;

  // Dimensions. These are what make P&L-by-location and margin-by-job a query rather
  // than a reporting project.
  locationId?: string | null;
  jobId?: string | null;
  technicianId?: string | null;
  serviceTypeId?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
}

export interface PostEntryInput {
  entryDate: Date;
  source: JournalSource;
  /** The document that caused this entry, so any GL line can be traced back to it. */
  sourceType?: string;
  sourceId?: string;
  memo?: string;
  lines: PostingLine[];
  /** Applied to every line that does not set its own. */
  defaultLocationId?: string | null;
}

export interface PostedEntry {
  id: string;
  entryNo: string;
  entryDate: Date;
  postedAt: Date;
  totalCents: Cents;
  lineCount: number;
}

/**
 * Post a balanced journal entry. Runs in its own transaction unless one is supplied —
 * pass `tx` when the entry must commit atomically with the document that caused it,
 * which is almost always.
 */
export async function postJournalEntry(
  db: PrismaClient,
  ctx: AuthContext,
  input: PostEntryInput,
  tx?: Tx,
): Promise<PostedEntry> {
  requirePermission(ctx, PERMISSIONS.GL_POST);

  try {
    if (tx) return await postWithin(tx, ctx, input);
    return await db.$transaction((t) => postWithin(t, ctx, input));
  } catch (error) {
    if (error instanceof ClosedPeriodError) await recordRefusedPosting(db, ctx, input);
    throw error;
  }
}

/**
 * Somebody tried to post into a closed month.
 *
 * Refusing it is half the job. The other half is that a controller finds out — a run of
 * these is somebody backdating, and the first time anyone notices should not be the
 * audit. Written on the base client rather than the caller's transaction, because that
 * transaction is already doomed and the record has to survive its rollback.
 *
 * Logging never breaks the thing it is logging: a failure here is swallowed so the
 * caller still sees the refusal it was going to see.
 */
async function recordRefusedPosting(
  db: PrismaClient,
  ctx: AuthContext,
  input: PostEntryInput,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId === 'system' ? null : ctx.userId,
        action: 'REFUSED_POSTING',
        entityType: 'AccountingPeriod',
        entityId: input.entryDate.toISOString().slice(0, 10),
        after: {
          entryDate: input.entryDate.toISOString(),
          source: input.source,
          sourceType: input.sourceType ?? null,
          sourceId: input.sourceId ?? null,
          memo: input.memo ?? null,
          amountCents: sum(normalizeLines(input).map((line) => line.debitCents)).toString(),
        },
      },
    });
  } catch {
    // Nothing to do: the refusal itself is what the caller needs, and it is on its way.
  }
}

async function postWithin(tx: Tx, ctx: AuthContext, input: PostEntryInput): Promise<PostedEntry> {
  const lines = normalizeLines(input);
  const debits = sum(lines.map((l) => l.debitCents));
  const credits = sum(lines.map((l) => l.creditCents));
  if (debits !== credits) throw new UnbalancedEntryError(debits, credits);
  if (debits === ZERO) throw new ValidationError('A journal entry cannot post for zero');

  const period = await assertPostingAllowed(tx, ctx.organizationId, input.entryDate);
  const accountIds = await resolveAccounts(tx, ctx.organizationId, lines);
  const entryNo = await nextDocumentNumber(tx, ctx.organizationId, 'JOURNAL_ENTRY');
  const postedAt = new Date();

  const entry = await tx.journalEntry.create({
    data: {
      organizationId: ctx.organizationId,
      entryNo,
      entryDate: input.entryDate,
      postedAt,
      source: input.source,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      memo: input.memo ?? null,
      periodId: period.id,
      createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
      lines: {
        create: lines.map((line, index) => ({
          accountId: accountIds.get(line.accountCode ?? line.accountId!)!,
          lineNo: index + 1,
          debitCents: line.debitCents,
          creditCents: line.creditCents,
          memo: line.memo ?? null,
          locationId: line.locationId ?? input.defaultLocationId ?? null,
          jobId: line.jobId ?? null,
          technicianId: line.technicianId ?? null,
          serviceTypeId: line.serviceTypeId ?? null,
          customerId: line.customerId ?? null,
          vendorId: line.vendorId ?? null,
        })),
      },
    },
    select: { id: true, entryNo: true, entryDate: true, postedAt: true },
  });

  await tx.auditLog.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId === 'system' ? null : ctx.userId,
      action: 'POST',
      entityType: 'JournalEntry',
      entityId: entry.id,
      after: {
        entryNo,
        entryDate: input.entryDate.toISOString(),
        source: input.source,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        totalCents: debits.toString(),
        lines: lines.map((l) => ({
          account: l.accountCode ?? l.accountId,
          debit: l.debitCents.toString(),
          credit: l.creditCents.toString(),
        })),
      },
    },
  });

  return {
    id: entry.id,
    entryNo: entry.entryNo,
    entryDate: entry.entryDate,
    postedAt: entry.postedAt!,
    totalCents: debits,
    lineCount: lines.length,
  };
}

interface NormalizedLine extends PostingLine {
  debitCents: Cents;
  creditCents: Cents;
}

function normalizeLines(input: PostEntryInput): NormalizedLine[] {
  if (!input.lines || input.lines.length < 2) {
    throw new ValidationError('A journal entry requires at least two lines');
  }

  return input.lines.map((line, index) => {
    const debit = line.debitCents ?? ZERO;
    const credit = line.creditCents ?? ZERO;
    const where = `line ${index + 1}`;

    if (!line.accountCode && !line.accountId) {
      throw new ValidationError(`${where}: an account code or id is required`);
    }
    if (debit < ZERO || credit < ZERO) {
      throw new ValidationError(
        `${where}: amounts must be positive. Reverse the side instead of using a negative.`,
      );
    }
    if (debit > ZERO && credit > ZERO) {
      throw new ValidationError(`${where}: a line is either a debit or a credit, never both`);
    }
    if (debit === ZERO && credit === ZERO) {
      throw new ValidationError(`${where}: a line cannot be zero on both sides`);
    }

    return { ...line, debitCents: debit, creditCents: credit };
  });
}

/** Map every referenced account code or id to a verified account id in this organization. */
async function resolveAccounts(
  tx: Tx,
  organizationId: string,
  lines: NormalizedLine[],
): Promise<Map<string, string>> {
  const codes = [...new Set(lines.map((l) => l.accountCode).filter((c): c is string => !!c))];
  const ids = [...new Set(lines.map((l) => l.accountId).filter((i): i is string => !!i))];

  const accounts = await tx.account.findMany({
    where: {
      organizationId,
      OR: [
        ...(codes.length ? [{ code: { in: codes } }] : []),
        ...(ids.length ? [{ id: { in: ids } }] : []),
      ],
    },
    select: { id: true, code: true, isActive: true, name: true },
  });

  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const resolved = new Map<string, string>();

  for (const code of codes) {
    const account = byCode.get(code);
    if (!account) throw new NotFoundError(`Account with code ${code}`);
    if (!account.isActive) {
      throw new ValidationError(`Account ${code} (${account.name}) is inactive and cannot be posted to`);
    }
    resolved.set(code, account.id);
  }
  for (const id of ids) {
    const account = byId.get(id);
    if (!account) throw new NotFoundError('Account', id);
    if (!account.isActive) {
      throw new ValidationError(`Account ${account.code} (${account.name}) is inactive and cannot be posted to`);
    }
    resolved.set(id, account.id);
  }

  return resolved;
}

/**
 * Reverse a posted entry.
 *
 * This is the only way to undo anything in the ledger. The original stays exactly as it
 * was posted; the reversal is a new entry with the sides swapped, linked back to it. The
 * pair nets to zero and both remain visible, which is precisely what an auditor wants to
 * see and what an edit would have destroyed.
 */
export async function reverseJournalEntry(
  db: PrismaClient,
  ctx: AuthContext,
  entryId: string,
  options: { entryDate?: Date; memo?: string } = {},
): Promise<PostedEntry> {
  requirePermission(ctx, PERMISSIONS.GL_REVERSE);

  return db.$transaction(async (tx) => {
    const original = await tx.journalEntry.findFirst({
      where: { id: entryId, organizationId: ctx.organizationId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!original) throw new NotFoundError('Journal entry', entryId);
    if (!original.postedAt) {
      throw new ValidationError('That entry was never posted, so there is nothing to reverse');
    }

    const existing = await tx.journalEntry.findFirst({
      where: { reversesEntryId: entryId, organizationId: ctx.organizationId },
      select: { entryNo: true },
    });
    if (existing) {
      throw new ValidationError(
        `Entry ${original.entryNo} has already been reversed by ${existing.entryNo}`,
      );
    }

    const entryDate = options.entryDate ?? original.entryDate;
    const period = await assertPostingAllowed(tx, ctx.organizationId, entryDate);
    const entryNo = await nextDocumentNumber(tx, ctx.organizationId, 'JOURNAL_ENTRY');
    const postedAt = new Date();

    const reversal = await tx.journalEntry.create({
      data: {
        organizationId: ctx.organizationId,
        entryNo,
        entryDate,
        postedAt,
        source: 'REVERSAL',
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        memo: options.memo ?? `Reversal of ${original.entryNo}`,
        periodId: period.id,
        isReversal: true,
        reversesEntryId: original.id,
        createdByUserId: ctx.userId === 'system' ? null : ctx.userId,
        lines: {
          // Sides swapped; dimensions preserved so the reversal lands in the same
          // location, job and service line as the entry it undoes.
          create: original.lines.map((line) => ({
            accountId: line.accountId,
            lineNo: line.lineNo,
            debitCents: line.creditCents,
            creditCents: line.debitCents,
            memo: line.memo,
            locationId: line.locationId,
            jobId: line.jobId,
            technicianId: line.technicianId,
            serviceTypeId: line.serviceTypeId,
            customerId: line.customerId,
            vendorId: line.vendorId,
          })),
        },
      },
      select: { id: true, entryNo: true, entryDate: true, postedAt: true },
    });

    const total = sum(original.lines.map((l) => l.debitCents));

    await tx.auditLog.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId === 'system' ? null : ctx.userId,
        action: 'REVERSE',
        entityType: 'JournalEntry',
        entityId: original.id,
        after: { reversalEntryNo: entryNo, reversalEntryId: reversal.id },
      },
    });

    return {
      id: reversal.id,
      entryNo: reversal.entryNo,
      entryDate: reversal.entryDate,
      postedAt: reversal.postedAt!,
      totalCents: total,
      lineCount: original.lines.length,
    };
  });
}

/**
 * Posted entries cannot be edited. This exists so the attempt fails with an explanation
 * rather than a raw database error, and so the intent is greppable in the codebase.
 */
export async function assertEntryMutable(tx: Tx, entryId: string): Promise<void> {
  const entry = await tx.journalEntry.findUnique({
    where: { id: entryId },
    select: { entryNo: true, postedAt: true },
  });
  if (!entry) throw new NotFoundError('Journal entry', entryId);
  if (entry.postedAt) throw new ImmutableLedgerError(entry.entryNo);
}
