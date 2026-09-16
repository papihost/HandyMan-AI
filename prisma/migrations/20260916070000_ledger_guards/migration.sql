-- Ledger integrity guards.
--
-- These are enforced in the database, not only in application code, because the
-- correctness of the books cannot depend on every future code path remembering to
-- check. Application-layer validation gives good error messages; these give the
-- guarantee.

-- ---------------------------------------------------------------------------
-- 1. A journal line is either a debit or a credit, never both, never negative,
--    and never zero on both sides.
-- ---------------------------------------------------------------------------
ALTER TABLE "JournalLine"
  ADD CONSTRAINT "JournalLine_amounts_nonnegative"
  CHECK ("debitCents" >= 0 AND "creditCents" >= 0);

ALTER TABLE "JournalLine"
  ADD CONSTRAINT "JournalLine_single_sided"
  CHECK (
    ("debitCents" > 0 AND "creditCents" = 0)
    OR ("creditCents" > 0 AND "debitCents" = 0)
  );

-- ---------------------------------------------------------------------------
-- 2. Debits must equal credits for every posted entry.
--
--    A deferred constraint trigger, so lines may be inserted one at a time inside a
--    transaction and the balance is verified once at COMMIT. An unbalanced entry can
--    never reach a committed state, whatever wrote it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_journal_entry_balanced()
RETURNS TRIGGER AS $$
DECLARE
  v_entry_id   TEXT;
  v_debits     BIGINT;
  v_credits    BIGINT;
  v_line_count INTEGER;
  v_posted_at  TIMESTAMP(3);
BEGIN
  v_entry_id := COALESCE(NEW."journalEntryId", OLD."journalEntryId");

  SELECT "postedAt" INTO v_posted_at FROM "JournalEntry" WHERE "id" = v_entry_id;
  -- The entry may have been deleted in this same transaction (draft cleanup).
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- Unposted drafts are allowed to be lopsided while they are being built.
  IF v_posted_at IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("debitCents"), 0), COALESCE(SUM("creditCents"), 0), COUNT(*)
    INTO v_debits, v_credits, v_line_count
    FROM "JournalLine" WHERE "journalEntryId" = v_entry_id;

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % is posted with % line(s); at least 2 are required',
      v_entry_id, v_line_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'Journal entry % is out of balance: debits % <> credits %',
      v_entry_id, v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "JournalLine_balanced"
  AFTER INSERT OR UPDATE OR DELETE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_entry_balanced();

-- Posting an entry must also verify it balances (the lines may already be in place).
CREATE OR REPLACE FUNCTION assert_posted_entry_balanced()
RETURNS TRIGGER AS $$
DECLARE
  v_debits     BIGINT;
  v_credits    BIGINT;
  v_line_count INTEGER;
BEGIN
  IF NEW."postedAt" IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM("debitCents"), 0), COALESCE(SUM("creditCents"), 0), COUNT(*)
    INTO v_debits, v_credits, v_line_count
    FROM "JournalLine" WHERE "journalEntryId" = NEW."id";

  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'Journal entry % is posted with % line(s); at least 2 are required',
      NEW."id", v_line_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION 'Journal entry % is out of balance: debits % <> credits %',
      NEW."id", v_debits, v_credits
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "JournalEntry_balanced"
  AFTER INSERT OR UPDATE ON "JournalEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_posted_entry_balanced();

-- ---------------------------------------------------------------------------
-- 3. Posted entries are immutable.
--
--    Once "postedAt" is set, the entry and its lines can never be altered or
--    removed. A correction is a reversing entry that references the original.
--    Only "periodId" may still be rewritten, so a period can be re-derived
--    administratively without touching any amount, account or date.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_posted_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."postedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Journal entry % is posted and cannot be deleted; post a reversing entry instead', OLD."entryNo"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."postedAt" IS NOT NULL THEN
    IF NEW."postedAt"      IS DISTINCT FROM OLD."postedAt"
    OR NEW."entryDate"     IS DISTINCT FROM OLD."entryDate"
    OR NEW."entryNo"       IS DISTINCT FROM OLD."entryNo"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."source"        IS DISTINCT FROM OLD."source"
    OR NEW."sourceType"    IS DISTINCT FROM OLD."sourceType"
    OR NEW."sourceId"      IS DISTINCT FROM OLD."sourceId"
    OR NEW."memo"          IS DISTINCT FROM OLD."memo"
    OR NEW."isReversal"    IS DISTINCT FROM OLD."isReversal"
    OR NEW."reversesEntryId" IS DISTINCT FROM OLD."reversesEntryId"
    THEN
      RAISE EXCEPTION 'Journal entry % is posted and cannot be modified; post a reversing entry instead', OLD."entryNo"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalEntry_immutable"
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_entry_mutation();

CREATE OR REPLACE FUNCTION forbid_posted_line_mutation()
RETURNS TRIGGER AS $$
DECLARE
  v_entry_id  TEXT;
  v_posted_at TIMESTAMP(3);
  v_entry_no  TEXT;
BEGIN
  v_entry_id := COALESCE(NEW."journalEntryId", OLD."journalEntryId");

  SELECT "postedAt", "entryNo" INTO v_posted_at, v_entry_no
    FROM "JournalEntry" WHERE "id" = v_entry_id;

  -- Entry gone (cascade delete of an unposted draft) -> nothing to protect.
  IF NOT FOUND THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_posted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Journal entry % is posted; its lines cannot be changed or removed', v_entry_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalLine_immutable"
  BEFORE UPDATE OR DELETE ON "JournalLine"
  FOR EACH ROW EXECUTE FUNCTION forbid_posted_line_mutation();

-- ---------------------------------------------------------------------------
-- 4. The audit log is append-only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'The audit log is append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- ---------------------------------------------------------------------------
-- 5. Reporting indexes for the GL.
-- ---------------------------------------------------------------------------
CREATE INDEX "JournalEntry_org_posted_idx" ON "JournalEntry" ("organizationId", "postedAt");
CREATE INDEX "JournalLine_account_entry_idx" ON "JournalLine" ("accountId", "journalEntryId");
