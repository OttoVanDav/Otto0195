import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string }>;
};

export const dynamic = "force-dynamic";

export default async function WarehousePurchasesPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      org: true,
      warehouse: true,
    },
  });
  if (!property) return notFound();
  const orgId = property.orgId;

  const fiscalYear = await ensureFiscalYear(orgId, year);

  const warehouse =
    property.warehouse ??
    (await prisma.warehouse.create({
      data: { propertyId: property.id, name: "Magazzino centrale" },
    }));

  const products = await prisma.product.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
  });

  const purchaseLines = await prisma.purchaseLine.findMany({
    where: {
      purchase: {
        fiscalYearId: fiscalYear.id,
        warehouseId: warehouse.id,
      },
    },
    include: {
      product: { select: { name: true, uom: true } },
      purchase: { select: { id: true, date: true, supplier: true, docNumber: true } },
    },
    orderBy: { purchase: { date: "desc" } },
    take: 120,
  });

  const totalNet = purchaseLines.reduce((acc, r) => acc + Number(r.qty) * Number(r.unitCostNet), 0);
  const totalQty = purchaseLines.reduce((acc, r) => acc + Number(r.qty), 0);

  async function createPurchaseLine(formData: FormData) {
    "use server";
    const productId = String(formData.get("productId") ?? "");
    const supplier = String(formData.get("supplier") ?? "").trim();
    const docNumber = String(formData.get("docNumber") ?? "").trim();
    const dateRaw = String(formData.get("date") ?? "");
    const qty = Number(formData.get("qty") ?? 0);
    const unitCostNet = parseNumberInput(formData.get("unitCostNet"));
    const vatRateRaw = String(formData.get("vatRate") ?? "").trim();

    if (!productId || !dateRaw || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unitCostNet) || unitCostNet < 0) {
      return;
    }

    const date = new Date(dateRaw);
    if (Number.isNaN(date.getTime())) return;

    await prisma.purchase.create({
      data: {
        orgId,
        fiscalYearId: fiscalYear.id,
        warehouseId: warehouse.id,
        date,
        supplier: supplier || null,
        docNumber: docNumber || null,
        lines: {
          create: {
            productId,
            qty,
            unitCostNet,
            vatRate: vatRateRaw ? Number(vatRateRaw) : null,
          },
        },
      },
    });

    revalidatePath(`/properties/${propertyId}/warehouse/purchases?year=${year}`);
    revalidatePath(`/properties/${propertyId}/sales?year=${year}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Carichi magazzino</h1>
            <p className="mt-1 text-sm text-zinc-600">Registra gli acquisti e aggiorna il costo medio dei prodotti.</p>
          </div>
          <Link
            href={`/properties/${propertyId}?year=${year}`}
            className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
          >
            ← Dashboard struttura
          </Link>
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <Kpi title="Totale netto anno" value={money(totalNet)} />
          <Kpi title="Quantità caricate" value={fmt(totalQty)} />
          <Kpi title="Righe registrate" value={String(purchaseLines.length)} />
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo carico</h2>
          <form action={createPurchaseLine} className="mt-4 grid gap-2 md:grid-cols-7">
            <input type="date" name="date" required className="rounded-xl border px-3 py-2 text-sm" />
            <select name="productId" required className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Prodotto</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input name="supplier" placeholder="Fornitore" className="rounded-xl border px-3 py-2 text-sm" />
            <input name="docNumber" placeholder="Documento" className="rounded-xl border px-3 py-2 text-sm" />
            <input name="qty" type="number" step="0.01" min="0.01" required placeholder="Q.tà" className="rounded-xl border px-3 py-2 text-sm" />
            <input name="unitCostNet" type="number" step="0.001" min="0" required placeholder="Costo netto (es. 0,628)" className="rounded-xl border px-3 py-2 text-sm" />
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">Registra</button>
            <input name="vatRate" type="number" step="0.01" min="0" max="100" placeholder="IVA % (opz.)" className="rounded-xl border px-3 py-2 text-sm md:col-span-2" />
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Storico carichi</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Data</th>
                  <th className="px-3 py-2">Prodotto</th>
                  <th className="px-3 py-2">Fornitore</th>
                  <th className="px-3 py-2">Doc</th>
                  <th className="px-3 py-2">Q.tà</th>
                  <th className="px-3 py-2">Costo netto</th>
                  <th className="px-3 py-2">Totale</th>
                </tr>
              </thead>
              <tbody>
                {purchaseLines.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2">{new Date(r.purchase.date).toLocaleDateString("it-IT")}</td>
                    <td className="px-3 py-2 font-medium">{r.product.name}</td>
                    <td className="px-3 py-2 text-zinc-600">{r.purchase.supplier ?? "-"}</td>
                    <td className="px-3 py-2 text-zinc-600">{r.purchase.docNumber ?? "-"}</td>
                    <td className="px-3 py-2">{qtyWithUom(Number(r.qty), r.product.uom)}</td>
                    <td className="px-3 py-2">{unitCostMoney(Number(r.unitCostNet))}</td>
                    <td className="px-3 py-2 font-semibold">{money(Number(r.qty) * Number(r.unitCostNet))}</td>
                  </tr>
                ))}
                {purchaseLines.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-zinc-500" colSpan={7}>
                      Nessun carico registrato per l&apos;anno selezionato.
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

function unitCostMoney(n: number) {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(n);
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

function parseNumberInput(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return Number.NaN;
  return Number(raw.replace(",", "."));
}

async function ensureFiscalYear(orgId: string, year: number) {
  return prisma.fiscalYear.upsert({
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
