import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ensureSupplierTable } from "@/lib/suppliers";

export type OutletCostRow = {
  id: string;
  outletId: string;
  productId: string;
  productName: string;
  uom: string;
  year: number;
  supplierId: string | null;
  supplierName: string | null;
  unitCostNetMin: number;
  unitCostNetMax: number;
  unitCostNet: number;
  note: string | null;
  updatedAt: Date;
};

export type OutletCostAverageRow = {
  outletId: string;
  productId: string;
  year: number;
  unitCostNet: number;
};

function averageUnitCost(unitCostNetMin: number, unitCostNetMax: number) {
  return (Number(unitCostNetMin) + Number(unitCostNetMax)) / 2;
}

export function averageOutletCostRows(rows: Array<Pick<OutletCostRow, "outletId" | "productId" | "year" | "unitCostNet">>): OutletCostAverageRow[] {
  const aggregate = new Map<string, { outletId: string; productId: string; year: number; sum: number; count: number }>();

  for (const row of rows) {
    const key = `${row.year}:${row.outletId}:${row.productId}`;
    const current = aggregate.get(key) ?? {
      outletId: row.outletId,
      productId: row.productId,
      year: row.year,
      sum: 0,
      count: 0,
    };
    current.sum += Number(row.unitCostNet);
    current.count += 1;
    aggregate.set(key, current);
  }

  return [...aggregate.values()].map((row) => ({
    outletId: row.outletId,
    productId: row.productId,
    year: row.year,
    unitCostNet: row.count > 0 ? row.sum / row.count : 0,
  }));
}

export async function ensureOutletCostTable() {
  await ensureSupplierTable().catch(() => null);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "OutletProductCost" (
      "id" TEXT NOT NULL,
      "outletId" TEXT NOT NULL,
      "productId" TEXT NOT NULL,
      "year" INTEGER NOT NULL,
      "supplierId" TEXT,
      "unitCostNetMin" DOUBLE PRECISION NOT NULL,
      "unitCostNetMax" DOUBLE PRECISION NOT NULL,
      "unitCostNet" DOUBLE PRECISION NOT NULL,
      "note" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "OutletProductCost_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductCost"
    ADD COLUMN IF NOT EXISTS "year" INTEGER;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductCost"
    ADD COLUMN IF NOT EXISTS "supplierId" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductCost"
    ADD COLUMN IF NOT EXISTS "unitCostNetMin" DOUBLE PRECISION;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductCost"
    ADD COLUMN IF NOT EXISTS "unitCostNetMax" DOUBLE PRECISION;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "OutletProductCost"
    SET "year" = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER
    WHERE "year" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "OutletProductCost"
    SET
      "unitCostNetMin" = COALESCE("unitCostNetMin", "unitCostNet"),
      "unitCostNetMax" = COALESCE("unitCostNetMax", "unitCostNet")
    WHERE "unitCostNetMin" IS NULL
      OR "unitCostNetMax" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    UPDATE "OutletProductCost"
    SET "unitCostNet" = ("unitCostNetMin" + "unitCostNetMax") / 2.0
    WHERE "unitCostNet" IS DISTINCT FROM (("unitCostNetMin" + "unitCostNetMax") / 2.0);
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductCost"
    ALTER COLUMN "year" SET NOT NULL;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductCost"
    ALTER COLUMN "unitCostNetMin" SET NOT NULL;
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "OutletProductCost"
    ALTER COLUMN "unitCostNetMax" SET NOT NULL;
  `);
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "OutletProductCost_outletId_productId_key";
  `);
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "OutletProductCost_outletId_productId_year_key";
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "OutletProductCost_outletId_productId_year_idx"
    ON "OutletProductCost"("outletId", "productId", "year");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "OutletProductCost_outletId_productId_year_supplier_key"
    ON "OutletProductCost"("outletId", "productId", "year", "supplierId")
    WHERE "supplierId" IS NOT NULL;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "OutletProductCost_outletId_productId_year_null_supplier_key"
    ON "OutletProductCost"("outletId", "productId", "year")
    WHERE "supplierId" IS NULL;
  `);
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "OutletProductCost_productId_idx";
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "OutletProductCost_productId_year_idx"
    ON "OutletProductCost"("productId", "year");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "OutletProductCost_supplierId_idx"
    ON "OutletProductCost"("supplierId");
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OutletProductCost_outletId_fkey'
      ) THEN
        ALTER TABLE "OutletProductCost"
          ADD CONSTRAINT "OutletProductCost_outletId_fkey"
          FOREIGN KEY ("outletId") REFERENCES "Outlet"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OutletProductCost_productId_fkey'
      ) THEN
        ALTER TABLE "OutletProductCost"
          ADD CONSTRAINT "OutletProductCost_productId_fkey"
          FOREIGN KEY ("productId") REFERENCES "Product"("id")
          ON DELETE CASCADE ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
  await prisma.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'OutletProductCost_supplierId_fkey'
      ) THEN
        ALTER TABLE "OutletProductCost"
          ADD CONSTRAINT "OutletProductCost_supplierId_fkey"
          FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;
  `);
}

export async function listOutletCosts(outletId: string, year: number): Promise<OutletCostRow[]> {
  return listOutletCostsForOutlets([outletId], [year]);
}

