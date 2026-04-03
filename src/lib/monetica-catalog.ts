import { prisma } from "@/lib/prisma";
import { ensureOutletPriceTable, upsertOutletPrice } from "@/lib/outlet-product-prices";

export type MoneticaArticle = {
  sku: string | number;
  name: string;
  status?: string | null;
  price: number | string | null;
};

export type ImportMoneticaCatalogResult = {
  propertyId: string;
  importedArticles: number;
  createdProducts: number;
  updatedProducts: number;
  updatedPrices: number;
  updatedBarOutlets: number;
  barOutlets: string[];
  warnings: string[];
};

type MoneticaImportProduct = {
  id: string;
  name: string;
  sku: string | null;
  uom: string;
  priceCategory: string;
  defaultSalePriceNet: number;
  trackShrinkageBar: boolean;
  createdAt: Date;
};

type MoneticaExternalMap = {
  externalSku: string;
  productId: string;
  createdAt: Date;
};

type MoneticaArticleInfo = {
  name: string;
  price: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(",", ".");
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pushWarning(warnings: string[], warning: string) {
  if (warnings.length < 25) warnings.push(warning);
}

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasPackagingDescriptor(value: string) {
  return /(?:\b\d+(?:[.,]\d+)?\s?(?:cl|ml|kg|gr|g|l)\b)/i.test(value);
}

function shouldUpdateMoneticaName(currentName: string, incomingName: string) {
  const current = normalizeName(currentName);
  const incoming = normalizeName(incomingName);
  if (!incoming || current === incoming) return false;
  if (!current) return true;
  if (current.includes(incoming) && current.length > incoming.length) return false;
  return true;
}

function buildCostIdentityKey(value: {
  outletId: string;
  year: number;
  supplierId: string | null;
  unitCostNetMin: number;
  unitCostNetMax: number;
  unitCostNet: number;
  note: string | null;
}) {
  return [
    value.outletId,
    value.year,
    value.supplierId ?? "",
    Number(value.unitCostNetMin).toFixed(3),
    Number(value.unitCostNetMax).toFixed(3),
    Number(value.unitCostNet).toFixed(3),
    value.note ?? "",
  ].join("|");
}

function isLikelyMoneticaSku(value: string | null | undefined) {
  return Boolean(value && /^\d+$/.test(value));
}

function pickCanonicalProductByIncomingName(args: {
  products: MoneticaImportProduct[];
  externalSkusByProductId: Map<string, string[]>;
  externalSku: string;
}) {
  const ranked = [...args.products].sort((a, b) => {
    const aMaps = args.externalSkusByProductId.get(a.id) ?? [];
    const bMaps = args.externalSkusByProductId.get(b.id) ?? [];
    const aScore =
      (aMaps.includes(args.externalSku) ? 100 : 0) +
      (a.sku === args.externalSku ? 80 : 0) +
      (aMaps.length === 0 ? 40 : 0) +
      (!a.sku ? 20 : 0);
    const bScore =
      (bMaps.includes(args.externalSku) ? 100 : 0) +
      (b.sku === args.externalSku ? 80 : 0) +
      (bMaps.length === 0 ? 40 : 0) +
      (!b.sku ? 20 : 0);

    if (aScore !== bScore) return bScore - aScore;
    return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  });

  return ranked[0] ?? null;
}

function canMergeProductByIncomingName(args: {
  product: MoneticaImportProduct;
  externalSkusByProductId: Map<string, string[]>;
  externalSku: string;
}) {
  const mappedSkus = args.externalSkusByProductId.get(args.product.id) ?? [];
  if (mappedSkus.length === 0) return true;
  if (mappedSkus.length === 1 && mappedSkus[0] === args.externalSku) return true;
  return false;
}

export function extractMoneticaArticles(value: unknown): MoneticaArticle[] | null {
  if (Array.isArray(value)) return value as MoneticaArticle[];
  if (!isRecord(value)) return null;

  const candidates = [value.articles, value.data, value.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as MoneticaArticle[];
  }

  return null;
}

async function ensureMoneticaProductIdentityRules() {
  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "Product_orgId_name_key";
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Product_orgId_name_idx"
    ON "Product"("orgId", "name");
  `);
}

async function mergeProductIntoCanonical(args: {
  keepProductId: string;
  removeProductId: string;
}) {
  if (args.keepProductId === args.removeProductId) return;

  await prisma.$transaction(async (tx) => {
    const keepProduct = await tx.product.findUnique({
      where: { id: args.keepProductId },
      select: {
        id: true,
        name: true,
        sku: true,
        uom: true,
        priceCategory: true,
        defaultSalePriceNet: true,
        trackShrinkageBar: true,
        createdAt: true,
      },
    });
    const removeProduct = await tx.product.findUnique({
      where: { id: args.removeProductId },
      select: {
        id: true,
        name: true,
        sku: true,
        uom: true,
        priceCategory: true,
        defaultSalePriceNet: true,
        trackShrinkageBar: true,
        createdAt: true,
      },
    });

    if (!keepProduct || !removeProduct) return;

    const updateKeepData: {
      name?: string;
      sku?: string;
      defaultSalePriceNet?: number;
      trackShrinkageBar?: boolean;
    } = {};

    if (shouldUpdateMoneticaName(keepProduct.name, removeProduct.name)) {
      updateKeepData.name = removeProduct.name;
    }
    if (!keepProduct.sku && removeProduct.sku) {
      updateKeepData.sku = removeProduct.sku;
    }
    if (Number(keepProduct.defaultSalePriceNet) <= 0 && Number(removeProduct.defaultSalePriceNet) > 0) {
      updateKeepData.defaultSalePriceNet = Number(removeProduct.defaultSalePriceNet);
    }
    if (!keepProduct.trackShrinkageBar && removeProduct.trackShrinkageBar) {
      updateKeepData.trackShrinkageBar = true;
    }

    if (Object.keys(updateKeepData).length > 0) {
      await tx.product.update({
        where: { id: keepProduct.id },
        data: updateKeepData,
      });
    }

    const externalMaps = await tx.externalProductMap.findMany({
      where: { productId: removeProduct.id },
      select: { orgId: true, source: true, externalSku: true },
    });
    for (const map of externalMaps) {
      await tx.externalProductMap.upsert({
        where: {
          orgId_source_externalSku: {
            orgId: map.orgId,
            source: map.source,
            externalSku: map.externalSku,
          },
        },
        update: { productId: keepProduct.id },
        create: {
          orgId: map.orgId,
          source: map.source,
          externalSku: map.externalSku,
          productId: keepProduct.id,
        },
      });
    }

    const outletPrices = await tx.outletProductPrice.findMany({
      where: { productId: removeProduct.id },
      select: {
        id: true,
        outletId: true,
        year: true,
        unitPriceNet: true,
        note: true,
      },
    });
    for (const row of outletPrices) {
      const existing = await tx.outletProductPrice.findFirst({
        where: {
          outletId: row.outletId,
          productId: keepProduct.id,
          year: row.year,
        },
        select: { id: true, unitPriceNet: true, note: true },
      });
      if (!existing) {
        await tx.outletProductPrice.create({
          data: {
            outletId: row.outletId,
            productId: keepProduct.id,
            year: row.year,
            unitPriceNet: Number(row.unitPriceNet),
            note: row.note,
          },
        });
        continue;
      }

      if (Number(existing.unitPriceNet) <= 0 && Number(row.unitPriceNet) > 0) {
        await tx.outletProductPrice.update({
          where: { id: existing.id },
          data: {
            unitPriceNet: Number(row.unitPriceNet),
            note: existing.note ?? row.note,
          },
        });
      }
    }
    await tx.outletProductPrice.deleteMany({ where: { productId: removeProduct.id } });

    const keepCosts = await tx.outletProductCost.findMany({
      where: { productId: keepProduct.id },
      select: {
        outletId: true,
        year: true,
        supplierId: true,
        unitCostNetMin: true,
        unitCostNetMax: true,
        unitCostNet: true,
        note: true,
      },
    });
    const keepCostKeys = new Set(keepCosts.map((row) => buildCostIdentityKey(row)));
    const removeCosts = await tx.outletProductCost.findMany({
      where: { productId: removeProduct.id },
      select: {
        outletId: true,
        year: true,
        supplierId: true,
        unitCostNetMin: true,
        unitCostNetMax: true,
        unitCostNet: true,
        note: true,
      },
    });
    for (const row of removeCosts) {
      const key = buildCostIdentityKey(row);
      if (keepCostKeys.has(key)) continue;
      await tx.outletProductCost.create({
        data: {
          outletId: row.outletId,
          productId: keepProduct.id,
          year: row.year,
          supplierId: row.supplierId,
          unitCostNetMin: Number(row.unitCostNetMin),
          unitCostNetMax: Number(row.unitCostNetMax),
          unitCostNet: Number(row.unitCostNet),
          note: row.note,
        },
      });
      keepCostKeys.add(key);
    }
    await tx.outletProductCost.deleteMany({ where: { productId: removeProduct.id } });

    await tx.purchaseLine.updateMany({
      where: { productId: removeProduct.id },
      data: { productId: keepProduct.id },
    });
    await tx.stockMoveLine.updateMany({
      where: { productId: removeProduct.id },
      data: { productId: keepProduct.id },
    });
    await tx.saleLine.updateMany({
      where: { productId: removeProduct.id },
      data: { productId: keepProduct.id },
    });
    await tx.inventoryCountLine.updateMany({
      where: { productId: removeProduct.id },
      data: { productId: keepProduct.id },
    });

    const sourceConfigs = await tx.doseSourceConfig.findMany({
      where: { sourceProductId: removeProduct.id },
      select: { id: true, propertyId: true },
    });
    for (const config of sourceConfigs) {
      const existingConfig = await tx.doseSourceConfig.findFirst({
        where: {
          propertyId: config.propertyId,
          sourceProductId: keepProduct.id,
        },
        select: { id: true },
      });

      if (!existingConfig) {
        await tx.doseSourceConfig.update({
          where: { id: config.id },
          data: { sourceProductId: keepProduct.id },
        });
        continue;
      }

      const links = await tx.doseSaleLink.findMany({
        where: { configId: config.id },
        select: {
          id: true,
          targetProductId: true,
          dosesPerSale: true,
          note: true,
        },
      });
      for (const link of links) {
        const existingLink = await tx.doseSaleLink.findFirst({
          where: {
            configId: existingConfig.id,
            targetProductId: link.targetProductId,
          },
          select: { id: true, dosesPerSale: true, note: true },
        });
        if (!existingLink) {
          await tx.doseSaleLink.create({
            data: {
              configId: existingConfig.id,
              targetProductId: link.targetProductId,
              dosesPerSale: Number(link.dosesPerSale),
              note: link.note,
            },
          });
        } else if (Number(existingLink.dosesPerSale) <= 0 && Number(link.dosesPerSale) > 0) {
          await tx.doseSaleLink.update({
            where: { id: existingLink.id },
            data: {
              dosesPerSale: Number(link.dosesPerSale),
              note: existingLink.note ?? link.note,
            },
          });
        }
      }

      await tx.doseSaleLink.deleteMany({ where: { configId: config.id } });
      await tx.doseSourceConfig.delete({ where: { id: config.id } });
    }

    const targetLinks = await tx.doseSaleLink.findMany({
      where: { targetProductId: removeProduct.id },
      select: {
        id: true,
        configId: true,
        dosesPerSale: true,
        note: true,
      },
    });
    for (const link of targetLinks) {
      const existingLink = await tx.doseSaleLink.findFirst({
        where: {
          configId: link.configId,
          targetProductId: keepProduct.id,
        },
        select: { id: true, dosesPerSale: true, note: true },
      });
      if (!existingLink) {
        await tx.doseSaleLink.update({
          where: { id: link.id },
          data: { targetProductId: keepProduct.id },
        });
      } else {
        if (Number(existingLink.dosesPerSale) <= 0 && Number(link.dosesPerSale) > 0) {
          await tx.doseSaleLink.update({
            where: { id: existingLink.id },
            data: {
              dosesPerSale: Number(link.dosesPerSale),
              note: existingLink.note ?? link.note,
            },
          });
        }
        await tx.doseSaleLink.delete({ where: { id: link.id } });
      }
    }

    const poolSources = await tx.dosePoolSource.findMany({
      where: { sourceProductId: removeProduct.id },
      select: {
        id: true,
        poolId: true,
        dosesPerUnit: true,
        note: true,
      },
    });
    for (const row of poolSources) {
      const existingRow = await tx.dosePoolSource.findFirst({
        where: {
          poolId: row.poolId,
          sourceProductId: keepProduct.id,
        },
        select: { id: true, dosesPerUnit: true, note: true },
      });
      if (!existingRow) {
        await tx.dosePoolSource.update({
          where: { id: row.id },
          data: { sourceProductId: keepProduct.id },
        });
      } else {
        if (Number(existingRow.dosesPerUnit) <= 0 && Number(row.dosesPerUnit) > 0) {
          await tx.dosePoolSource.update({
            where: { id: existingRow.id },
            data: {
              dosesPerUnit: Number(row.dosesPerUnit),
              note: existingRow.note ?? row.note,
            },
          });
        }
        await tx.dosePoolSource.delete({ where: { id: row.id } });
      }
    }

    const poolSaleLinks = await tx.dosePoolSaleLink.findMany({
      where: { targetProductId: removeProduct.id },
      select: {
        id: true,
        poolId: true,
        dosesPerSale: true,
        note: true,
      },
    });
    for (const row of poolSaleLinks) {
      const existingRow = await tx.dosePoolSaleLink.findFirst({
        where: {
          poolId: row.poolId,
          targetProductId: keepProduct.id,
        },
        select: { id: true, dosesPerSale: true, note: true },
      });
      if (!existingRow) {
        await tx.dosePoolSaleLink.update({
          where: { id: row.id },
          data: { targetProductId: keepProduct.id },
        });
      } else {
        if (Number(existingRow.dosesPerSale) <= 0 && Number(row.dosesPerSale) > 0) {
          await tx.dosePoolSaleLink.update({
            where: { id: existingRow.id },
            data: {
              dosesPerSale: Number(row.dosesPerSale),
              note: existingRow.note ?? row.note,
            },
          });
        }
        await tx.dosePoolSaleLink.delete({ where: { id: row.id } });
      }
    }

    await tx.product.delete({ where: { id: removeProduct.id } });
  });
}

async function consolidateProductsByExactSku(args: {
  productById: Map<string, MoneticaImportProduct>;
  productIdBySku: Map<string, string>;
  externalSkusByProductId?: Map<string, string[]>;
  warnings: string[];
}) {
  let removedProducts = 0;
  const productsByExactSku = new Map<string, MoneticaImportProduct[]>();
  for (const product of args.productById.values()) {
    const sku = asString(product.sku);
    if (!sku) continue;
    const current = productsByExactSku.get(sku) ?? [];
    current.push(product);
    productsByExactSku.set(sku, current);
  }

  for (const [sku, products] of productsByExactSku.entries()) {
    if (products.length <= 1) continue;

    const mappedProductId = args.productIdBySku.get(sku);
    const sorted = [...products].sort((a, b) => {
      if (mappedProductId && a.id === mappedProductId && b.id !== mappedProductId) return -1;
      if (mappedProductId && b.id === mappedProductId && a.id !== mappedProductId) return 1;
      return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
    });
    const keeper = sorted[0];

    for (const duplicate of sorted.slice(1)) {
      const duplicateMaps = args.externalSkusByProductId?.get(duplicate.id) ?? [];
      await mergeProductIntoCanonical({
        keepProductId: keeper.id,
        removeProductId: duplicate.id,
      });
      args.productById.delete(duplicate.id);
      args.productIdBySku.set(sku, keeper.id);
      if (args.externalSkusByProductId) {
        const mergedMaps = new Set(args.externalSkusByProductId.get(keeper.id) ?? []);
        for (const mappedSku of duplicateMaps) {
          mergedMaps.add(mappedSku);
        }
        args.externalSkusByProductId.set(keeper.id, [...mergedMaps]);
        args.externalSkusByProductId.delete(duplicate.id);
      }
      removedProducts += 1;
      pushWarning(
        args.warnings,
        `SKU ${sku}: consolidato su un solo prodotto per eliminare duplicati con codice identico.`,
      );
    }
  }

  return removedProducts;
}

function pickCanonicalProductByResolvedSku(args: {
  products: MoneticaImportProduct[];
  externalSkusByProductId: Map<string, string[]>;
  resolvedSku: string;
}) {
  const ranked = [...args.products].sort((a, b) => {
    const aMaps = args.externalSkusByProductId.get(a.id) ?? [];
    const bMaps = args.externalSkusByProductId.get(b.id) ?? [];
    const aScore =
      (aMaps.includes(args.resolvedSku) ? 200 : 0) +
      (a.sku === args.resolvedSku ? 120 : 0) +
      (aMaps.length > 0 ? 40 : 0) +
      (a.sku ? 20 : 0);
    const bScore =
      (bMaps.includes(args.resolvedSku) ? 200 : 0) +
      (b.sku === args.resolvedSku ? 120 : 0) +
      (bMaps.length > 0 ? 40 : 0) +
      (b.sku ? 20 : 0);

    if (aScore !== bScore) return bScore - aScore;
    return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  });

  return ranked[0] ?? null;
}

function canMergeProductByResolvedSku(args: {
  product: MoneticaImportProduct;
  externalSkusByProductId: Map<string, string[]>;
  resolvedSku: string;
}) {
  const mappedSkus = args.externalSkusByProductId.get(args.product.id) ?? [];
  if (mappedSkus.length > 1) return false;
  if (mappedSkus.length === 1 && mappedSkus[0] !== args.resolvedSku) return false;
  const sku = asString(args.product.sku);
  if (sku && sku !== args.resolvedSku) return false;
  return true;
}

async function consolidateProductsByLocalMoneticaName(args: {
  productById: Map<string, MoneticaImportProduct>;
  externalSkusByProductId: Map<string, string[]>;
  warnings: string[];
}) {
  let removedProducts = 0;
  const productsByName = new Map<string, MoneticaImportProduct[]>();
  for (const product of args.productById.values()) {
    const nameKey = normalizeName(product.name);
    const current = productsByName.get(nameKey) ?? [];
    current.push(product);
    productsByName.set(nameKey, current);
  }

  for (const [nameKey, products] of productsByName.entries()) {
    if (products.length <= 1) continue;

    const resolvedSkus = new Set<string>();
    let hasMoneticaSignal = false;
    for (const product of products) {
      const mappedSkus = args.externalSkusByProductId.get(product.id) ?? [];
      if (mappedSkus.length > 0) hasMoneticaSignal = true;
      for (const mappedSku of mappedSkus) {
        resolvedSkus.add(mappedSku);
      }
      const sku = asString(product.sku);
      if (isLikelyMoneticaSku(sku)) {
        hasMoneticaSignal = true;
        resolvedSkus.add(sku!);
      }
    }

    if (!hasMoneticaSignal) continue;
    if (resolvedSkus.size !== 1) continue;

    const resolvedSku = [...resolvedSkus][0] ?? null;
    if (!resolvedSku) continue;

    const keeper = pickCanonicalProductByResolvedSku({
      products,
      externalSkusByProductId: args.externalSkusByProductId,
      resolvedSku,
    });
    if (!keeper) continue;

    for (const duplicate of products) {
      if (duplicate.id === keeper.id) continue;
      if (!canMergeProductByResolvedSku({
        product: duplicate,
        externalSkusByProductId: args.externalSkusByProductId,
        resolvedSku,
      })) {
        continue;
      }

      const duplicateMaps = args.externalSkusByProductId.get(duplicate.id) ?? [];
      await mergeProductIntoCanonical({
        keepProductId: keeper.id,
        removeProductId: duplicate.id,
      });
      const mergedMaps = new Set(args.externalSkusByProductId.get(keeper.id) ?? []);
      mergedMaps.add(resolvedSku);
      for (const mappedSku of duplicateMaps) {
        mergedMaps.add(mappedSku);
      }
      args.externalSkusByProductId.set(keeper.id, [...mergedMaps]);
      args.externalSkusByProductId.delete(duplicate.id);
      args.productById.delete(duplicate.id);
      removedProducts += 1;
      pushWarning(
        args.warnings,
        `${nameKey}: consolidato su un solo prodotto per eliminare duplicati con stesso nome e stesso SKU Monetica.`,
      );
    }
  }

  return removedProducts;
}

async function consolidateProductsByUniqueIncomingName(args: {
  productById: Map<string, MoneticaImportProduct>;
  externalSkusByProductId: Map<string, string[]>;
  articleBySku: Map<string, MoneticaArticleInfo>;
  warnings: string[];
}) {
  let removedProducts = 0;

  const articleNameCounts = new Map<string, number>();
  const externalSkuByName = new Map<string, string>();
  for (const [externalSku, article] of args.articleBySku.entries()) {
    const nameKey = normalizeName(article.name);
    articleNameCounts.set(nameKey, (articleNameCounts.get(nameKey) ?? 0) + 1);
    if (!externalSkuByName.has(nameKey)) {
      externalSkuByName.set(nameKey, externalSku);
    }
  }

  const productsByName = new Map<string, MoneticaImportProduct[]>();
  for (const product of args.productById.values()) {
    const nameKey = normalizeName(product.name);
    const current = productsByName.get(nameKey) ?? [];
    current.push(product);
    productsByName.set(nameKey, current);
  }

  for (const [nameKey, products] of productsByName.entries()) {
    if (products.length <= 1) continue;
    if ((articleNameCounts.get(nameKey) ?? 0) !== 1) continue;

    const externalSku = externalSkuByName.get(nameKey);
    if (!externalSku) continue;

    const keeper = pickCanonicalProductByIncomingName({
      products,
      externalSkusByProductId: args.externalSkusByProductId,
      externalSku,
    });
    if (!keeper) continue;

    for (const duplicate of products) {
      if (duplicate.id === keeper.id) continue;
      if (!canMergeProductByIncomingName({
        product: duplicate,
        externalSkusByProductId: args.externalSkusByProductId,
        externalSku,
      })) {
        continue;
      }

      const duplicateMaps = args.externalSkusByProductId.get(duplicate.id) ?? [];
      await mergeProductIntoCanonical({
        keepProductId: keeper.id,
        removeProductId: duplicate.id,
      });
      const mergedMaps = new Set(args.externalSkusByProductId.get(keeper.id) ?? []);
      for (const mappedSku of duplicateMaps) {
        mergedMaps.add(mappedSku);
      }
      args.externalSkusByProductId.set(keeper.id, [...mergedMaps]);
      args.externalSkusByProductId.delete(duplicate.id);
      args.productById.delete(duplicate.id);
      removedProducts += 1;
      pushWarning(
        args.warnings,
        `${keeper.name}: consolidato su un solo prodotto per eliminare duplicati con nome Monetica identico.`,
      );
    }
  }

  return removedProducts;
}

function findReusableProductByIncomingName(args: {
  productById: Map<string, MoneticaImportProduct>;
  externalSkusByProductId: Map<string, string[]>;
  articleNameCounts: Map<string, number>;
  externalSku: string;
  name: string;
}) {
  const nameKey = normalizeName(args.name);
  if ((args.articleNameCounts.get(nameKey) ?? 0) !== 1) return null;

  const candidates = [...args.productById.values()].filter((product) => normalizeName(product.name) === nameKey);
  if (candidates.length === 0) return null;

  const reusable = candidates.filter((product) =>
    canMergeProductByIncomingName({
      product,
      externalSkusByProductId: args.externalSkusByProductId,
      externalSku: args.externalSku,
    }),
  );
  if (reusable.length === 0) return null;

  return pickCanonicalProductByIncomingName({
    products: reusable,
    externalSkusByProductId: args.externalSkusByProductId,
    externalSku: args.externalSku,
  });
}

async function splitSharedMoneticaProducts(args: {
  orgId: string;
  year: number;
  currentUtcYear: number;
  productsById: Map<string, MoneticaImportProduct>;
  productIdBySku: Map<string, string>;
  externalMaps: MoneticaExternalMap[];
  articleBySku: Map<string, MoneticaArticleInfo>;
  warnings: string[];
}) {
  let createdProducts = 0;
  const mapsByProductId = new Map<string, MoneticaExternalMap[]>();
  for (const map of args.externalMaps) {
    const current = mapsByProductId.get(map.productId) ?? [];
    current.push(map);
    mapsByProductId.set(map.productId, current);
  }

  for (const [productId, maps] of mapsByProductId.entries()) {
    const activeMaps = maps
      .filter((map) => args.articleBySku.has(map.externalSku))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.externalSku.localeCompare(b.externalSku));
    if (activeMaps.length <= 1) continue;

    const baseProduct = args.productsById.get(productId);
    if (!baseProduct) continue;

    const keeperMap = (() => {
      if (hasPackagingDescriptor(baseProduct.name)) {
        const nullPriceMap = activeMaps.find((map) => args.articleBySku.get(map.externalSku)?.price === null);
        if (nullPriceMap) return nullPriceMap;
      }
      const pricedMap = activeMaps.find((map) => args.articleBySku.get(map.externalSku)?.price !== null);
      return pricedMap ?? activeMaps[0];
    })();

    for (const map of activeMaps) {
      if (map.externalSku === keeperMap.externalSku) continue;
      if (args.productIdBySku.get(map.externalSku) !== productId) continue;

      const article = args.articleBySku.get(map.externalSku);
      const clonedProduct = await prisma.product.create({
        data: {
          orgId: args.orgId,
          name: article?.name ?? baseProduct.name,
          sku: map.externalSku,
          uom: baseProduct.uom,
          priceCategory: baseProduct.priceCategory,
          defaultSalePriceNet:
            args.year === args.currentUtcYear && article?.price !== null && article?.price !== undefined
              ? article.price
              : 0,
          trackShrinkageBar: baseProduct.trackShrinkageBar,
        },
        select: {
          id: true,
          name: true,
          sku: true,
          uom: true,
          priceCategory: true,
          defaultSalePriceNet: true,
          trackShrinkageBar: true,
          createdAt: true,
        },
      });

      await prisma.externalProductMap.update({
        where: {
          orgId_source_externalSku: {
            orgId: args.orgId,
            source: "MONETICA",
            externalSku: map.externalSku,
          },
        },
        data: { productId: clonedProduct.id },
      });

      args.productsById.set(clonedProduct.id, clonedProduct);
      args.productIdBySku.set(map.externalSku, clonedProduct.id);
      createdProducts += 1;
      pushWarning(
        args.warnings,
        `SKU ${map.externalSku}: separato da un prodotto condiviso con piu codici Monetica.`,
      );
    }
  }

  return createdProducts;
}

export async function importMoneticaArticlesIntoProperty(
  propertyId: string,
  articles: MoneticaArticle[],
  year: number = new Date().getUTCFullYear(),
): Promise<ImportMoneticaCatalogResult> {
  const currentUtcYear = new Date().getUTCFullYear();
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) throw new Error("property not found");

  const barOutlets = property.outlets.filter((outlet) => outlet.type === "BAR");
  if (barOutlets.length === 0) throw new Error("no bar outlets found");

  await ensureMoneticaProductIdentityRules().catch(() => null);
  await ensureOutletPriceTable().catch(() => null);

  const products = await prisma.product.findMany({
    where: { orgId: property.orgId },
    select: {
      id: true,
      name: true,
      sku: true,
      uom: true,
      priceCategory: true,
      defaultSalePriceNet: true,
      trackShrinkageBar: true,
      createdAt: true,
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const externalMaps = await prisma.externalProductMap.findMany({
    where: { orgId: property.orgId, source: "MONETICA" },
    select: { externalSku: true, productId: true, createdAt: true },
  });
  const productIdBySku = new Map(externalMaps.map((map) => [map.externalSku, map.productId]));
  const externalSkusByProductId = new Map<string, string[]>();
  for (const map of externalMaps) {
    const current = externalSkusByProductId.get(map.productId) ?? [];
    current.push(map.externalSku);
    externalSkusByProductId.set(map.productId, current);
  }

  const articleBySku = new Map<string, MoneticaArticleInfo>();
  const articleNameCounts = new Map<string, number>();
  for (const article of articles) {
    if (!isRecord(article)) continue;
    const externalSku = asString(article.sku);
    const name = asString(article.name);
    const price = asNumber(article.price);
    if (!externalSku || !name) continue;
    articleBySku.set(externalSku, { name, price });
    const nameKey = normalizeName(name);
    articleNameCounts.set(nameKey, (articleNameCounts.get(nameKey) ?? 0) + 1);
  }

  let importedArticles = 0;
  let createdProducts = 0;
  let updatedProducts = 0;
  let updatedPrices = 0;
  const warnings: string[] = [];

  await consolidateProductsByExactSku({
    productById,
    productIdBySku,
    externalSkusByProductId,
    warnings,
  }).catch(() => 0);

  await consolidateProductsByLocalMoneticaName({
    productById,
    externalSkusByProductId,
    warnings,
  }).catch(() => 0);

  await consolidateProductsByUniqueIncomingName({
    productById,
    externalSkusByProductId,
    articleBySku,
    warnings,
  }).catch(() => 0);

  createdProducts += await splitSharedMoneticaProducts({
    orgId: property.orgId,
    year,
    currentUtcYear,
    productsById: productById,
    productIdBySku,
    externalMaps,
    articleBySku,
    warnings,
  }).catch(() => 0);

  const productIdByExactSku = new Map(
    [...productById.values()]
      .map((product) => [asString(product.sku), product.id] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0])),
  );

  for (const article of articles) {
    if (!isRecord(article)) {
      pushWarning(warnings, "Articolo Monetica non valido nel payload.");
      continue;
    }

    const externalSku = asString(article.sku);
    const name = asString(article.name);
    const price = asNumber(article.price);
    const status = asString(article.status) ?? "visible";

    if (!externalSku || !name) {
      pushWarning(warnings, "Articolo Monetica senza sku o nome valido.");
      continue;
    }
    if (price !== null && price < 0) {
      pushWarning(warnings, `Articolo Monetica ${externalSku}: prezzo non valido.`);
      continue;
    }

    let product = productIdBySku.get(externalSku) ? productById.get(productIdBySku.get(externalSku)!) ?? null : null;
    if (!product) {
      const exactSkuProductId = productIdByExactSku.get(externalSku);
      product = exactSkuProductId ? productById.get(exactSkuProductId) ?? null : null;
    }
    if (!product) {
      product = findReusableProductByIncomingName({
        productById,
        externalSkusByProductId,
        articleNameCounts,
        externalSku,
        name,
      });
    }

    if (!product) {
      product = await prisma.product.create({
        data: {
          orgId: property.orgId,
          name,
          sku: externalSku,
          uom: "PZ",
          priceCategory: "STANDARD",
          defaultSalePriceNet: year === currentUtcYear && price !== null ? price : 0,
          trackShrinkageBar: false,
        },
        select: {
          id: true,
          name: true,
          sku: true,
          uom: true,
          priceCategory: true,
          defaultSalePriceNet: true,
          trackShrinkageBar: true,
          createdAt: true,
        },
      });
      createdProducts += 1;
      productById.set(product.id, product);
    } else {
      const updateData: {
        name?: string;
        sku?: string;
        defaultSalePriceNet?: number;
      } = {};

      if (shouldUpdateMoneticaName(product.name, name)) {
        updateData.name = name;
      }
      if (!product.sku) {
        updateData.sku = externalSku;
      }
      if (year === currentUtcYear && price !== null && Number(product.defaultSalePriceNet) !== price) {
        updateData.defaultSalePriceNet = price;
      }

      if (Object.keys(updateData).length > 0) {
        product = await prisma.product.update({
          where: { id: product.id },
          data: updateData,
          select: {
            id: true,
            name: true,
            sku: true,
            uom: true,
            priceCategory: true,
            defaultSalePriceNet: true,
            trackShrinkageBar: true,
            createdAt: true,
          },
        });
        updatedProducts += 1;
        productById.set(product.id, product);
      }
    }

    await prisma.externalProductMap.upsert({
      where: {
        orgId_source_externalSku: {
          orgId: property.orgId,
          source: "MONETICA",
          externalSku,
        },
      },
      update: { productId: product.id },
      create: {
        orgId: property.orgId,
        source: "MONETICA",
        externalSku,
        productId: product.id,
      },
    });

    productIdBySku.set(externalSku, product.id);
    productIdByExactSku.set(externalSku, product.id);
    const mappedSkus = new Set(externalSkusByProductId.get(product.id) ?? []);
    mappedSkus.add(externalSku);
    externalSkusByProductId.set(product.id, [...mappedSkus]);

    if (price !== null) {
      const note = `Import Monetica automatico ${year}${status ? ` · ${status}` : ""}`;
      for (const outlet of barOutlets) {
        await upsertOutletPrice(outlet.id, product.id, year, price, note);
        updatedPrices += 1;
      }
    } else {
      pushWarning(warnings, `Articolo Monetica ${externalSku}: importato senza prezzo cliente per l'anno ${year}.`);
    }

    importedArticles += 1;
  }

  return {
    propertyId,
    importedArticles,
    createdProducts,
    updatedProducts,
    updatedPrices,
    updatedBarOutlets: barOutlets.length,
    barOutlets: barOutlets.map((outlet) => outlet.name),
    warnings,
  };
}

