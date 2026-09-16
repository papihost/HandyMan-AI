-- DocumentSequence.locationCode must not be nullable.
--
-- Postgres treats NULLs as distinct in a unique index, so
-- UNIQUE (organizationId, docType, locationCode) did not actually constrain
-- organization-wide sequences: every concurrent allocator inserted its own row and
-- handed out the same document number. An empty string is the sentinel for
-- "not location-scoped", and the unique index then does what it claims to.
--
-- Existing duplicates are collapsed onto the highest counter any of them reached, so a
-- number that was already issued can never be issued a second time. The partition uses
-- COALESCE so NULL and '' rows are treated as the same sequence while collapsing —
-- they have to be merged before the column can be made NOT NULL.

WITH partitioned AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "organizationId", "docType", COALESCE("locationCode", '')
           ORDER BY "nextValue" DESC, "id"
         ) AS rn,
         MAX("nextValue") OVER (
           PARTITION BY "organizationId", "docType", COALESCE("locationCode", '')
         ) AS max_next
  FROM "DocumentSequence"
)
UPDATE "DocumentSequence" d
SET "nextValue" = p.max_next
FROM partitioned p
WHERE d."id" = p."id" AND p.rn = 1;

DELETE FROM "DocumentSequence" d
USING (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "organizationId", "docType", COALESCE("locationCode", '')
           ORDER BY "nextValue" DESC, "id"
         ) AS rn
  FROM "DocumentSequence"
) p
WHERE d."id" = p."id" AND p.rn > 1;

UPDATE "DocumentSequence" SET "locationCode" = '' WHERE "locationCode" IS NULL;

ALTER TABLE "DocumentSequence" ALTER COLUMN "locationCode" SET DEFAULT '';
ALTER TABLE "DocumentSequence" ALTER COLUMN "locationCode" SET NOT NULL;
