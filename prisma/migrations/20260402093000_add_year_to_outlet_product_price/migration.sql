ALTER TABLE "OutletProductPrice"
ADD COLUMN IF NOT EXISTS "year" INTEGER;

UPDATE "OutletProductPrice"
SET "year" = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
WHERE "year" IS NULL;

ALTER TABLE "OutletProductPrice"
ALTER COLUMN "year" SET NOT NULL;

DROP INDEX IF EXISTS "OutletProductPrice_outletId_productId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "OutletProductPrice_outletId_productId_year_key"
ON "OutletProductPrice"("outletId", "productId", "year");

DROP INDEX IF EXISTS "OutletProductPrice_productId_idx";

CREATE INDEX IF NOT EXISTS "OutletProductPrice_productId_year_idx"
ON "OutletProductPrice"("productId", "year");

CREATE INDEX IF NOT EXISTS "OutletProductPrice_outletId_year_idx"
ON "OutletProductPrice"("outletId", "year");
