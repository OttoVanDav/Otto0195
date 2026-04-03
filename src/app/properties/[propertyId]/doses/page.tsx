import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { averageOutletCostRows, listOutletCostsForOutlets } from "@/lib/outlet-product-costs";
import {
  buildDoseDerivedCostMaps,
  deleteDosePool,
  deleteDosePoolSaleLink,
  deleteDosePoolSource,
  listPropertyDosePools,
  upsertDosePool,
  upsertDosePoolSaleLink,
  upsertDosePoolSource,
} from "@/lib/product-doses";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string; fromOutletId?: string }>;
};

export const dynamic = "force-dynamic";

export default async function PropertyDosesPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const fromOutletId = String(sp.fromOutletId ?? "");

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) return notFound();

  const barOutlets = property.outlets.filter((outlet) => outlet.type === "BAR");
  const allOutletIds = property.outlets.map((outlet) => outlet.id);
  const costOutletIds = barOutlets.length > 0 ? barOutlets.map((outlet) => outlet.id) : allOutletIds;
  const hasFromOutlet = barOutlets.some((outlet) => outlet.id === fromOutletId);
  const backHref = hasFromOutlet
    ? `/properties/${propertyId}/outlets/${fromOutletId}?year=${year}`
    : `/properties/${propertyId}?year=${year}`;

  const products = await prisma.product.findMany({
    where: { orgId: property.orgId },
    include: {
      externalMaps: {
        where: { source: "MONETICA" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
    orderBy: { name: "asc" },
  });
  const moneticaProducts = products.filter((product) => product.externalMaps.length > 0);
  const moneticaProductIds = new Set(moneticaProducts.map((product) => product.id));

  const fiscalYear = await prisma.fiscalYear.upsert({
    where: { orgId_year: { orgId: property.orgId, year } },
    update: {},
    create: {
      orgId: property.orgId,
      year,
      startDate: new Date(Date.UTC(year, 0, 1)),
      endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59)),
    },
  });

  const dosePools = await listPropertyDosePools(propertyId).catch(() => []);
  const poolIds = new Set(dosePools.map((pool) => pool.id));
  const sourceIds = new Set(dosePools.flatMap((pool) => pool.sources.map((source) => source.id)));
  const linkIds = new Set(dosePools.flatMap((pool) => pool.links.map((link) => link.id)));

  const purchaseRows = await prisma.purchaseLine.findMany({
    where: {
      purchase: {
        fiscalYearId: fiscalYear.id,
        warehouse: { propertyId },
      },
    },
    select: { productId: true, qty: true, unitCostNet: true },
  });

  const saleRows = await prisma.saleLine.findMany({
    where: {
      sale: {
        fiscalYearId: fiscalYear.id,
        outlet: { propertyId },
      },
    },
    select: { productId: true, qty: true },
  });

  const configuredCostRows = averageOutletCostRows(
    await listOutletCostsForOutlets(costOutletIds, [year]).catch(() => []),
  );

  const avgPurchaseCostByYear = new Map<string, number>();
  const avgPurchaseCostByProduct = new Map<string, number>();
  const purchaseQtyByYear = new Map<string, number>();
  const purchaseQtyByProduct = new Map<string, number>();
  const purchaseAggregate = new Map<string, { qty: number; cost: number }>();
  for (const row of purchaseRows) {
    const current = purchaseAggregate.get(row.productId) ?? { qty: 0, cost: 0 };
    current.qty += Number(row.qty);
    current.cost += Number(row.qty) * Number(row.unitCostNet);
    purchaseAggregate.set(row.productId, current);
    purchaseQtyByProduct.set(row.productId, (purchaseQtyByProduct.get(row.productId) ?? 0) + Number(row.qty));
    purchaseQtyByYear.set(`${year}:${row.productId}`, (purchaseQtyByYear.get(`${year}:${row.productId}`) ?? 0) + Number(row.qty));
  }
  for (const [productId, value] of purchaseAggregate.entries()) {
    const average = value.qty > 0 ? value.cost / value.qty : 0;
    avgPurchaseCostByProduct.set(productId, average);
    avgPurchaseCostByYear.set(`${year}:${productId}`, average);
  }

  const avgConfiguredCostByProduct = new Map<string, number>();
  const configuredAggregate = new Map<string, { sum: number; count: number }>();
  for (const row of configuredCostRows) {
    const current = configuredAggregate.get(row.productId) ?? { sum: 0, count: 0 };
    current.sum += Number(row.unitCostNet);
    current.count += 1;
    configuredAggregate.set(row.productId, current);
  }
  for (const [productId, value] of configuredAggregate.entries()) {
    avgConfiguredCostByProduct.set(productId, value.count > 0 ? value.sum / value.count : 0);
  }

  const soldQtyByProduct = new Map<string, number>();
  for (const row of saleRows) {
    soldQtyByProduct.set(row.productId, (soldQtyByProduct.get(row.productId) ?? 0) + Number(row.qty));
  }

  const doseCostMaps = await buildDoseDerivedCostMaps({
    propertyId,
    years: [year],
    outletIds: costOutletIds,
    configuredCostRows,
    avgPurchaseCostByYear,
    purchaseQtyByYear,
  }).catch(() => ({ specificByTarget: new Map<string, number>(), averageByTarget: new Map<string, number>() }));

  const poolCards = dosePools.map((pool) => {
    const sourceRows = pool.sources.map((source) => {
      const sourceUnitCost = Number(
        avgConfiguredCostByProduct.get(source.sourceProductId) ??
        avgPurchaseCostByProduct.get(source.sourceProductId) ??
        0,
      );
      const purchasedQty = Number(purchaseQtyByProduct.get(source.sourceProductId) ?? 0);
      const availableDoses = purchasedQty * Number(source.dosesPerUnit);
      const weightedUnits = purchasedQty > 0 ? purchasedQty : 1;
      return {
        ...source,
        sourceUnitCost,
        purchasedQty,
        availableDoses,
        weightedUnits,
      };
    });

    const poolWeightedCost = sourceRows.reduce((acc, source) => acc + source.sourceUnitCost * source.weightedUnits, 0);
    const poolWeightedDoses = sourceRows.reduce((acc, source) => acc + Number(source.dosesPerUnit) * source.weightedUnits, 0);
    const poolDoseCost = poolWeightedDoses > 0 ? poolWeightedCost / poolWeightedDoses : 0;
    const availableDoses = sourceRows.reduce((acc, source) => acc + source.availableDoses, 0);

    const linkRows = pool.links.map((link) => {
      const soldQty = Number(soldQtyByProduct.get(link.targetProductId) ?? 0);
      const consumedDoses = soldQty * Number(link.dosesPerSale);
      const unitPoolContribution = poolDoseCost * Number(link.dosesPerSale);
      const totalUnitDoseCost = Number(
        doseCostMaps.averageByTarget.get(`${year}:${link.targetProductId}`) ?? unitPoolContribution,
      );
      return {
        ...link,
        soldQty,
        consumedDoses,
        unitPoolContribution,
        totalUnitDoseCost,
      };
    });

    const consumedDoses = linkRows.reduce((acc, link) => acc + link.consumedDoses, 0);

    return {
      ...pool,
      sourceRows,
      linkRows,
      poolDoseCost,
      availableDoses,
      consumedDoses,
      remainingDoses: availableDoses - consumedDoses,
    };
  });

  const totalSources = poolCards.reduce((acc, pool) => acc + pool.sourceRows.length, 0);
  const totalLinks = poolCards.reduce((acc, pool) => acc + pool.linkRows.length, 0);
  const totalAvailableDoses = poolCards.reduce((acc, pool) => acc + pool.availableDoses, 0);
  const totalConsumedDoses = poolCards.reduce((acc, pool) => acc + pool.consumedDoses, 0);
  const yearChoices = [year - 1, year, year + 1];

  async function savePool(formData: FormData) {
    "use server";
    const name = String(formData.get("name") ?? "").trim();
    const note = String(formData.get("note") ?? "").trim();
    if (!name) return;

    await upsertDosePool(propertyId, name, note || null).catch(() => null);
    revalidateDosePaths(propertyId, year, costOutletIds, hasFromOutlet ? fromOutletId : "");
    redirect(`/properties/${propertyId}/doses?year=${year}${hasFromOutlet ? `&fromOutletId=${fromOutletId}` : ""}`);
  }

  async function savePoolSource(formData: FormData) {
    "use server";
    const poolId = String(formData.get("poolId") ?? "");
    const sourceProductId = String(formData.get("sourceProductId") ?? "");
    const dosesPerUnit = parseNumberInput(formData.get("dosesPerUnit"));
    const note = String(formData.get("note") ?? "").trim();

    if (!poolIds.has(poolId) || !moneticaProductIds.has(sourceProductId)) return;
    if (!Number.isFinite(dosesPerUnit) || dosesPerUnit <= 0) return;

    await upsertDosePoolSource(poolId, sourceProductId, dosesPerUnit, note || null).catch(() => null);
    revalidateDosePaths(propertyId, year, costOutletIds, hasFromOutlet ? fromOutletId : "");
    redirect(`/properties/${propertyId}/doses?year=${year}${hasFromOutlet ? `&fromOutletId=${fromOutletId}` : ""}`);
  }

  async function savePoolLink(formData: FormData) {
    "use server";
    const poolId = String(formData.get("poolId") ?? "");
    const targetProductId = String(formData.get("targetProductId") ?? "");
    const dosesPerSale = parseNumberInput(formData.get("dosesPerSale"));
    const note = String(formData.get("note") ?? "").trim();

    if (!poolIds.has(poolId) || !moneticaProductIds.has(targetProductId)) return;
    if (!Number.isFinite(dosesPerSale) || dosesPerSale <= 0) return;

    await upsertDosePoolSaleLink(poolId, targetProductId, dosesPerSale, note || null).catch(() => null);
    revalidateDosePaths(propertyId, year, costOutletIds, hasFromOutlet ? fromOutletId : "");
    redirect(`/properties/${propertyId}/doses?year=${year}${hasFromOutlet ? `&fromOutletId=${fromOutletId}` : ""}`);
  }

  async function removePool(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    if (!poolIds.has(id)) return;

    await deleteDosePool(id).catch(() => null);
    revalidateDosePaths(propertyId, year, costOutletIds, hasFromOutlet ? fromOutletId : "");
    redirect(`/properties/${propertyId}/doses?year=${year}${hasFromOutlet ? `&fromOutletId=${fromOutletId}` : ""}`);
  }

  async function removePoolSource(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    if (!sourceIds.has(id)) return;

    await deleteDosePoolSource(id).catch(() => null);
    revalidateDosePaths(propertyId, year, costOutletIds, hasFromOutlet ? fromOutletId : "");
    redirect(`/properties/${propertyId}/doses?year=${year}${hasFromOutlet ? `&fromOutletId=${fromOutletId}` : ""}`);
  }

  async function removePoolLink(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    if (!linkIds.has(id)) return;

    await deleteDosePoolSaleLink(id).catch(() => null);
    revalidateDosePaths(propertyId, year, costOutletIds, hasFromOutlet ? fromOutletId : "");
    redirect(`/properties/${propertyId}/doses?year=${year}${hasFromOutlet ? `&fromOutletId=${fromOutletId}` : ""}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name} · {property.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Gestione dosi</h1>
            <p className="mt-1 max-w-4xl text-sm text-zinc-600">
              Ogni pool somma le dosi di uno o piu prodotti origine Monetica. Esempio: puoi creare un pool caffè con “Caffè Perla Nera 1Kg”
              oppure un pool alcolici con piu bottiglie da 1L o 700ml. Lo stesso prodotto vendita puo essere collegato anche a piu pool diversi:
              il software somma i contributi dei pool e usa quel costo reale in analytics, dashboard e vendite e margini.
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-1">
              {yearChoices.map((choice) => (
                <Link
                  key={choice}
                  href={`/properties/${propertyId}/doses?year=${choice}${hasFromOutlet ? `&fromOutletId=${fromOutletId}` : ""}`}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    choice === year ? "bg-zinc-900 text-white shadow-sm" : "text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  {choice}
                </Link>
              ))}
            </div>
            <Link
              href={backHref}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
            >
              {hasFromOutlet ? "← Dashboard outlet" : "← Dashboard struttura"}
            </Link>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-5">
          <StatCard title="Pool dosi" value={String(poolCards.length)} />
          <StatCard title="Prodotti origine" value={String(totalSources)} />
          <StatCard title="Prodotti vendita collegati" value={String(totalLinks)} />
          <StatCard title={`Dosi teoriche ${year}`} value={qty(totalAvailableDoses)} />
          <StatCard title={`Dosi consumate ${year}`} value={qty(totalConsumedDoses)} />
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo pool dosi</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Crea un contenitore logico di dosi. Poi ci inserisci i prodotti origine che alimentano il pool e i prodotti vendita che consumano quelle dosi.
          </p>
          <form action={savePool} className="mt-4 grid gap-2 md:grid-cols-3">
            <input
              name="name"
              required
              placeholder="Nome pool, es. Base caffè o Base gin"
              className="rounded-xl border px-3 py-2 text-sm"
            />
            <input
              name="note"
              placeholder="Nota"
              className="rounded-xl border px-3 py-2 text-sm"
            />
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
              Salva pool
            </button>
          </form>
        </section>

        {poolCards.length === 0 ? (
          <section className="rounded-2xl border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
            Nessun pool configurato. Crea un pool, aggiungi i prodotti origine Monetica e collega i prodotti vendita che ne consumano le dosi.
          </section>
        ) : (
          poolCards.map((pool) => (
            <section key={pool.id} className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">{pool.name}</h2>
                  <div className="mt-1 text-sm text-zinc-600">
                    costo medio per dose {money3(pool.poolDoseCost)} · dosi teoriche {qty(pool.availableDoses)} · dosi residue {qty(pool.remainingDoses)}
                  </div>
                  {pool.note ? <div className="mt-1 text-sm text-zinc-500">{pool.note}</div> : null}
                </div>
                <form action={removePool}>
                  <input type="hidden" name="id" value={pool.id} />
                  <button className="rounded-xl border border-red-200 px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">
                    Rimuovi pool
                  </button>
                </form>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-6">
                <MiniStat title="Prodotti origine" value={String(pool.sourceRows.length)} />
                <MiniStat title="Prodotti vendita" value={String(pool.linkRows.length)} />
                <MiniStat title="Dosi teoriche" value={qty(pool.availableDoses)} />
                <MiniStat title="Dosi consumate" value={qty(pool.consumedDoses)} />
                <MiniStat title="Dosi residue" value={qty(pool.remainingDoses)} />
                <MiniStat title="Costo per dose" value={money3(pool.poolDoseCost)} />
              </div>

              <div className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                <h3 className="text-sm font-semibold text-zinc-900">Aggiungi prodotto origine al pool</h3>
                <p className="mt-1 text-sm text-zinc-600">
                  Qui puoi sommare piu bottiglie o confezioni diverse nello stesso pool. Esempio: bottiglia gin 1L e bottiglia gin 700ml.
                </p>
                <form action={savePoolSource} className="mt-3 grid gap-2 md:grid-cols-4">
                  <input type="hidden" name="poolId" value={pool.id} />
                  <select name="sourceProductId" required className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm">
                    <option value="">Prodotto origine Monetica</option>
                    {moneticaProducts.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                  <input
                    name="dosesPerUnit"
                    type="number"
                    min="0.001"
                    step="0.001"
                    required
                    placeholder="Dosi ricavate per unita"
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
                  />
                  <input
                    name="note"
                    placeholder="Nota prodotto origine"
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
                  />
                  <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
                    Salva prodotto origine
                  </button>
                </form>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-left">
                    <tr>
                      <th className="px-3 py-2">Prodotto origine</th>
                      <th className="px-3 py-2">Dosi per unita</th>
                      <th className="px-3 py-2">Acquisti {year}</th>
                      <th className="px-3 py-2">Dosi teoriche</th>
                      <th className="px-3 py-2">Costo unitario origine</th>
                      <th className="px-3 py-2">Nota</th>
                      <th className="px-3 py-2">Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pool.sourceRows.map((source) => (
                      <tr key={source.id} className="border-t">
                        <td className="px-3 py-2 font-medium">{source.sourceProductName}</td>
                        <td className="px-3 py-2">{qty(Number(source.dosesPerUnit))}</td>
                        <td className="px-3 py-2">{qtyWithUom(source.purchasedQty, source.sourceProductUom)}</td>
                        <td className="px-3 py-2">{qty(source.availableDoses)}</td>
                        <td className="px-3 py-2">{money3(source.sourceUnitCost)}</td>
                        <td className="px-3 py-2 text-zinc-600">{source.note || "—"}</td>
                        <td className="px-3 py-2">
                          <form action={removePoolSource}>
                            <input type="hidden" name="id" value={source.id} />
                            <button className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">
                              Rimuovi
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                    {pool.sourceRows.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-3 py-5 text-zinc-500">
                          Nessun prodotto origine collegato a questo pool.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                <h3 className="text-sm font-semibold text-zinc-900">Collega prodotto vendita Monetica</h3>
                <p className="mt-1 text-sm text-zinc-600">
                  Lo stesso prodotto vendita puo essere collegato anche a piu pool. Esempio: un cocktail puo consumare 1 dose di gin e 1 dose di bitter.
                </p>
                <form action={savePoolLink} className="mt-3 grid gap-2 md:grid-cols-4">
                  <input type="hidden" name="poolId" value={pool.id} />
                  <select name="targetProductId" required className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm">
                    <option value="">Prodotto vendita Monetica</option>
                    {moneticaProducts.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </select>
                  <input
                    name="dosesPerSale"
                    type="number"
                    min="0.001"
                    step="0.001"
                    defaultValue="1"
                    required
                    placeholder="Dosi consumate per vendita"
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
                  />
                  <input
                    name="note"
                    placeholder="Nota collegamento"
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm"
                  />
                  <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
                    Salva collegamento
                  </button>
                </form>
              </div>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-left">
                    <tr>
                      <th className="px-3 py-2">Prodotto vendita</th>
                      <th className="px-3 py-2">Dosi per vendita</th>
                      <th className="px-3 py-2">Vendite {year}</th>
                      <th className="px-3 py-2">Dosi consumate</th>
                      <th className="px-3 py-2">Costo da questo pool</th>
                      <th className="px-3 py-2">Costo totale prodotto</th>
                      <th className="px-3 py-2">Nota</th>
                      <th className="px-3 py-2">Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pool.linkRows.map((link) => (
                      <tr key={link.id} className="border-t">
                        <td className="px-3 py-2 font-medium">{link.targetProductName}</td>
                        <td className="px-3 py-2">{qty(Number(link.dosesPerSale))}</td>
                        <td className="px-3 py-2">{qty(link.soldQty)}</td>
                        <td className="px-3 py-2">{qty(link.consumedDoses)}</td>
                        <td className="px-3 py-2">{money3(link.unitPoolContribution)}</td>
                        <td className="px-3 py-2 font-medium">{money3(link.totalUnitDoseCost)}</td>
                        <td className="px-3 py-2 text-zinc-600">{link.note || "—"}</td>
                        <td className="px-3 py-2">
                          <form action={removePoolLink}>
                            <input type="hidden" name="id" value={link.id} />
                            <button className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">
                              Rimuovi
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                    {pool.linkRows.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-3 py-5 text-zinc-500">
                          Nessun prodotto vendita collegato a questo pool.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function revalidateDosePaths(propertyId: string, year: number, outletIds: string[], fromOutletId: string) {
  revalidatePath(`/properties/${propertyId}/doses`);
  revalidatePath(`/properties/${propertyId}/doses?year=${year}`);
  if (fromOutletId) {
    revalidatePath(`/properties/${propertyId}/doses?year=${year}&fromOutletId=${fromOutletId}`);
  }
  revalidatePath(`/properties/${propertyId}`);
  revalidatePath(`/properties/${propertyId}?year=${year}`);
  revalidatePath(`/properties/${propertyId}/analytics?year=${year}`);
  revalidatePath(`/properties/${propertyId}/sales?year=${year}`);

  for (const outletId of outletIds) {
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}?year=${year}`);
  }
}

function parseNumberInput(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  return Number(raw.replace(",", "."));
}

function qty(value: number) {
  return Number(value ?? 0).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

function qtyWithUom(value: number, uom: string) {
  const rendered = qty(value);
  const cleanedUom = String(uom ?? "").trim().toUpperCase();
  return cleanedUom ? `${rendered} ${cleanedUom}` : rendered;
}

function money3(value: number) {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value);
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function MiniStat({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4">
      <div className="text-xs text-zinc-500">{title}</div>
      <div className="mt-1 text-base font-semibold text-zinc-900">{value}</div>
    </div>
  );
}
