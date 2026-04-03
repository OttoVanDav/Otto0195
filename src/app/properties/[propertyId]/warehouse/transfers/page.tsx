import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentAppAuthUser, requireAdminAppAuthUser } from "@/lib/app-auth-server";
import { hasAppSectionPermission } from "@/lib/app-permissions";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { StockMoveType } from "@prisma/client";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string; fromOutletId?: string }>;
};

export const dynamic = "force-dynamic";

export default async function WarehouseTransfersPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const fromOutletId = sp.fromOutletId ?? "";
  const currentUser = await getCurrentAppAuthUser();
  const isAdmin = Boolean(currentUser?.isAdmin);
  const canAccessControlManagement = hasAppSectionPermission(currentUser, "controlManagement");

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true, warehouse: true },
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

  const rows = await prisma.stockMoveLine.findMany({
    where: {
      move: {
        fiscalYearId: fiscalYear.id,
        warehouseId: warehouse.id,
      },
    },
    include: {
      product: { select: { name: true, uom: true } },
      move: {
        select: {
          id: true,
          date: true,
          type: true,
          note: true,
          outlet: { select: { name: true } },
        },
      },
    },
    orderBy: { move: { date: "desc" } },
    take: 120,
  });

  const transferByOutlet = new Map<string, number>();
  for (const r of rows) {
    if (r.move.type !== "TRANSFER_TO_OUTLET") continue;
    const outletName = r.move.outlet?.name ?? "N/A";
    transferByOutlet.set(outletName, (transferByOutlet.get(outletName) ?? 0) + Number(r.qty));
  }

  async function createStockMove(formData: FormData) {
    "use server";
    const dateRaw = String(formData.get("date") ?? "");
    const productId = String(formData.get("productId") ?? "");
    const type = String(formData.get("type") ?? "TRANSFER_TO_OUTLET") as StockMoveType;
    const outletIdRaw = String(formData.get("outletId") ?? "");
    const qty = Number(formData.get("qty") ?? 0);
    const note = String(formData.get("note") ?? "").trim();

    if (!dateRaw || !productId || !Number.isFinite(qty) || qty <= 0) return;
    if (!["TRANSFER_TO_OUTLET", "ADJUSTMENT_PLUS", "ADJUSTMENT_MINUS"].includes(type)) return;

    const date = new Date(dateRaw);
    if (Number.isNaN(date.getTime())) return;

    const outletId =
      type === "TRANSFER_TO_OUTLET"
        ? outletIdRaw || (!canAccessControlManagement && fromOutletId ? fromOutletId : "")
        : "";
    if (type === "TRANSFER_TO_OUTLET" && !outletId) return;

    await prisma.stockMove.create({
      data: {
        orgId,
        fiscalYearId: fiscalYear.id,
        warehouseId: warehouse.id,
        outletId: outletId || null,
        type,
        date,
        note: note || null,
        lines: {
          create: {
            productId,
            qty,
          },
        },
      },
    });

    revalidatePath(`/properties/${propertyId}/warehouse/transfers?year=${year}`);
    if (fromOutletId) {
      revalidatePath(`/properties/${propertyId}/warehouse/transfers?year=${year}&fromOutletId=${fromOutletId}`);
      revalidatePath(`/properties/${propertyId}/outlets/${fromOutletId}?year=${year}`);
      revalidatePath(`/properties/${propertyId}/inventory?year=${year}&view=bars&bar=${fromOutletId}&fromOutletId=${fromOutletId}`);
    }
    revalidatePath(`/properties/${propertyId}/inventory?year=${year}`);
    revalidatePath(`/properties/${propertyId}/inventory?year=${year}&view=bars`);
    revalidatePath(`/properties/${propertyId}/outlets`);
    redirect(`/properties/${propertyId}/warehouse/transfers?year=${year}${fromOutletId ? `&fromOutletId=${fromOutletId}` : ""}`);
  }

  async function deleteStockMove(formData: FormData) {
    "use server";
    await requireAdminAppAuthUser();

    const moveId = String(formData.get("moveId") ?? "").trim();
    if (!moveId) return;

    const existingMove = await prisma.stockMove.findFirst({
      where: {
        id: moveId,
        orgId,
        warehouseId: warehouse.id,
        fiscalYearId: fiscalYear.id,
      },
      select: {
        id: true,
        outletId: true,
      },
    });
    if (!existingMove) return;

    await prisma.stockMove.delete({
      where: { id: existingMove.id },
    });

    revalidatePath(`/properties/${propertyId}/warehouse/transfers?year=${year}`);
    if (fromOutletId) {
      revalidatePath(`/properties/${propertyId}/warehouse/transfers?year=${year}&fromOutletId=${fromOutletId}`);
      revalidatePath(`/properties/${propertyId}/outlets/${fromOutletId}?year=${year}`);
      revalidatePath(`/properties/${propertyId}/inventory?year=${year}&view=bars&bar=${fromOutletId}&fromOutletId=${fromOutletId}`);
    }
    if (existingMove.outletId) {
      revalidatePath(`/properties/${propertyId}/outlets/${existingMove.outletId}?year=${year}`);
      revalidatePath(`/properties/${propertyId}/inventory?year=${year}&view=bars&bar=${existingMove.outletId}`);
    }
    revalidatePath(`/properties/${propertyId}/inventory?year=${year}`);
    revalidatePath(`/properties/${propertyId}/inventory?year=${year}&view=bars`);
    revalidatePath(`/properties/${propertyId}/outlets`);
    redirect(`/properties/${propertyId}/warehouse/transfers?year=${year}${fromOutletId ? `&fromOutletId=${fromOutletId}` : ""}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Prelievi e rettifiche magazzino</h1>
            <p className="mt-1 text-sm text-zinc-600">Uscite verso bar/ristorante e aggiustamenti di stock.</p>
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
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo movimento</h2>
          <form action={createStockMove} className="mt-4 grid gap-2 md:grid-cols-7">
            <input type="date" name="date" required className="rounded-xl border px-3 py-2 text-sm" />
            <select name="type" defaultValue="TRANSFER_TO_OUTLET" className="rounded-xl border px-3 py-2 text-sm">
              <option value="TRANSFER_TO_OUTLET">Prelievo verso outlet</option>
              <option value="ADJUSTMENT_PLUS">Rettifica +</option>
              <option value="ADJUSTMENT_MINUS">Rettifica -</option>
            </select>
            <select
              name="outletId"
              defaultValue={fromOutletId}
              className="rounded-xl border px-3 py-2 text-sm"
            >
              <option value="">Outlet (solo per prelievo)</option>
              {property.outlets.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <select name="productId" required className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Prodotto</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input name="qty" type="number" step="0.01" min="0.01" required placeholder="Q.tà" className="rounded-xl border px-3 py-2 text-sm" />
            <input name="note" placeholder="Nota" className="rounded-xl border px-3 py-2 text-sm" />
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">Registra</button>
          </form>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-zinc-900">Prelievi per outlet</h2>
            <div className="mt-3 space-y-2">
              {[...transferByOutlet.entries()].map(([name, qty]) => (
                <div key={name} className="flex items-center justify-between rounded-xl border px-3 py-2">
                  <span className="text-sm text-zinc-700">{name}</span>
                  <span className="text-sm font-semibold text-zinc-900">{fmt(qty)}</span>
                </div>
              ))}
              {transferByOutlet.size === 0 && <p className="text-sm text-zinc-500">Nessun prelievo registrato.</p>}
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-zinc-900">Tipi movimento</h2>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-zinc-600">
              <li>`TRANSFER_TO_OUTLET`: scarico da magazzino verso bar/ristorante</li>
              <li>`ADJUSTMENT_PLUS`: rettifica in aumento stock</li>
              <li>`ADJUSTMENT_MINUS`: rettifica in diminuzione stock</li>
            </ul>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Storico movimenti</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Data</th>
                  <th className="px-3 py-2">Tipo</th>
                  <th className="px-3 py-2">Outlet</th>
                  <th className="px-3 py-2">Prodotto</th>
                  <th className="px-3 py-2">Q.tà</th>
                  <th className="px-3 py-2">Nota</th>
                  {isAdmin ? <th className="px-3 py-2 text-right">Azioni</th> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-3 py-2">{new Date(r.move.date).toLocaleDateString("it-IT")}</td>
                    <td className="px-3 py-2 text-xs font-semibold">{r.move.type}</td>
                    <td className="px-3 py-2 text-zinc-600">{r.move.outlet?.name ?? "-"}</td>
                    <td className="px-3 py-2 font-medium">{r.product.name}</td>
                    <td className="px-3 py-2">{qtyWithUom(Number(r.qty), r.product.uom)}</td>
                    <td className="px-3 py-2 text-zinc-600">{r.move.note ?? "-"}</td>
                    {isAdmin ? (
                      <td className="px-3 py-2 text-right">
                        <form action={deleteStockMove}>
                          <input type="hidden" name="moveId" value={r.move.id} />
                          <button className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-100">
                            Elimina
                          </button>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-zinc-500" colSpan={isAdmin ? 7 : 6}>
                      Nessun movimento registrato nell&apos;anno selezionato.
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
