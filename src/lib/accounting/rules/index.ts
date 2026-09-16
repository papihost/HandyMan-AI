/**
 * Posting rules.
 *
 * Each rule is a pure function: a business event in, journal lines out. No database, no
 * clock, no context. That means every rule in the system can be unit-tested against a
 * table of expected debits and credits, and the posting table in
 * `docs/01-accounting-design.md` is executable documentation rather than a wish.
 *
 * The caller hands the resulting lines to `postJournalEntry`, inside the same transaction
 * as the document that produced them.
 */
export * from './invoice';
export * from './payment';
export * from './inventory';
export * from './labor';
