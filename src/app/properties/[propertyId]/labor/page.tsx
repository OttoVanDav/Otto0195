import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string; fromOutletId?: string }>;
};

export const dynamic = "force-dynamic";

export default async function LaborCostsPage({ params, searchParams }: Props) {
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

  const fiscalYear = await ensureFiscalYear(orgId, year);

  const pools = await prisma.laborPool.findMany({
    where: {
      propertyId,
      fiscalYearId: fiscalYear.id,
      type: "BAR_POOL",
    },
    include: {
      outlet: { select: { name: true } },
      allocations: { include: { outlet: { select: { id: true, name: true, type: true } } } },
    },
    orderBy: [{ month: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  const totalLabor = pools.reduce((acc, p) => acc + Number(p.amountNet), 0);
  const totalBarPool = pools
    .filter((p) => p.type === "BAR_POOL")
    .reduce((acc, p) => acc + Number(p.amountNet), 0);
  const totalBarPeople = pools
    .filter((p) => p.type === "BAR_POOL")
    .reduce((acc, p) => acc + Number(p.headcount), 0);

  const byOutlet = new Map<string, { outletName: string; amount: number }>();
  for (const p of pools) {
    for (const a of p.allocations) {
      const prev = byOutlet.get(a.outletId) ?? { outletName: a.outlet.name, amount: 0 };
      prev.amount += Number(a.amountNet);
      byOutlet.set(a.outletId, prev);
    }
  }

  const bars = property.outlets.filter((o) => o.type === "BAR");

  async function createBarPool(formData: FormData) {
    "use server";
    const month = Number(formData.get("month") ?? 0);
    const headcount = Number(formData.get("headcount") ?? 0);
    const amountNet = parseNumberInput(formData.get("amountNet"));
    const note = String(formData.get("note") ?? "").trim();

    if (!Number.isInteger(month) || month < 1 || month > 12) return;
    if (!Number.isInteger(headcount) || headcount <= 0) return;
    if (!Number.isFinite(amountNet) || amountNet <= 0) return;
    if (bars.length === 0) return;

    const split = amountNet / bars.length;

    await prisma.$transaction(async (tx) => {
      const pool = await tx.laborPool.create({
        data: {
          orgId,
          propertyId,
          fiscalYearId: fiscalYear.id,
          month,
          type: "BAR_POOL",
          headcount,
          amountNet,
          note: note || null,
        },
      });

      await tx.laborAllocation.createMany({
        data: bars.map((b) => ({
          laborPoolId: pool.id,
          outletId: b.id,
          amountNet: split,
        })),
      });
    });

    revalidatePath(`/properties/${propertyId}/labor?year=${year}`);
    revalidatePath(`/properties/${propertyId}/outlets`);
    revalidatePath(`/properties/${propertyId}?year=${year}`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Costi personale</h1>
            <p className="mt-1 text-sm text-zinc-600">Gestione pool bar e costi diretti per singolo outlet.</p>
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

        <section className="grid gap-4 md:grid-cols-2">
          <Kpi title="Costo personale anno" value={money(totalLabor)} />
          <Kpi title="Movimenti registrati" value={String(pools.length)} />
        </section>
        <section className="grid gap-4 md:grid-cols-2">
          <Kpi title="Pool bar (rotazione)" value={money(totalBarPool)} />
          <Kpi title="Costo medio per persona" value={money(totalBarPeople > 0 ? totalBarPool / totalBarPeople : 0)} />
        </section>
        <section className="grid gap-4 md:grid-cols-2">
          <Kpi title="Persone pool bar (somma periodi)" value={String(totalBarPeople)} />
          <Kpi title="Bar attivi" value={String(bars.length)} />
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Pool personale bar (rotazione)</h2>
          <form action={createBarPool} className="mt-4 grid gap-2 md:grid-cols-6">
            <select name="month" required className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Mese</option>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input name="headcount" type="number" min="1" step="1" required placeholder="N. persone" className="rounded-xl border px-3 py-2 text-sm" />
            <input name="amountNet" type="number" min="0.01" step="0.01" required placeholder="Importo netto" className="rounded-xl border px-3 py-2 text-sm" />
            <input name="note" placeholder="Nota pool bar" className="rounded-xl border px-3 py-2 text-sm md:col-span-2" />
            <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">Registra</button>
          </form>
          <p className="mt-2 text-xs text-zinc-500">
            Il costo viene distribuito in parti uguali sui bar della struttura.
          </p>
        </section>

        <section className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-zinc-900">Costo per outlet</h2>
            <div className="mt-3 space-y-2">
              {[...byOutlet.values()].map((v) => (
                <div key={v.outletName} className="rounded-xl border px-3 py-2 text-sm">
                  <div className="font-semibold text-zinc-900">{v.outletName}</div>
                  <div className="text-zinc-600">{money(v.amount)}</div>
                </div>
              ))}
              {byOutlet.size === 0 && <p className="text-sm text-zinc-500">Nessuna allocazione registrata.</p>}
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm lg:col-span-2">
            <h2 className="text-lg font-semibold text-zinc-900">Storico costi personale</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left">
                  <tr>
                    <th className="px-3 py-2">Mese</th>
                    <th className="px-3 py-2">Tipo</th>
                    <th className="px-3 py-2">Persone</th>
                    <th className="px-3 py-2">Outlet diretto</th>
                    <th className="px-3 py-2">Importo</th>
                    <th className="px-3 py-2">Allocazioni</th>
                    <th className="px-3 py-2">Nota</th>
                  </tr>
                </thead>
                <tbody>
                  {pools.map((p) => (
                    <tr key={p.id} className="border-t align-top">
                      <td className="px-3 py-2">{p.month}</td>
                      <td className="px-3 py-2 text-xs font-semibold">
                        BAR_POOL_ROTAZIONE
                      </td>
                      <td className="px-3 py-2">{p.headcount}</td>
                      <td className="px-3 py-2 text-zinc-600">{p.outlet?.name ?? "-"}</td>
                      <td className="px-3 py-2 font-semibold">{money(Number(p.amountNet))}</td>
                      <td className="px-3 py-2 text-xs text-zinc-600">
                        {p.allocations.length > 0
                          ? p.allocations.map((a) => `${a.outlet.name}: ${money(Number(a.amountNet))}`).join(" • ")
                          : "-"}
                      </td>
                      <td className="px-3 py-2 text-zinc-600">{p.note ?? "-"}</td>
                    </tr>
                  ))}
                  {pools.length === 0 && (
                    <tr>
                      <td className="px-3 py-6 text-zinc-500" colSpan={7}>
                        Nessun costo personale registrato nell&apos;anno selezionato.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
