CREATE TABLE IF NOT EXISTS "DoseSourceConfig" (
  "id" TEXT NOT NULL,
  "propertyId" TEXT NOT NULL,
  "sourceProductId" TEXT NOT NULL,
  "dosesPerUnit" DOUBLE PRECISION NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DoseSourceConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DoseSourceConfig_propertyId_sourceProductId_key"
ON "DoseSourceConfig"("propertyId", "sourceProductId");

CREATE INDEX IF NOT EXISTS "DoseSourceConfig_propertyId_idx"
ON "DoseSourceConfig"("propertyId");

CREATE INDEX IF NOT EXISTS "DoseSourceConfig_sourceProductId_idx"
ON "DoseSourceConfig"("sourceProductId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DoseSourceConfig_propertyId_fkey'
  ) THEN
    ALTER TABLE "DoseSourceConfig"
      ADD CONSTRAINT "DoseSourceConfig_propertyId_fkey"
      FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DoseSourceConfig_sourceProductId_fkey'
  ) THEN
    ALTER TABLE "DoseSourceConfig"
      ADD CONSTRAINT "DoseSourceConfig_sourceProductId_fkey"
      FOREIGN KEY ("sourceProductId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "DoseSaleLink" (
  "id" TEXT NOT NULL,
  "configId" TEXT NOT NULL,
  "targetProductId" TEXT NOT NULL,
  "dosesPerSale" DOUBLE PRECISION NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DoseSaleLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "DoseSaleLink_configId_targetProductId_key"
ON "DoseSaleLink"("configId", "targetProductId");

CREATE INDEX IF NOT EXISTS "DoseSaleLink_targetProductId_idx"
ON "DoseSaleLink"("targetProductId");

CREATE INDEX IF NOT EXISTS "DoseSaleLink_configId_idx"
ON "DoseSaleLink"("configId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DoseSaleLink_configId_fkey'
  ) THEN
    ALTER TABLE "DoseSaleLink"
      ADD CONSTRAINT "DoseSaleLink_configId_fkey"
      FOREIGN KEY ("configId") REFERENCES "DoseSourceConfig"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DoseSaleLink_targetProductId_fkey'
  ) THEN
    ALTER TABLE "DoseSaleLink"
      ADD CONSTRAINT "DoseSaleLink_targetProductId_fkey"
      FOREIGN KEY ("targetProductId") REFERENCES "Product"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
