CREATE TABLE IF NOT EXISTS "Supplier" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Supplier_propertyId_name_key"
ON "Supplier"("propertyId", "name");

CREATE INDEX IF NOT EXISTS "Supplier_propertyId_idx"
ON "Supplier"("propertyId");

ALTER TABLE "Supplier"
ADD CONSTRAINT "Supplier_propertyId_fkey"
FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutletProductCost"
ADD COLUMN IF NOT EXISTS "supplierId" TEXT;

CREATE INDEX IF NOT EXISTS "OutletProductCost_supplierId_idx"
ON "OutletProductCost"("supplierId");

ALTER TABLE "OutletProductCost"
ADD CONSTRAINT "OutletProductCost_supplierId_fkey"
FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
