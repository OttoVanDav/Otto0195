// src/app/properties/[propertyId]/page.tsx

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentAppAuthUser, requireAdminAppAuthUser } from "@/lib/app-auth-server";
import { averageOutletCostRows, listOutletCostsForOutlets } from "@/lib/outlet-product-costs";
import { hasAppSectionPermission } from "@/lib/app-permissions";
import { buildDoseDerivedCostMaps } from "@/lib/product-doses";
import { grossToNetSaleUnitPrice } from "@/lib/sales-vat";
import { revalidatePath } from "next/cache";
import { OutletType } from "@prisma/client";
import { notFound } from "next/navigation";

type PageProps = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string }>;
};

export const dynamic = "force-dynamic";

function clsx(...x: Array<string | false | null | undefined>) {
  return x.filter(Boolean).join(" ");
}

export default async function PropertyDashboardPage({ params, searchParams }: PageProps) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const currentUser = await getCurrentAppAuthUser();

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { warehouse: true, outlets: true, org: true },
  });

  if (!property) return notFound();

  const canAccessControlManagement = hasAppSectionPermission(currentUser, "controlManagement");
  const canAccessSalesPoints = hasAppSectionPermission(currentUser, "salesPoints");
  const canAccessOutletDashboards = hasAppSectionPermission(currentUser, "outletDashboards");
  const canSeeAnySection = canAccessControlManagement || canAccessSalesPoints;

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

  const sales = await prisma.saleLine.findMany({
    where: {
      sale: {
        fiscalYearId: fy.id,
        outlet: { propertyId },
      },
    },
    select: {
      qty: true,
      unitPriceNet: true,
      productId: true,
      sale: { select: { outletId: true } },
    },
  });

  const purchaseLines = await prisma.purchaseLine.findMany({
    where: {
      purchase: {
        fiscalYearId: fy.id,
        warehouse: { propertyId },
      },
    },
    select: {
      productId: true,
      qty: true,
      unitCostNet: true,
    },
  });

  const expensesAgg = await prisma.expense.aggregate({
    where: { propertyId, fiscalYearId: fy.id },
    _sum: { amountNet: true },
  });

  const laborAgg = await prisma.laborAllocation.aggregate({
    where: { laborPool: { propertyId, fiscalYearId: fy.id } },
    _sum: { amountNet: true },
  });

  async function createOutlet(formData: FormData) {
    "use server";
    await requireAdminAppAuthUser();
    const name = String(formData.get("name") ?? "").trim();
    const type = String(formData.get("type") ?? "BAR") as OutletType;
    if (!name) return;

    await prisma.outlet.create({
      data: { propertyId, name, type },
    });

    revalidatePath(`/properties/${propertyId}?year=${year}`);
  }

  async function createBar(formData: FormData) {
    "use server";
    await requireAdminAppAuthUser();
    const name = String(formData.get("barName") ?? "").trim();
    if (!name) return;

    await prisma.outlet.create({
      data: { propertyId, name, type: "BAR" },
    });

    revalidatePath(`/properties/${propertyId}?year=${year}`);
  }

  const bars = property.outlets.filter((o) => o.type === "BAR");
  const restaurants = property.outlets.filter((o) => o.type === "RESTAURANT");
  const yearChoices = [year - 1, year, year + 1];
  const configuredCostRows = averageOutletCostRows(
    await listOutletCostsForOutlets(property.outlets.map((outlet) => outlet.id), [year]).catch(() => []),
  );
  const configuredCostMap = new Map(
    configuredCostRows.map((row) => [`${row.outletId}:${row.productId}`, Number(row.unitCostNet)]),
  );

  const avgCostMap = new Map<string, number>();
  const costAgg = new Map<string, { qty: number; cost: number }>();
  for (const p of purchaseLines) {
    const prev = costAgg.get(p.productId) ?? { qty: 0, cost: 0 };
    prev.qty += Number(p.qty);
    prev.cost += Number(p.qty) * Number(p.unitCostNet);
    costAgg.set(p.productId, prev);
  }
  for (const [productId, v] of costAgg.entries()) {
    avgCostMap.set(productId, v.qty > 0 ? v.cost / v.qty : 0);
  }

  const avgCostByYear = new Map<string, number>();
  const purchaseQtyByYear = new Map<string, number>();
  for (const [productId, value] of avgCostMap.entries()) {
    avgCostByYear.set(`${year}:${productId}`, value);
  }
  for (const [productId, value] of costAgg.entries()) {
    purchaseQtyByYear.set(`${year}:${productId}`, value.qty);
  }

  const doseCostMaps = await buildDoseDerivedCostMaps({
    propertyId,
    years: [year],
    outletIds: property.outlets.map((outlet) => outlet.id),
    configuredCostRows,
    avgPurchaseCostByYear: avgCostByYear,
    purchaseQtyByYear,
  }).catch(() => ({ specificByTarget: new Map<string, number>(), averageByTarget: new Map<string, number>() }));

  for (const [key, value] of doseCostMaps.specificByTarget.entries()) {
    const [, outletId, productId] = key.split(":");
    if (outletId && productId) {
      configuredCostMap.set(`${outletId}:${productId}`, Number(value));
    }
  }

  const revenueNet = sales.reduce((acc, s) => acc + Number(s.qty) * grossToNetSaleUnitPrice(Number(s.unitPriceNet)), 0);
  const cogsEst = sales.reduce(
    (acc, s) => acc + Number(s.qty) * Number(configuredCostMap.get(`${s.sale.outletId}:${s.productId}`) ?? avgCostMap.get(s.productId) ?? 0),
    0
  );
  const grossMarginEst = revenueNet - cogsEst;
  const laborNet = Number(laborAgg._sum.amountNet ?? 0);
  const expensesNet = Number(expensesAgg._sum.amountNet ?? 0);
  const operatingMarginEst = grossMarginEst - laborNet - expensesNet;

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-white">
      <div className="sticky top-0 z-10 border-b bg-white/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-zinc-500">{property.org.name}</div>
              <div className="text-lg font-semibold text-zinc-900">{property.name}</div>
            </div>
            <Link
              href="/properties"
              className="rounded-xl border px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
            >
              ← Strutture
            </Link>
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-6xl px-6 py-6">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              Controllo di gestione
            </h1>

            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-xl border bg-zinc-50 p-1">
                {yearChoices.map((y) => (
                  <Link
                    key={y}
                    href={`/properties/${propertyId}?year=${y}`}
                    className={clsx(
                      "rounded-lg px-3 py-1.5 text-sm font-medium transition",
                      y === year
                        ? "bg-zinc-900 text-white shadow-sm"
                        : "text-zinc-700 hover:bg-white hover:shadow-sm"
                    )}
                  >
                    {y}
                  </Link>
                ))}
              </div>
            </div>
          </div>

          {canAccessControlManagement ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <QuickCard href={`/properties/${propertyId}/analytics?year=${year}`} title="Analytics" />
              <QuickCard href={`/properties/${propertyId}/products?year=${year}`} title="Prodotti" />
              <QuickCard href={`/properties/${propertyId}/costs?year=${year}`} title="Costo acquisto merci" />
              <QuickCard href={`/properties/${propertyId}/doses?year=${year}`} title="Gestione dosi" />
              <QuickCard href={`/properties/${propertyId}/suppliers?year=${year}`} title="Fornitori" />
              <QuickCard href={`/properties/${propertyId}/warehouse/purchases?year=${year}`} title="Carichi" />
              <QuickCard href={`/properties/${propertyId}/warehouse/transfers?year=${year}`} title="Prelievi" />
              <QuickCard href={`/properties/${propertyId}/sales?year=${year}`} title="Vendite" />
              <QuickCard href={`/properties/${propertyId}/inventory?year=${year}`} title="Inventari Bar" />
              <QuickCard href={`/properties/${propertyId}/labor?year=${year}`} title="Personale" />
              {currentUser?.isAdmin ? (
                <QuickCard href={`/properties/${propertyId}/settings?year=${year}`} title="Impostazioni" />
              ) : null}
            </div>
          ) : (
            <div className="mt-5 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
              Il tuo profilo non ha accesso alla macrosezione “Controllo di gestione”.
            </div>
          )}
        </div>

        {canAccessControlManagement ? (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <KpiCard title="Ricavi netti" value={money(revenueNet)} />
            <KpiCard title="Costo venduto stimato" value={money(cogsEst)} />
            <KpiCard title="Margine lordo stimato" value={money(grossMarginEst)} />
            <KpiCard title="Costo personale" value={money(laborNet)} />
            <KpiCard title="Margine operativo stimato" value={money(operatingMarginEst)} />
          </div>
        ) : null}

        {/* Outlets + Warehouse */}
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {canAccessSalesPoints ? (
            <section className="lg:col-span-2">
              <div className="rounded-2xl border bg-white p-6 shadow-sm">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-zinc-900">Punti vendita</h2>
                  <div className="text-xs font-medium text-zinc-500">
                    {property.outlets.length}
                  </div>
                </div>

                {currentUser?.isAdmin ? (
                  <>
                    <form action={createOutlet} className="mt-4 grid gap-2 sm:grid-cols-5">
                      <input
                        name="name"
                        placeholder="Nome"
                        className="sm:col-span-3 rounded-xl border px-3 py-2 text-sm focus:border-zinc-400 outline-none"
                      />
                      <select
                        name="type"
                        className="sm:col-span-1 rounded-xl border px-3 py-2 text-sm focus:border-zinc-400 outline-none"
                      >
                        <option value="BAR">Bar</option>
                        <option value="RESTAURANT">Ristorante</option>
                      </select>
                      <button className="sm:col-span-1 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
                        Aggiungi
                      </button>
                    </form>

                    <form action={createBar} className="mt-3 grid gap-2 sm:grid-cols-5">
                      <input
                        name="barName"
                        placeholder="Nome bar (es. Bar Piscina)"
                        className="sm:col-span-4 rounded-xl border px-3 py-2 text-sm focus:border-zinc-400 outline-none"
                      />
                      <button className="sm:col-span-1 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-100">
                        Registra Bar
                      </button>
                    </form>
                  </>
                ) : null}

                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {bars.map((o) => (
                    <OutletCard
                      key={o.id}
                      name={o.name}
                      href={canAccessOutletDashboards ? `/properties/${propertyId}/outlets/${o.id}?year=${year}` : undefined}
                    />
                  ))}
                  {restaurants.map((o) => (
                    <OutletCard
                      key={o.id}
                      name={o.name}
                      href={canAccessOutletDashboards ? `/properties/${propertyId}/outlets/${o.id}?year=${year}` : undefined}
                    />
                  ))}
                </div>
              </div>
            </section>
          ) : canSeeAnySection ? null : (
            <section className="lg:col-span-2">
              <div className="rounded-2xl border bg-white p-6 text-sm text-zinc-600 shadow-sm">
                Il tuo profilo non ha accesso a nessuna macrosezione disponibile su questa struttura.
                <div className="mt-3">
                  <Link
                    href={`/login?force=1&next=${encodeURIComponent(`/properties/${propertyId}?year=${year}`)}`}
                    className="inline-flex rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50"
                  >
                    Accedi con un altro account
                  </Link>
                </div>
              </div>
            </section>
          )}

          <aside>
            <div className="rounded-2xl border bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-zinc-900">Magazzino</h2>
              {property.warehouse && (
                <div className="mt-4 rounded-xl bg-zinc-50 p-4">
                  <div className="text-sm font-semibold text-zinc-900">
                    {property.warehouse.name}
                  </div>
                  <div className="text-xs text-zinc-600 font-mono">
                    {property.warehouse.id}
                  </div>
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

function QuickCard({ title, href }: { title: string; href: string }) {
  return (
    <Link
      href={href}
      className="rounded-2xl border bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="text-sm font-semibold text-zinc-900">{title}</div>
    </Link>
  );
}

function OutletCard({ name, href }: { name: string; href?: string }) {
  if (!href) {
    return (
      <div className="rounded-2xl border bg-zinc-50 p-4 shadow-sm">
        <div className="text-sm font-semibold text-zinc-900">{name}</div>
        <div className="mt-1 text-xs text-zinc-500">Dashboard punto vendita non abilitato per questo utente.</div>
      </div>
    );
  }

  return (
    <Link href={href} className="rounded-2xl border bg-white p-4 shadow-sm transition hover:shadow-md">
      <div className="text-sm font-semibold text-zinc-900">{name}</div>
    </Link>
  );
}

function KpiCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="text-xs text-zinc-500">{title}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function money(n: number) {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}
