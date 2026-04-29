import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { reconcileLocalMoneticaProducts, syncOfficialMoneticaCatalog } from "@/lib/monetica-catalog";
import { listOutletPricesForOutlets } from "@/lib/outlet-product-prices";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string; fromOutletId?: string }>;
};

export const dynamic = "force-dynamic";

export default async function ProductsPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const fromOutletId = sp.fromOutletId ?? "";

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) return notFound();
  const orgId = property.orgId;
  const barOutlets = property.outlets.filter((outlet) => outlet.type === "BAR");
  const moneticaCatalogConfigured = Boolean(process.env.MONETICA_ARTICLES_URL && process.env.MONETICA_API_BEARER_TOKEN);
  const moneticaCatalogEndpoint = process.env.MONETICA_ARTICLES_URL?.trim() ?? "";

  await ensureFiscalYear(orgId, year);
  await reconcileLocalMoneticaProducts(orgId).catch(() => null);

  const products = await prisma.product.findMany({
    where: { orgId },
    orderBy: [{ name: "asc" }],
    include: {
      externalMaps: {
        where: { source: "MONETICA" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
  const outletPriceRows = await listOutletPricesForOutlets(barOutlets.map((outlet) => outlet.id), [year]).catch(() => []);
  const outletPriceAgg = new Map<string, { sum: number; count: number }>();
  for (const row of outletPriceRows) {
    const current = outletPriceAgg.get(row.productId) ?? { sum: 0, count: 0 };
    current.sum += Number(row.unitPriceNet);
    current.count += 1;
    outletPriceAgg.set(row.productId, current);
  }
  const moneticaPriceByProduct = new Map<string, number>();
  for (const [productId, value] of outletPriceAgg.entries()) {
    moneticaPriceByProduct.set(productId, value.count > 0 ? value.sum / value.count : 0);
  }

  async function createProduct(formData: FormData) {
    "use server";
    const name = String(formData.get("name") ?? "").trim();
    const sku = String(formData.get("sku") ?? "").trim();
    const uom = sanitizeUom(String(formData.get("uom") ?? "PZ"));
    const priceCategory = String(formData.get("priceCategory") ?? "STANDARD").trim().toUpperCase();
    const defaultSalePriceNet = Number(formData.get("defaultSalePriceNet") ?? 0);
    const trackShrinkageBar = formData.get("trackShrinkageBar") === "on";
    const excludeFromAvgTicketAndSalesCount = formData.get("excludeFromAvgTicketAndSalesCount") === "on";
    if (!name) return;
    if (!Number.isFinite(defaultSalePriceNet) || defaultSalePriceNet < 0) return;

    await prisma.product.create({
      data: {
        orgId,
        name,
        sku: sku || null,
        uom: uom || "PZ",
        priceCategory: priceCategory || "STANDARD",
        defaultSalePriceNet,
        trackShrinkageBar,
        excludeFromAvgTicketAndSalesCount,
      },
    });

    revalidatePath(`/properties/${propertyId}/products?year=${year}`);
    revalidatePath(`/properties/${propertyId}/inventory?year=${year}`);
    revalidatePath(`/properties/${propertyId}/analytics?year=${year}`);
  }

  async function toggleShrinkage(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    const value = String(formData.get("value") ?? "false") === "true";
    if (!id) return;

    await prisma.product.update({
      where: { id },
      data: { trackShrinkageBar: value },
    });

    revalidatePath(`/properties/${propertyId}/products?year=${year}`);
    revalidatePath(`/properties/${propertyId}/inventory?year=${year}`);
  }

  async function toggleReceiptMetricsExclusion(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    const value = String(formData.get("value") ?? "false") === "true";
    if (!id) return;

    await prisma.product.update({
      where: { id },
      data: { excludeFromAvgTicketAndSalesCount: value },
    });

    revalidatePath(`/properties/${propertyId}/products?year=${year}`);
    revalidatePath(`/properties/${propertyId}/analytics?year=${year}`);
  }

  async function upsertMoneticaMap(formData: FormData) {
    "use server";
    const productId = String(formData.get("productId") ?? "");
    const externalSku = String(formData.get("externalSku") ?? "").trim();
    if (!productId || !externalSku) return;

    await prisma.externalProductMap.upsert({
      where: {
        orgId_source_externalSku: {
          orgId,
          source: "MONETICA",
          externalSku,
        },
      },
      update: { productId },
      create: {
        orgId,
        source: "MONETICA",
        externalSku,
        productId,
      },
    });

    revalidatePath(`/properties/${propertyId}/products?year=${year}`);
  }

  async function removeProduct(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    if (!id) return;

    await prisma.externalProductMap.deleteMany({ where: { productId: id } });
    await prisma.product.delete({ where: { id } }).catch(() => null);

    revalidatePath(`/properties/${propertyId}/products?year=${year}`);
    revalidatePath(`/properties/${propertyId}/analytics?year=${year}`);
  }

  async function updatePriceConfig(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    const priceCategory = String(formData.get("priceCategory") ?? "STANDARD").trim().toUpperCase();
    const defaultSalePriceNet = Number(formData.get("defaultSalePriceNet") ?? 0);
    if (!id) return;
    if (!Number.isFinite(defaultSalePriceNet) || defaultSalePriceNet < 0) return;

    await prisma.product.update({
      where: { id },
      data: {
        priceCategory: priceCategory || "STANDARD",
        defaultSalePriceNet,
      },
    });

    revalidatePath(`/properties/${propertyId}/products?year=${year}`);
    revalidatePath(`/properties/${propertyId}/sales?year=${year}`);
  }

  async function syncMoneticaCatalogAction() {
    "use server";
    if (!process.env.MONETICA_ARTICLES_URL || !process.env.MONETICA_API_BEARER_TOKEN) return;

    await syncOfficialMoneticaCatalog(propertyId, year).catch(() => null);
    await reconcileLocalMoneticaProducts(orgId).catch(() => null);

    revalidatePath(`/properties/${propertyId}/products?year=${year}`);
    revalidatePath(`/properties/${propertyId}/sales?year=${year}`);
    revalidatePath(`/properties/${propertyId}/inventory?year=${year}`);
    for (const outlet of barOutlets) {
      revalidatePath(`/properties/${propertyId}/outlets/${outlet.id}/prices?year=${year}`);
      revalidatePath(`/properties/${propertyId}/outlets/${outlet.id}?year=${year}`);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Prodotti</h1>
            <p className="mt-1 text-sm text-zinc-600">Anagrafica unica per bar, ristorante e magazzino.</p>
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
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-zinc-900">Sincronizzazione ufficiale Monetica</h2>
              <p className="mt-1 text-sm text-zinc-600">
                Importa il catalogo prodotti dall&apos;endpoint ufficiale Monetica e aggiorna automaticamente anche i prezzi vendita di tutti i bar della struttura per l&apos;anno selezionato.
              </p>
              <div className="mt-3 space-y-2 text-sm text-zinc-700">
                <div>
                  Endpoint configurato:{" "}
                  <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">
                    {moneticaCatalogEndpoint || "non configurato"}
                  </code>
                </div>
                <div>
                  Bar aggiornati: {barOutlets.length > 0 ? barOutlets.map((outlet) => outlet.name).join(", ") : "nessuno"}
                </div>
              </div>
            </div>

            <form action={syncMoneticaCatalogAction}>
              <button
                disabled={!moneticaCatalogConfigured}
                className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                Sincronizza da Monetica
              </button>
            </form>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo prodotto</h2>
          <form action={createProduct} className="mt-4 grid gap-2 md:grid-cols-10">
            <input name="name" required placeholder="Nome prodotto" className="md:col-span-2 rounded-xl border px-3 py-2 text-sm" />
            <input name="sku" placeholder="SKU interno" className="rounded-xl border px-3 py-2 text-sm" />
            <input name="uom" defaultValue="PZ" placeholder="U.M." className="rounded-xl border px-3 py-2 text-sm" />
            <input name="priceCategory" defaultValue="STANDARD" placeholder="Categoria prezzo" className="rounded-xl border px-3 py-2 text-sm" />
            <input name="defaultSalePriceNet" type="number" min="0" step="0.01" defaultValue="0" placeholder="Prezzo base netto" className="rounded-xl border px-3 py-2 text-sm" />
            <label className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm">
              <input type="checkbox" name="trackShrinkageBar" />
              Track shrinkage bar
            </label>
            <label className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm md:col-span-2">
              <input type="checkbox" name="excludeFromAvgTicketAndSalesCount" />
              Escludi da scontrino medio e N. vendite
            </label>
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">Aggiungi</button>
          </form>
          <div className="mt-3 rounded-xl border border-zinc-200 bg-zinc-50/40 px-3 py-2 text-xs text-zinc-600">
            I prodotti esclusi da questi due KPI continuano a contribuire a ricavi, margini, costi e a tutte le altre sezioni della pagina analytics.
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Catalogo prodotti</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Nome</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">U.M.</th>
                  <th className="px-3 py-2">Categoria prezzo</th>
                  <th className="px-3 py-2">Prezzo Monetica {year}</th>
                  <th className="px-3 py-2">Prezzo base</th>
                  <th className="px-3 py-2">Shrinkage bar</th>
                  <th className="px-3 py-2">KPI ticket</th>
                  <th className="px-3 py-2">Mapping Monetica</th>
                  <th className="px-3 py-2">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{p.name}</td>
                    <td className="px-3 py-2 text-zinc-600">{p.sku ?? "-"}</td>
                    <td className="px-3 py-2 text-zinc-600">{p.uom}</td>
                    <td className="px-3 py-2">
                      <form action={updatePriceConfig} className="flex items-center gap-2">
                        <input type="hidden" name="id" value={p.id} />
                        <input
                          name="priceCategory"
                          defaultValue={p.priceCategory}
                          className="w-28 rounded-lg border px-2 py-1 text-xs"
                        />
                        <input
                          name="defaultSalePriceNet"
                          type="number"
                          min="0"
                          step="0.01"
                          defaultValue={String(p.defaultSalePriceNet)}
                          className="w-24 rounded-lg border px-2 py-1 text-xs"
                        />
                        <button className="rounded-lg border px-2 py-1 text-xs font-semibold hover:bg-zinc-50">Salva</button>
                      </form>
                    </td>
                    <td className="px-3 py-2 text-zinc-600">
                      {moneticaPriceByProduct.has(p.id) ? money(Number(moneticaPriceByProduct.get(p.id) ?? 0)) : "-"}
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{money(Number(p.defaultSalePriceNet))}</td>
                    <td className="px-3 py-2">
                      <form action={toggleShrinkage} className="inline">
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="value" value={String(!p.trackShrinkageBar)} />
                        <button className={`rounded-lg px-2 py-1 text-xs font-semibold ${p.trackShrinkageBar ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-700"}`}>
                          {p.trackShrinkageBar ? "Attivo" : "No"}
                        </button>
                      </form>
                    </td>
                    <td className="px-3 py-2">
                      <form action={toggleReceiptMetricsExclusion} className="inline">
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="value" value={String(!p.excludeFromAvgTicketAndSalesCount)} />
                        <button className={`rounded-lg px-2 py-1 text-xs font-semibold ${p.excludeFromAvgTicketAndSalesCount ? "bg-amber-100 text-amber-800" : "bg-zinc-100 text-zinc-700"}`}>
                          {p.excludeFromAvgTicketAndSalesCount ? "Escluso" : "No"}
                        </button>
                      </form>
                    </td>
                    <td className="px-3 py-2">
                      <form action={upsertMoneticaMap} className="flex items-center gap-2">
                        <input type="hidden" name="productId" value={p.id} />
                        <input
                          name="externalSku"
                          defaultValue={p.externalMaps[0]?.externalSku ?? ""}
                          placeholder="SKU esterno"
                          className="w-36 rounded-lg border px-2 py-1 text-xs"
                        />
                        <button className="rounded-lg border px-2 py-1 text-xs font-semibold hover:bg-zinc-50">Salva</button>
                      </form>
                    </td>
                    <td className="px-3 py-2">
                      <form action={removeProduct}>
                        <input type="hidden" name="id" value={p.id} />
                        <button className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">Elimina</button>
                      </form>
                    </td>
                  </tr>
                ))}
                {products.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-sm text-zinc-500" colSpan={10}>
                      Nessun prodotto inserito.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

async function ensureFiscalYear(orgId: string, year: number) {
  await prisma.fiscalYear.upsert({
    where: { orgId_year: { orgId, year } },
    update: {},
    create: {
      orgId,
      year,
      startDate: new Date(Date.UTC(year, 0, 1)),
      endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59)),
    },
  });
}

function money(n: number) {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}

function sanitizeUom(raw: string) {
  const cleaned = raw.trim().toUpperCase();
  if (!cleaned || /^[0-9]+(?:[.,][0-9]+)?$/.test(cleaned)) return "PZ";
  return cleaned;
}
