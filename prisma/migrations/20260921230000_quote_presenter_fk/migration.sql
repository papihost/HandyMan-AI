-- A quote presented on a tablet records which technician held it out.
--
-- The column has been there since the field app was built; the constraint has not, so
-- nothing but application code stopped it holding an id that belongs to no technician at
-- all. Reading it back therefore meant a second lookup and a fallback for the row that
-- would not resolve. With the key in place it is a relation like any other, and a
-- technician who leaves takes their name off the quote rather than breaking it.

UPDATE "Quote" q
SET "presentedByTechnicianId" = NULL
WHERE q."presentedByTechnicianId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Technician" t WHERE t.id = q."presentedByTechnicianId"
  );

ALTER TABLE "Quote"
  ADD CONSTRAINT "Quote_presentedByTechnicianId_fkey"
  FOREIGN KEY ("presentedByTechnicianId") REFERENCES "Technician"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
