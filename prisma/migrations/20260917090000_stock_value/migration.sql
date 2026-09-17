-- Track total value on hand alongside quantity.
--
-- Valuing inventory as quantity x average cost re-rounds a rounded number on every
-- report, and the drift compounds with each receipt. Holding the value and deriving the
-- average from it keeps the balance sheet equal to the money actually spent, and lets a
-- consumption that empties a bin relieve exactly what is left rather than a rounded
-- approximation of it.

ALTER TABLE "StockLevel" ADD COLUMN "valueCents" BIGINT NOT NULL DEFAULT 0;

UPDATE "StockLevel"
SET "valueCents" = ROUND("quantity" * "avgCostCents")::BIGINT
WHERE "quantity" <> 0;
