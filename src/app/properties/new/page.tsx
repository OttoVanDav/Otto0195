import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdminAppAuthUser } from "@/lib/app-auth-server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NewPropertyPage() {
  await requireAdminAppAuthUser();

  async function createCompanyAndProperty(formData: FormData) {
    "use server";

    await requireAdminAppAuthUser();

    const orgName = String(formData.get("orgName") ?? "").trim();
    const propertyName = String(formData.get("propertyName") ?? "").trim();
    const warehouseName = String(formData.get("warehouseName") ?? "Magazzino centrale").trim();
    const withDefaultOutlets = formData.get("withDefaultOutlets") === "on";
    const bar1Name = String(formData.get("bar1Name") ?? "Bar 1").trim();
    const bar2Name = String(formData.get("bar2Name") ?? "Bar 2").trim();
    const bar3Name = String(formData.get("bar3Name") ?? "Bar 3").trim();
    const restaurantName = String(formData.get("restaurantName") ?? "Ristorante").trim();

    if (!orgName || !propertyName) return;

    const year = new Date().getUTCFullYear();

    const existingOrg = await prisma.org.findFirst({ where: { name: orgName } });
    const org = existingOrg ?? (await prisma.org.create({ data: { name: orgName } }));

    const property = await prisma.property.create({
      data: {
        orgId: org.id,
        name: propertyName,
      },
    });

    await prisma.warehouse.create({
      data: {
        propertyId: property.id,
        name: warehouseName || "Magazzino centrale",
      },
    });

    if (withDefaultOutlets) {
      const outletCandidates = [
        { name: bar1Name || "Bar 1", type: "BAR" as const },
        { name: bar2Name || "Bar 2", type: "BAR" as const },
        { name: bar3Name || "Bar 3", type: "BAR" as const },
        { name: restaurantName || "Ristorante", type: "RESTAURANT" as const },
      ];
      const seen = new Set<string>();
      const outlets = outletCandidates.filter((o) => {
        const key = o.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      await prisma.outlet.createMany({
        data: outlets.map((o) => ({ propertyId: property.id, name: o.name, type: o.type })),
      });
    }

    await prisma.fiscalYear.upsert({
      where: { orgId_year: { orgId: org.id, year } },
      update: {},
      create: {
        orgId: org.id,
        year,
        startDate: new Date(Date.UTC(year, 0, 1)),
        endDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59)),
      },
    });

    revalidatePath("/properties");
    redirect(`/properties/${property.id}?year=${year}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-3xl rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-zinc-900">Registra azienda e struttura</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Crea l&apos;azienda, la prima struttura, il magazzino e i punti vendita iniziali.
        </p>

        <form action={createCompanyAndProperty} className="mt-6 grid gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium text-zinc-700">Nome azienda</label>
            <input
              name="orgName"
              required
              placeholder="Es. Villaggio Turistico Aurora"
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium text-zinc-700">Nome struttura</label>
            <input
              name="propertyName"
              required
              placeholder="Es. Villaggio Aurora - Sede Centrale"
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-sm font-medium text-zinc-700">Nome magazzino</label>
            <input
              name="warehouseName"
              defaultValue="Magazzino centrale"
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>

          <label className="md:col-span-2 flex items-center gap-2 rounded-xl border border-zinc-200 px-3 py-2 text-sm">
            <input type="checkbox" name="withDefaultOutlets" defaultChecked />
            Crea automaticamente 3 bar + 1 ristorante
          </label>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">Nome Bar 1</label>
            <input
              name="bar1Name"
              defaultValue="Bar 1"
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">Nome Bar 2</label>
            <input
              name="bar2Name"
              defaultValue="Bar 2"
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">Nome Bar 3</label>
            <input
              name="bar3Name"
              defaultValue="Bar 3"
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-zinc-700">Nome Ristorante</label>
            <input
              name="restaurantName"
              defaultValue="Ristorante"
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="md:col-span-2 mt-2 flex items-center gap-2">
            <button className="rounded-lg bg-black px-4 py-2 text-sm font-semibold text-white">
              Crea azienda
            </button>
            <Link
              href="/properties"
              className="inline-flex rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Annulla
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
