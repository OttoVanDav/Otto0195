import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  ensureFiscalYear,
  extractMoneticaTransactions,
  importMoneticaTransactionsIntoProperty,
  syncOfficialMoneticaSales,
} from "@/lib/monetica-sales";

type LegacyMoneticaSaleLine = {
  externalSku: string;
  qty: number;
  unitPriceNet: number;
};

type LegacyMoneticaPayload = {
  orgName: string;
  propertyName: string;
  outletName: string;
  date: string;
  externalRef: string;
  lines: LegacyMoneticaSaleLine[];
};

type SaleLineInput = {
  productId: string;
  qty: number;
  unitPriceNet: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseDate(raw: string | null) {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isLegacyMoneticaPayload(value: unknown): value is LegacyMoneticaPayload {
  if (!isRecord(value)) return false;
  const payload = value;

  if (
    typeof payload.orgName !== "string" ||
    typeof payload.propertyName !== "string" ||
    typeof payload.outletName !== "string" ||
    typeof payload.date !== "string" ||
    typeof payload.externalRef !== "string" ||
    !Array.isArray(payload.lines)
  ) {
    return false;
  }

  return payload.lines.every((line) => {
    if (!isRecord(line)) return false;
    const l = line;
    return (
      typeof l.externalSku === "string" &&
      typeof l.qty === "number" &&
      typeof l.unitPriceNet === "number"
    );
  });
}

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

async function importLegacyPayload(body: LegacyMoneticaPayload) {
  const { orgName, propertyName, outletName, date, externalRef, lines } = body;
  const org = await prisma.org.findFirst({ where: { name: orgName } });
  if (!org) return NextResponse.json({ ok: false, error: "org not found" }, { status: 404 });

  const property = await prisma.property.findFirst({ where: { orgId: org.id, name: propertyName } });
  if (!property) return NextResponse.json({ ok: false, error: "property not found" }, { status: 404 });

  const outlet = await prisma.outlet.findFirst({ where: { propertyId: property.id, name: outletName } });
  if (!outlet) return NextResponse.json({ ok: false, error: "outlet not found" }, { status: 404 });

  const dt = new Date(date);
  if (Number.isNaN(dt.getTime())) return NextResponse.json({ ok: false, error: "invalid date" }, { status: 400 });

  const fy = await ensureFiscalYear(org.id, dt.getUTCFullYear());

  const sale = await prisma.sale.upsert({
    where: { orgId_source_externalRef: { orgId: org.id, source: "MONETICA", externalRef } },
    update: { date: dt, outletId: outlet.id, fiscalYearId: fy.id },
    create: { orgId: org.id, fiscalYearId: fy.id, outletId: outlet.id, date: dt, source: "MONETICA", externalRef },
  });

  await prisma.saleLine.deleteMany({ where: { saleId: sale.id } });

  const createData: SaleLineInput[] = [];
  for (const l of lines) {
    const map = await prisma.externalProductMap.findFirst({
      where: { orgId: org.id, source: "MONETICA", externalSku: String(l.externalSku ?? "") },
    });
    if (!map) continue;

    const qty = Number(l.qty);
    const unitPriceNet = Number(l.unitPriceNet);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(unitPriceNet) || unitPriceNet < 0) continue;

    createData.push({ productId: map.productId, qty, unitPriceNet });
  }

  if (createData.length > 0) {
    await prisma.saleLine.createMany({
      data: createData.map((line) => ({ saleId: sale.id, ...line })),
    });
  }

  return NextResponse.json({ ok: true, mode: "legacy", saleId: sale.id, importedLines: createData.length });
}

export async function POST(req: Request) {
  const secret = process.env.MONETICA_WEBHOOK_SECRET;
  const got = req.headers.get("x-monetica-secret");
  if (!secret || !got || got !== secret) return unauthorized();

  const url = new URL(req.url);
  const propertyId = (url.searchParams.get("propertyId") ?? req.headers.get("x-property-id") ?? "").trim();
  if (!propertyId) {
    return NextResponse.json({ ok: false, error: "missing propertyId" }, { status: 400 });
  }

  try {
    if (url.searchParams.get("mode") === "official") {
      const result = await syncOfficialMoneticaSales(propertyId, {
        from: url.searchParams.get("from"),
        to: url.searchParams.get("to"),
        force: true,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    const body: unknown = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });

    if (isLegacyMoneticaPayload(body)) {
      return importLegacyPayload(body);
    }

    const transactions = extractMoneticaTransactions(body);
    if (!transactions) {
      return NextResponse.json(
        { ok: false, error: "payload must be a transaction array or legacy Monetica payload" },
        { status: 400 },
      );
    }

    const batchDate = parseDate((url.searchParams.get("date") ?? req.headers.get("x-monetica-date"))?.trim() ?? null);
    if ((url.searchParams.get("date") ?? req.headers.get("x-monetica-date")) && !batchDate) {
      return NextResponse.json({ ok: false, error: "invalid batch date" }, { status: 400 });
    }

    const result = await importMoneticaTransactionsIntoProperty(propertyId, transactions, batchDate);
    return NextResponse.json({ ok: true, mode: "batch", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "import failed";
    const status =
      message === "property not found" ? 404 :
      message === "invalid from date" || message === "invalid to date" || message === "invalid sync date range" ? 400 :
      500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
