import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { listPropertyDosePools } from "@/lib/product-doses";
import { notFound } from "next/navigation";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string; view?: "total" | "bars"; bar?: string; fromOutletId?: string }>;
};

function clsx(...x: Array<string | false | null | undefined>) {
  return x.filter(Boolean).join(" ");
}

export const dynamic = "force-dynamic";

export default async function PropertyInventoryPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const view: "total" | "bars" = sp.view ?? "total";
  const barId = sp.bar ?? null;
  const fromOutletId = sp.fromOutletId ?? "";

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) return notFound();

  const fy = await prisma.fiscalYear.findFirst({
    where: { orgId: property.orgId, year },
    select: { id: true },
  });
  const fiscalYearId = fy?.id ?? null;

  const bars = property.outlets.filter((o) => o.type === "BAR");
  const barIds = bars.map((b) => b.id);
  const dosePools = await listPropertyDosePools(propertyId).catch(() => []);
  const doseTargetProductIds = [...new Set(dosePools.flatMap((pool) => pool.links.map((link) => link.targetProductId)))];

  // Prodotti tracciati per shrinkage bar
  const products = await prisma.product.findMany({
    where: { orgId: property.orgId, trackShrinkageBar: true },
    select: { id: true, name: true, uom: true },
    orderBy: { name: "asc" },
  });

  // Se non hai bar o non hai prodotti tracciati, fai vedere una pagina pulita.
  // (non placeholders)
  if (bars.length === 0) {
    return (
      <div className="min-h-screen bg-zinc-50 p-8">
        <div className="mx-auto max-w-6xl space-y-4">
          <Header propertyId={propertyId} year={year} propertyName={property.name} />
          <div className="rounded-2xl border bg-white p-6 text-sm text-zinc-600">
            Non ci sono bar in questa struttura.
          </div>
        </div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="min-h-screen bg-zinc-50 p-8">
        <div className="mx-auto max-w-6xl space-y-4">
          <Header propertyId={propertyId} year={year} propertyName={property.name} />
          <div className="rounded-2xl border bg-white p-6 text-sm text-zinc-600">
            Non ci sono prodotti con <span className="font-mono">trackShrinkageBar=true</span>. Impostali in “Prodotti”.
          </div>
        </div>
      </div>
    );
  }

  // === 1) INGRESSI AI BAR (TRANSFER_TO_OUTLET) ===
  // prendo tutte le righe di trasferimento verso i bar, per anno
  const transferLines = await prisma.stockMoveLine.findMany({
    where: {
      productId: { in: products.map((p) => p.id) },
      move: {
        fiscalYearId: fiscalYearId ?? undefined,
        type: "TRANSFER_TO_OUTLET",
        outletId: { in: barIds },
      },
    },
    select: { productId: true, qty: true, move: { select: { outletId: true } } },
  });

  // === 2) VENDITE BAR ===
  const saleLines = await prisma.saleLine.findMany({
    where: {
      productId: { in: [...new Set([...products.map((p) => p.id), ...doseTargetProductIds])] },
      sale: {
        fiscalYearId: fiscalYearId ?? undefined,
        outletId: { in: barIds },
      },
    },
    select: { productId: true, qty: true, unitPriceNet: true, sale: { select: { outletId: true } } },
  });

  // === 3) ULTIMO INVENTARIO FISICO per (outletId, productId) ===
  // Prisma non fa “distinct on” in modo comodo, quindi:
  // prendiamo tutti i count dell’anno per i bar, ordine desc, e prendiamo il primo per ogni outlet+product.
  const counts = await prisma.inventoryCount.findMany({
    where: {
      fiscalYearId: fiscalYearId ?? undefined,
      outletId: { in: barIds },
    },
    orderBy: { date: "desc" },
    select: {
      outletId: true,
      date: true,
      lines: { select: { productId: true, qtyCounted: true } },
    },
  });

  // Mappe di aggregazione
  // key: `${outletId}:${productId}`
  const lastPhysical = new Map<string, { qty: number; date: Date }>();

  for (const c of counts) {
    for (const line of c.lines) {
      const k = `${c.outletId}:${line.productId}`;
      if (!lastPhysical.has(k)) {
        lastPhysical.set(k, { qty: Number(line.qtyCounted), date: c.date });
      }
    }
  }

  // Build maps: received/sold per outlet+product
  const receivedByOP = new Map<string, number>();
  for (const tl of transferLines) {
    const outletId = tl.move.outletId;
    if (!outletId) continue;
    const k = `${outletId}:${tl.productId}`;
    receivedByOP.set(k, (receivedByOP.get(k) ?? 0) + Number(tl.qty));
  }

  const soldByOP = new Map<string, { qty: number; revenueNet: number }>();
  for (const sl of saleLines) {
    const outletId = sl.sale.outletId;
    const k = `${outletId}:${sl.productId}`;
    const prev = soldByOP.get(k) ?? { qty: 0, revenueNet: 0 };
    soldByOP.set(k, {
      qty: prev.qty + Number(sl.qty),
      revenueNet: prev.revenueNet + Number(sl.qty) * Number(sl.unitPriceNet),
    });
  }

  const doseConsumedByOP = buildDoseSourceConsumptionByOutlet({
    dosePools,
    outletIds: barIds,
    receivedByOutletProduct: receivedByOP,
    soldByOutletProduct: new Map([...soldByOP.entries()].map(([key, value]) => [key, value.qty])),
  });
  const doseReceivedByTargetOP = buildDoseTargetAvailabilityByOutlet({
    dosePools,
    outletIds: barIds,
    receivedByOutletProduct: receivedByOP,
  });

  // Helper per righe
  function calcRow(outletId: string, productId: string) {
    const k = `${outletId}:${productId}`;
    const directReceived = receivedByOP.get(k) ?? 0;
    const received = doseReceivedByTargetOP.get(k) ?? directReceived;
    const directSold = soldByOP.get(k)?.qty ?? 0;
    const doseConsumed = doseConsumedByOP.get(k) ?? 0;
    const sold = directSold + doseConsumed;
    const theoretical = received - sold;
    const physicalObj = lastPhysical.get(k);
    const physical = physicalObj ? physicalObj.qty : null;
    const diff = physical === null ? null : physical - theoretical; // negativa = mancanza
    return { received, sold, theoretical, physical, diff, physicalDate: physicalObj?.date ?? null };
  }

  // === VISTA TOTAL (aggregata su tutti i bar) ===
  // Sommiamo per prodotto su tutti i bar.
  const totalRows = products.map((p) => {
    let received = 0;
    let sold = 0;
    let theoretical = 0;
    let physicalSum: number | null = 0; // se manca il fisico per anche solo 1 bar, metto null (non invento)
    let diff: number | null = 0;

    for (const b of bars) {
      const r = calcRow(b.id, p.id);
      received += r.received;
      sold += r.sold;
      theoretical += r.theoretical;

      if (r.physical === null) {
        physicalSum = null;
        diff = null;
      } else {
        if (physicalSum !== null) physicalSum += r.physical;
        if (diff !== null) diff += (r.diff ?? 0);
      }
    }

    return { product: p, received, sold, theoretical, physical: physicalSum, diff };
  });

  // === VISTA PER BAR ===
  const selectedBar = barId ? bars.find((b) => b.id === barId) : null;
  const perBar = (bar: { id: string; name: string }) =>
    products.map((p) => ({ product: p, ...calcRow(bar.id, p.id) }));

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-white">
      <div className="mx-auto max-w-6xl px-6 py-6 space-y-6">
        <Header
          propertyId={propertyId}
          year={year}
          propertyName={property.name}
          fromOutletId={fromOutletId}
        />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-1">
            <Link
              href={`/properties/${propertyId}/inventory?year=${year}&view=total${fromOutletId ? `&fromOutletId=${fromOutletId}` : ""}`}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-semibold",
                view === "total" ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-50"
              )}
            >
              Totale
            </Link>
            <Link
              href={`/properties/${propertyId}/inventory?year=${year}&view=bars${fromOutletId ? `&fromOutletId=${fromOutletId}` : ""}`}
              className={clsx(
                "rounded-lg px-3 py-1.5 text-sm font-semibold",
                view === "bars" ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-50"
              )}
            >
              Per bar
            </Link>
          </div>

          <div className="text-sm text-zinc-600">
            Anno: <span className="font-semibold text-zinc-900">{year}</span>
          </div>
        </div>

        {view === "total" && (
          <SectionCard title="Inventario totale (somma di tutti i bar)">
            <InventoryTable
              rows={totalRows.map((r) => ({
                name: r.product.name,
                uom: r.product.uom,
                received: r.received,
                sold: r.sold,
                theoretical: r.theoretical,
                physical: r.physical,
                diff: r.diff,
              }))}
            />
            <div className="mt-3 text-xs text-zinc-500">
              * Per i prodotti target configurati in “Gestione dosi”, “Ricevuto” mostra la capacita teorica ricevuta dai pool dose. “Venduto” include anche il consumo teorico derivato dalle stesse regole. “Fisico” e “Differenza” sono mostrati solo se esiste un ultimo inventario per tutti i bar su quel prodotto.
            </div>
          </SectionCard>
        )}

        {view === "bars" && (
          <div className="grid gap-6 lg:grid-cols-3">
            <SectionCard title="Bar" className="lg:col-span-1">
              <div className="grid gap-2">
                {bars.map((b) => (
                  <Link
                    key={b.id}
                    href={`/properties/${propertyId}/inventory?year=${year}&view=bars&bar=${b.id}${fromOutletId ? `&fromOutletId=${fromOutletId}` : ""}`}
                    className={clsx(
                      "rounded-xl border px-4 py-3 text-sm font-semibold",
                      selectedBar?.id === b.id
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white text-zinc-900 hover:bg-zinc-50"
                    )}
                  >
                    {b.name}
                  </Link>
                ))}
              </div>
            </SectionCard>

            <SectionCard
              title={selectedBar ? `Inventario — ${selectedBar.name}` : "Seleziona un bar"}
              className="lg:col-span-2"
            >
              {!selectedBar ? (
                <div className="text-sm text-zinc-600">Clicca un bar a sinistra.</div>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Link
                      href={`/properties/${propertyId}/outlets/${selectedBar.id}?year=${year}`}
                      className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50"
                    >
                      Dashboard bar
                    </Link>
                  </div>

                  <InventoryTable
                    rows={perBar(selectedBar).map((r) => ({
                      name: r.product.name,
                      uom: r.product.uom,
                      received: r.received,
                      sold: r.sold,
                      theoretical: r.theoretical,
                      physical: r.physical,
                      diff: r.diff,
                    }))}
                  />
                </>
              )}
            </SectionCard>
          </div>
        )}
      </div>
    </div>
  );
}

