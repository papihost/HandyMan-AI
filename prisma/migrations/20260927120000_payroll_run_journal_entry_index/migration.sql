-- An index nobody queries through.
--
-- PayrollRun.journalEntryId is ON DELETE SET NULL, and Postgres enforces that by scanning
-- the referencing table for every row deleted from JournalEntry. Demo teardown deletes the
-- whole year of entries, so an unindexed foreign key here turned a two-minute reset into
-- one that timed out. The index exists for the delete path, not for any read.
CREATE INDEX "PayrollRun_journalEntryId_idx" ON "PayrollRun"("journalEntryId");
