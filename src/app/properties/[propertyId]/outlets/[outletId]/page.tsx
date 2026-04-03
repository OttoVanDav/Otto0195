import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentAppAuthUser } from "@/lib/app-auth-server";
import { hasAppSectionPermission } from "@/lib/app-permissions";
import { averageOutletCostRows, listOutletCosts } from "@/lib/outlet-product-costs";
import { buildDoseDerivedCostMaps } from "@/lib/product-doses";
import { grossToNetSaleUnitPrice } from "@/lib/sales-vat";
import { notFound } from "next/navigation";

type Props = {
  params: Promise<{ propertyId: string; outletId: string }>;
  searchParams?: Promise<{ year?: string }>;
};

export const dynamic = "force-dynamic";

function money(n: number) {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}

export default async function OutletDashboardPage({ params, searchParams }: Props) {
  const { propertyId, outletId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const currentUser = await getCurrentAppAuthUser();
  const canAccessControlManagement = hasAppSectionPermission(currentUser, "controlManagement");

  const outlet = await prisma.outlet.findUnique({
    where: { id: outletId },
    include: { property: { include: { org: true } } },
  });
  if (!outlet) return notFound();

  const fy = await prisma.fiscalYear.findFirst({
    where: { orgId: outlet.property.orgId, year },
    select: { id: true },
  });
  const fiscalYearId = fy?.id;

  const revenueRows =
    fiscalYearId
      ? await prisma.saleLine.findMany({
          where: { sale: { outletId, fiscalYearId } },
          select: { qty: true, unitPriceNet: true, productId: true, product: { select: { name: true } } },
        })
      : [];
  const revenueNet = revenueRows.reduce((acc, r) => {
    return acc + Number(r.qty) * grossToNetSaleUnitPrice(Number(r.unitPriceNet));
  }, 0);

  const purchaseRows =
    fiscalYearId
      ? await prisma.purchaseLine.findMany({
          where: {
            purchase: {
              fiscalYearId,
              warehouse: { propertyId },
            },
          },
          select: { productId: true, qty: true, unitCostNet: true },
        })
      : [];

  const outletCostRows =
    fiscalYearId
      ? await listOutletCosts(outletId, year).catch(() => [])
      : [];
  const outletCostMap = new Map(
    averageOutletCostRows(outletCostRows).map((r) => [r.productId, Number(r.unitCostNet)]),
  );

  const avgCostByProduct = new Map<string, number>();
  const costAgg = new Map<string, { qty: number; cost: number }>();
  for (const p of purchaseRows) {
    const prev = costAgg.get(p.productId) ?? { qty: 0, cost: 0 };
    prev.qty += Number(p.qty);
    prev.cost += Number(p.qty) * Number(p.unitCostNet);
    costAgg.set(p.productId, prev);
  }
  for (const [productId, v] of costAgg.entries()) {
    avgCostByProduct.set(productId, v.qty > 0 ? v.cost / v.qty : 0);
  }

  const avgCostByYear = new Map<string, number>();
  const purchaseQtyByYear = new Map<string, number>();
  for (const [productId, value] of avgCostByProduct.entries()) {
    avgCostByYear.set(`${year}:${productId}`, value);
  }
  for (const [productId, value] of costAgg.entries()) {
    purchaseQtyByYear.set(`${year}:${productId}`, value.qty);
  }

  const doseCostMaps = await buildDoseDerivedCostMaps({
    propertyId,
    years: [year],
    outletIds: [outletId],
    configuredCostRows: averageOutletCostRows(outletCostRows),
    avgPurchaseCostByYear: avgCostByYear,
    purchaseQtyByYear,
  }).catch(() => ({ specificByTarget: new Map<string, number>(), averageByTarget: new Map<string, number>() }));

  for (const [key, value] of doseCostMaps.specificByTarget.entries()) {
    const [, mappedOutletId, productId] = key.split(":");
    if (mappedOutletId === outletId && productId) {
      outletCostMap.set(productId, Number(value));
    }
  }

  const cogsNet = revenueRows.reduce((acc, r) => {
    const unitCost = outletCostMap.get(r.productId) ?? Number(avgCostByProduct.get(r.productId) ?? 0);
    return acc + Number(r.qty) * unitCost;
  }, 0);
  const grossMarginNet = revenueNet - cogsNet;

  const transferRows =
    fiscalYearId
      ? await prisma.stockMoveLine.findMany({
          where: { move: { outletId, fiscalYearId, type: "TRANSFER_TO_OUTLET" } },
          select: { qty: true },
        })
      : [];
  const qtyIn = transferRows.reduce((acc, r) => acc + Number(r.qty), 0);

  const laborAgg =
    fiscalYearId
      ? await prisma.laborAllocation.aggregate({
          where: {
            outletId,
            laborPool: {
              fiscalYearId,
              type: outlet.type === "BAR" ? "BAR_POOL" : "DIRECT",
            },
          },
          _sum: { amountNet: true },
        })
      : { _sum: { amountNet: null } };
  const laborNet = Number(laborAgg._sum.amountNet ?? 0);

  const expAgg =
    fiscalYearId
      ? await prisma.expense.aggregate({
          where: { outletId, fiscalYearId },
          _sum: { amountNet: true },
        })
      : { _sum: { amountNet: null } };
  const expensesNet = Number(expAgg._sum.amountNet ?? 0);
  const operatingMarginNet = grossMarginNet - laborNet - expensesNet;

  const yearChoices = [year - 1, year, year + 1];

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-white">
      <div className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-zinc-500">
                {outlet.property.org.name} · {outlet.property.name}
              </div>
              <div className="truncate text-lg font-semibold text-zinc-900">{outlet.name}</div>
            </div>

            <Link
              href={`/properties/${propertyId}?year=${year}`}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              ← Struttura
            </Link>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-6 py-6">
        <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Dashboard punto vendita</h1>
              <p className="mt-1 text-sm text-zinc-600">KPI sintetici + accesso rapido alle sezioni operative.</p>
            </div>

            <div className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-1">
              {yearChoices.map((y) => (
                <Link
                  key={y}
                  href={`/properties/${propertyId}/outlets/${outletId}?year=${y}`}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    y === year ? "bg-zinc-900 text-white shadow-sm" : "text-zinc-700 hover:bg-white hover:shadow-sm"
                  }`}
                >
                  {y}
                </Link>
              ))}
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {canAccessControlManagement ? (
              <>
                <Metric title="Ricavi (netti)" value={money(revenueNet)} />
                <Metric title="Costo merci (COGS)" value={money(cogsNet)} />
                <Metric title="Margine lordo merce" value={money(grossMarginNet)} />
                <Metric title="Personale allocato" value={money(laborNet)} />
                <Metric title="Spese dirette" value={money(expensesNet)} />
                <Metric title="Quantità in ingresso" value={String(Math.round(qtyIn))} />
                <Metric title="Margine operativo" value={money(operatingMarginNet)} />
              </>
            ) : (
              <div className="sm:col-span-2 lg:col-span-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
                Questo profilo può usare solo la sezione <span className="font-semibold text-zinc-900">Prelievi</span> del punto vendita.
              </div>
            )}
          </div>

          {canAccessControlManagement ? (
            <div className="mt-3 text-xs text-zinc-500">
              {outlet.type === "BAR"
                ? "COGS usa il costo acquisto condiviso dei bar; se mancante usa il costo medio dai carichi magazzino."
                : "COGS usa prima il costo merci specifico outlet; se mancante usa il costo medio dai carichi magazzino."}
            </div>
          ) : null}

          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Action href={`/properties/${propertyId}/warehouse/transfers?year=${year}&fromOutletId=${outletId}`} title="Prelievi" subtitle="Scarichi magazzino → outlet" />
            {canAccessControlManagement ? (
              <>
                <Action href={`/properties/${propertyId}/analytics?year=${year}&fromOutletId=${outletId}`} title="Analytics" subtitle="Indici e monitoraggio" />
                <Action
                  href={
                    outlet.type === "BAR"
                      ? `/properties/${propertyId}/costs?year=${year}&fromOutletId=${outletId}`
                      : `/properties/${propertyId}/outlets/${outletId}/costs?year=${year}&fromOutletId=${outletId}`
                  }
                  title="Costi merci"
                  subtitle={
                    outlet.type === "BAR"
                      ? "Costo acquisto unico per tutti i bar"
                      : "Costo acquisto prodotti del punto vendita"
                  }
                />
                <Action href={`/properties/${propertyId}/outlets/${outletId}/prices?year=${year}&fromOutletId=${outletId}`} title="Prezzi vendita" subtitle="Prezzo vendita prodotti al cliente" />
                <Action href={`/properties/${propertyId}/sales?year=${year}&fromOutletId=${outletId}`} title="Vendite" subtitle="Monetica + manuale" />
                {outlet.type === "BAR" ? (
                  <Action href={`/properties/${propertyId}/inventory?year=${year}&fromOutletId=${outletId}`} title="Inventari Bar" subtitle="Conteggi e shrinkage" />
                ) : (
                  <Action href={`/properties/${propertyId}/products?year=${year}&fromOutletId=${outletId}`} title="Prodotti" subtitle="Anagrafica e costi" />
                )}
                <Action
                  href={`/properties/${propertyId}/labor?year=${year}&fromOutletId=${outletId}`}
                  title="Personale"
                  subtitle={outlet.type === "BAR" ? "Pool bar (rotazione)" : "Pool ristorante fisso"}
                />
                <Action href={`/properties/${propertyId}/products?year=${year}&fromOutletId=${outletId}`} title="Prodotti" subtitle="Anagrafica + mapping" />
              </>
            ) : null}
            <Action href={`/properties/${propertyId}?year=${year}`} title="Dashboard struttura" subtitle="Vista generale" />
          </div>
        </div>
      </main>
    </div>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function Action({ href, title, subtitle }: { href: string; title: string; subtitle: string }) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-zinc-900">{title}</div>
        <div className="mt-1 text-sm text-zinc-600">{subtitle}</div>
      </div>
    </Link>
  );
}
