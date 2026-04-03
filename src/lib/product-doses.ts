import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export type DosePoolRow = {
  id: string;
  propertyId: string;
  name: string;
  note: string | null;
  legacyConfigId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DosePoolSourceRow = {
  id: string;
  poolId: string;
  sourceProductId: string;
  sourceProductName: string;
  sourceProductUom: string;
  dosesPerUnit: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DosePoolSaleLinkRow = {
  id: string;
  poolId: string;
  targetProductId: string;
  targetProductName: string;
  targetProductUom: string;
  dosesPerSale: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DosePoolWithDetails = DosePoolRow & {
  sources: DosePoolSourceRow[];
  links: DosePoolSaleLinkRow[];
};

export type DoseDerivedCostMaps = {
  specificByTarget: Map<string, number>;
  averageByTarget: Map<string, number>;
};

type CostRowLike = {
  outletId: string;
  productId: string;
  year: number;
  unitCostNet: number;
};

type PoolRecord = {
  id: string;
  propertyId: string;
  name: string;
  note: string | null;
  legacyConfigId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type PoolSourceRecord = {
  id: string;
  poolId: string;
  sourceProductId: string;
  dosesPerUnit: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceProductName: string;
  sourceProductUom: string;
};

type PoolSaleLinkRecord = {
  id: string;
  poolId: string;
  targetProductId: string;
  dosesPerSale: number;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  targetProductName: string;
  targetProductUom: string;
};

type LegacyDoseConfigRecord = {
  id: string;
  propertyId: string;
  sourceProductId: string;
  dosesPerUnit: number;
  note: string | null;
  sourceProductName: string;
};

type LegacyDoseSaleLinkRecord = {
  configId: string;
  targetProductId: string;
  dosesPerSale: number;
  note: string | null;
};

export async function ensureDoseTables() {
  await prisma.$executeRawUnsafe(`
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
  `);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "DosePool"
    ADD COLUMN IF NOT EXISTS "legacyConfigId" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DosePool_propertyId_name_key"
    ON "DosePool"("propertyId", "name");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DosePool_legacyConfigId_key"
    ON "DosePool"("legacyConfigId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DosePool_propertyId_idx"
    ON "DosePool"("propertyId");
  `);
  await prisma.$executeRawUnsafe(`
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
  `);

  await prisma.$executeRawUnsafe(`
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
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DosePoolSource_poolId_sourceProductId_key"
    ON "DosePoolSource"("poolId", "sourceProductId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DosePoolSource_poolId_idx"
    ON "DosePoolSource"("poolId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DosePoolSource_sourceProductId_idx"
    ON "DosePoolSource"("sourceProductId");
  `);
  await prisma.$executeRawUnsafe(`
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
  `);
  await prisma.$executeRawUnsafe(`
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
  `);

  await prisma.$executeRawUnsafe(`
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
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "DosePoolSaleLink_poolId_targetProductId_key"
    ON "DosePoolSaleLink"("poolId", "targetProductId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DosePoolSaleLink_poolId_idx"
    ON "DosePoolSaleLink"("poolId");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "DosePoolSaleLink_targetProductId_idx"
    ON "DosePoolSaleLink"("targetProductId");
  `);
  await prisma.$executeRawUnsafe(`
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
  `);
  await prisma.$executeRawUnsafe(`
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
  `);

  await migrateLegacyDoseConfigsToPools().catch(() => null);
}

async function migrateLegacyDoseConfigsToPools() {
  const legacyConfigs = await prisma.$queryRaw<Array<LegacyDoseConfigRecord>>`
    SELECT
      cfg."id" AS "id",
      cfg."propertyId" AS "propertyId",
      cfg."sourceProductId" AS "sourceProductId",
      cfg."dosesPerUnit" AS "dosesPerUnit",
      cfg."note" AS "note",
      p."name" AS "sourceProductName"
    FROM "DoseSourceConfig" cfg
    INNER JOIN "Product" p ON p."id" = cfg."sourceProductId"
  `.catch(() => []);
  if (legacyConfigs.length === 0) return;

  const legacyLinks = await prisma.$queryRaw<Array<LegacyDoseSaleLinkRecord>>`
    SELECT
      "configId" AS "configId",
      "targetProductId" AS "targetProductId",
      "dosesPerSale" AS "dosesPerSale",
      "note" AS "note"
    FROM "DoseSaleLink"
  `.catch(() => []);

  const linksByConfigId = new Map<string, LegacyDoseSaleLinkRecord[]>();
  for (const link of legacyLinks) {
    const current = linksByConfigId.get(link.configId) ?? [];
    current.push(link);
    linksByConfigId.set(link.configId, current);
  }

  for (const config of legacyConfigs) {
    const existingPool = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "DosePool"
      WHERE "legacyConfigId" = ${config.id}
      LIMIT 1
    `.catch(() => []);

    const poolId = existingPool[0]?.id ?? randomUUID();
    if (!existingPool[0]?.id) {
      await prisma.$executeRaw`
        INSERT INTO "DosePool"
          ("id", "propertyId", "name", "note", "legacyConfigId", "createdAt", "updatedAt")
        VALUES
          (${poolId}, ${config.propertyId}, ${config.sourceProductName}, ${config.note}, ${config.id}, NOW(), NOW())
      `;
    }

    const existingSource = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "DosePoolSource"
      WHERE "poolId" = ${poolId}
        AND "sourceProductId" = ${config.sourceProductId}
      LIMIT 1
    `.catch(() => []);
    if (existingSource[0]?.id) {
      await prisma.$executeRaw`
        UPDATE "DosePoolSource"
        SET
          "dosesPerUnit" = ${Number(config.dosesPerUnit)},
          "note" = ${config.note},
          "updatedAt" = NOW()
        WHERE "id" = ${existingSource[0].id}
      `;
    } else {
      await prisma.$executeRaw`
        INSERT INTO "DosePoolSource"
          ("id", "poolId", "sourceProductId", "dosesPerUnit", "note", "createdAt", "updatedAt")
        VALUES
          (${randomUUID()}, ${poolId}, ${config.sourceProductId}, ${Number(config.dosesPerUnit)}, ${config.note}, NOW(), NOW())
      `;
    }

    for (const link of linksByConfigId.get(config.id) ?? []) {
      const existingLink = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "DosePoolSaleLink"
        WHERE "poolId" = ${poolId}
          AND "targetProductId" = ${link.targetProductId}
        LIMIT 1
      `.catch(() => []);
      if (existingLink[0]?.id) {
        await prisma.$executeRaw`
          UPDATE "DosePoolSaleLink"
          SET
            "dosesPerSale" = ${Number(link.dosesPerSale)},
            "note" = ${link.note},
            "updatedAt" = NOW()
          WHERE "id" = ${existingLink[0].id}
        `;
      } else {
        await prisma.$executeRaw`
          INSERT INTO "DosePoolSaleLink"
            ("id", "poolId", "targetProductId", "dosesPerSale", "note", "createdAt", "updatedAt")
          VALUES
            (${randomUUID()}, ${poolId}, ${link.targetProductId}, ${Number(link.dosesPerSale)}, ${link.note}, NOW(), NOW())
        `;
      }
    }

    await prisma.$executeRaw`
      DELETE FROM "DoseSourceConfig"
      WHERE "id" = ${config.id}
    `.catch(() => null);
  }
}

export async function listPropertyDosePools(propertyId: string): Promise<DosePoolWithDetails[]> {
  await ensureDoseTables().catch(() => null);

  const poolRows = await prisma.$queryRaw<Array<PoolRecord>>`
    SELECT
      pool."id" AS "id",
      pool."propertyId" AS "propertyId",
      pool."name" AS "name",
      pool."note" AS "note",
      pool."legacyConfigId" AS "legacyConfigId",
      pool."createdAt" AS "createdAt",
      pool."updatedAt" AS "updatedAt"
    FROM "DosePool" pool
    WHERE pool."propertyId" = ${propertyId}
    ORDER BY pool."name" ASC
  `.catch(() => []);

  const sourceRows = await prisma.$queryRaw<Array<PoolSourceRecord>>`
    SELECT
      src."id" AS "id",
      src."poolId" AS "poolId",
      src."sourceProductId" AS "sourceProductId",
      src."dosesPerUnit" AS "dosesPerUnit",
      src."note" AS "note",
      src."createdAt" AS "createdAt",
      src."updatedAt" AS "updatedAt",
      p."name" AS "sourceProductName",
      p."uom" AS "sourceProductUom"
    FROM "DosePoolSource" src
    INNER JOIN "DosePool" pool ON pool."id" = src."poolId"
    INNER JOIN "Product" p ON p."id" = src."sourceProductId"
    WHERE pool."propertyId" = ${propertyId}
    ORDER BY p."name" ASC
  `.catch(() => []);

  const linkRows = await prisma.$queryRaw<Array<PoolSaleLinkRecord>>`
    SELECT
      lnk."id" AS "id",
      lnk."poolId" AS "poolId",
      lnk."targetProductId" AS "targetProductId",
      lnk."dosesPerSale" AS "dosesPerSale",
      lnk."note" AS "note",
      lnk."createdAt" AS "createdAt",
      lnk."updatedAt" AS "updatedAt",
      p."name" AS "targetProductName",
      p."uom" AS "targetProductUom"
    FROM "DosePoolSaleLink" lnk
    INNER JOIN "DosePool" pool ON pool."id" = lnk."poolId"
    INNER JOIN "Product" p ON p."id" = lnk."targetProductId"
    WHERE pool."propertyId" = ${propertyId}
    ORDER BY p."name" ASC
  `.catch(() => []);

  const sourcesByPoolId = new Map<string, DosePoolSourceRow[]>();
  for (const source of sourceRows) {
    const current = sourcesByPoolId.get(source.poolId) ?? [];
    current.push({
      id: source.id,
      poolId: source.poolId,
      sourceProductId: source.sourceProductId,
      sourceProductName: source.sourceProductName,
      sourceProductUom: source.sourceProductUom,
      dosesPerUnit: Number(source.dosesPerUnit),
      note: source.note,
      createdAt: new Date(source.createdAt),
      updatedAt: new Date(source.updatedAt),
    });
    sourcesByPoolId.set(source.poolId, current);
  }

  const linksByPoolId = new Map<string, DosePoolSaleLinkRow[]>();
  for (const link of linkRows) {
    const current = linksByPoolId.get(link.poolId) ?? [];
    current.push({
      id: link.id,
      poolId: link.poolId,
      targetProductId: link.targetProductId,
      targetProductName: link.targetProductName,
      targetProductUom: link.targetProductUom,
      dosesPerSale: Number(link.dosesPerSale),
      note: link.note,
      createdAt: new Date(link.createdAt),
      updatedAt: new Date(link.updatedAt),
    });
    linksByPoolId.set(link.poolId, current);
  }

  return poolRows.map((pool) => ({
    id: pool.id,
    propertyId: pool.propertyId,
    name: pool.name,
    note: pool.note,
    legacyConfigId: pool.legacyConfigId,
    createdAt: new Date(pool.createdAt),
    updatedAt: new Date(pool.updatedAt),
    sources: sourcesByPoolId.get(pool.id) ?? [],
    links: linksByPoolId.get(pool.id) ?? [],
  }));
}

export async function upsertDosePool(propertyId: string, name: string, note: string | null) {
  await ensureDoseTables().catch(() => null);
  const trimmedName = name.trim();
  if (!trimmedName) return null;

  const existing = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "DosePool"
    WHERE "propertyId" = ${propertyId}
      AND "name" = ${trimmedName}
    LIMIT 1
  `.catch(() => []);

  const existingId = existing[0]?.id;
  if (existingId) {
    await prisma.$executeRaw`
      UPDATE "DosePool"
      SET
        "note" = ${note},
        "updatedAt" = NOW()
      WHERE "id" = ${existingId}
    `;
    return existingId;
  }

  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "DosePool"
      ("id", "propertyId", "name", "note", "createdAt", "updatedAt")
    VALUES
      (${id}, ${propertyId}, ${trimmedName}, ${note}, NOW(), NOW())
  `;
  return id;
}

export async function deleteDosePool(id: string) {
  await ensureDoseTables().catch(() => null);
  const linkedLegacy = await prisma.$queryRaw<Array<{ legacyConfigId: string | null }>>`
    SELECT "legacyConfigId"
    FROM "DosePool"
    WHERE "id" = ${id}
    LIMIT 1
  `.catch(() => []);

  const legacyConfigId = linkedLegacy[0]?.legacyConfigId ?? null;
  if (legacyConfigId) {
    await prisma.$executeRaw`
      DELETE FROM "DoseSourceConfig"
      WHERE "id" = ${legacyConfigId}
    `.catch(() => null);
  }
  await prisma.$executeRaw`DELETE FROM "DosePool" WHERE "id" = ${id}`;
}

export async function upsertDosePoolSource(
  poolId: string,
  sourceProductId: string,
  dosesPerUnit: number,
  note: string | null,
) {
  await ensureDoseTables().catch(() => null);
  const existing = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "DosePoolSource"
    WHERE "poolId" = ${poolId}
      AND "sourceProductId" = ${sourceProductId}
    LIMIT 1
  `.catch(() => []);

  const existingId = existing[0]?.id;
  if (existingId) {
    await prisma.$executeRaw`
      UPDATE "DosePoolSource"
      SET
        "dosesPerUnit" = ${dosesPerUnit},
        "note" = ${note},
        "updatedAt" = NOW()
      WHERE "id" = ${existingId}
    `;
    return existingId;
  }

  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "DosePoolSource"
      ("id", "poolId", "sourceProductId", "dosesPerUnit", "note", "createdAt", "updatedAt")
    VALUES
      (${id}, ${poolId}, ${sourceProductId}, ${dosesPerUnit}, ${note}, NOW(), NOW())
  `;
  return id;
}

export async function deleteDosePoolSource(id: string) {
  await ensureDoseTables().catch(() => null);
  await prisma.$executeRaw`DELETE FROM "DosePoolSource" WHERE "id" = ${id}`;
}

export async function upsertDosePoolSaleLink(
  poolId: string,
  targetProductId: string,
  dosesPerSale: number,
  note: string | null,
) {
  await ensureDoseTables().catch(() => null);
  const existing = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "DosePoolSaleLink"
    WHERE "poolId" = ${poolId}
      AND "targetProductId" = ${targetProductId}
    LIMIT 1
  `.catch(() => []);

  const existingId = existing[0]?.id;
  if (existingId) {
    await prisma.$executeRaw`
      UPDATE "DosePoolSaleLink"
      SET
        "dosesPerSale" = ${dosesPerSale},
        "note" = ${note},
        "updatedAt" = NOW()
      WHERE "id" = ${existingId}
    `;
    return existingId;
  }

  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "DosePoolSaleLink"
      ("id", "poolId", "targetProductId", "dosesPerSale", "note", "createdAt", "updatedAt")
    VALUES
      (${id}, ${poolId}, ${targetProductId}, ${dosesPerSale}, ${note}, NOW(), NOW())
  `;
  return id;
}

export async function deleteDosePoolSaleLink(id: string) {
  await ensureDoseTables().catch(() => null);
  await prisma.$executeRaw`DELETE FROM "DosePoolSaleLink" WHERE "id" = ${id}`;
}

export async function buildDoseDerivedCostMaps(args: {
  propertyId: string;
  years: number[];
  outletIds: string[];
  configuredCostRows: CostRowLike[];
  avgPurchaseCostByYear: Map<string, number>;
  purchaseQtyByYear?: Map<string, number>;
}): Promise<DoseDerivedCostMaps> {
  const pools = await listPropertyDosePools(args.propertyId).catch(() => []);
  const specificByTarget = new Map<string, number>();
  const averageByTarget = new Map<string, number>();

  if (pools.length === 0 || args.years.length === 0 || args.outletIds.length === 0) {
    return { specificByTarget, averageByTarget };
  }

  const purchaseQtyByYear = args.purchaseQtyByYear ?? new Map<string, number>();
  const configuredSourceCost = new Map<string, number>();
  const avgConfiguredSourceCost = new Map<string, number>();
  const aggregateBySource = new Map<string, { sum: number; count: number }>();

  for (const row of args.configuredCostRows) {
    configuredSourceCost.set(`${row.year}:${row.outletId}:${row.productId}`, Number(row.unitCostNet));
    const aggregateKey = `${row.year}:${row.productId}`;
    const current = aggregateBySource.get(aggregateKey) ?? { sum: 0, count: 0 };
    current.sum += Number(row.unitCostNet);
    current.count += 1;
    aggregateBySource.set(aggregateKey, current);
  }

  for (const [key, value] of aggregateBySource.entries()) {
    avgConfiguredSourceCost.set(key, value.count > 0 ? value.sum / value.count : 0);
  }

  const resolveWeight = (year: number, productId: string) => {
    const purchasedQty = Number(purchaseQtyByYear.get(`${year}:${productId}`) ?? 0);
    return purchasedQty > 0 ? purchasedQty : 1;
  };

  const buildPoolDoseCost = (pool: DosePoolWithDetails, year: number, outletId?: string) => {
    let totalWeightedCost = 0;
    let totalWeightedDoses = 0;

    for (const source of pool.sources) {
      if (!Number.isFinite(source.dosesPerUnit) || source.dosesPerUnit <= 0) continue;
      const unitCost = Number(
        outletId
          ? configuredSourceCost.get(`${year}:${outletId}:${source.sourceProductId}`) ??
            args.avgPurchaseCostByYear.get(`${year}:${source.sourceProductId}`) ??
            0
          : avgConfiguredSourceCost.get(`${year}:${source.sourceProductId}`) ??
            args.avgPurchaseCostByYear.get(`${year}:${source.sourceProductId}`) ??
            0,
      );
      const weight = resolveWeight(year, source.sourceProductId);
      totalWeightedCost += unitCost * weight;
      totalWeightedDoses += Number(source.dosesPerUnit) * weight;
    }

    return totalWeightedDoses > 0 ? totalWeightedCost / totalWeightedDoses : 0;
  };

  for (const pool of pools) {
    const validSources = pool.sources.filter((source) => Number.isFinite(source.dosesPerUnit) && source.dosesPerUnit > 0);
    const validLinks = pool.links.filter((link) => Number.isFinite(link.dosesPerSale) && link.dosesPerSale > 0);
    if (validSources.length === 0 || validLinks.length === 0) continue;

    for (const year of args.years) {
      const averagePoolDoseCost = buildPoolDoseCost({ ...pool, sources: validSources }, year);
      for (const link of validLinks) {
        const avgKey = `${year}:${link.targetProductId}`;
        const contribution = averagePoolDoseCost * Number(link.dosesPerSale);
        averageByTarget.set(avgKey, (averageByTarget.get(avgKey) ?? 0) + contribution);
      }

      for (const outletId of args.outletIds) {
        const poolDoseCost = buildPoolDoseCost({ ...pool, sources: validSources }, year, outletId);
        for (const link of validLinks) {
          const specificKey = `${year}:${outletId}:${link.targetProductId}`;
          const contribution = poolDoseCost * Number(link.dosesPerSale);
          specificByTarget.set(specificKey, (specificByTarget.get(specificKey) ?? 0) + contribution);
        }
      }
    }
  }

  return { specificByTarget, averageByTarget };
}
