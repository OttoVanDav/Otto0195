CREATE TABLE IF NOT EXISTS "DosePool" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "note" TEXT,
  "legacyConfigId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DosePool_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "DosePool"
ADD COLUMN IF NOT EXISTS "legacyConfigId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "DosePool_propertyId_name_key"
ON "DosePool"("propertyId", "name");

CREATE UNIQUE INDEX IF NOT EXISTS "DosePool_legacyConfigId_key"
ON "DosePool"("legacyConfigId");

CREATE INDEX IF NOT EXISTS "DosePool_propertyId_idx"
ON "DosePool"("propertyId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DosePool_propertyId_fkey'
  ) THEN
    ALTER TABLE "DosePool"
      ADD CONSTRAINT "DosePool_propertyId_fkey"
      FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "DosePoolSource" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "sourceProductId" TEXT NOT NULL,
  "dosesPerUnit" DOUBLE PRECISION NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DosePoolSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DosePoolSource_poolId_sourceProductId_key"
ON "DosePoolSource"("poolId", "sourceProductId");

CREATE INDEX IF NOT EXISTS "DosePoolSource_poolId_idx"
ON "DosePoolSource"("poolId");

CREATE INDEX IF NOT EXISTS "DosePoolSource_sourceProductId_idx"
ON "DosePoolSource"("sourceProductId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DosePoolSource_poolId_fkey'
  ) THEN
    ALTER TABLE "DosePoolSource"
      ADD CONSTRAINT "DosePoolSource_poolId_fkey"
      FOREIGN KEY ("poolId") REFERENCES "DosePool"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DosePoolSource_sourceProductId_fkey'
  ) THEN
    ALTER TABLE "DosePoolSource"
      ADD CONSTRAINT "DosePoolSource_sourceProductId_fkey"
      FOREIGN KEY ("sourceProductId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "DosePoolSaleLink" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "targetProductId" TEXT NOT NULL,
  "dosesPerSale" DOUBLE PRECISION NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DosePoolSaleLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DosePoolSaleLink_poolId_targetProductId_key"
ON "DosePoolSaleLink"("poolId", "targetProductId");

CREATE INDEX IF NOT EXISTS "DosePoolSaleLink_poolId_idx"
ON "DosePoolSaleLink"("poolId");

CREATE INDEX IF NOT EXISTS "DosePoolSaleLink_targetProductId_idx"
ON "DosePoolSaleLink"("targetProductId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DosePoolSaleLink_poolId_fkey'
  ) THEN
    ALTER TABLE "DosePoolSaleLink"
      ADD CONSTRAINT "DosePoolSaleLink_poolId_fkey"
      FOREIGN KEY ("poolId") REFERENCES "DosePool"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DosePoolSaleLink_targetProductId_fkey'
  ) THEN
    ALTER TABLE "DosePoolSaleLink"
      ADD CONSTRAINT "DosePoolSaleLink_targetProductId_fkey"
      FOREIGN KEY ("targetProductId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
