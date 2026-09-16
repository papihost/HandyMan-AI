-- Store a normalized phone number for duplicate detection.
--
-- Matching on the typed value does not work: "(480) 555-0142", "480.555.0142" and
-- "+1 480 555 0142" are the same number and share no useful substring. Duplicate
-- customers are expensive once each copy has its own job history and open balance, so
-- the comparison key is stored rather than guessed at query time.

ALTER TABLE "Customer" ADD COLUMN "phoneNormalized" TEXT;

UPDATE "Customer"
SET "phoneNormalized" = CASE
  WHEN length(regexp_replace("phone", '\D', '', 'g')) = 11
       AND left(regexp_replace("phone", '\D', '', 'g'), 1) = '1'
    THEN right(regexp_replace("phone", '\D', '', 'g'), 10)
  ELSE regexp_replace("phone", '\D', '', 'g')
END
WHERE "phone" IS NOT NULL AND "phone" <> '';

CREATE INDEX "Customer_organizationId_phoneNormalized_idx"
  ON "Customer" ("organizationId", "phoneNormalized");
