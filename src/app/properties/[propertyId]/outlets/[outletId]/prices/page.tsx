import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { syncOfficialMoneticaCatalog } from "@/lib/monetica-catalog";
import { deleteOutletPrice, listOutletPrices, upsertOutletPrice } from "@/lib/outlet-product-prices";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";

type Props = {
  params: Promise<{ propertyId: string; outletId: string }>;
  searchParams?: Promise<{ year?: string }>;
};

export const dynamic = "force-dynamic";

export default async function OutletPricesPage({ params, searchParams }: Props) {
  const { propertyId, outletId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());

  const outlet = await prisma.outlet.findUnique({
    where: { id: outletId },
    include: { property: { include: { org: true, outlets: true } } },
  });
  if (!outlet || outlet.propertyId !== propertyId) return notFound();
  const barOutlets = outlet.property.outlets.filter((item) => item.type === "BAR");

  const products = await prisma.product.findMany({
    where: { orgId: outlet.property.orgId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const prices = await listOutletPrices(outletId, year);
  const moneticaEndpoint = `/api/monetica/articles?propertyId=${propertyId}&year=${year}`;
  const moneticaCatalogConfigured = Boolean(process.env.MONETICA_ARTICLES_URL && process.env.MONETICA_API_BEARER_TOKEN);
  const moneticaCatalogEndpoint = process.env.MONETICA_ARTICLES_URL?.trim() ?? "";
  const yearChoices = [year - 1, year, year + 1];
  const moneticaPayloadExample = JSON.stringify(
    [
      {
        sku: "1",
        name: "Caffè espresso",
        status: "visible",
        price: 1.3,
      },
      {
        sku: "21",
        name: "Coca Cola vetro 33cl",
        status: "visible",
        price: 3,
      },
    ],
    null,
    2,
  );

  async function upsertPrice(formData: FormData) {
    "use server";
    const productId = String(formData.get("productId") ?? "");
    const unitPriceNet = parseNumberInput(formData.get("unitPriceNet"));
    const note = String(formData.get("note") ?? "").trim();
    if (!productId || !Number.isFinite(unitPriceNet) || unitPriceNet < 0) return;

    await upsertOutletPrice(outletId, productId, year, unitPriceNet, note || null).catch(() => null);

    revalidatePath(`/properties/${propertyId}/outlets/${outletId}/prices?year=${year}`);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}?year=${year}`);
  }

  async function removePrice(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    if (!id) return;

    await deleteOutletPrice(id).catch(() => null);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}/prices?year=${year}`);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}?year=${year}`);
  }

  async function syncMoneticaCatalogAction() {
    "use server";
    if (!process.env.MONETICA_ARTICLES_URL || !process.env.MONETICA_API_BEARER_TOKEN) return;

    await syncOfficialMoneticaCatalog(propertyId, year).catch(() => null);

    revalidatePath(`/properties/${propertyId}/products?year=${year}&fromOutletId=${outletId}`);
    for (const barOutlet of barOutlets) {
      revalidatePath(`/properties/${propertyId}/outlets/${barOutlet.id}/prices?year=${year}`);
      revalidatePath(`/properties/${propertyId}/outlets/${barOutlet.id}?year=${year}`);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{outlet.property.org.name} · {outlet.property.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Prezzi vendita al cliente — {outlet.name}</h1>
            <p className="mt-1 text-sm text-zinc-600">Imposta il prezzo vendita unitario netto per prodotto del bar sull&apos;anno selezionato.</p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-1">
              {yearChoices.map((choice) => (
                <Link
                  key={choice}
                  href={`/properties/${propertyId}/outlets/${outletId}/prices?year=${choice}`}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    choice === year ? "bg-zinc-900 text-white shadow-sm" : "text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  {choice}
                </Link>
              ))}
            </div>
            <Link
              href={`/properties/${propertyId}/outlets/${outletId}?year=${year}`}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
            >
              ← Dashboard outlet
            </Link>
          </div>
        </header>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-zinc-900">Import automatico Monetica</h2>
                  <p className="mt-1 text-sm text-zinc-600">
                    Monetica puo aggiornare automaticamente prodotti e prezzi di tutti i bar della struttura partendo dal listino articoli.
                  </p>
                </div>
                <Link
                  href={`/properties/${propertyId}/products?year=${year}&fromOutletId=${outletId}`}
                  className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
                >
                  Prodotti + mapping
                </Link>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Bar aggiornati dall&apos;import</div>
                  <div className="mt-1 text-2xl font-semibold text-zinc-900">{barOutlets.length}</div>
                </div>
                <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Prezzi visibili su questo outlet</div>
                  <div className="mt-1 text-2xl font-semibold text-zinc-900">{prices.length}</div>
                </div>
              </div>

              <div className="mt-4 space-y-2 text-sm text-zinc-700">
                <div>
                  Endpoint push JSON interno: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{moneticaEndpoint}</code>
                </div>
                <div>
                  Endpoint ufficiale Monetica configurato: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">{moneticaCatalogEndpoint || "non configurato"}</code>
                </div>
                <div>
                  Header richiesto per il push JSON: <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">x-monetica-secret</code> = <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs">MONETICA_WEBHOOK_SECRET</code>
                </div>
                <div>
                  Effetto dell&apos;import: crea/aggiorna prodotti, salva il mapping Monetica per SKU e aggiorna i prezzi di tutti i bar per l&apos;anno {year}.
                </div>
              </div>

              <form action={syncMoneticaCatalogAction} className="mt-4">
                <button
                  disabled={!moneticaCatalogConfigured}
                  className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
                >
                  Sincronizza da endpoint ufficiale
                </button>
              </form>

              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
                <div className="font-semibold">Bar coinvolti</div>
                <div className="mt-2">
                  {barOutlets.length > 0 ? barOutlets.map((item) => item.name).join(", ") : "Nessun bar configurato nella struttura."}
                </div>
              </div>
            </div>

            <div>
              <div className="text-sm font-semibold text-zinc-900">Payload supportato</div>
              <p className="mt-1 text-xs text-zinc-500">
                L&apos;import accetta l&apos;array JSON Monetica con <code>sku</code>, <code>name</code>, <code>status</code> e <code>price</code>.
              </p>
              <pre className="mt-3 overflow-x-auto rounded-2xl bg-zinc-950 p-4 text-xs leading-5 text-zinc-100">
                <code>{moneticaPayloadExample}</code>
              </pre>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo prezzo vendita {year}</h2>
          <form action={upsertPrice} className="mt-4 grid gap-2 md:grid-cols-5">
            <select name="productId" required className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Prodotto</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              name="unitPriceNet"
              type="number"
              min="0"
              step="0.01"
              required
              placeholder="Prezzo vendita netto"
              className="rounded-xl border px-3 py-2 text-sm"
            />
            <input name="note" placeholder="Nota" className="rounded-xl border px-3 py-2 text-sm md:col-span-2" />
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">Salva prezzo</button>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Prezzi configurati {year}</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Prodotto</th>
                  <th className="px-3 py-2">Prezzo vendita netto</th>
                  <th className="px-3 py-2">Nota</th>
                  <th className="px-3 py-2">Ultimo update</th>
                  <th className="px-3 py-2">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{p.productName}</td>
                    <td className="px-3 py-2">{money(p.unitPriceNet)} / {p.uom}</td>
                    <td className="px-3 py-2 text-zinc-600">{p.note ?? "-"}</td>
                    <td className="px-3 py-2 text-zinc-600">{new Date(p.updatedAt).toLocaleString("it-IT")}</td>
                    <td className="px-3 py-2">
                      <form action={removePrice}>
                        <input type="hidden" name="id" value={p.id} />
                        <button className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">
                          Rimuovi
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
                {prices.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-zinc-500" colSpan={5}>
                      Nessun prezzo vendita impostato per questo outlet nell&apos;anno selezionato.
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

function money(n: number) {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(n);
}

function parseNumberInput(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  return Number(raw.replace(",", "."));
}
