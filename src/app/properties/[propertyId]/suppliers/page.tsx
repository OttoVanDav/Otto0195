import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createPropertySupplier, deletePropertySupplier, listPropertySuppliers } from "@/lib/suppliers";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string }>;
};

export const dynamic = "force-dynamic";

export default async function PropertySuppliersPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) return notFound();

  const suppliers = await listPropertySuppliers(propertyId).catch(() => []);
  const barOutlets = property.outlets.filter((outlet) => outlet.type === "BAR");
  const barOutletIds = barOutlets.map((outlet) => outlet.id);

  async function createSupplier(formData: FormData) {
    "use server";
    const name = String(formData.get("name") ?? "").trim();
    if (!name) return;

    await createPropertySupplier(propertyId, name).catch(() => null);
    revalidateSupplierPages(propertyId, year, barOutletIds);
    redirect(`/properties/${propertyId}/suppliers?year=${year}`);
  }

  async function removeSupplier(formData: FormData) {
    "use server";
    const supplierId = String(formData.get("supplierId") ?? "").trim();
    if (!supplierId) return;

    await deletePropertySupplier(propertyId, supplierId).catch(() => null);
    revalidateSupplierPages(propertyId, year, barOutletIds);
    redirect(`/properties/${propertyId}/suppliers?year=${year}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name} · {property.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Fornitori</h1>
            <p className="mt-1 text-sm text-zinc-600">
              I fornitori registrati qui diventano selezionabili nel form “Nuovo costo merce condiviso”.
            </p>
          </div>
          <Link
            href={`/properties/${propertyId}?year=${year}`}
            className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
          >
            ← Dashboard struttura
          </Link>
        </header>

        <section className="grid gap-3 md:grid-cols-3">
          <StatCard title="Fornitori registrati" value={String(suppliers.length)} />
          <StatCard title="Bar collegati" value={String(barOutlets.length)} />
          <StatCard title="Anno attivo" value={String(year)} />
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo fornitore</h2>
          <form action={createSupplier} className="mt-4 grid gap-2 md:grid-cols-5">
            <input
              name="name"
              required
              placeholder="Nome fornitore"
              className="rounded-xl border px-3 py-2 text-sm md:col-span-4"
            />
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 md:col-span-1">
              Salva fornitore
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Elenco fornitori</h2>
          <div className="mt-2 text-sm text-zinc-600">
            Se rimuovi un fornitore, i costi merci gia registrati restano salvati ma perdono il collegamento anagrafico.
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Fornitore</th>
                  <th className="px-3 py-2">Creato il</th>
                  <th className="px-3 py-2">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((supplier) => (
                  <tr key={supplier.id} className="border-t">
                    <td className="px-3 py-2 font-medium">{supplier.name}</td>
                    <td className="px-3 py-2 text-zinc-600">
                      {new Date(supplier.createdAt).toLocaleString("it-IT")}
                    </td>
                    <td className="px-3 py-2">
                      <form action={removeSupplier}>
                        <input type="hidden" name="supplierId" value={supplier.id} />
                        <button className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">
                          Rimuovi
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
                {suppliers.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-zinc-500" colSpan={3}>
                      Nessun fornitore registrato per questa struttura.
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

function revalidateSupplierPages(propertyId: string, year: number, barOutletIds: string[]) {
  revalidatePath(`/properties/${propertyId}/suppliers`);
  revalidatePath(`/properties/${propertyId}/suppliers?year=${year}`);
  revalidatePath(`/properties/${propertyId}`);
  revalidatePath(`/properties/${propertyId}?year=${year}`);
  revalidatePath(`/properties/${propertyId}/costs`);
  revalidatePath(`/properties/${propertyId}/costs?year=${year}`);

  for (const outletId of barOutletIds) {
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}`);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}?year=${year}`);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}/costs`);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}/costs?year=${year}`);
  }
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-900">{value}</div>
    </div>
  );
}