export async function reconcileLocalMoneticaProducts(orgId: string) {
  await ensureMoneticaProductIdentityRules().catch(() => null);

  const products = await prisma.product.findMany({
    where: { orgId },
    select: {
      id: true,
      name: true,
      sku: true,
      uom: true,
      priceCategory: true,
      defaultSalePriceNet: true,
      trackShrinkageBar: true,
      createdAt: true,
    },
  });
  const productById = new Map(products.map((product) => [product.id, product]));

  const externalMaps = await prisma.externalProductMap.findMany({
    where: { orgId, source: "MONETICA" },
    select: { externalSku: true, productId: true, createdAt: true },
  });
  const productIdBySku = new Map(externalMaps.map((map) => [map.externalSku, map.productId]));
  const externalSkusByProductId = new Map<string, string[]>();
  for (const map of externalMaps) {
    const current = externalSkusByProductId.get(map.productId) ?? [];
    current.push(map.externalSku);
    externalSkusByProductId.set(map.productId, current);
  }

  const warnings: string[] = [];
  await consolidateProductsByExactSku({
    productById,
    productIdBySku,
    externalSkusByProductId,
    warnings,
  }).catch(() => 0);
  await consolidateProductsByLocalMoneticaName({
    productById,
    externalSkusByProductId,
    warnings,
  }).catch(() => 0);

  return {
    warnings,
  };
}

export async function syncOfficialMoneticaCatalog(
  propertyId: string,
  year: number = new Date().getUTCFullYear(),
): Promise<ImportMoneticaCatalogResult> {
  const endpoint = process.env.MONETICA_ARTICLES_URL?.trim();
  const bearerToken = process.env.MONETICA_API_BEARER_TOKEN?.trim();

  if (!endpoint || !bearerToken) {
    throw new Error("MONETICA_ARTICLES_URL or MONETICA_API_BEARER_TOKEN missing");
  }

  const response = await fetch(endpoint, {
    method: "GET",
    headers: { authorization: `Bearer ${bearerToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Monetica catalog request failed with status ${response.status}`);
  }

  const body: unknown = await response.json().catch(() => null);
  const articles = extractMoneticaArticles(body);
  if (!articles) {
    throw new Error("Monetica catalog response is not a valid articles array");
  }

  return importMoneticaArticlesIntoProperty(propertyId, articles, year);
}
