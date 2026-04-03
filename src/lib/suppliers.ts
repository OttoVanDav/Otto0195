import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export type PropertySupplierRow = {
  id: string;
  propertyId: string;
  name: string;
  createdAt: Date;
};

export async function ensureSupplierTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "Supplier" (
      "id" TEXT NOT NULL,
      "propertyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Supplier_propertyId_name_key"
    ON "Supplier"("propertyId", "name");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Supplier_propertyId_idx"
    ON "Supplier"("propertyId");
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Supplier_propertyId_fkey'
      ) THEN
        ALTER TABLE "Supplier"
          ADD CONSTRAINT "Supplier_propertyId_fkey"
          FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
}

export async function listPropertySuppliers(propertyId: string): Promise<PropertySupplierRow[]> {
  await ensureSupplierTable().catch(() => null);

  const rows = await prisma.$queryRaw<Array<PropertySupplierRow>>`
    SELECT "id", "propertyId", "name", "createdAt"
    FROM "Supplier"
    WHERE "propertyId" = ${propertyId}
    ORDER BY "name" ASC
  `.catch(() => []);

  return rows.map((row) => ({
    id: row.id,
    propertyId: row.propertyId,
    name: row.name,
    createdAt: new Date(row.createdAt),
  }));
}

export async function createPropertySupplier(propertyId: string, name: string) {
  await ensureSupplierTable().catch(() => null);
  const id = randomUUID();

  await prisma.$executeRaw`
    INSERT INTO "Supplier" ("id", "propertyId", "name", "createdAt")
    VALUES (${id}, ${propertyId}, ${name}, NOW())
    ON CONFLICT ("propertyId", "name") DO NOTHING
  `;
}

export async function deletePropertySupplier(propertyId: string, id: string) {
  await ensureSupplierTable().catch(() => null);
  await prisma.$executeRaw`
    DELETE FROM "Supplier"
    WHERE "id" = ${id}
      AND "propertyId" = ${propertyId}
  `;
}
