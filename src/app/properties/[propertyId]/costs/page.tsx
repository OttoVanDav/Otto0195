import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  deleteOutletCostsByProductSupplier,
  listOutletCostsForOutlets,
  upsertOutletCosts,
} from "@/lib/outlet-product-costs";
import { listPropertySuppliers } from "@/lib/suppliers";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string; fromOutletId?: string; productId?: string; supplierId?: string }>;
};

type SharedCostRow = {
  key: string;
  productId: string;
  productName: string;
  uom: string;
  year: number;
  supplierId: string | null;
  supplierName: string | null;
  unitCostNetMin: number;
  unitCostNetMax: number;
  unitCostNetAvg: number;
  note: string | null;
  updatedAt: Date;
  coverageCount: number;
  isAligned: boolean;
};

export const dynamic = "force-dynamic";

export default async function PropertyCostsPage({ params, searchParams }: Props) {
  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const fromOutletId = String(sp.fromOutletId ?? "");
  const selectedProductId = String(sp.productId ?? "").trim();
  const selectedSupplierId = String(sp.supplierId ?? "").trim();

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) return notFound();

  const barOutlets = property.outlets.filter((outlet) => outlet.type === "BAR");
  if (barOutlets.length === 0) return notFound();

  const barOutletIds = barOutlets.map((outlet) => outlet.id);
  const visibleYears = [year - 2, year - 1, year];
  const products = await prisma.product.findMany({
    where: { orgId: property.orgId },
    orderBy: { name: "asc" },
  });
  const suppliers = await listPropertySuppliers(propertyId).catch(() => []);
  const supplierIds = suppliers.map((supplier) => supplier.id);
  const hasSuppliers = suppliers.length > 0;
  const rawCosts = await listOutletCostsForOutlets(barOutletIds, visibleYears);
  const costs = buildSharedCosts(rawCosts, barOutletIds.length, year);
  const filteredCosts = costs.filter((row) => {
    if (selectedProductId && row.productId !== selectedProductId) return false;
    if (selectedSupplierId && row.supplierId !== selectedSupplierId) return false;
    return true;
  });
  const historyRows = buildCostHistoryRows(rawCosts, barOutletIds.length, visibleYears);
  const yearChoices = buildYearChoices(year);
  const distinctProductCount = new Set(costs.map((row) => row.productId)).size;
  const costFilterProducts = buildCostFilterProducts(costs);
  const costFilterSuppliers = buildCostFilterSuppliers(costs);

  const hasFromOutlet = barOutlets.some((outlet) => outlet.id === fromOutletId);
  const backHref = hasFromOutlet
    ? `/properties/${propertyId}/outlets/${fromOutletId}?year=${year}`
    : `/properties/${propertyId}?year=${year}`;

  async function upsertCost(formData: FormData) {
    "use server";
    const productId = String(formData.get("productId") ?? "");
    const selectedYear = Number(formData.get("year") ?? year);
    const supplierId = String(formData.get("supplierId") ?? "").trim();
    const unitCostNetMin = parseNumberInput(formData.get("unitCostNetMin"));
    const unitCostNetMax = parseNumberInput(formData.get("unitCostNetMax"));
    const note = String(formData.get("note") ?? "").trim();
    const supplierExists = supplierIds.includes(supplierId);
    if (
      !productId ||
      !supplierExists ||
      !Number.isFinite(selectedYear) ||
      !Number.isFinite(unitCostNetMin) ||
      !Number.isFinite(unitCostNetMax) ||
      unitCostNetMin < 0 ||
      unitCostNetMax < 0 ||
      unitCostNetMin > unitCostNetMax
    ) {
      return;
    }

    await upsertOutletCosts(
      barOutletIds,
      productId,
      selectedYear,
      unitCostNetMin,
      unitCostNetMax,
      note || null,
      supplierId,
    ).catch(() => null);

    revalidateStructureCosts(propertyId, selectedYear, barOutletIds);
    redirect(buildCostsPageHref({
      propertyId,
      year: selectedYear,
      fromOutletId: hasFromOutlet ? fromOutletId : "",
      productId: selectedProductId,
      supplierId: selectedSupplierId,
    }));
  }

  async function updateConfiguredCost(formData: FormData) {
    "use server";
    const productId = String(formData.get("productId") ?? "").trim();
    const selectedYear = Number(formData.get("year") ?? year);
    const supplierIdRaw = String(formData.get("supplierId") ?? "").trim();
    const supplierId = supplierIdRaw || null;
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

    await upsertOutletCosts(
      barOutletIds,
      productId,
      selectedYear,
      unitCostNetMin,
      unitCostNetMax,
      note || null,
      supplierId,
    ).catch(() => null);

    revalidateStructureCosts(propertyId, selectedYear, barOutletIds);
    redirect(buildCostsPageHref({
      propertyId,
      year: selectedYear,
      fromOutletId: hasFromOutlet ? fromOutletId : "",
      productId: selectedProductId,
      supplierId: selectedSupplierId,
    }));
  }

  async function removeCost(formData: FormData) {
    "use server";
    const productId = String(formData.get("productId") ?? "");
    const supplierIdRaw = String(formData.get("supplierId") ?? "").trim();
    const supplierId = supplierIdRaw || null;
    if (!productId) return;

    await deleteOutletCostsByProductSupplier(barOutletIds, productId, year, supplierId).catch(() => null);
    revalidateStructureCosts(propertyId, year, barOutletIds);
    redirect(buildCostsPageHref({
      propertyId,
      year,
      fromOutletId: hasFromOutlet ? fromOutletId : "",
      productId: selectedProductId,
      supplierId: selectedSupplierId,
    }));
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">{property.org.name} · {property.name}</div>
            <h1 className="text-2xl font-semibold text-zinc-900">Costo acquisto merci</h1>
            <p className="mt-1 text-sm text-zinc-600">
              Magazzino unico bar: qui registri costo minimo e massimo; il costo medio calcolato viene applicato a {barOutlets.map((outlet) => outlet.name).join(", ")} per l&apos;anno selezionato.
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-1">
              {yearChoices.map((choice) => (
                <Link
                  key={choice}
                  href={buildCostsPageHref({
                    propertyId,
                    year: choice,
                    fromOutletId: hasFromOutlet ? fromOutletId : "",
                    productId: selectedProductId,
                    supplierId: selectedSupplierId,
                  })}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    choice === year ? "bg-zinc-900 text-white shadow-sm" : "text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  {choice}
                </Link>
              ))}
            </div>
            <Link
              href={`/properties/${propertyId}/suppliers?year=${year}`}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
            >
              Gestisci fornitori
            </Link>
            <Link
              href={backHref}
              className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
            >
              {hasFromOutlet ? "← Dashboard outlet" : "← Dashboard struttura"}
            </Link>
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <StatCard title="Bar collegati" value={String(barOutlets.length)} />
          <StatCard title={`Prodotti con costo ${year}`} value={String(distinctProductCount)} />
          <StatCard title="Fornitori attivi" value={String(suppliers.length)} />
          <StatCard
            title="Registrazioni allineate"
            value={`${costs.filter((row) => row.isAligned).length}/${costs.length || 0}`}
          />
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo costo merce condiviso</h2>
          <div className="mt-2 text-sm text-zinc-600">
            {hasSuppliers ? (
              <>Seleziona fornitore, costo minimo e costo massimo: il costo medio viene calcolato automaticamente.</>
            ) : (
              <>
                Prima registra almeno un fornitore nella pagina{" "}
                <Link
                  href={`/properties/${propertyId}/suppliers?year=${year}`}
                  className="font-semibold text-zinc-900 underline underline-offset-2"
                >
                  Fornitori
                </Link>
                .
              </>
            )}
          </div>
          <form action={upsertCost} className="mt-4 grid gap-2 md:grid-cols-7">
            <select name="productId" required className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Prodotto</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
            <select
              name="supplierId"
              required
              disabled={!hasSuppliers}
              className="rounded-xl border px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-zinc-100"
            >
              <option value="">Fornitore</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
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
            <button
              disabled={!hasSuppliers}
              className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300"
            >
              Salva costo
            </button>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Costi configurati per il {year}</h2>
          <div className="mt-2 text-sm text-zinc-600">
            Ogni modifica aggiorna automaticamente tutti i bar della struttura.
          </div>
          <form action={`/properties/${propertyId}/costs`} method="get" className="mt-4 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]">
            <input type="hidden" name="year" value={String(year)} />
            {hasFromOutlet ? <input type="hidden" name="fromOutletId" value={fromOutletId} /> : null}
            <select name="productId" defaultValue={selectedProductId} className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Tutti i prodotti</option>
              {costFilterProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
            <select name="supplierId" defaultValue={selectedSupplierId} className="rounded-xl border px-3 py-2 text-sm">
              <option value="">Tutti i fornitori</option>
              {costFilterSuppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
            <button className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100">
              Applica filtri
            </button>
            <Link
              href={buildCostsPageHref({
                propertyId,
                year,
                fromOutletId: hasFromOutlet ? fromOutletId : "",
              })}
              className="rounded-xl border border-zinc-200 bg-white px-4 py-2 text-center text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
            >
              Reset
            </Link>
          </form>
          <div className="mt-3 text-xs text-zinc-500">
            Risultati mostrati: {filteredCosts.length} di {costs.length}.
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Prodotto</th>
                  <th className="px-3 py-2">Fornitore</th>
                  <th className="px-3 py-2">Costo unitario minimo</th>
                  <th className="px-3 py-2">Costo unitario massimo</th>
                  <th className="px-3 py-2">Costo unitario medio</th>
                  <th className="px-3 py-2">Nota</th>
                  <th className="px-3 py-2">Copertura bar</th>
                  <th className="px-3 py-2">Ultimo update</th>
                  <th className="px-3 py-2">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {filteredCosts.map((cost) => (
                  <tr key={cost.key} className="border-t">
                    <td className="px-3 py-2 font-medium">{cost.productName}</td>
                    <td className="px-3 py-2 text-zinc-600">{cost.supplierName ?? "-"}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input
                          form={`update-cost-${cost.key}`}
                          name="unitCostNetMin"
                          type="number"
                          min="0"
                          step="0.001"
                          defaultValue={formatCostInput(cost.unitCostNetMin)}
                          className="w-28 rounded-lg border px-2 py-1 text-sm"
                        />
                        <span className="text-zinc-500">/ {cost.uom}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input
                          form={`update-cost-${cost.key}`}
                          name="unitCostNetMax"
                          type="number"
                          min="0"
                          step="0.001"
                          defaultValue={formatCostInput(cost.unitCostNetMax)}
                          className="w-28 rounded-lg border px-2 py-1 text-sm"
                        />
                        <span className="text-zinc-500">/ {cost.uom}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-medium">{money(cost.unitCostNetAvg)} / {cost.uom}</td>
                    <td className="px-3 py-2 text-zinc-600">{cost.note ?? "-"}</td>
                    <td className="px-3 py-2 text-zinc-600">
                      {cost.coverageCount}/{barOutlets.length} {cost.isAligned ? "allineati" : "da riallineare"}
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{new Date(cost.updatedAt).toLocaleString("it-IT")}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <form id={`update-cost-${cost.key}`} action={updateConfiguredCost}>
                          <input type="hidden" name="productId" value={cost.productId} />
                          <input type="hidden" name="supplierId" value={cost.supplierId ?? ""} />
                          <input type="hidden" name="year" value={String(cost.year)} />
                          <input type="hidden" name="note" value={cost.note ?? ""} />
                        </form>
                        <button
                          form={`update-cost-${cost.key}`}
                          className="rounded-lg border border-zinc-200 px-2 py-1 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
                        >
                          Aggiorna
                        </button>
                        <form action={removeCost}>
                          <input type="hidden" name="productId" value={cost.productId} />
                          <input type="hidden" name="supplierId" value={cost.supplierId ?? ""} />
                          <button className="rounded-lg border border-red-200 px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50">
                            Rimuovi
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredCosts.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-zinc-500" colSpan={9}>
                      {selectedProductId || selectedSupplierId
                        ? `Nessun costo merce trovato per i filtri selezionati nel ${year}.`
                        : `Nessun costo merce impostato per i bar della struttura nel ${year}.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Storico costi ultimi 3 anni</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Confronto anno su anno basato sull&apos;anno selezionato: {visibleYears.join(" / ")}.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left">
                <tr>
                  <th className="px-3 py-2">Prodotto</th>
                  <th className="px-3 py-2">{visibleYears[0]}</th>
                  <th className="px-3 py-2">{visibleYears[1]}</th>
                  <th className="px-3 py-2">Var. {visibleYears[1]}/{visibleYears[0]}</th>
                  <th className="px-3 py-2">{visibleYears[2]}</th>
                  <th className="px-3 py-2">Var. {visibleYears[2]}/{visibleYears[1]}</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((row) => (
                  <tr key={row.productId} className="border-t">
                    <td className="px-3 py-2 font-medium">{row.productName}</td>
                    <td className="px-3 py-2">{renderHistoricalCost(row.years[visibleYears[0]], row.uom)}</td>
                    <td className="px-3 py-2">{renderHistoricalCost(row.years[visibleYears[1]], row.uom)}</td>
                    <td className="px-3 py-2">{renderYearDelta(row.years[visibleYears[0]], row.years[visibleYears[1]])}</td>
                    <td className="px-3 py-2">{renderHistoricalCost(row.years[visibleYears[2]], row.uom)}</td>
                    <td className="px-3 py-2">{renderYearDelta(row.years[visibleYears[1]], row.years[visibleYears[2]])}</td>
                  </tr>
                ))}
                {historyRows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-6 text-zinc-500" colSpan={6}>
                      Nessuno storico costi disponibile negli ultimi 3 anni.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function buildSharedCosts(
  rows: Awaited<ReturnType<typeof listOutletCostsForOutlets>>,
  totalBars: number,
  selectedYear: number,
): SharedCostRow[] {
  const grouped = new Map<string, typeof rows>();

  for (const row of rows) {
    if (row.year !== selectedYear) continue;
    const groupKey = `${row.productId}::${row.supplierId ?? ""}`;
    const existing = grouped.get(groupKey) ?? [];
    existing.push(row);
    grouped.set(groupKey, existing);
  }

  return [...grouped.values()]
    .map((groupRows) => {
      const latest = [...groupRows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
      const distinctValues = new Set(
        groupRows.map(
          (row) =>
            `${Number(row.unitCostNetMin).toFixed(4)}::${Number(row.unitCostNetMax).toFixed(4)}::${row.note ?? ""}::${row.supplierId ?? ""}`,
        ),
      );

      return {
        key: `${latest.productId}::${latest.supplierId ?? ""}`,
        productId: latest.productId,
        productName: latest.productName,
        uom: latest.uom,
        year: latest.year,
        supplierId: latest.supplierId,
        supplierName: latest.supplierName,
        unitCostNetMin: latest.unitCostNetMin,
        unitCostNetMax: latest.unitCostNetMax,
        unitCostNetAvg: latest.unitCostNet,
        note: latest.note,
        updatedAt: latest.updatedAt,
        coverageCount: groupRows.length,
        isAligned: distinctValues.size === 1 && groupRows.length === totalBars,
      };
    })
    .sort((a, b) => a.productName.localeCompare(b.productName, "it"));
}

function revalidateStructureCosts(propertyId: string, year: number, barOutletIds: string[]) {
  revalidatePath(`/properties/${propertyId}/costs?year=${year}`);
  revalidatePath(`/properties/${propertyId}?year=${year}`);

  for (const outletId of barOutletIds) {
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}?year=${year}`);
    revalidatePath(`/properties/${propertyId}/outlets/${outletId}/costs?year=${year}`);
  }
}

function buildCostsPageHref(args: {
  propertyId: string;
  year: number;
  fromOutletId?: string;
  productId?: string;
  supplierId?: string;
}) {
  const params = new URLSearchParams();
  params.set("year", String(args.year));
  if (args.fromOutletId) params.set("fromOutletId", args.fromOutletId);
  if (args.productId) params.set("productId", args.productId);
  if (args.supplierId) params.set("supplierId", args.supplierId);
  return `/properties/${args.propertyId}/costs?${params.toString()}`;
}

function buildCostFilterProducts(costs: SharedCostRow[]) {
  const products = new Map<string, { id: string; name: string }>();
  for (const cost of costs) {
    if (!products.has(cost.productId)) {
      products.set(cost.productId, { id: cost.productId, name: cost.productName });
    }
  }
  return [...products.values()].sort((a, b) => a.name.localeCompare(b.name, "it"));
}

function buildCostFilterSuppliers(costs: SharedCostRow[]) {
  const suppliers = new Map<string, { id: string; name: string }>();
  for (const cost of costs) {
    if (!cost.supplierId || !cost.supplierName || suppliers.has(cost.supplierId)) continue;
    suppliers.set(cost.supplierId, { id: cost.supplierId, name: cost.supplierName });
  }
  return [...suppliers.values()].sort((a, b) => a.name.localeCompare(b.name, "it"));
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-1 text-xl font-semibold text-zinc-900">{value}</div>
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

function formatCostInput(value: number) {
  return Number(value).toFixed(3);
}

function buildYearChoices(year: number) {
  return [year - 2, year - 1, year, year + 1].filter((value, index, array) => array.indexOf(value) === index);
}

function buildCostHistoryRows(
  rows: Awaited<ReturnType<typeof listOutletCostsForOutlets>>,
  totalBars: number,
  years: number[],
) {
  const productMap = new Map<string, {
    productId: string;
    productName: string;
    uom: string;
    years: Record<number, { unitCostNetAvg: number; coverageCount: number; isAligned: boolean } | null>;
  }>();

  for (const year of years) {
    const yearlyRows = buildSharedCosts(rows, totalBars, year);
    const yearlyProductAggregate = new Map<string, {
      productId: string;
      productName: string;
      uom: string;
      sum: number;
      count: number;
      isAligned: boolean;
    }>();

    for (const row of yearlyRows) {
      const current = yearlyProductAggregate.get(row.productId) ?? {
        productId: row.productId,
        productName: row.productName,
        uom: row.uom,
        sum: 0,
        count: 0,
        isAligned: true,
      };
      current.sum += row.unitCostNetAvg;
      current.count += 1;
      current.isAligned = current.isAligned && row.isAligned;
      yearlyProductAggregate.set(row.productId, current);
    }

    for (const row of yearlyProductAggregate.values()) {
      const existing = productMap.get(row.productId) ?? {
        productId: row.productId,
        productName: row.productName,
        uom: row.uom,
        years: Object.fromEntries(years.map((value) => [value, null])),
      };
      existing.years[year] = {
        unitCostNetAvg: row.count > 0 ? row.sum / row.count : 0,
        coverageCount: row.count,
        isAligned: row.isAligned,
      };
      productMap.set(row.productId, existing);
    }
  }

  return [...productMap.values()].sort((a, b) => a.productName.localeCompare(b.productName, "it"));
}

function renderHistoricalCost(
  value: { unitCostNetAvg: number; coverageCount: number; isAligned: boolean } | null | undefined,
  uom: string,
) {
  if (!value) return "-";
  const alignmentLabel = value.isAligned ? "" : " *";
  return `${money(value.unitCostNetAvg)} / ${uom}${alignmentLabel}`;
}

function renderYearDelta(
  previous: { unitCostNetAvg: number } | null | undefined,
  current: { unitCostNetAvg: number } | null | undefined,
) {
  if (!previous || !current) return "-";
  const diff = current.unitCostNetAvg - previous.unitCostNetAvg;
  if (Math.abs(diff) < 0.0001) {
    return <span className="font-medium text-zinc-500">→ stabile</span>;
  }
  if (diff < 0) {
    return <span className="font-medium text-emerald-600">↓ {money(Math.abs(diff))}</span>;
  }
  return <span className="font-medium text-red-600">↑ {money(diff)}</span>;
}
