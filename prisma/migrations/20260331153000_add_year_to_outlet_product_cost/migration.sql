ALTER TABLE "OutletProductCost"
ADD COLUMN IF NOT EXISTS "year" INTEGER;

UPDATE "OutletProductCost"
SET "year" = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
WHERE "year" IS NULL;

ALTER TABLE "OutletProductCost"
ALTER COLUMN "year" SET NOT NULL;

DROP INDEX IF EXISTS "OutletProductCost_outletId_productId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "OutletProductCost_outletId_productId_year_key"
ON "OutletProductCost"("outletId", "productId", "year");

DROP INDEX IF EXISTS "OutletProductCost_productId_idx";

CREATE INDEX IF NOT EXISTS "OutletProductCost_productId_year_idx"
ON "OutletProductCost"("productId", "year");
