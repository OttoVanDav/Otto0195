DROP INDEX IF EXISTS "Product_orgId_name_key";

CREATE INDEX IF NOT EXISTS "Product_orgId_name_idx"
ON "Product"("orgId", "name");
