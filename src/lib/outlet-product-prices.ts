import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type OutletPriceRow = {
  id: string;
  outletId: string;
  productId: string;
  productName: string;
  uom: string;
  year: number;
  unitPriceNet: number;
  note: string | null;
  updatedAt: Date;
};

function currentYearUtc() {
  return new Date().getUTCFullYear();
}

export async function ensureOutletPriceTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "OutletProductPrice" (
      "id" TEXT NOT NULL,
      "outletId" TEXT NOT NULL,
      "productId" TEXT NOT NULL,
      "year" INTEGER NOT NULL,
      "unitPriceNet" DOUBLE PRECISION NOT NULL,
      "note" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "OutletProductPrice_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductPrice"
    ADD COLUMN IF NOT EXISTS "year" INTEGER;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "OutletProductPrice"
    SET "year" = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
    WHERE "year" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductPrice"
    ALTER COLUMN "year" SET NOT NULL;
  `);
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "OutletProductPrice_outletId_productId_key";
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "OutletProductPrice_outletId_productId_year_key"
    ON "OutletProductPrice"("outletId", "productId", "year");
  `);
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "OutletProductPrice_productId_idx";
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "OutletProductPrice_productId_year_idx"
    ON "OutletProductPrice"("productId", "year");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "OutletProductPrice_outletId_year_idx"
    ON "OutletProductPrice"("outletId", "year");
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OutletProductPrice_outletId_fkey'
      ) THEN
        ALTER TABLE "OutletProductPrice"
          ADD CONSTRAINT "OutletProductPrice_outletId_fkey"
          FOREIGN KEY ("outletId") REFERENCES "Outlet"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OutletProductPrice_productId_fkey'
      ) THEN
        ALTER TABLE "OutletProductPrice"
          ADD CONSTRAINT "OutletProductPrice_productId_fkey"
          FOREIGN KEY ("productId") REFERENCES "Product"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
}

export async function listOutletPrices(outletId: string, year: number): Promise<OutletPriceRow[]> {
  return listOutletPricesForOutlets([outletId], [year]);
}

export async function listOutletPricesForOutlets(outletIds: string[], years: number[]): Promise<OutletPriceRow[]> {
  if (outletIds.length === 0 || years.length === 0) return [];

  await ensureOutletPriceTable().catch(() => null);

  const rows = await prisma.$queryRaw<Array<OutletPriceRow>>(Prisma.sql`
    SELECT
      opp."id" AS "id",
      opp."outletId" AS "outletId",
      opp."productId" AS "productId",
      p."name" AS "productName",
      p."uom" AS "uom",
      opp."year" AS "year",
      opp."unitPriceNet" AS "unitPriceNet",
      opp."note" AS "note",
      opp."updatedAt" AS "updatedAt"
    FROM "OutletProductPrice" opp
    INNER JOIN "Product" p ON p."id" = opp."productId"
    WHERE opp."outletId" IN (${Prisma.join(outletIds)})
      AND opp."year" IN (${Prisma.join(years)})
    ORDER BY opp."year" DESC, p."name" ASC, opp."updatedAt" DESC
  `).catch(() => []);

  return rows.map((row) => ({
    id: row.id,
    outletId: row.outletId,
    productId: row.productId,
    productName: row.productName,
    uom: row.uom,
    year: Number(row.year),
    unitPriceNet: Number(row.unitPriceNet),
    note: row.note,
    updatedAt: new Date(row.updatedAt),
  }));
}

export async function getOutletConfiguredPrice(outletId: string, productId: string, year: number = currentYearUtc()): Promise<number | null> {
  await ensureOutletPriceTable().catch(() => null);

  const raw = await prisma.$queryRaw<Array<{ unitPriceNet: number }>>`
    SELECT "unitPriceNet"
    FROM "OutletProductPrice"
    WHERE "outletId" = ${outletId}
      AND "productId" = ${productId}
      AND "year" = ${year}
    LIMIT 1
  `.catch(() => []);
  if (raw[0] && Number.isFinite(Number(raw[0].unitPriceNet))) return Number(raw[0].unitPriceNet);
  return null;
}

export async function upsertOutletPrice(
  outletId: string,
  productId: string,
  year: number,
  unitPriceNet: number,
  note: string | null,
) {
  await ensureOutletPriceTable().catch(() => null);
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "OutletProductPrice"
      ("id", "outletId", "productId", "year", "unitPriceNet", "note", "createdAt", "updatedAt")
    VALUES
      (${id}, ${outletId}, ${productId}, ${year}, ${unitPriceNet}, ${note}, NOW(), NOW())
    ON CONFLICT ("outletId", "productId", "year")
    DO UPDATE SET
      "unitPriceNet" = EXCLUDED."unitPriceNet",
      "note" = EXCLUDED."note",
      "updatedAt" = NOW()
  `;
}

export async function deleteOutletPrice(id: string) {
  await ensureOutletPriceTable().catch(() => null);
  await prisma.$executeRaw`DELETE FROM "OutletProductPrice" WHERE "id" = ${id}`;
}