function Header({
  propertyId,
  year,
  propertyName,
  fromOutletId,
}: {
  propertyId: string;
  year: number;
  propertyName: string;
  fromOutletId?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="text-xs text-zinc-500">Struttura</div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{propertyName}</h1>
        <div className="mt-1 text-sm text-zinc-600">Inventario bar (controllo sprechi / furti)</div>
      </div>
      <Link
        href={
          fromOutletId
            ? `/properties/${propertyId}/outlets/${fromOutletId}?year=${year}`
            : `/properties/${propertyId}?year=${year}`
        }
        className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-50"
      >
        ← {fromOutletId ? "Dashboard outlet" : "Dashboard struttura"}
      </Link>
    </div>
  );
}

function SectionCard({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm", className)}>
      <div className="text-lg font-semibold text-zinc-900">{title}</div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function InventoryTable({
  rows,
}: {
  rows: Array<{
    name: string;
    uom: string;
    received: number;
    sold: number;
    theoretical: number;
    physical: number | null;
    diff: number | null;
  }>;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-200">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left">
          <tr>
            <th className="px-4 py-3">Prodotto</th>
            <th className="px-4 py-3">U.M.</th>
            <th className="px-4 py-3">Ricevuto / dosi ricevute</th>
            <th className="px-4 py-3">Venduto / consumato</th>
            <th className="px-4 py-3">Teorico</th>
            <th className="px-4 py-3">Fisico</th>
            <th className="px-4 py-3">Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name} className="border-t hover:bg-zinc-50">
              <td className="px-4 py-3 font-semibold text-zinc-900">{r.name}</td>
              <td className="px-4 py-3 text-zinc-600">{r.uom}</td>
              <td className="px-4 py-3">{fmt(r.received)}</td>
              <td className="px-4 py-3">{fmt(r.sold)}</td>
              <td className="px-4 py-3">{fmt(r.theoretical)}</td>
              <td className="px-4 py-3">{r.physical === null ? "-" : fmt(r.physical)}</td>
              <td className={clsx("px-4 py-3 font-semibold", r.diff === null ? "text-zinc-500" : r.diff < 0 ? "text-red-600" : r.diff > 0 ? "text-emerald-700" : "text-zinc-900")}>
                {r.diff === null ? "-" : fmt(r.diff)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmt(n: number) {
  // evita 1.9999999
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  return String(rounded);
}

function buildDoseSourceConsumptionByOutlet({
  dosePools,
  outletIds,
  receivedByOutletProduct,
  soldByOutletProduct,
}: {
  dosePools: Awaited<ReturnType<typeof listPropertyDosePools>>;
  outletIds: string[];
  receivedByOutletProduct: Map<string, number>;
  soldByOutletProduct: Map<string, number>;
}) {
  const consumedByOutletProduct = new Map<string, number>();

  for (const pool of dosePools) {
    const validSources = pool.sources.filter((source) => Number.isFinite(Number(source.dosesPerUnit)) && Number(source.dosesPerUnit) > 0);
    const validLinks = pool.links.filter((link) => Number.isFinite(Number(link.dosesPerSale)) && Number(link.dosesPerSale) > 0);
    if (validSources.length === 0 || validLinks.length === 0) continue;

    for (const outletId of outletIds) {
      let totalConsumedDoses = 0;
      for (const link of validLinks) {
        const soldQty = Number(soldByOutletProduct.get(`${outletId}:${link.targetProductId}`) ?? 0);
        totalConsumedDoses += soldQty * Number(link.dosesPerSale);
      }
      if (totalConsumedDoses <= 0) continue;

      const sourceShares = validSources.map((source) => {
        const receivedQty = Number(receivedByOutletProduct.get(`${outletId}:${source.sourceProductId}`) ?? 0);
        const dosesPerUnit = Number(source.dosesPerUnit);
        return {
          sourceProductId: source.sourceProductId,
          dosesPerUnit,
          availableDoses: receivedQty > 0 ? receivedQty * dosesPerUnit : 0,
        };
      });

      const totalAvailableDoses = sourceShares.reduce((acc, source) => acc + source.availableDoses, 0);
      const fallbackWeight = sourceShares.reduce((acc, source) => acc + source.dosesPerUnit, 0);

      for (const source of sourceShares) {
        const allocatedDoses =
          totalAvailableDoses > 0
            ? totalConsumedDoses * (source.availableDoses / totalAvailableDoses)
            : fallbackWeight > 0
              ? totalConsumedDoses * (source.dosesPerUnit / fallbackWeight)
              : 0;
        if (allocatedDoses <= 0 || source.dosesPerUnit <= 0) continue;

        const consumedUnits = allocatedDoses / source.dosesPerUnit;
        const key = `${outletId}:${source.sourceProductId}`;
        consumedByOutletProduct.set(key, (consumedByOutletProduct.get(key) ?? 0) + consumedUnits);
      }
    }
  }

  return consumedByOutletProduct;
}

function buildDoseTargetAvailabilityByOutlet({
  dosePools,
  outletIds,
  receivedByOutletProduct,
}: {
  dosePools: Awaited<ReturnType<typeof listPropertyDosePools>>;
  outletIds: string[];
  receivedByOutletProduct: Map<string, number>;
}) {
  const receivedCapsByTarget = new Map<string, number[]>();

  for (const pool of dosePools) {
    const validSources = pool.sources.filter((source) => Number.isFinite(Number(source.dosesPerUnit)) && Number(source.dosesPerUnit) > 0);
    const validLinks = pool.links.filter((link) => Number.isFinite(Number(link.dosesPerSale)) && Number(link.dosesPerSale) > 0);
    if (validSources.length === 0 || validLinks.length === 0) continue;

    for (const outletId of outletIds) {
      const poolAvailableDoses = validSources.reduce((acc, source) => {
        const receivedQty = Number(receivedByOutletProduct.get(`${outletId}:${source.sourceProductId}`) ?? 0);
        return acc + receivedQty * Number(source.dosesPerUnit);
      }, 0);
      if (poolAvailableDoses <= 0) continue;

      for (const link of validLinks) {
        const dosesPerSale = Number(link.dosesPerSale);
        if (!Number.isFinite(dosesPerSale) || dosesPerSale <= 0) continue;
        const capacity = poolAvailableDoses / dosesPerSale;
        if (capacity <= 0) continue;

        const key = `${outletId}:${link.targetProductId}`;
        const current = receivedCapsByTarget.get(key) ?? [];
        current.push(capacity);
        receivedCapsByTarget.set(key, current);
      }
    }
  }

  const receivedByTarget = new Map<string, number>();
  for (const [key, capacities] of receivedCapsByTarget.entries()) {
    if (capacities.length === 0) continue;
    receivedByTarget.set(key, Math.min(...capacities));
  }

  return receivedByTarget;
}
