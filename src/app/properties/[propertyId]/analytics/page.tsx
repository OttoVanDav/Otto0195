import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { averageOutletCostRows, listOutletCostsForOutlets } from "@/lib/outlet-product-costs";
import { listOutletPricesForOutlets } from "@/lib/outlet-product-prices";
import { buildDoseDerivedCostMaps } from "@/lib/product-doses";
import { grossToNetSaleUnitPrice } from "@/lib/sales-vat";
import { notFound } from "next/navigation";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{
    year?: string;
    fromOutletId?: string;
    dateFrom?: string;
    dateTo?: string;
    barA?: string;
    barB?: string;
    cmpBarA?: string;
    cmpMonthA?: string;
    cmpYearA?: string;
    cmpBarB?: string;
    cmpMonthB?: string;
    cmpYearB?: string;
  }>;
};

type OutletProductCostReadModel = {
  findMany: (args: {
    where: { outletId: { in: string[] }; year: number };
    select: { outletId: true; productId: true; unitCostNet: true };
  }) => Promise<Array<{ outletId: string; productId: string; unitCostNet: number }>>;
};

function getOutletCostReadModel(): OutletProductCostReadModel | null {
  const model = (prisma as unknown as { outletProductCost?: OutletProductCostReadModel }).outletProductCost;
  return model ?? null;
}

async function loadOutletCosts(outletIds: string[], year: number): Promise<Array<{ outletId: string; productId: string; unitCostNet: number }>> {
  const helperRows = await listOutletCostsForOutlets(outletIds, [year]).catch(() => []);
  if (helperRows.length > 0) {
    return averageOutletCostRows(helperRows).map((row) => ({
      outletId: row.outletId,
      productId: row.productId,
      unitCostNet: Number(row.unitCostNet),
    }));
  }

  const model = getOutletCostReadModel();
  if (model) {
    const rows = await model
      .findMany({
        where: { outletId: { in: outletIds }, year },
        select: { outletId: true, productId: true, unitCostNet: true },
      })
      .catch(() => null);
    if (rows) {
      return averageOutletCostRows(
        rows.map((r) => ({ outletId: r.outletId, productId: r.productId, year, unitCostNet: Number(r.unitCostNet) })),
      ).map((row) => ({ outletId: row.outletId, productId: row.productId, unitCostNet: row.unitCostNet }));
    }
  }

  const fallbackRows: Array<{ outletId: string; productId: string; unitCostNet: number }> = [];
  for (const outletId of outletIds) {
    const rawRows = await prisma.$queryRaw<Array<{ productId: string; unitCostNet: number }>>`
      SELECT "productId", "unitCostNet"
      FROM "OutletProductCost"
      WHERE "outletId" = ${outletId}
        AND "year" = ${year}
    `.catch(() => []);
    for (const r of rawRows) {
      fallbackRows.push({ outletId, productId: r.productId, unitCostNet: Number(r.unitCostNet) });
    }
  }
  return averageOutletCostRows(
    fallbackRows.map((row) => ({ ...row, year })),
  ).map((row) => ({ outletId: row.outletId, productId: row.productId, unitCostNet: row.unitCostNet }));
}

async function loadOutletPrices(outletIds: string[], year: number): Promise<Array<{ outletId: string; productId: string; unitPriceNet: number }>> {
  const rows = await listOutletPricesForOutlets(outletIds, [year]).catch(() => []);
  return rows.map((row) => ({
    outletId: row.outletId,
    productId: row.productId,
    unitPriceNet: Number(row.unitPriceNet),
  }));
}

export const dynamic = "force-dynamic";

function resolveYear(rawYear: string | undefined) {
  const parsed = Number(rawYear ?? new Date().getUTCFullYear());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : new Date().getUTCFullYear();
}

function resolveDateRange(year: number, rawFrom: string | undefined, rawTo: string | undefined) {
  const fallbackFrom = `${year}-01-01`;
  const fallbackTo = `${year}-12-31`;
  const dateFrom = (rawFrom ?? "").trim() || fallbackFrom;
  const dateTo = (rawTo ?? "").trim() || fallbackTo;
  const rangeStart = new Date(`${dateFrom}T00:00:00.000Z`);
  const rangeEnd = new Date(`${dateTo}T23:59:59.999Z`);
  const startOk = !Number.isNaN(rangeStart.getTime());
  const endOk = !Number.isNaN(rangeEnd.getTime());
  const sameYear = startOk && endOk && rangeStart.getUTCFullYear() === year && rangeEnd.getUTCFullYear() === year;

  if (!startOk || !endOk || !sameYear || rangeStart > rangeEnd) {
    return {
      dateFrom: fallbackFrom,
      dateTo: fallbackTo,
      rangeStart: new Date(`${fallbackFrom}T00:00:00.000Z`),
      rangeEnd: new Date(`${fallbackTo}T23:59:59.999Z`),
    };
  }

  return { dateFrom, dateTo, rangeStart, rangeEnd };
}

