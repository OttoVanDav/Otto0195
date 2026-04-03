import Link from "next/link";
import { prisma } from "@/lib/prisma";
import {
  deleteOutletCost,
  listOutletCosts,
  upsertOutletCost,
} from "@/lib/outlet-product-costs";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

type Props = {
  params: Promise<{ propertyId: string; outletId: string }>;
  searchParams?: Promise<{ year?: string }>;
};

export const dynamic = "force-dynamic";

export default async function OutletCostsPage({ params, searchParams }: Props) {
  const { propertyId, outletId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const yearChoices = [year - 1, year, year + 1];

  const outlet = await prisma.outlet.findUnique({
    where: { id: outletId },
    include: { property: { include: { org: true } } },
  });
  if (!outlet || outlet.propertyId !== propertyId) return notFound();
  if (outlet.type === "BAR") {
    redirect(`/properties/${propertyId}/costs?year=${year}&fromOutletId=${outletId}`);
  }

  const products = await prisma.product.findMany({
    where: { orgId: outlet.property.orgId },
    orderBy: { name: "asc" },
  });

  const costs = await listOutletCosts(outletId, year);

  async function upsertCost(formData: FormData) {
    "use server";
    const productId = String(formData.get("productId") ?? "");
    const selectedYear = Number(formData.get("year") ?? year);
    const unitCostNetMin = parseNumberInput(formData.get("unitCostNetMin"));
    const unitCostNetMax = parseNumberInput(formData.get("unitCostNetMax"));
    const note = String(formData.get("note") ?? "").trim();
    if (
      !productId ||
      !Number.isFinite(selectedYear) ||
      !Number.isFinite(unitCostNetMin) ||
      !Number.isFinite(unitCostNetMax) ||
      unitCostNetMin < 0 ||
      unitCostNetMax < 0 ||
      unitCostNetMin > unitCostNetMax
    ) {
      return;
    }

    await upsertOutletCost(outletId, productId, selectedYear, unitCostNetMin, unitCostNetMax, note || null).catch(() => null);

    revalidatePath(`/properties/${propertyId}/outlets/${outletId}/costs?year=${selectedYear}`);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}?year=${selectedYear}`);
    redirect(`/properties/${propertyId}/outlets/${outletId}/costs?year=${selectedYear}`);
  }

  async function removeCost(formData: FormData) {
    "use server";
    const id = String(formData.get("id") ?? "");
    if (!id) return;

    await deleteOutletCost(id).catch(() => null);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}/costs?year=${year}`);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}?year=${year}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{outlet.property.org.name} · {outlet.property.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Costi acquisto merci — {outlet.name}</h1>
            <p className="mt-1 text-sm text-zinc-600">Imposta costo minimo e massimo per prodotto e per anno; il costo medio viene calcolato automaticamente.</p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-1">
              {yearChoices.map((choice) => (
                <Link
                  key={choice}
                  href={`/properties/${propertyId}/outlets/${outletId}/costs?year=${choice}`}
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
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo costo merce</h2>
          <form action={upsertCost} className="mt-4 grid gap-2 md:grid-cols-6">
            <select name="productId" required className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Prodotto</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select name="year" defaultValue={String(year)} className="rounded-xl border px-3 py-2 text-sm">
              {yearChoices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
            <input
              name="unitCostNetMin"
              type="number"
              min="0"
              step="0.001"
              required
              placeholder="Costo netto unitario minimo"
              className="rounded-xl border px-3 py-2 text-sm"
            />
            <input
              name="unitCostNetMax"
              type="number"
              min="0"
              step="0.001"
              required
              placeholder="Costo netto unitario massimo"
              className="rounded-xl border px-3 py-2 text-sm"
            />
            <input name="note" placeholder="Nota" className="rounded-xl border px-3 py-2 text-sm" />
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">Salva costo</button>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Costi configurati per il {year}</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Prodotto</th>
                  <th className="px-3 py-2">Costo unitario minimo</th>
                  <th className="px-3 py-2">Costo unitario massimo</th>
                  <th className="px-3 py-2">Costo unitario medio</th>
                  <th className="px-3 py-2">Nota</th>
                  <th className="px-3 py-2">Ultimo update</th>
                  <th className="px-3 py-2">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {costs.map((c) => (
                  <tr key={c.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{c.productName}</td>
                    <td className="px-3 py-2">{money(c.unitCostNetMin)} / {c.uom}</td>
                    <td className="px-3 py-2">{money(c.unitCostNetMax)} / {c.uom}</td>
                    <td className="px-3 py-2 font-medium">{money(c.unitCostNet)} / {c.uom}</td>
                    <td className="px-3 py-2 text-zinc-600">{c.note ?? "-"}</td>
                    <td className="px-3 py-2 text-zinc-600">{new Date(c.updatedAt).toLocaleString("it-IT")}</td>
                    <td className="px-3 py-2">
                      <form action={removeCost}>
                        <input type="hidden" name="id" value={c.id} />
                        <button className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">
                          Rimuovi
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
                {costs.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-zinc-500" colSpan={7}>
                      Nessun costo merce impostato per questo outlet nel {year}.
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
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(n);
}

function parseNumberInput(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  return Number(raw.replace(",", "."));
}