export async function listOutletCostsForOutlets(outletIds: string[], years: number[]): Promise<OutletCostRow[]> {
  if (outletIds.length === 0 || years.length === 0) return [];

  await ensureOutletCostTable().catch(() => null);

  const rows = await prisma.$queryRaw<Array<OutletCostRow>>(Prisma.sql`
    SELECT
      opc."id" AS "id",
      opc."outletId" AS "outletId",
      opc."productId" AS "productId",
      p."name" AS "productName",
      p."uom" AS "uom",
      opc."year" AS "year",
      opc."supplierId" AS "supplierId",
      s."name" AS "supplierName",
      opc."unitCostNetMin" AS "unitCostNetMin",
      opc."unitCostNetMax" AS "unitCostNetMax",
      opc."unitCostNet" AS "unitCostNet",
      opc."note" AS "note",
      opc."updatedAt" AS "updatedAt"
    FROM "OutletProductCost" opc
    INNER JOIN "Product" p ON p."id" = opc."productId"
    LEFT JOIN "Supplier" s ON s."id" = opc."supplierId"
    WHERE opc."outletId" IN (${Prisma.join(outletIds)})
      AND opc."year" IN (${Prisma.join(years)})
    ORDER BY opc."year" DESC, p."name" ASC, opc."updatedAt" DESC
  `).catch(() => []);

  return rows.map((row) => ({
    id: row.id,
    outletId: row.outletId,
    productId: row.productId,
    productName: row.productName,
    uom: row.uom,
    year: Number(row.year),
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    unitCostNetMin: Number(row.unitCostNetMin),
    unitCostNetMax: Number(row.unitCostNetMax),
    unitCostNet: Number(row.unitCostNet),
    note: row.note,
    updatedAt: new Date(row.updatedAt),
  }));
}

export async function upsertOutletCost(
  outletId: string,
  productId: string,
  year: number,
  unitCostNetMin: number,
  unitCostNetMax: number,
  note: string | null,
  supplierId: string | null = null,
) {
  await ensureOutletCostTable().catch(() => null);
  const unitCostNet = averageUnitCost(unitCostNetMin, unitCostNetMax);
  const existingRows = supplierId
    ? await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "OutletProductCost"
        WHERE "outletId" = ${outletId}
          AND "productId" = ${productId}
          AND "year" = ${year}
          AND "supplierId" = ${supplierId}
        LIMIT 1
      `)
    : await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "OutletProductCost"
        WHERE "outletId" = ${outletId}
          AND "productId" = ${productId}
          AND "year" = ${year}
          AND "supplierId" IS NULL
        LIMIT 1
      `);

  const existingId = existingRows[0]?.id;
  if (existingId) {
    await prisma.$executeRaw`
      UPDATE "OutletProductCost"
      SET
        "supplierId" = ${supplierId},
        "unitCostNetMin" = ${unitCostNetMin},
        "unitCostNetMax" = ${unitCostNetMax},
        "unitCostNet" = ${unitCostNet},
        "note" = ${note},
        "updatedAt" = NOW()
      WHERE "id" = ${existingId}
    `;
    return;
  }

  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "OutletProductCost"
      ("id", "outletId", "productId", "year", "supplierId", "unitCostNetMin", "unitCostNetMax", "unitCostNet", "note", "createdAt", "updatedAt")
    VALUES
      (${id}, ${outletId}, ${productId}, ${year}, ${supplierId}, ${unitCostNetMin}, ${unitCostNetMax}, ${unitCostNet}, ${note}, NOW(), NOW())
  `;
}

export async function upsertOutletCosts(
  outletIds: string[],
  productId: string,
  year: number,
  unitCostNetMin: number,
  unitCostNetMax: number,
  note: string | null,
  supplierId: string | null = null,
) {
  for (const outletId of outletIds) {
    await upsertOutletCost(outletId, productId, year, unitCostNetMin, unitCostNetMax, note, supplierId);
  }
}

export async function deleteOutletCost(id: string) {
  await ensureOutletCostTable().catch(() => null);
  await prisma.$executeRaw`DELETE FROM "OutletProductCost" WHERE "id" = ${id}`;
}

export async function deleteOutletCostsByProduct(outletIds: string[], productId: string, year: number) {
  if (outletIds.length === 0) return;

  await ensureOutletCostTable().catch(() => null);
  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM "OutletProductCost"
    WHERE "productId" = ${productId}
      AND "year" = ${year}
      AND "outletId" IN (${Prisma.join(outletIds)})
  `);
}

export async function deleteOutletCostsByProductSupplier(
  outletIds: string[],
  productId: string,
  year: number,
  supplierId: string | null,
) {
  if (outletIds.length === 0) return;

  await ensureOutletCostTable().catch(() => null);
  if (supplierId) {
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "OutletProductCost"
      WHERE "productId" = ${productId}
        AND "year" = ${year}
        AND "supplierId" = ${supplierId}
        AND "outletId" IN (${Prisma.join(outletIds)})
    `);
    return;
  }

  await prisma.$executeRaw(Prisma.sql`
    DELETE FROM "OutletProductCost"
    WHERE "productId" = ${productId}
      AND "year" = ${year}
      AND "supplierId" IS NULL
      AND "outletId" IN (${Prisma.join(outletIds)})
  `);
}