export default async function PropertyAnalyticsPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};

  const year = resolveYear(sp.year);
  const fromOutletId = sp.fromOutletId ?? "";
  const { dateFrom, dateTo, rangeStart, rangeEnd } = resolveDateRange(year, sp.dateFrom, sp.dateTo);

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) return notFound();

  const bars = property.outlets.filter((o) => o.type === "BAR");
  const barA = sp.barA && bars.some((b) => b.id === sp.barA) ? sp.barA : bars[0]?.id ?? "";
  const barB = sp.barB && bars.some((b) => b.id === sp.barB) ? sp.barB : bars[1]?.id ?? bars[0]?.id ?? "";
  const cmpBarA = sp.cmpBarA && bars.some((b) => b.id === sp.cmpBarA) ? sp.cmpBarA : barA;
  const cmpBarB = sp.cmpBarB && bars.some((b) => b.id === sp.cmpBarB) ? sp.cmpBarB : barB;
  const cmpYearA = Number(sp.cmpYearA ?? year);
  const cmpYearB = Number(sp.cmpYearB ?? cmpYearA - 1);
  const cmpMonthA = clampMonth(Number(sp.cmpMonthA ?? (rangeStart.getUTCMonth() + 1)));
  const cmpMonthB = clampMonth(Number(sp.cmpMonthB ?? cmpMonthA));

  const fy = await prisma.fiscalYear.upsert({
    where: { orgId_year: { orgId: property.orgId, year } },
    update: {},
    create: {
      orgId: property.orgId,
      year,
      startDate: new Date(Date.UTC(year, 0, 1)),
      endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59)),
    },
  });

  const outletIds = property.outlets.map((o) => o.id);

  const saleRows = await prisma.saleLine.findMany({
    where: {
      sale: {
        fiscalYearId: fy.id,
        outlet: { propertyId },
        date: { gte: rangeStart, lte: rangeEnd },
      },
    },
    select: {
      qty: true,
      unitPriceNet: true,
      productId: true,
      sale: { select: { id: true, outletId: true, date: true } },
    },
  });

  const purchaseRows = await prisma.purchaseLine.findMany({
    where: {
      purchase: {
        fiscalYearId: fy.id,
        warehouse: { propertyId },
        date: { gte: rangeStart, lte: rangeEnd },
      },
    },
    select: {
      productId: true,
      qty: true,
      unitCostNet: true,
    },
  });

  const products = await prisma.product.findMany({
    where: { orgId: property.orgId },
    select: { id: true, name: true, priceCategory: true, defaultSalePriceNet: true, excludeFromAvgTicketAndSalesCount: true },
    orderBy: { name: "asc" },
  });
  const productInfoById = new Map(products.map((p) => [p.id, p]));
  const excludedFromReceiptMetricsProductIds = new Set(
    products
      .filter((product) => product.excludeFromAvgTicketAndSalesCount)
      .map((product) => product.id),
  );

  const transferRows = await prisma.stockMoveLine.findMany({
    where: {
      move: {
        fiscalYearId: fy.id,
        type: "TRANSFER_TO_OUTLET",
        outlet: { propertyId },
        date: { gte: rangeStart, lte: rangeEnd },
      },
    },
    select: { qty: true, move: { select: { outletId: true, date: true } } },
  });

  const monthStart = rangeStart.getUTCMonth() + 1;
  const monthEnd = rangeEnd.getUTCMonth() + 1;

  const laborAllocRows = await prisma.laborAllocation.findMany({
    where: {
      laborPool: {
        propertyId,
        fiscalYearId: fy.id,
        month: { gte: monthStart, lte: monthEnd },
      },
    },
    select: {
      outletId: true,
      amountNet: true,
      laborPool: { select: { month: true } },
    },
  });

  const expenseRows = await prisma.expense.findMany({
    where: {
      propertyId,
      fiscalYearId: fy.id,
      date: { gte: rangeStart, lte: rangeEnd },
    },
    select: { outletId: true, amountNet: true, date: true },
  });

  const inventoryRows = await prisma.inventoryCount.findMany({
    where: {
      fiscalYearId: fy.id,
      outlet: { propertyId, type: "BAR" },
      date: { gte: rangeStart, lte: rangeEnd },
    },
    select: { outletId: true },
  });

  const outletCosts = await loadOutletCosts(outletIds, year);
  const outletPrices = await loadOutletPrices(outletIds, year);
  const currentUtcYear = new Date().getUTCFullYear();

  const avgCostByProduct = new Map<string, number>();
  const purchaseAgg = new Map<string, { qty: number; cost: number }>();
  for (const p of purchaseRows) {
    const prev = purchaseAgg.get(p.productId) ?? { qty: 0, cost: 0 };
    prev.qty += Number(p.qty);
    prev.cost += Number(p.qty) * Number(p.unitCostNet);
    purchaseAgg.set(p.productId, prev);
  }
  for (const [productId, v] of purchaseAgg.entries()) {
    avgCostByProduct.set(productId, v.qty > 0 ? v.cost / v.qty : 0);
  }

  const avgPurchaseCostByYear = new Map<string, number>();
  const purchaseQtyByYear = new Map<string, number>();
  for (const [productId, value] of avgCostByProduct.entries()) {
    avgPurchaseCostByYear.set(`${year}:${productId}`, value);
  }
  for (const [productId, value] of purchaseAgg.entries()) {
    purchaseQtyByYear.set(`${year}:${productId}`, value.qty);
  }

  const outletCostMap = new Map<string, number>();
  const avgOutletCostByProduct = new Map<string, number>();
  const outletCostAggByProduct = new Map<string, { sum: number; count: number }>();
  for (const c of outletCosts) {
    outletCostMap.set(`${c.outletId}:${c.productId}`, Number(c.unitCostNet));
    const prev = outletCostAggByProduct.get(c.productId) ?? { sum: 0, count: 0 };
    prev.sum += Number(c.unitCostNet);
    prev.count += 1;
    outletCostAggByProduct.set(c.productId, prev);
  }
  for (const [productId, v] of outletCostAggByProduct.entries()) {
    avgOutletCostByProduct.set(productId, v.count > 0 ? v.sum / v.count : 0);
  }

  const doseCostMaps = await buildDoseDerivedCostMaps({
    propertyId,
    years: [year],
    outletIds,
    configuredCostRows: outletCosts.map((row) => ({ ...row, year })),
    avgPurchaseCostByYear,
    purchaseQtyByYear,
  }).catch(() => ({ specificByTarget: new Map<string, number>(), averageByTarget: new Map<string, number>() }));

  for (const [key, value] of doseCostMaps.specificByTarget.entries()) {
    const [, outletId, productId] = key.split(":");
    if (outletId && productId) {
      outletCostMap.set(`${outletId}:${productId}`, Number(value));
    }
  }
  for (const [key, value] of doseCostMaps.averageByTarget.entries()) {
    const [, productId] = key.split(":");
    if (productId) {
      avgOutletCostByProduct.set(productId, Number(value));
    }
  }

  const outletPriceMap = new Map<string, number>();
  const avgOutletPriceByProduct = new Map<string, number>();
  const outletPriceAggByProduct = new Map<string, { sum: number; count: number }>();
  for (const p of outletPrices) {
    outletPriceMap.set(`${p.outletId}:${p.productId}`, Number(p.unitPriceNet));
    const prev = outletPriceAggByProduct.get(p.productId) ?? { sum: 0, count: 0 };
    prev.sum += Number(p.unitPriceNet);
    prev.count += 1;
    outletPriceAggByProduct.set(p.productId, prev);
  }
  for (const [productId, v] of outletPriceAggByProduct.entries()) {
    avgOutletPriceByProduct.set(productId, v.count > 0 ? v.sum / v.count : 0);
  }

  const outletStats = new Map<string, {
    name: string;
    type: string;
    revenue: number;
    cogs: number;
    qtySold: number;
    qtyTransferred: number;
    salesCount: number;
    labor: number;
    expenses: number;
  }>();

  for (const o of property.outlets) {
    outletStats.set(o.id, {
      name: o.name,
      type: o.type,
      revenue: 0,
      cogs: 0,
      qtySold: 0,
      qtyTransferred: 0,
      salesCount: 0,
      labor: 0,
      expenses: 0,
    });
  }

  const byMonth = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    revenue: 0,
    cogs: 0,
    labor: 0,
    expenses: 0,
    operating: 0,
  }));

  const productMargins = new Map<string, {
    productId: string;
    name: string;
    priceCategory: string;
    qtySold: number;
    revenue: number;
    cogs: number;
    configuredSellPrice: number;
    avgUnitCost: number;
    margin: number;
    marginPct: number;
  }>();
  const outletProductQty = new Map<string, number>();
  const outletProductRevenue = new Map<string, number>();
  const priceVarianceByProduct = new Map<string, {
    productId: string;
    name: string;
    qty: number;
    variance: number;
    targetRevenue: number;
    actualRevenue: number;
  }>();
  const purchaseVarianceByProduct = new Map<string, {
    productId: string;
    name: string;
    qty: number;
    variance: number;
    standardCost: number;
    actualCost: number;
  }>();
  let totalPriceVariance = 0;
  let totalPriceTargetRevenue = 0;
  let totalPurchaseVariance = 0;
  let totalPurchaseStandardCost = 0;
  const receiptOutletBySaleId = new Map<string, string>();
  let receiptMetricsRevenue = 0;

  for (const p of products) {
    const defaultConfiguredPrice = year === currentUtcYear ? Number(p.defaultSalePriceNet) : 0;
    const configuredSellPrice = grossToNetSaleUnitPrice(
      Number(avgOutletPriceByProduct.get(p.id) ?? defaultConfiguredPrice),
    );
    const configuredUnitCost = Number(avgOutletCostByProduct.get(p.id) ?? avgCostByProduct.get(p.id) ?? 0);
    productMargins.set(p.id, {
      productId: p.id,
      name: p.name,
      priceCategory: p.priceCategory,
      qtySold: 0,
      revenue: 0,
      cogs: 0,
      configuredSellPrice: configuredSellPrice,
      avgUnitCost: configuredUnitCost,
      margin: 0,
      marginPct: 0,
    });
  }

  for (const p of purchaseRows) {
    const qty = Number(p.qty);
    const actualUnitCost = Number(p.unitCostNet);
    const standardUnitCost = Number(avgOutletCostByProduct.get(p.productId) ?? actualUnitCost);
    const variance = (actualUnitCost - standardUnitCost) * qty;
    const standardCost = standardUnitCost * qty;
    const actualCost = actualUnitCost * qty;

    totalPurchaseVariance += variance;
    totalPurchaseStandardCost += standardCost;

    const prev = purchaseVarianceByProduct.get(p.productId) ?? {
      productId: p.productId,
      name: productInfoById.get(p.productId)?.name ?? `Prodotto ${p.productId.slice(-6)}`,
      qty: 0,
      variance: 0,
      standardCost: 0,
      actualCost: 0,
    };
    prev.qty += qty;
    prev.variance += variance;
    prev.standardCost += standardCost;
    prev.actualCost += actualCost;
    purchaseVarianceByProduct.set(p.productId, prev);
  }

  for (const r of saleRows) {
    const outlet = outletStats.get(r.sale.outletId);
    if (!outlet) continue;

    const qty = Number(r.qty);
    const actualUnitPriceGross = Number(r.unitPriceNet);
    const actualUnitPrice = grossToNetSaleUnitPrice(actualUnitPriceGross);
    const targetUnitPrice = grossToNetSaleUnitPrice(Number(
      outletPriceMap.get(`${r.sale.outletId}:${r.productId}`) ??
      (year === currentUtcYear ? productInfoById.get(r.productId)?.defaultSalePriceNet : undefined) ??
      actualUnitPriceGross
    ));
    const sellUnitPrice = actualUnitPrice;
    const revenue = qty * sellUnitPrice;
    const specificCost = outletCostMap.get(`${r.sale.outletId}:${r.productId}`);
    const unitCost = specificCost ?? Number(avgOutletCostByProduct.get(r.productId) ?? avgCostByProduct.get(r.productId) ?? 0);
    const cogs = qty * unitCost;

    outlet.revenue += revenue;
    outlet.cogs += cogs;
    outlet.qtySold += qty;
    if (!excludedFromReceiptMetricsProductIds.has(r.productId)) {
      receiptOutletBySaleId.set(r.sale.id, r.sale.outletId);
      receiptMetricsRevenue += revenue;
    }
    const outletProductKey = `${r.sale.outletId}:${r.productId}`;
    outletProductQty.set(outletProductKey, (outletProductQty.get(outletProductKey) ?? 0) + qty);
    outletProductRevenue.set(outletProductKey, (outletProductRevenue.get(outletProductKey) ?? 0) + revenue);

    const targetRevenue = targetUnitPrice * qty;
    const actualRevenue = actualUnitPrice * qty;
    const priceVariance = actualRevenue - targetRevenue;
    totalPriceVariance += priceVariance;
    totalPriceTargetRevenue += targetRevenue;
    const pricePrev = priceVarianceByProduct.get(r.productId) ?? {
      productId: r.productId,
      name: productInfoById.get(r.productId)?.name ?? `Prodotto ${r.productId.slice(-6)}`,
      qty: 0,
      variance: 0,
      targetRevenue: 0,
      actualRevenue: 0,
    };
    pricePrev.qty += qty;
    pricePrev.variance += priceVariance;
    pricePrev.targetRevenue += targetRevenue;
    pricePrev.actualRevenue += actualRevenue;
    priceVarianceByProduct.set(r.productId, pricePrev);

    const configuredFallbackPrice = grossToNetSaleUnitPrice(Number(
      avgOutletPriceByProduct.get(r.productId) ??
      (year === currentUtcYear ? productInfoById.get(r.productId)?.defaultSalePriceNet : undefined) ??
      r.unitPriceNet
    ));
    const current = productMargins.get(r.productId) ?? {
      productId: r.productId,
      name: `Prodotto ${r.productId.slice(-6)}`,
      priceCategory: "N/A",
      qtySold: 0,
      revenue: 0,
      cogs: 0,
      configuredSellPrice: configuredFallbackPrice,
      avgUnitCost: Number(avgOutletCostByProduct.get(r.productId) ?? avgCostByProduct.get(r.productId) ?? 0),
      margin: 0,
      marginPct: 0,
    };
    current.qtySold += qty;
    current.revenue += revenue;
    current.cogs += cogs;
    current.configuredSellPrice = configuredFallbackPrice;
    current.avgUnitCost = current.qtySold > 0
      ? current.cogs / current.qtySold
      : Number(avgOutletCostByProduct.get(r.productId) ?? avgCostByProduct.get(r.productId) ?? 0);
    current.margin = current.revenue - current.cogs;
    current.marginPct = pct(current.margin, current.revenue);
    productMargins.set(r.productId, current);

    const m = new Date(r.sale.date).getUTCMonth();
    byMonth[m].revenue += revenue;
    byMonth[m].cogs += cogs;
  }

  for (const outletId of receiptOutletBySaleId.values()) {
    const outlet = outletStats.get(outletId);
    if (outlet) outlet.salesCount += 1;
  }

  for (const t of transferRows) {
    if (!t.move.outletId) continue;
    const outlet = outletStats.get(t.move.outletId);
    if (!outlet) continue;
    outlet.qtyTransferred += Number(t.qty);
  }

  for (const l of laborAllocRows) {
    const outlet = outletStats.get(l.outletId);
    if (outlet) outlet.labor += Number(l.amountNet);

    const monthIdx = Math.max(0, Math.min(11, Number(l.laborPool.month) - 1));
    byMonth[monthIdx].labor += Number(l.amountNet);
  }

  let centralExpenses = 0;
  for (const e of expenseRows) {
    const amount = Number(e.amountNet);
    if (e.outletId && outletStats.has(e.outletId)) {
      outletStats.get(e.outletId)!.expenses += amount;
    } else {
      centralExpenses += amount;
    }

    const m = new Date(e.date).getUTCMonth();
    byMonth[m].expenses += amount;
  }

  const totalRevenue = [...outletStats.values()].reduce((a, o) => a + o.revenue, 0);
  const totalCogs = [...outletStats.values()].reduce((a, o) => a + o.cogs, 0);
  const totalLabor = [...outletStats.values()].reduce((a, o) => a + o.labor, 0);
  const totalDirectExpenses = [...outletStats.values()].reduce((a, o) => a + o.expenses, 0);
  const totalExpenses = totalDirectExpenses + centralExpenses;
  const totalGross = totalRevenue - totalCogs;
  const totalOperating = totalGross - totalLabor - totalExpenses;

  const totalSalesCount = receiptOutletBySaleId.size;
  const avgTicket = totalSalesCount > 0 ? receiptMetricsRevenue / totalSalesCount : 0;
  const foodCostPct = pct(totalCogs, totalRevenue);
  const laborPct = pct(totalLabor, totalRevenue);
  const primeCostPct = pct(totalCogs + totalLabor, totalRevenue);
  const operatingMarginPct = pct(totalOperating, totalRevenue);

  const barsWithInventory = new Set(inventoryRows.map((i) => i.outletId));
  const inventoryCoveragePct = pct(barsWithInventory.size, bars.length || 1);

  for (const m of byMonth) {
    m.operating = m.revenue - m.cogs - m.labor - m.expenses;
  }

  const productMarginRows = [...productMargins.values()]
    .filter((row) => row.qtySold > 0)
    .sort((a, b) => b.margin - a.margin || b.revenue - a.revenue);
  const priceVarianceRows = [...priceVarianceByProduct.values()].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  const purchaseVarianceRows = [...purchaseVarianceByProduct.values()].sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
  const priceVariancePct = pct(totalPriceVariance, totalPriceTargetRevenue);
  const purchaseVariancePct = pct(totalPurchaseVariance, totalPurchaseStandardCost);

  const barAQtyTotal = cmpBarA
    ? [...outletProductQty.entries()]
        .filter(([k]) => k.startsWith(`${cmpBarA}:`))
        .reduce((acc, [, qty]) => acc + qty, 0)
    : 0;
  const barBQtyTotal = cmpBarB
    ? [...outletProductQty.entries()]
        .filter(([k]) => k.startsWith(`${cmpBarB}:`))
        .reduce((acc, [, qty]) => acc + qty, 0)
    : 0;
  let mixVarianceAmount = 0;
  let volumeVarianceAmount = 0;
  let revenueBridgeAtBasePrice = 0;
  if (cmpBarA && cmpBarB && cmpBarA !== cmpBarB && barAQtyTotal > 0) {
    const productIds = new Set<string>([
      ...products.map((p) => p.id),
      ...saleRows.map((r) => r.productId),
    ]);
    for (const productId of productIds) {
      const qtyA = Number(outletProductQty.get(`${cmpBarA}:${productId}`) ?? 0);
      const qtyB = Number(outletProductQty.get(`${cmpBarB}:${productId}`) ?? 0);
      const revenueA = Number(outletProductRevenue.get(`${cmpBarA}:${productId}`) ?? 0);
      const basePrice =
        qtyA > 0
          ? revenueA / qtyA
          : Number(
              outletPriceMap.get(`${cmpBarA}:${productId}`) ??
              (year === currentUtcYear ? productInfoById.get(productId)?.defaultSalePriceNet : undefined) ??
              0,
            );
      const mixA = qtyA / barAQtyTotal;
      const expectedQtyBAtAMix = barBQtyTotal * mixA;
      mixVarianceAmount += (qtyB - expectedQtyBAtAMix) * basePrice;
      volumeVarianceAmount += (barBQtyTotal - barAQtyTotal) * mixA * basePrice;
      revenueBridgeAtBasePrice += (qtyB - qtyA) * basePrice;
    }
  }
  const actualRevenueDeltaAB = Number(outletStats.get(cmpBarB)?.revenue ?? 0) - Number(outletStats.get(cmpBarA)?.revenue ?? 0);

  const comparisonStatsA =
    cmpBarA
      ? await buildComparisonOutletStats({
          propertyId,
          orgId: property.orgId,
          outletId: cmpBarA,
          year: cmpYearA,
          month: cmpMonthA,
          outletCostMap,
          avgOutletCostByProduct,
          outletPriceMap,
          excludedFromReceiptMetricsProductIds,
        })
      : undefined;
  const comparisonStatsB =
    cmpBarB
      ? await buildComparisonOutletStats({
          propertyId,
          orgId: property.orgId,
          outletId: cmpBarB,
          year: cmpYearB,
          month: cmpMonthB,
          outletCostMap,
          avgOutletCostByProduct,
          outletPriceMap,
          excludedFromReceiptMetricsProductIds,
        })
      : undefined;
  const comparisonOutletALabel = outletStats.get(cmpBarA)?.name ?? "Bar A";
  const comparisonOutletBLabel = outletStats.get(cmpBarB)?.name ?? "Bar B";
  const comparisonHeaderA = `${comparisonOutletALabel} · ${monthLabel(cmpMonthA)} ${cmpYearA}`;
  const comparisonHeaderB = `${comparisonOutletBLabel} · ${monthLabel(cmpMonthB)} ${cmpYearB}`;

  const breakEvenRows = bars.map((b) => {
    const stats = outletStats.get(b.id);
    const revenue = Number(stats?.revenue ?? 0);
    const cogs = Number(stats?.cogs ?? 0);
    const labor = Number(stats?.labor ?? 0);
    const expenses = Number(stats?.expenses ?? 0);
    const qtySold = Number(stats?.qtySold ?? 0);
    const contribution = revenue - cogs;
    const fixedCosts = labor + expenses;
    const contributionRatio = revenue > 0 ? contribution / revenue : 0;
    const breakEvenRevenue = contributionRatio > 0 ? fixedCosts / contributionRatio : null;
    const contributionPerUnit = qtySold > 0 ? contribution / qtySold : 0;
    const breakEvenUnits = contributionPerUnit > 0 ? fixedCosts / contributionPerUnit : null;
    const gap = breakEvenRevenue !== null ? revenue - breakEvenRevenue : null;
    return {
      outletId: b.id,
      name: b.name,
      revenue,
      contribution,
      fixedCosts,
      contributionRatio,
      breakEvenRevenue,
      breakEvenUnits,
      gap,
    };
  });

  const positiveMarginRows = productMarginRows.filter((r) => r.margin > 0);
  const totalPositiveMargin = positiveMarginRows.reduce((acc, r) => acc + r.margin, 0);
  let runningMargin = 0;
  const paretoRows = positiveMarginRows.map((r) => {
    runningMargin += r.margin;
    const cumulativePct = pct(runningMargin, totalPositiveMargin);
    const sharePct = pct(r.margin, totalPositiveMargin);
    const inTop80 = runningMargin - r.margin < totalPositiveMargin * 0.8;
    return {
      ...r,
      sharePct,
      cumulativePct,
      inTop80,
    };
  });
  const paretoTop80 = paretoRows.filter((r) => r.inTop80);
  const paretoTopMargin = paretoTop80.reduce((acc, r) => acc + r.margin, 0);
  const destructiveProducts = [...productMarginRows]
    .filter((r) => r.margin < 0)
    .sort((a, b) => a.margin - b.margin)
    .slice(0, 8);

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Analytics e monitoraggio</h1>
            <p className="mt-1 text-sm text-zinc-600">KPI, grafici sintetici e confronto bar.</p>
          </div>
          <Link
            href={
              fromOutletId
                ? `/properties/${propertyId}/outlets/${fromOutletId}?year=${year}`
                : `/properties/${propertyId}?year=${year}`
            }
            className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
          >
            ← {fromOutletId ? "Dashboard outlet" : "Dashboard struttura"}
          </Link>
        </header>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <form className="grid gap-2 md:grid-cols-7" method="GET">
            <input type="hidden" name="fromOutletId" value={fromOutletId} />
            <label className="text-xs text-zinc-600 md:col-span-1">
              Anno
              <input name="year" defaultValue={String(year)} type="number" className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-zinc-600 md:col-span-2">
              Data da
              <input name="dateFrom" defaultValue={dateFrom} type="date" className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-zinc-600 md:col-span-2">
              Data a
              <input name="dateTo" defaultValue={dateTo} type="date" className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-zinc-600 md:col-span-1">
              Bar A
              <select name="barA" defaultValue={barA} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm">
                {bars.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-zinc-600 md:col-span-1">
              Bar B
              <select name="barB" defaultValue={barB} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm">
                {bars.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <div className="md:col-span-7 mt-1">
              <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white">Applica filtri</button>
            </div>
          </form>
          <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/40 px-3 py-2 text-xs text-zinc-600">
            KPI struttura aggregati sul range selezionato. Per confronto periodi tra bar usa la sezione &quot;Confronto bar vs bar&quot;.
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Cruscotto sintetico aggregato</h2>
          <div className="mt-2 text-xs text-zinc-500">
            I ricavi netti sono calcolati scorporando IVA 10% dai corrispettivi vendita registrati.
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi title="Ricavi netti" value={money(totalRevenue)} />
            <Kpi title="COGS" value={money(totalCogs)} />
            <Kpi title="Margine lordo" value={money(totalGross)} />
            <Kpi title="Margine operativo" value={money(totalOperating)} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/30 p-4">
              <div className="mb-3 text-sm font-semibold text-zinc-800">Incidenze %</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Kpi title="Food Cost %" value={percent(foodCostPct)} />
                <Kpi title="Labor Cost %" value={percent(laborPct)} />
                <Kpi title="Prime Cost %" value={percent(primeCostPct)} />
                <Kpi title="Operating Margin %" value={percent(operatingMarginPct)} />
              </div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50/30 p-4">
              <div className="mb-3 text-sm font-semibold text-zinc-800">Operativita e Qualita dati</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Kpi title="Scontrino medio" value={money(avgTicket)} />
                <Kpi title="N. vendite" value={String(totalSalesCount)} />
                <Kpi title="Spese centrali" value={money(centralExpenses)} />
                <Kpi title="Copertura inventari bar" value={percent(inventoryCoveragePct)} />
              </div>
              <div className="mt-3 text-xs text-zinc-500">
                N. vendite e scontrino medio sono calcolati per scontrino/testata vendita. I prodotti marcati in “Prodotti” come esclusi dai KPI ticket non entrano in questi due indicatori ma restano inclusi nel resto delle analytics.
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm lg:col-span-2">
            <h2 className="text-lg font-semibold text-zinc-900">Trend economico mensile</h2>
            <LineChart months={byMonth} />
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-zinc-900">Composizione costi</h2>
            <DonutChart
              segments={[
                { label: "COGS", value: totalCogs, color: "#1ec997" },
                { label: "Personale", value: totalLabor, color: "#53e8bd" },
                { label: "Spese", value: totalExpenses, color: "#ff8b6a" },
              ]}
            />
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Confronto bar vs bar (range selezionato)</h2>
          <form method="GET" className="mt-3 grid gap-2 md:grid-cols-8">
            <input type="hidden" name="year" value={year} />
            <input type="hidden" name="dateFrom" value={dateFrom} />
            <input type="hidden" name="dateTo" value={dateTo} />
            <input type="hidden" name="barA" value={barA} />
            <input type="hidden" name="barB" value={barB} />
            <input type="hidden" name="fromOutletId" value={fromOutletId} />

            <label className="text-xs text-zinc-600 md:col-span-2">
              Bar A
              <select name="cmpBarA" defaultValue={cmpBarA} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm">
                {bars.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-zinc-600 md:col-span-2">
              Mese A
              <select name="cmpMonthA" defaultValue={String(cmpMonthA)} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm">
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>{monthLabel(i + 1)}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-zinc-600 md:col-span-1">
              Anno A
              <input name="cmpYearA" defaultValue={String(cmpYearA)} type="number" className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" />
            </label>
            <label className="text-xs text-zinc-600 md:col-span-2">
              Bar B
              <select name="cmpBarB" defaultValue={cmpBarB} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm">
                {bars.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-zinc-600 md:col-span-2">
              Mese B
              <select name="cmpMonthB" defaultValue={String(cmpMonthB)} className="mt-1 w-full rounded-xl border px-3 py-2 text-sm">
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={String(i + 1)}>{monthLabel(i + 1)}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-zinc-600 md:col-span-1">
              Anno B
              <input name="cmpYearB" defaultValue={String(cmpYearB)} type="number" className="mt-1 w-full rounded-xl border px-3 py-2 text-sm" />
            </label>
            <div className="md:col-span-8 mt-1">
              <button className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white">Confronta periodi</button>
            </div>
          </form>
          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-zinc-700">Tabella confronto</h3>
              <table className="mt-2 w-full text-sm">
                <thead className="bg-zinc-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Indice</th>
                    <th className="px-3 py-2">{comparisonHeaderA}</th>
                    <th className="px-3 py-2">{comparisonHeaderB}</th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows(comparisonStatsA, comparisonStatsB).map((r) => (
                    <tr key={r.label} className="border-t">
                      <td className="px-3 py-2 font-medium">{r.label}</td>
                      <td className="px-3 py-2">{r.a}</td>
                      <td className="px-3 py-2">{r.b}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-700">Grafico confronto</h3>
              <CompareBarsChart
                labels={["Ricavi", "COGS", "Personale", "Margine op."]}
                aValues={[
                  comparisonStatsA?.revenue ?? 0,
                  comparisonStatsA?.cogs ?? 0,
                  comparisonStatsA?.labor ?? 0,
                  operating(comparisonStatsA),
                ]}
                bValues={[
                  comparisonStatsB?.revenue ?? 0,
                  comparisonStatsB?.cogs ?? 0,
                  comparisonStatsB?.labor ?? 0,
                  operating(comparisonStatsB),
                ]}
                aName={comparisonHeaderA}
                bName={comparisonHeaderB}
              />
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Price Variance e Purchase Variance</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Price variance: differenza tra prezzo netto registrato in vendita e prezzo netto target configurato. Purchase variance: differenza tra costo acquisto reale e costo standard.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi title="Price Variance" value={money(totalPriceVariance)} />
            <Kpi title="Price Variance %" value={percent(priceVariancePct)} />
            <Kpi title="Purchase Variance" value={money(totalPurchaseVariance)} />
            <Kpi title="Purchase Variance %" value={percent(purchaseVariancePct)} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-zinc-700">Top Price Variance (prodotti)</h3>
              <table className="mt-2 w-full text-sm">
                <thead className="bg-zinc-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Prodotto</th>
                    <th className="px-3 py-2">Qta</th>
                    <th className="px-3 py-2">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {priceVarianceRows.slice(0, 8).map((row) => (
                    <tr key={row.productId} className="border-t">
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2">{qtyLabel(row.qty)}</td>
                      <td className={`px-3 py-2 font-semibold ${row.variance >= 0 ? "text-emerald-600" : "text-red-600"}`}>{money(row.variance)}</td>
                    </tr>
                  ))}
                  {priceVarianceRows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-zinc-500" colSpan={3}>Nessun dato price variance nel periodo.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-700">Top Purchase Variance (prodotti)</h3>
              <table className="mt-2 w-full text-sm">
                <thead className="bg-zinc-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Prodotto</th>
                    <th className="px-3 py-2">Qta</th>
                    <th className="px-3 py-2">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseVarianceRows.slice(0, 8).map((row) => (
                    <tr key={row.productId} className="border-t">
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2">{qtyLabel(row.qty)}</td>
                      <td className={`px-3 py-2 font-semibold ${row.variance <= 0 ? "text-emerald-600" : "text-red-600"}`}>{money(row.variance)}</td>
                    </tr>
                  ))}
                  {purchaseVarianceRows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-zinc-500" colSpan={3}>Nessun dato purchase variance nel periodo.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Mix Variance e Volume Variance (Bar B vs Bar A)</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Analisi del delta ricavi tra {comparisonOutletALabel} (baseline) e {comparisonOutletBLabel}.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Kpi title="Qty Totale Bar A" value={qtyLabel(barAQtyTotal)} />
            <Kpi title="Qty Totale Bar B" value={qtyLabel(barBQtyTotal)} />
            <Kpi title="Mix Variance" value={money(mixVarianceAmount)} />
            <Kpi title="Volume Variance" value={money(volumeVarianceAmount)} />
            <Kpi title="Delta ricavi B-A" value={money(actualRevenueDeltaAB)} />
          </div>
          <div className="mt-2 text-xs text-zinc-500">
            Mix + Volume (a prezzi baseline A): {money(revenueBridgeAtBasePrice)}.
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Break-even per bar</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Punto di pareggio su base contributiva: costi fissi diretti (personale + spese) / contribution ratio.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Bar</th>
                  <th className="px-3 py-2">Ricavi</th>
                  <th className="px-3 py-2">Contribution</th>
                  <th className="px-3 py-2">Contribution %</th>
                  <th className="px-3 py-2">Costi fissi diretti</th>
                  <th className="px-3 py-2">Break-even ricavi</th>
                  <th className="px-3 py-2">Gap vs break-even</th>
                  <th className="px-3 py-2">Break-even qty</th>
                </tr>
              </thead>
              <tbody>
                {breakEvenRows.map((row) => (
                  <tr key={row.outletId} className="border-t">
                    <td className="px-3 py-2 font-medium">{row.name}</td>
                    <td className="px-3 py-2">{money(row.revenue)}</td>
                    <td className="px-3 py-2">{money(row.contribution)}</td>
                    <td className="px-3 py-2">{percent(row.contributionRatio * 100)}</td>
                    <td className="px-3 py-2">{money(row.fixedCosts)}</td>
                    <td className="px-3 py-2">{row.breakEvenRevenue !== null ? money(row.breakEvenRevenue) : "-"}</td>
                    <td className={`px-3 py-2 font-semibold ${row.gap === null ? "" : row.gap >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {row.gap !== null ? money(row.gap) : "-"}
                    </td>
                    <td className="px-3 py-2">{row.breakEvenUnits !== null ? qtyLabel(row.breakEvenUnits) : "-"}</td>
                  </tr>
                ))}
                {breakEvenRows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-zinc-500" colSpan={8}>Nessun bar registrato per questa struttura.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Margine per prodotto (acquisto vs vendita)</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Margine calcolato come Ricavi netti - Costo merci (COGS) sul periodo selezionato. Il costo acquisto medio usa la media tra costo minimo e massimo configurati.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Prodotto</th>
                  <th className="px-3 py-2">Categoria prezzo</th>
                  <th className="px-3 py-2">Qta venduta</th>
                  <th className="px-3 py-2">Prezzo vendita netto Monetica</th>
                  <th className="px-3 py-2">Costo acquisto medio</th>
                  <th className="px-3 py-2">Ricavi</th>
                  <th className="px-3 py-2">Costo merci</th>
                  <th className="px-3 py-2">Margine</th>
                  <th className="px-3 py-2">Margine %</th>
                </tr>
              </thead>
              <tbody>
                {productMarginRows.map((row) => (
                  <tr key={row.productId} className="border-t">
                    <td className="px-3 py-2 font-medium">{row.name}</td>
                    <td className="px-3 py-2">{row.priceCategory}</td>
                    <td className="px-3 py-2">{qtyLabel(row.qtySold)}</td>
                    <td className="px-3 py-2">{money(row.configuredSellPrice)}</td>
                    <td className="px-3 py-2">{unitCostMoney(row.avgUnitCost)}</td>
                    <td className="px-3 py-2">{money(row.revenue)}</td>
                    <td className="px-3 py-2">{money(row.cogs)}</td>
                    <td className={`px-3 py-2 font-semibold ${row.margin >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {money(row.margin)}
                    </td>
                    <td className={`px-3 py-2 font-semibold ${row.marginPct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {percent(row.marginPct)}
                    </td>
                  </tr>
                ))}
                {productMarginRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-5 text-center text-zinc-500">
                      Nessun prodotto disponibile per il periodo selezionato.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Pareto 80/20 prodotti (su margine)</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi title="Prodotti in top 80%" value={String(paretoTop80.length)} />
            <Kpi title="Prodotti con margine +" value={String(positiveMarginRows.length)} />
            <Kpi title="Margine top 80%" value={money(paretoTopMargin)} />
            <Kpi title="Copertura top 80%" value={percent(pct(paretoTopMargin, totalPositiveMargin))} />
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-zinc-700">Classifica Pareto margine</h3>
              <table className="mt-2 w-full text-sm">
                <thead className="bg-zinc-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Prodotto</th>
                    <th className="px-3 py-2">Margine</th>
                    <th className="px-3 py-2">Share %</th>
                    <th className="px-3 py-2">Cum. %</th>
                    <th className="px-3 py-2">Top80</th>
                  </tr>
                </thead>
                <tbody>
                  {paretoRows.slice(0, 12).map((row) => (
                    <tr key={row.productId} className="border-t">
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2">{money(row.margin)}</td>
                      <td className="px-3 py-2">{percent(row.sharePct)}</td>
                      <td className="px-3 py-2">{percent(row.cumulativePct)}</td>
                      <td className="px-3 py-2">{row.inTop80 ? "SI" : "NO"}</td>
                    </tr>
                  ))}
                  {paretoRows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-zinc-500" colSpan={5}>Nessun prodotto con margine positivo nel periodo.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-700">Prodotti distruttivi di margine</h3>
              <table className="mt-2 w-full text-sm">
                <thead className="bg-zinc-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Prodotto</th>
                    <th className="px-3 py-2">Ricavi</th>
                    <th className="px-3 py-2">Costo merci</th>
                    <th className="px-3 py-2">Margine</th>
                  </tr>
                </thead>
                <tbody>
                  {destructiveProducts.map((row) => (
                    <tr key={row.productId} className="border-t">
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2">{money(row.revenue)}</td>
                      <td className="px-3 py-2">{money(row.cogs)}</td>
                      <td className="px-3 py-2 font-semibold text-red-600">{money(row.margin)}</td>
                    </tr>
                  ))}
                  {destructiveProducts.length === 0 ? (
                    <tr>
                      <td className="px-3 py-4 text-zinc-500" colSpan={4}>Nessun prodotto con margine negativo nel periodo.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Classifica outlet per margine operativo</h2>
          <OutletRankChart
            items={[...outletStats.values()].map((o) => ({
              label: o.name,
              value: o.revenue - o.cogs - o.labor - o.expenses,
            }))}
          />
        </section>
      </div>
    </div>
  );
}

function comparisonRows(
  a: {
    revenue: number;
    cogs: number;
    labor: number;
    expenses?: number;
    receiptMetricRevenue: number;
    salesCount: number;
  } | undefined,
  b: {
    revenue: number;
    cogs: number;
    labor: number;
    expenses?: number;
    receiptMetricRevenue: number;
    salesCount: number;
  } | undefined
) {
  const aGross = (a?.revenue ?? 0) - (a?.cogs ?? 0);
  const bGross = (b?.revenue ?? 0) - (b?.cogs ?? 0);
  const aOp = aGross - (a?.labor ?? 0) - Number(a?.expenses ?? 0);
  const bOp = bGross - (b?.labor ?? 0) - Number(b?.expenses ?? 0);
  const aAvgTicket = (a?.salesCount ?? 0) > 0 ? (a?.receiptMetricRevenue ?? 0) / (a?.salesCount ?? 1) : 0;
  const bAvgTicket = (b?.salesCount ?? 0) > 0 ? (b?.receiptMetricRevenue ?? 0) / (b?.salesCount ?? 1) : 0;
  return [
    { label: "Ricavi netti", a: money(a?.revenue ?? 0), b: money(b?.revenue ?? 0) },
    { label: "COGS", a: money(a?.cogs ?? 0), b: money(b?.cogs ?? 0) },
    { label: "Margine lordo", a: money(aGross), b: money(bGross) },
    { label: "Costo personale", a: money(a?.labor ?? 0), b: money(b?.labor ?? 0) },
    { label: "Margine operativo", a: money(aOp), b: money(bOp) },
    { label: "Food Cost %", a: percent(pct(a?.cogs ?? 0, a?.revenue ?? 0)), b: percent(pct(b?.cogs ?? 0, b?.revenue ?? 0)) },
    { label: "Labor Cost %", a: percent(pct(a?.labor ?? 0, a?.revenue ?? 0)), b: percent(pct(b?.labor ?? 0, b?.revenue ?? 0)) },
    { label: "Prime Cost %", a: percent(pct((a?.cogs ?? 0) + (a?.labor ?? 0), a?.revenue ?? 0)), b: percent(pct((b?.cogs ?? 0) + (b?.labor ?? 0), b?.revenue ?? 0)) },
    { label: "Gross Margin %", a: percent(pct(aGross, a?.revenue ?? 0)), b: percent(pct(bGross, b?.revenue ?? 0)) },
    { label: "Operating Margin %", a: percent(pct(aOp, a?.revenue ?? 0)), b: percent(pct(bOp, b?.revenue ?? 0)) },
    { label: "Scontrino medio", a: money(aAvgTicket), b: money(bAvgTicket) },
    { label: "N. vendite", a: String(a?.salesCount ?? 0), b: String(b?.salesCount ?? 0) },
  ];
}

type ComparisonOutletStats = {
  revenue: number;
  cogs: number;
  labor: number;
  expenses: number;
  centralExpenses: number;
  inventoryCoveragePct: number;
  receiptMetricRevenue: number;
  salesCount: number;
};

async function buildComparisonOutletStats(args: {
  propertyId: string;
  orgId: string;
  outletId: string;
  year: number;
  month: number;
  outletCostMap: Map<string, number>;
  avgOutletCostByProduct: Map<string, number>;
  outletPriceMap: Map<string, number>;
  excludedFromReceiptMetricsProductIds: Set<string>;
}): Promise<ComparisonOutletStats> {
  const month = clampMonth(args.month);
  const periodStart = new Date(Date.UTC(args.year, month - 1, 1, 0, 0, 0, 0));
  const periodEnd = new Date(Date.UTC(args.year, month, 0, 23, 59, 59, 999));

  const fy = await prisma.fiscalYear.upsert({
    where: { orgId_year: { orgId: args.orgId, year: args.year } },
    update: {},
    create: {
      orgId: args.orgId,
      year: args.year,
      startDate: new Date(Date.UTC(args.year, 0, 1)),
      endDate: new Date(Date.UTC(args.year, 11, 31, 23, 59, 59)),
    },
  });

  const saleRows = await prisma.saleLine.findMany({
    where: {
      sale: {
        fiscalYearId: fy.id,
        outletId: args.outletId,
        date: { gte: periodStart, lte: periodEnd },
      },
    },
    select: { saleId: true, qty: true, unitPriceNet: true, productId: true },
  });

  const purchaseRows = await prisma.purchaseLine.findMany({
    where: {
      purchase: {
        fiscalYearId: fy.id,
        warehouse: { propertyId: args.propertyId },
        date: { gte: periodStart, lte: periodEnd },
      },
    },
    select: { productId: true, qty: true, unitCostNet: true },
  });

  const avgCostByProduct = new Map<string, number>();
  const purchaseAgg = new Map<string, { qty: number; cost: number }>();
  for (const p of purchaseRows) {
    const prev = purchaseAgg.get(p.productId) ?? { qty: 0, cost: 0 };
    prev.qty += Number(p.qty);
    prev.cost += Number(p.qty) * Number(p.unitCostNet);
    purchaseAgg.set(p.productId, prev);
  }
  for (const [productId, v] of purchaseAgg.entries()) {
    avgCostByProduct.set(productId, v.qty > 0 ? v.cost / v.qty : 0);
  }

  let revenue = 0;
  let cogs = 0;
  const receiptIds = new Set<string>();
  let receiptMetricRevenue = 0;
  for (const r of saleRows) {
    const qty = Number(r.qty);
    const sellUnitPrice = grossToNetSaleUnitPrice(Number(r.unitPriceNet));
    const unitCost = Number(
      args.outletCostMap.get(`${args.outletId}:${r.productId}`) ??
      args.avgOutletCostByProduct.get(r.productId) ??
      avgCostByProduct.get(r.productId) ??
      0
    );
    revenue += qty * sellUnitPrice;
    cogs += qty * unitCost;
    if (!args.excludedFromReceiptMetricsProductIds.has(r.productId)) {
      receiptIds.add(r.saleId);
      receiptMetricRevenue += qty * sellUnitPrice;
    }
  }

  const salesCount = receiptIds.size;

  const laborAgg = await prisma.laborAllocation.aggregate({
    where: {
      outletId: args.outletId,
      laborPool: {
        propertyId: args.propertyId,
        fiscalYearId: fy.id,
        month,
      },
    },
    _sum: { amountNet: true },
  });
  const labor = Number(laborAgg._sum.amountNet ?? 0);

  const expAgg = await prisma.expense.aggregate({
    where: {
      propertyId: args.propertyId,
      fiscalYearId: fy.id,
      outletId: args.outletId,
      date: { gte: periodStart, lte: periodEnd },
    },
    _sum: { amountNet: true },
  });
  const expenses = Number(expAgg._sum.amountNet ?? 0);

  const centralExpAgg = await prisma.expense.aggregate({
    where: {
      propertyId: args.propertyId,
      fiscalYearId: fy.id,
      outletId: null,
      date: { gte: periodStart, lte: periodEnd },
    },
    _sum: { amountNet: true },
  });
  const centralExpenses = Number(centralExpAgg._sum.amountNet ?? 0);

  const bars = await prisma.outlet.findMany({
    where: { propertyId: args.propertyId, type: "BAR" },
    select: { id: true },
  });
  const inventoryRows = await prisma.inventoryCount.findMany({
    where: {
      fiscalYearId: fy.id,
      outlet: { propertyId: args.propertyId, type: "BAR" },
      date: { gte: periodStart, lte: periodEnd },
    },
    select: { outletId: true },
  });
  const inventoryCoveragePct = pct(new Set(inventoryRows.map((r) => r.outletId)).size, bars.length || 1);

  return { revenue, cogs, labor, expenses, centralExpenses, inventoryCoveragePct, receiptMetricRevenue, salesCount };
}

function operating(o: { revenue: number; cogs: number; labor: number; expenses?: number } | undefined) {
  if (!o) return 0;
  return o.revenue - o.cogs - o.labor - Number(o.expenses ?? 0);
}

function Kpi({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-zinc-500">{title}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function LineChart({ months }: { months: Array<{ month: number; revenue: number; cogs: number; operating: number }> }) {
  const w = 680;
  const h = 260;
  const p = 28;

  const values = months.flatMap((m) => [m.revenue, m.cogs, m.operating]);
  const max = Math.max(1, ...values);

  const toPoints = (arr: number[]) =>
    arr
      .map((v, i) => {
        const x = p + (i * (w - p * 2)) / 11;
        const y = h - p - (v / max) * (h - p * 2);
        return `${x},${y}`;
      })
      .join(" ");

  const rev = toPoints(months.map((m) => m.revenue));
  const cogs = toPoints(months.map((m) => m.cogs));
  const op = toPoints(months.map((m) => Math.max(0, m.operating)));

  return (
    <div className="mt-4">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full rounded-xl border border-zinc-200 bg-zinc-50/30">
        {Array.from({ length: 6 }, (_, i) => {
          const y = p + (i * (h - p * 2)) / 5;
          return <line key={i} x1={p} y1={y} x2={w - p} y2={y} stroke="rgba(130,150,190,0.25)" strokeDasharray="3 4" />;
        })}
        <polyline fill="none" stroke="#53e8bd" strokeWidth="3" points={rev} />
        <polyline fill="none" stroke="#ff8b6a" strokeWidth="3" points={cogs} />
        <polyline fill="none" stroke="#1ec997" strokeWidth="3" points={op} />
      </svg>
      <div className="mt-2 flex gap-4 text-xs text-zinc-600">
        <Legend color="#53e8bd" label="Ricavi" />
        <Legend color="#ff8b6a" label="COGS" />
        <Legend color="#1ec997" label="Margine operativo (>=0)" />
      </div>
    </div>
  );
}

function DonutChart({ segments }: { segments: Array<{ label: string; value: number; color: string }> }) {
  const total = Math.max(1, segments.reduce((a, s) => a + s.value, 0));
  const circles = segments.reduce<Array<{ label: string; color: string; len: number; offset: number }>>((acc, s) => {
    const prev = acc[acc.length - 1];
    const offset = prev ? prev.offset + prev.len : 0;
    const len = (s.value / total) * 264;
    acc.push({ label: s.label, color: s.color, len, offset });
    return acc;
  }, []);
  return (
    <div className="mt-4 flex items-center gap-6">
      <svg width="180" height="180" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="42" fill="none" stroke="rgba(145,165,205,0.2)" strokeWidth="14" />
        {circles.map((s) => (
            <circle
              key={s.label}
              cx="60"
              cy="60"
              r="42"
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${s.len} 264`}
              strokeDashoffset={-s.offset}
              transform="rotate(-90 60 60)"
            />
        ))}
      </svg>
      <div className="space-y-2 text-sm">
        {segments.map((s) => (
          <div key={s.label} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="text-zinc-700">{s.label}</span>
            <span className="font-semibold">{money(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OutletRankChart({ items }: { items: Array<{ label: string; value: number }> }) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...sorted.map((i) => Math.abs(i.value)));

  return (
    <div className="mt-4 space-y-2">
      {sorted.map((i) => {
        const width = `${(Math.abs(i.value) / max) * 100}%`;
        const color = i.value >= 0 ? "#1ec997" : "#ff6b81";
        return (
          <div key={i.label}>
            <div className="mb-1 flex justify-between text-sm">
              <span>{i.label}</span>
              <span className="font-semibold">{money(i.value)}</span>
            </div>
            <div className="h-2 rounded bg-zinc-100">
              <div className="h-2 rounded" style={{ width, backgroundColor: color }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CompareBarsChart({
  labels,
  aValues,
  bValues,
  aName,
  bName,
}: {
  labels: string[];
  aValues: number[];
  bValues: number[];
  aName: string;
  bName: string;
}) {
  const max = Math.max(1, ...aValues.map(Math.abs), ...bValues.map(Math.abs));
  return (
    <div className="mt-2 space-y-2">
      {labels.map((label, i) => (
        <div key={label} className="space-y-1">
          <div className="text-xs text-zinc-600">{label}</div>
          <div className="grid gap-1">
            <BarLine name={aName} value={aValues[i]} max={max} color="#53e8bd" />
            <BarLine name={bName} value={bValues[i]} max={max} color="#1ec997" />
          </div>
        </div>
      ))}
    </div>
  );
}

function BarLine({ name, value, max, color }: { name: string; value: number; max: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="w-28 truncate text-zinc-600">{name}</div>
      <div className="h-2 flex-1 rounded bg-zinc-100">
        <div className="h-2 rounded" style={{ width: `${(Math.abs(value) / max) * 100}%`, backgroundColor: color }} />
      </div>
      <div className="w-20 text-right font-semibold">{money(value)}</div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </div>
  );
}

function money(n: number) {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}

function unitCostMoney(n: number) {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(n);
}

function percent(n: number) {
  return `${n.toFixed(1)}%`;
}

function qtyLabel(n: number) {
  return n.toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function clampMonth(month: number) {
  if (!Number.isFinite(month)) return 1;
  return Math.max(1, Math.min(12, Math.trunc(month)));
}

function monthLabel(month: number) {
  const labels = ["Gen", "Feb", "Mar", "Apr", "Mag", "Giu", "Lug", "Ago", "Set", "Ott", "Nov", "Dic"];
  return labels[clampMonth(month) - 1];
}

function pct(n: number, d: number) {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 0;
  return (n / d) * 100;
}
