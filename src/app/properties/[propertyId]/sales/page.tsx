import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ensureFiscalYear, syncOfficialMoneticaSales } from "@/lib/monetica-sales";
import { averageOutletCostRows, listOutletCostsForOutlets } from "@/lib/outlet-product-costs";
import { getOutletConfiguredPrice } from "@/lib/outlet-product-prices";
import { buildDoseDerivedCostMaps } from "@/lib/product-doses";
import { grossToNetSaleUnitPrice } from "@/lib/sales-vat";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import AutoRefresh from "./auto-refresh";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{
    year?: string;
    outletId?: string;
    fromOutletId?: string;
    from?: string;
    to?: string;
  }>;
};

export const dynamic = "force-dynamic";

type AvgCostMap = Map<string, number>;
type PurchaseQtyMap = Map<string, number>;

const AUTO_REFRESH_MS = 600_000;

export default async function SalesPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const requestedYear = Number(sp.year ?? new Date().getUTCFullYear());
  const year = Number.isFinite(requestedYear) ? requestedYear : new Date().getUTCFullYear();
  const outletFilter = sp.outletId ?? "";
  const fromOutletId = sp.fromOutletId ?? "";
  const rawFrom = normalizeDateInput(sp.from);
  const rawTo = normalizeDateInput(sp.to);
  const filterFrom = rawFrom ?? rawTo;
  const filterTo = rawTo ?? rawFrom;
  const hasDateFilter = Boolean(filterFrom || filterTo);

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) return notFound();

  const orgId = property.orgId;
  const fiscalYear = await ensureFiscalYear(orgId, year);
  const barOutlets = property.outlets.filter((outlet) => outlet.type === "BAR");

  const products = await prisma.product.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
  });

  const moneticaPushEndpoint = `/api/monetica/sales?propertyId=${propertyId}`;
  const moneticaPushEndpointWithDate = `${moneticaPushEndpoint}&date=${new Date().toISOString().slice(0, 10)}`;
  const moneticaOfficialEndpoint = process.env.MONETICA_TRANSACTIONS_URL?.trim() ?? "";
  const moneticaSalesConfigured = Boolean(process.env.MONETICA_TRANSACTIONS_URL && process.env.MONETICA_API_BEARER_TOKEN);
  const shouldAutoSyncLatestSales = !hasDateFilter;
  const moneticaPayloadExample = JSON.stringify(
    [
      {
        id: 1,
        pos: 5,
        pos_name: "Bar Del Sole",
        transaction_id: 1234,
        transaction_type: "purchase_success",
        transaction_items: [
          {
            sku: "1",
            name: "Caffè espresso",
            quantity: 3,
            unit_price: 1.1,
            total: 3.3,
          },
        ],
        total_amount: 3.3,
      },
    ],
    null,
    2,
  );

  const moneticaSyncResult = moneticaSalesConfigured && shouldAutoSyncLatestSales
    ? await syncOfficialMoneticaSales(propertyId, {
        from: filterFrom ?? undefined,
        to: filterTo ?? undefined,
        allowHistoricalBootstrap: false,
      }).catch(() => null)
    : null;

  const saleDateWhere = buildSaleDateWhere(filterFrom, filterTo);
  const saleWhere = {
    outlet: { propertyId },
    ...(outletFilter ? { outletId: outletFilter } : {}),
    ...(saleDateWhere ? { date: saleDateWhere } : { fiscalYearId: fiscalYear.id }),
  };

  const saleLines = await prisma.saleLine.findMany({
    where: {
      sale: saleWhere,
    },
    include: {
      product: { select: { id: true, name: true, uom: true } },
      sale: {
        select: {
          id: true,
          date: true,
          source: true,
          externalRef: true,
          outlet: { select: { id: true, name: true, type: true } },
        },
      },
    },
    orderBy: { sale: { date: "desc" } },
  });

  const recentSales = await prisma.sale.findMany({
    where: saleWhere,
    select: {
      id: true,
      date: true,
      source: true,
      externalRef: true,
      outlet: { select: { id: true, name: true, type: true } },
      lines: {
        select: {
          id: true,
          qty: true,
          unitPriceNet: true,
          product: { select: { id: true, name: true, uom: true } },
        },
      },
    },
    orderBy: { date: "desc" },
    take: 100,
  });

  const costYears = [...new Set([
    year,
    ...saleLines.map((row) => new Date(row.sale.date).getUTCFullYear()),
    ...recentSales.map((sale) => new Date(sale.date).getUTCFullYear()),
  ])].sort((a, b) => a - b);
  const { avgCostMap: avgCostByProduct, purchaseQtyMap } = await buildPurchaseCostMapsByYears(propertyId, costYears);
  const outletIds = property.outlets.map((outlet) => outlet.id);
  const configuredCostRows = averageOutletCostRows(
    await listOutletCostsForOutlets(outletIds, costYears).catch(() => []),
  );
  const configuredCostMap = new Map(
    configuredCostRows.map((row) => [`${row.year}:${row.outletId}:${row.productId}`, Number(row.unitCostNet)]),
  );

  const doseCostMaps = await buildDoseDerivedCostMaps({
    propertyId,
    years: costYears,
    outletIds,
    configuredCostRows,
    avgPurchaseCostByYear: avgCostByProduct,
    purchaseQtyByYear: purchaseQtyMap,
  }).catch(() => ({ specificByTarget: new Map<string, number>(), averageByTarget: new Map<string, number>() }));

  for (const [key, value] of doseCostMaps.specificByTarget.entries()) {
    configuredCostMap.set(key, Number(value));
  }

  const enriched = saleLines.map((row) => {
    const qty = Number(row.qty);
    const saleYear = new Date(row.sale.date).getUTCFullYear();
    const key = `${saleYear}:${row.sale.outlet.id}:${row.product.id}`;
    const sellUnitPrice = grossToNetSaleUnitPrice(Number(row.unitPriceNet));
    const unitCost = configuredCostMap.get(key) ?? (avgCostByProduct.get(`${saleYear}:${row.product.id}`) ?? 0);
    const revenue = qty * sellUnitPrice;
    const cogs = qty * unitCost;
    const margin = revenue - cogs;
    return { ...row, qty, revenue, cogs, margin };
  });

  const revenueTotal = enriched.reduce((acc, row) => acc + row.revenue, 0);
  const cogsTotal = enriched.reduce((acc, row) => acc + row.cogs, 0);
  const marginTotal = revenueTotal - cogsTotal;
  const saleSourceById = new Map<string, string>();
  for (const row of enriched) {
    if (!saleSourceById.has(row.sale.id)) {
      saleSourceById.set(row.sale.id, row.sale.source);
    }
  }
  const moneticaSalesCount = [...saleSourceById.values()].filter((source) => source === "MONETICA").length;
  const manualSalesCount = [...saleSourceById.values()].filter((source) => source === "MANUAL").length;

  const byOutlet = new Map<string, { name: string; revenue: number; cogs: number; margin: number }>();
  for (const row of enriched) {
    const key = row.sale.outlet.id;
    const previous = byOutlet.get(key) ?? { name: row.sale.outlet.name, revenue: 0, cogs: 0, margin: 0 };
    previous.revenue += row.revenue;
    previous.cogs += row.cogs;
    previous.margin += row.margin;
    byOutlet.set(key, previous);
  }

  const receiptRows = recentSales
    .map((sale) => {
      const saleYear = new Date(sale.date).getUTCFullYear();
      const items = sale.lines.map((line) => {
        const qty = Number(line.qty);
        const key = `${saleYear}:${sale.outlet.id}:${line.product.id}`;
        const revenue = qty * grossToNetSaleUnitPrice(Number(line.unitPriceNet));
        const unitCost = configuredCostMap.get(key) ?? (avgCostByProduct.get(`${saleYear}:${line.product.id}`) ?? 0);
        const cogs = qty * unitCost;
        return {
          id: line.id,
          qty,
          revenue,
          cogs,
          margin: revenue - cogs,
          product: line.product,
        };
      });

      const revenue = items.reduce((acc, item) => acc + item.revenue, 0);
      const cogs = items.reduce((acc, item) => acc + item.cogs, 0);
      return {
        id: sale.id,
        date: sale.date,
        source: sale.source,
        externalRef: sale.externalRef,
        outlet: sale.outlet,
        items,
        revenue,
        cogs,
        margin: revenue - cogs,
      };
    })
    .filter((sale) => sale.items.length > 0);

  const periodLabel = hasDateFilter ? formatPeriodLabel(filterFrom, filterTo) : `Intero anno ${year}`;
  const autoSyncLabel = hasDateFilter
    ? `il periodo filtrato viene letto subito dal database; se vuoi riallinearlo con Monetica usa "Sincronizza vendite"`
    : "dopo la prima sincronizzazione manuale vengono riallineate automaticamente solo le nuove transazioni";

  async function createManualSale(formData: FormData) {
    "use server";
    const dateRaw = String(formData.get("date") ?? "");
    const outletId = String(formData.get("outletId") ?? "");
    const productId = String(formData.get("productId") ?? "");
    const qty = Number(formData.get("qty") ?? 0);

    if (!dateRaw || !outletId || !productId || !Number.isFinite(qty) || qty <= 0) {
      return;
    }

    const date = new Date(dateRaw);
    if (Number.isNaN(date.getTime())) return;

    const selectedProduct = products.find((product) => product.id === productId);
    const saleYear = date.getUTCFullYear();
    const configuredOutletPrice = outletId && productId ? await getOutletConfiguredPrice(outletId, productId, saleYear) : null;
    const fallbackPrice = configuredOutletPrice !== null
      ? Number(configuredOutletPrice)
      : selectedProduct
        ? Number(selectedProduct.defaultSalePriceNet)
        : 0;
    const unitPriceNet = fallbackPrice;
    if (!Number.isFinite(unitPriceNet) || unitPriceNet < 0) return;

    const saleFiscalYear = await ensureFiscalYear(orgId, date.getUTCFullYear());

    await prisma.sale.create({
      data: {
        orgId,
        fiscalYearId: saleFiscalYear.id,
        outletId,
        date,
        source: "MANUAL",
        externalRef: null,
        lines: {
          create: {
            productId,
            qty,
            unitPriceNet,
          },
        },
      },
    });

    revalidatePath(`/properties/${propertyId}/sales`);
    revalidatePath(`/properties/${propertyId}/outlets`);
    revalidatePath(`/properties/${propertyId}?year=${year}`);
    revalidatePath(`/properties/${propertyId}/analytics?year=${year}`);
  }

  async function syncMoneticaSalesAction() {
    "use server";
    if (!process.env.MONETICA_TRANSACTIONS_URL || !process.env.MONETICA_API_BEARER_TOKEN) return;

    await syncOfficialMoneticaSales(propertyId, {
      from: filterFrom ?? undefined,
      to: filterTo ?? undefined,
      force: true,
      allowHistoricalBootstrap: true,
    }).catch(() => null);

    revalidatePath(`/properties/${propertyId}/sales`);
    revalidatePath(`/properties/${propertyId}/outlets`);
    revalidatePath(`/properties/${propertyId}?year=${year}`);
    revalidatePath(`/properties/${propertyId}/analytics?year=${year}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <AutoRefresh intervalMs={AUTO_REFRESH_MS} />

      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Vendite e margini</h1>
            <p className="mt-1 text-sm text-zinc-600">
              Ricavi netti con IVA 10% scorporata, costo stimato del venduto e marginalità per outlet. Periodo visualizzato: {periodLabel}.
            </p>
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

        <section className="grid gap-4 md:grid-cols-3">
          <Kpi title="Ricavi netti" value={money(revenueTotal)} />
          <Kpi title="Costo venduto stimato" value={money(cogsTotal)} />
          <Kpi title="Margine lordo stimato" value={money(marginTotal)} />
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Registra vendita manuale</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Prezzo vendita salvato al momento della registrazione da &quot;Prezzi vendita&quot; (fallback: prezzo base prodotto).
          </p>
          <form action={createManualSale} className="mt-4 grid gap-2 md:grid-cols-5">
            <input type="date" name="date" required className="rounded-xl border px-3 py-2 text-sm" />
            <select name="outletId" required className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Outlet</option>
              {property.outlets.map((outlet) => (
                <option key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </option>
              ))}
            </select>
            <select name="productId" required className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Prodotto</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
            <input name="qty" type="number" min="0.01" step="0.01" required placeholder="Q.tà" className="rounded-xl border px-3 py-2 text-sm" />
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">Registra</button>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">Integrazione API Monetica</h2>
                  <p className="mt-1 text-sm text-zinc-600">
                    Le vendite dei bar possono arrivare via push JSON oppure essere sincronizzate automaticamente dall&apos;endpoint ufficiale Monetica.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/properties/${propertyId}/products?year=${year}`}
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
                  >
                    Mapping prodotti
                  </Link>
                  <form action={syncMoneticaSalesAction}>
                    <button
                      disabled={!moneticaSalesConfigured}
                      className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                    >
                      Sincronizza vendite
                    </button>
                  </form>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Scontrini Monetica</div>
                  <div className="mt-1 text-2xl font-semibold text-zinc-900">{moneticaSalesCount}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Vendite manuali</div>
                  <div className="mt-1 text-2xl font-semibold text-zinc-900">{manualSalesCount}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Ultima sync ufficiale</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-900">
                    {moneticaSyncResult?.lastSyncedAt ? formatDateTime(moneticaSyncResult.lastSyncedAt) : "mai"}
                  </div>
                </div>
              </div>

              <div className="mt-4 space-y-2 text-sm text-zinc-700">
                <div>
                  Endpoint push JSON interno: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{moneticaPushEndpoint}</code>
                </div>
                <div>
                  Endpoint ufficiale Monetica: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{moneticaOfficialEndpoint || "non configurato"}</code>
                </div>
                <div>
                  Header richiesto per il push JSON: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">x-monetica-secret</code> = <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">MONETICA_WEBHOOK_SECRET</code>
                </div>
                <div>
                  Fonte registrata automaticamente: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">MONETICA</code>
                </div>
                <div>
                  Aggiornamento automatico pagina: ogni <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">10 minuti</code> sullo stesso periodo visualizzato; senza filtro data la sync segue questa logica: {autoSyncLabel}.
                </div>
                <div>
                  Alias outlet Monetica gestiti: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">Chalet mare</code> viene importato su <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">Bar Del Mare</code>.
                </div>
                <div>
                  Data opzionale del batch push: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{moneticaPushEndpointWithDate}</code>
                </div>
                <div>
                  Bar collegati: {barOutlets.length > 0 ? barOutlets.map((outlet) => outlet.name).join(", ") : "nessuno"}
                </div>
              </div>

              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <div className="font-semibold">Prerequisiti per l&apos;import automatico</div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li><code>pos_name</code> viene allineato ai nomi interni anche quando Monetica usa alias come <code>Chalet mare</code> per <code>Bar Del Mare</code>.</li>
                  <li><code>transaction_items[].sku</code> deve essere mappato nella pagina prodotti come Mapping Monetica.</li>
                  <li>La sync ufficiale salva gli scontrini raggruppati per <code>transaction_id</code> e non duplica le vendite gia registrate.</li>
                  <li>Senza filtro data, se il database vendite Monetica e vuoto il primo bootstrap storico completo avviene con il bottone <code>Sincronizza vendite</code>; dalle sync successive vengono richieste solo le transazioni nuove.</li>
                  <li>Con un filtro data esteso la pagina mostra subito lo storico gia importato nel DB; il bottone <code>Sincronizza vendite</code> aggiorna esplicitamente quel periodo.</li>
                </ul>
              </div>

              {moneticaSyncResult?.warnings.length ? (
                <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                  <div className="font-semibold">Avvisi ultima sync</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {moneticaSyncResult.warnings.slice(0, 5).map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            <div>
              <div className="text-sm font-semibold text-zinc-900">Payload supportato</div>
              <p className="mt-1 text-xs text-zinc-500">
                Il body puo essere inviato come array JSON puro mantenendo la struttura Monetica originale.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-2xl bg-zinc-950 p-4 text-xs leading-5 text-zinc-100">
                <code>{moneticaPayloadExample}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6">
            <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-zinc-900">Filtri</h2>
              <p className="mt-1 text-sm text-zinc-600">
                Seleziona un intervallo <code>dal</code>/<code>al</code> per vedere e sincronizzare le vendite di quella porzione temporale.
              </p>

              <form method="GET" className="mt-4 grid gap-3">
                <input type="hidden" name="year" value={String(year)} />
                {fromOutletId ? <input type="hidden" name="fromOutletId" value={fromOutletId} /> : null}
                {outletFilter ? <input type="hidden" name="outletId" value={outletFilter} /> : null}

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm text-zinc-700">
                    <span>Dal</span>
                    <input
                      type="date"
                      name="from"
                      defaultValue={rawFrom ?? ""}
                      className="rounded-xl border px-3 py-2 text-sm"
                    />
                  </label>

                  <label className="grid gap-1 text-sm text-zinc-700">
                    <span>Al</span>
                    <input
                      type="date"
                      name="to"
                      defaultValue={rawTo ?? ""}
                      className="rounded-xl border px-3 py-2 text-sm"
                    />
                  </label>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
                    Applica periodo
                  </button>
                  <Link
                    href={buildSalesPageHref({ propertyId, year, outletId: outletFilter, fromOutletId })}
                    className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
                  >
                    Reset periodo
                  </Link>
                </div>
              </form>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold text-zinc-900">Filtro outlet</h2>
              <div className="mt-3 grid gap-2">
                <Link
                  href={buildSalesPageHref({ propertyId, year, from: rawFrom, to: rawTo, fromOutletId })}
                  className={`rounded-xl border px-3 py-2 text-sm font-semibold ${outletFilter ? "border-zinc-200 text-zinc-700" : "border-zinc-900 bg-zinc-900 text-white"}`}
                >
                  Tutti
                </Link>
                {property.outlets.map((outlet) => (
                  <Link
                    key={outlet.id}
                    href={buildSalesPageHref({
                      propertyId,
                      year,
                      outletId: outlet.id,
                      from: rawFrom,
                      to: rawTo,
                      fromOutletId,
                    })}
                    className={`rounded-xl border px-3 py-2 text-sm font-semibold ${outletFilter === outlet.id ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-200 text-zinc-700"}`}
                  >
                    {outlet.name}
                  </Link>
                ))}
              </div>

              <h3 className="mt-6 text-sm font-semibold text-zinc-900">Riepilogo per outlet</h3>
              <div className="mt-2 space-y-2">
                {[...byOutlet.values()].map((value) => (
                  <div key={value.name} className="rounded-xl border px-3 py-2 text-sm">
                    <div className="font-semibold text-zinc-900">{value.name}</div>
                    <div className="text-zinc-600">Ricavi: {money(value.revenue)}</div>
                    <div className="text-zinc-600">Margine: {money(value.margin)}</div>
                  </div>
                ))}
                {byOutlet.size === 0 ? (
                  <div className="rounded-xl border px-3 py-3 text-sm text-zinc-500">
                    Nessuna vendita trovata nel periodo selezionato.
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm lg:col-span-2">
            <h2 className="text-lg font-semibold text-zinc-900">Dettaglio righe vendita</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Ultimi 100 scontrini del periodo visualizzato. I prodotti dello stesso scontrino sono raggruppati nella stessa riga.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Outlet</th>
                    <th className="px-3 py-2">Scontrino</th>
                    <th className="px-3 py-2">Prodotti</th>
                    <th className="px-3 py-2">Ricavo</th>
                    <th className="px-3 py-2">Costo stimato</th>
                    <th className="px-3 py-2">Margine</th>
                    <th className="px-3 py-2">Fonte</th>
                  </tr>
                </thead>
                <tbody>
                  {receiptRows.map((sale) => (
                    <tr key={sale.id} className="border-t align-top">
                      <td className="px-3 py-2">
                        <div>{new Date(sale.date).toLocaleDateString("it-IT")}</div>
                        <div className="text-xs text-zinc-500">
                          {new Date(sale.date).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      </td>
                      <td className="px-3 py-2">{sale.outlet.name}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-zinc-900">{receiptLabel(sale.source, sale.externalRef)}</div>
                        {sale.externalRef ? <div className="text-xs text-zinc-500">{sale.externalRef}</div> : null}
                      </td>
                      <td className="px-3 py-2">
                        <div className="space-y-1">
                          {sale.items.map((item) => (
                            <div key={item.id} className="text-sm text-zinc-700">
                              <span className="font-medium text-zinc-900">{item.product.name}</span>
                              {" · "}
                              {qtyWithUom(item.qty, item.product.uom)}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">{money(sale.revenue)}</td>
                      <td className="px-3 py-2">{money(sale.cogs)}</td>
                      <td className={`px-3 py-2 font-semibold ${sale.margin < 0 ? "text-red-600" : "text-emerald-700"}`}>{money(sale.margin)}</td>
                      <td className="px-3 py-2 text-xs text-zinc-600">{sale.source}</td>
                    </tr>
                  ))}
                  {receiptRows.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-zinc-500" colSpan={8}>
                        Nessuna vendita trovata nel periodo selezionato.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

async function buildPurchaseCostMapsByYears(propertyId: string, years: number[]): Promise<{ avgCostMap: AvgCostMap; purchaseQtyMap: PurchaseQtyMap }> {
  if (years.length === 0) return { avgCostMap: new Map(), purchaseQtyMap: new Map() };

  const lines = await prisma.purchaseLine.findMany({
    where: {
      purchase: {
        warehouse: { propertyId },
        fiscalYear: { year: { in: years } },
      },
    },
    select: {
      productId: true,
      qty: true,
      unitCostNet: true,
      purchase: { select: { fiscalYear: { select: { year: true } } } },
    },
  });

  const aggregate = new Map<string, { qty: number; cost: number }>();
  for (const line of lines) {
    const purchaseYear = line.purchase.fiscalYear.year;
    const key = `${purchaseYear}:${line.productId}`;
    const previous = aggregate.get(key) ?? { qty: 0, cost: 0 };
    previous.qty += Number(line.qty);
    previous.cost += Number(line.qty) * Number(line.unitCostNet);
    aggregate.set(key, previous);
  }

  const avgCostMap: AvgCostMap = new Map();
  const purchaseQtyMap: PurchaseQtyMap = new Map();
  for (const [key, value] of aggregate.entries()) {
    avgCostMap.set(key, value.qty > 0 ? value.cost / value.qty : 0);
    purchaseQtyMap.set(key, value.qty);
  }
  return { avgCostMap, purchaseQtyMap };
}

function Kpi({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-900">{value}</div>
    </div>
  );
}

function money(n: number) {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}

function fmt(n: number) {
  return String(Math.round((n + Number.EPSILON) * 100) / 100);
}

function qtyWithUom(qty: number, uom: string) {
  const cleanedUom = String(uom ?? "").trim().toUpperCase();
  if (!cleanedUom || /^[0-9]+(?:[.,][0-9]+)?$/.test(cleanedUom)) {
    return fmt(qty);
  }
  return `${fmt(qty)} ${cleanedUom}`;
}

function receiptLabel(source: string, externalRef: string | null) {
  if (!externalRef) return source === "MANUAL" ? "Vendita manuale" : source;
  const segments = externalRef.split(":").filter(Boolean);
  const ref = segments[segments.length - 1] ?? externalRef;
  return `Scontrino ${ref}`;
}

function normalizeDateInput(value: string | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function buildSaleDateWhere(from: string | null, to: string | null) {
  if (!from || !to) return null;
  return {
    gte: new Date(`${from}T00:00:00.000Z`),
    lte: new Date(`${to}T23:59:59.999Z`),
  };
}

function formatPeriodLabel(from: string | null, to: string | null) {
  if (!from && !to) return "nessun filtro";
  if (from && to && from !== to) return `${formatDateLabel(from)} - ${formatDateLabel(to)}`;
  return formatDateLabel(from ?? to ?? "");
}

function formatDateLabel(value: string) {
  return new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" }).format(new Date(`${value}T12:00:00.000Z`));
}

function formatDateTime(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "n/d";
  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function buildSalesPageHref({
  propertyId,
  year,
  outletId,
  fromOutletId,
  from,
  to,
}: {
  propertyId: string;
  year: number;
  outletId?: string;
  fromOutletId?: string;
  from?: string | null;
  to?: string | null;
}) {
  const params = new URLSearchParams();
  params.set("year", String(year));
  if (outletId) params.set("outletId", outletId);
  if (fromOutletId) params.set("fromOutletId", fromOutletId);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString();
  return `/properties/${propertyId}/sales${query ? `?${query}` : ""}`;
}
