DROP INDEX IF EXISTS "OutletProductCost_outletId_productId_year_key";

CREATE INDEX IF NOT EXISTS "OutletProductCost_outletId_productId_year_idx"
ON "OutletProductCost"("outletId", "productId", "year");

CREATE UNIQUE INDEX IF NOT EXISTS "OutletProductCost_outletId_productId_year_supplier_key"
ON "OutletProductCost"("outletId", "productId", "year", "supplierId")
WHERE "supplierId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "OutletProductCost_outletId_productId_year_null_supplier_key"
ON "OutletProductCost"("outletId", "productId", "year")
WHERE "supplierId" IS NULL;
