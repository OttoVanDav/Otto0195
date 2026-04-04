import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export type MoneticaTransactionItem = {
  sku: string | number;
  name?: string;
  quantity: number | string;
  unit_price?: number | string;
  total?: number | string;
  discount_name?: string | null;
};

export type MoneticaTransaction = {
  id?: string | number;
  pos?: string | number;
  pos_name?: string;
  transaction_id?: string | number;
  transaction_type?: string;
  transaction_items?: MoneticaTransactionItem[];
  total_amount?: number | string;
  date?: string;
  transaction_date?: string;
  created_at?: string;
  timestamp?: string;
  occurred_at?: string;
  purchased_at?: string;
};

type SaleLineInput = {
  productId: string;
  qty: number;
  unitPriceNet: number;
};

type ResolvedSaleSkuAlias = {
  externalSku: string;
  productId: string;
};

export type ImportMoneticaSalesResult = {
  propertyId: string;
  importedSales: number;
  importedLines: number;
  skippedSales: number;
  skippedLines: number;
  warnings: string[];
};

export type SyncOfficialMoneticaSalesResult = ImportMoneticaSalesResult & {
  mode: "official";
  syncedFrom: string;
  syncedTo: string;
  fetchedTransactions: number;
  fetchedDays: number;
  limitPerDay: number;
  performedSync: boolean;
  lastSyncedAt: Date | null;
};

type SyncRange = {
  from: Date;
  to: Date;
  scope: string;
};

type SyncStateRow = {
  syncedFrom: string | null;
  syncedTo: string | null;
  lastSyncedAt: Date | null;
};

const MONETICA_SALES_SOURCE = "MONETICA";
const MONETICA_SYNC_STATE_SOURCE = "MONETICA_OFFICIAL_SALES";
const DEFAULT_LIMIT_PER_DAY = 1000;
const DEFAULT_SYNC_THROTTLE_MS = 10 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 2;
const DEFAULT_HISTORY_LOOKBACK_YEARS = 10;
const DEFAULT_SYNC_SCOPE = "default";
const DEFAULT_BOOTSTRAP_SCOPE = "default-bootstrap";
const DEFAULT_BOOTSTRAP_LIMIT = 20_000;
const DEFAULT_BOOTSTRAP_CHUNK_MONTHS = 1;
const MONETICA_OUTLET_ALIAS_BY_POS_ID = new Map<string, string>([
  ["5", "bar del sole"],
  ["20", "bar dello sport"],
  ["21", "bar del mare"],
]);
const MONETICA_OUTLET_ALIAS_BY_POS_NAME = new Map<string, string>([
  ["bar del sole", "bar del sole"],
  ["bar dello sport", "bar dello sport"],
  ["chalet mare", "bar del mare"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(",", ".");
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function pushWarning(warnings: string[], warning: string) {
  if (warnings.length < 50) warnings.push(warning);
}

function parseTimestamp(raw: string | null) {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDateOnly(raw: string | null | undefined) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function addUtcMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function startOfUtcYear(year: number) {
  return new Date(Date.UTC(year, 0, 1));
}

function startOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function resolveTransactionDate(transaction: MoneticaTransaction, batchDate: Date | null) {
  const dateFields = [
    asString(transaction.date),
    asString(transaction.transaction_date),
    asString(transaction.created_at),
    asString(transaction.timestamp),
    asString(transaction.occurred_at),
    asString(transaction.purchased_at),
  ];

  for (const raw of dateFields) {
    const parsed = parseTimestamp(raw);
    if (parsed) return parsed;
  }

  return batchDate ?? new Date();
}

function buildMoneticaExternalRef(propertyId: string, transaction: MoneticaTransaction) {
  const transactionId = asString(transaction.transaction_id) ?? asString(transaction.id);
  const pos = asString(transaction.pos) ?? asString(transaction.pos_name);
  if (!transactionId || !pos) return null;
  return `${propertyId}:${pos}:${transactionId}`;
}

function resolveOutletCandidateKeys(transaction: MoneticaTransaction) {
  const posId = asString(transaction.pos);
  const posName = asString(transaction.pos_name);
  const keys = new Set<string>();

  if (posId) {
    const aliasedByPos = MONETICA_OUTLET_ALIAS_BY_POS_ID.get(posId);
    if (aliasedByPos) keys.add(aliasedByPos);
  }

  if (posName) {
    const normalizedPosName = normalizeKey(posName);
    const aliasedByName = MONETICA_OUTLET_ALIAS_BY_POS_NAME.get(normalizedPosName);
    if (aliasedByName) keys.add(aliasedByName);
    keys.add(normalizedPosName);
  }

  return [...keys];
}

function parseMoneticaLines(
  transaction: MoneticaTransaction,
  productMap: Map<string, string>,
  productIdByName: Map<string, string>,
  ambiguousProductNames: Set<string>,
  warnings: string[],
) {
  const rawItems = Array.isArray(transaction.transaction_items) ? transaction.transaction_items : [];
  const transactionRef = asString(transaction.transaction_id) ?? asString(transaction.id) ?? "n/a";
  const lines: SaleLineInput[] = [];
  const resolvedAliases: ResolvedSaleSkuAlias[] = [];
  let skippedLines = 0;

  for (const item of rawItems) {
    if (!isRecord(item)) {
      skippedLines += 1;
      pushWarning(warnings, `Transazione ${transactionRef}: riga Monetica non valida.`);
      continue;
    }

    const externalSku = asString(item.sku);
    const qty = asNumber(item.quantity);
    const unitPriceNet = asNumber(item.unit_price) ?? (() => {
      const total = asNumber(item.total);
      if (total === null || qty === null || qty <= 0) return null;
      return total / qty;
    })();

    if (!externalSku) {
      skippedLines += 1;
      pushWarning(warnings, `Transazione ${transactionRef}: SKU Monetica mancante.`);
      continue;
    }
    if (qty === null || qty <= 0) {
      skippedLines += 1;
      pushWarning(warnings, `Transazione ${transactionRef}: quantita non valida per SKU ${externalSku}.`);
      continue;
    }
    if (unitPriceNet === null || unitPriceNet < 0) {
      skippedLines += 1;
      pushWarning(warnings, `Transazione ${transactionRef}: prezzo non valido per SKU ${externalSku}.`);
      continue;
    }

    const itemName = asString(item.name);
    const normalizedItemName = itemName ? normalizeKey(itemName) : null;
    let productId = productMap.get(externalSku) ?? null;
    if (!productId && normalizedItemName && !ambiguousProductNames.has(normalizedItemName)) {
      productId = productIdByName.get(normalizedItemName) ?? null;
      if (productId) {
        resolvedAliases.push({ externalSku, productId });
      }
    }
    if (!productId) {
      skippedLines += 1;
      pushWarning(warnings, `Transazione ${transactionRef}: SKU ${externalSku} non mappato su un prodotto interno.`);
      continue;
    }

    lines.push({ productId, qty, unitPriceNet });
  }

  return { lines, skippedLines, resolvedAliases };
}

export function extractMoneticaTransactions(value: unknown): MoneticaTransaction[] | null {
  if (Array.isArray(value)) return value as MoneticaTransaction[];
  if (!isRecord(value)) return null;

  const candidates = [value.transactions, value.data, value.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as MoneticaTransaction[];
  }

  return null;
}

export async function ensureFiscalYear(orgId: string, year: number) {
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

async function ensureMoneticaSyncStateTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "IntegrationSyncState" (
      "id" TEXT NOT NULL,
      "propertyId" TEXT NOT NULL,
      "source" TEXT NOT NULL,
      "scope" TEXT NOT NULL,
      "syncedFrom" TEXT,
      "syncedTo" TEXT,
      "lastSyncedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "IntegrationSyncState_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "IntegrationSyncState_propertyId_source_scope_key"
    ON "IntegrationSyncState"("propertyId", "source", "scope");
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "IntegrationSyncState_propertyId_source_idx"
    ON "IntegrationSyncState"("propertyId", "source");
  `);
}

async function getSyncState(propertyId: string, scope: string): Promise<SyncStateRow | null> {
  await ensureMoneticaSyncStateTable();
  const rows = await prisma.$queryRaw<SyncStateRow[]>`
    SELECT "syncedFrom", "syncedTo", "lastSyncedAt"
    FROM "IntegrationSyncState"
    WHERE "propertyId" = ${propertyId}
      AND "source" = ${MONETICA_SYNC_STATE_SOURCE}
      AND "scope" = ${scope}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function upsertSyncState(propertyId: string, scope: string, syncedFrom: string, syncedTo: string) {
  await ensureMoneticaSyncStateTable();
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO "IntegrationSyncState"
      ("id", "propertyId", "source", "scope", "syncedFrom", "syncedTo", "lastSyncedAt", "createdAt", "updatedAt")
    VALUES
      (${id}, ${propertyId}, ${MONETICA_SYNC_STATE_SOURCE}, ${scope}, ${syncedFrom}, ${syncedTo}, NOW(), NOW(), NOW())
    ON CONFLICT ("propertyId", "source", "scope")
    DO UPDATE SET
      "syncedFrom" = EXCLUDED."syncedFrom",
      "syncedTo" = EXCLUDED."syncedTo",
      "lastSyncedAt" = NOW(),
      "updatedAt" = NOW()
  `;
}

function resolveSyncRange(from?: string | null, to?: string | null): SyncRange {
  const parsedFrom = parseDateOnly(from);
  const parsedTo = parseDateOnly(to);

  if (from && !parsedFrom) throw new Error("invalid from date");
  if (to && !parsedTo) throw new Error("invalid to date");

  let rangeFrom = parsedFrom ?? parsedTo;
  let rangeTo = parsedTo ?? parsedFrom;

  if (!rangeFrom || !rangeTo) {
    const today = startOfUtcDay(new Date());
    rangeTo = today;
    rangeFrom = addUtcDays(today, -DEFAULT_LOOKBACK_DAYS);
  }

  if (rangeFrom.getTime() > rangeTo.getTime()) {
    throw new Error("invalid sync date range");
  }

  const fromLabel = formatDateOnly(rangeFrom);
  const toLabel = formatDateOnly(rangeTo);

  return {
    from: rangeFrom,
    to: rangeTo,
    scope: fromLabel === toLabel ? `range:${fromLabel}` : `range:${fromLabel}:${toLabel}`,
  };
}

async function getLatestImportedMoneticaSaleDate(propertyId: string) {
  const latestSale = await prisma.sale.findFirst({
    where: {
      source: MONETICA_SALES_SOURCE,
      outlet: { propertyId },
    },
    orderBy: { date: "desc" },
    select: { date: true },
  });
  return latestSale?.date ?? null;
}

async function getBootstrapStartYear(propertyId: string, today: Date) {
  const configuredYear = Number(process.env.MONETICA_BOOTSTRAP_START_YEAR?.trim() ?? "");
  if (Number.isFinite(configuredYear) && configuredYear > 2000 && configuredYear <= today.getUTCFullYear()) {
    return Math.trunc(configuredYear);
  }

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: {
      org: {
        select: {
          fiscalYears: {
            select: { year: true },
            orderBy: { year: "asc" },
            take: 1,
          },
        },
      },
    },
  });

  const earliestFiscalYear = property?.org.fiscalYears[0]?.year ?? null;
  if (typeof earliestFiscalYear === "number" && earliestFiscalYear <= today.getUTCFullYear()) {
    return earliestFiscalYear;
  }

  return today.getUTCFullYear() - DEFAULT_HISTORY_LOOKBACK_YEARS;
}

async function resolveBootstrapChunk(args: {
  propertyId: string;
  today: Date;
  bootstrapState: SyncStateRow | null;
  restart: boolean;
}) {
  const bootstrapStartYear = await getBootstrapStartYear(args.propertyId, args.today);
  const overallFrom = startOfUtcYear(bootstrapStartYear);
  const processedTo = !args.restart ? parseDateOnly(args.bootstrapState?.syncedTo) : null;
  const from = processedTo ? addUtcDays(processedTo, 1) : overallFrom;
  if (from.getTime() > args.today.getTime()) return null;

  const startMonth = startOfUtcMonth(from);
  const endMonth = addUtcMonths(startMonth, DEFAULT_BOOTSTRAP_CHUNK_MONTHS - 1);
  const toCandidate = endOfUtcMonth(endMonth);
  const to = toCandidate.getTime() > args.today.getTime() ? args.today : toCandidate;

  return { overallFrom, from, to };
}

async function fetchMoneticaTransactionsForRange(
  endpoint: string,
  bearerToken: string,
  from: Date,
  to: Date,
  limit: number,
) {
  const url = new URL(endpoint);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("from", formatDateOnly(from));
  url.searchParams.set("to", formatDateOnly(to));

  const response = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${bearerToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Monetica sales request failed with status ${response.status} for ${formatDateOnly(from)}:${formatDateOnly(to)}`);
  }

  const body: unknown = await response.json().catch(() => null);
  const transactions = extractMoneticaTransactions(body);
  if (!transactions) {
    throw new Error(`Monetica sales response is not a valid transactions array for ${formatDateOnly(from)}:${formatDateOnly(to)}`);
  }

  return transactions;
}

async function collectTransactionsByDay(args: {
  endpoint: string;
  bearerToken: string;
  from: Date;
  to: Date;
  limitPerDay: number;
  warnings: string[];
}) {
  const transactions: MoneticaTransaction[] = [];
  let fetchedDays = 0;

  for (let cursor = args.from; cursor.getTime() <= args.to.getTime(); cursor = addUtcDays(cursor, 1)) {
    const day = formatDateOnly(cursor);
    const dayTransactions = await fetchMoneticaTransactionsForRange(
      args.endpoint,
      args.bearerToken,
      cursor,
      cursor,
      args.limitPerDay,
    );

    fetchedDays += 1;
    transactions.push(...dayTransactions);

    if (dayTransactions.length >= args.limitPerDay) {
      pushWarning(
        args.warnings,
        `Il giorno ${day} ha raggiunto il limite di ${args.limitPerDay} movimenti restituiti da Monetica; il risultato potrebbe essere parziale.`,
      );
    }
  }

  return { transactions, fetchedDays };
}

export async function importMoneticaTransactionsIntoProperty(
  propertyId: string,
  transactions: MoneticaTransaction[],
  batchDate: Date | null = null,
): Promise<ImportMoneticaSalesResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true, outlets: true },
  });
  if (!property) throw new Error("property not found");

  const outletByName = new Map<string, { id: string; name: string }>();
  for (const outlet of property.outlets) {
    outletByName.set(normalizeKey(outlet.name), { id: outlet.id, name: outlet.name });
  }

  const products = await prisma.product.findMany({
    where: { orgId: property.orgId },
    select: { id: true, name: true },
  });
  const productNameCounts = new Map<string, number>();
  const productIdByName = new Map<string, string>();
  for (const product of products) {
    const key = normalizeKey(product.name);
    productNameCounts.set(key, (productNameCounts.get(key) ?? 0) + 1);
    if (!productIdByName.has(key)) {
      productIdByName.set(key, product.id);
    }
  }
  const ambiguousProductNames = new Set(
    [...productNameCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  );

  const externalMaps = await prisma.externalProductMap.findMany({
    where: { orgId: property.orgId, source: MONETICA_SALES_SOURCE },
    select: { externalSku: true, productId: true },
  });
  const productMap = new Map(externalMaps.map((map) => [map.externalSku, map.productId]));
  const fiscalYearCache = new Map<number, { id: string }>();
  const warnings: string[] = [];
  let importedSales = 0;
  let importedLines = 0;
  let skippedSales = 0;
  let skippedLines = 0;

  for (const transaction of transactions) {
    if (!isRecord(transaction)) {
      skippedSales += 1;
      pushWarning(warnings, "Una transazione Monetica del batch non e valida.");
      continue;
    }

    const type = asString(transaction.transaction_type);
    if (type && type !== "purchase_success") {
      skippedSales += 1;
      pushWarning(
        warnings,
        `Transazione ${asString(transaction.transaction_id) ?? asString(transaction.id) ?? "n/a"} ignorata: tipo ${type} non supportato.`,
      );
      continue;
    }

    const outletName = asString(transaction.pos_name);
    if (!outletName && !asString(transaction.pos)) {
      skippedSales += 1;
      pushWarning(warnings, `Transazione ${asString(transaction.transaction_id) ?? asString(transaction.id) ?? "n/a"} senza pos o pos_name.`);
      continue;
    }

    const outlet = resolveOutletCandidateKeys(transaction)
      .map((candidate) => outletByName.get(candidate) ?? null)
      .find((candidate) => candidate !== null) ?? null;
    if (!outlet) {
      skippedSales += 1;
      const outletLabel = outletName ?? asString(transaction.pos) ?? "n/a";
      pushWarning(warnings, `Outlet Monetica "${outletLabel}" non trovato nella struttura ${property.name}.`);
      continue;
    }

    const externalRef = buildMoneticaExternalRef(property.id, transaction);
    if (!externalRef) {
      skippedSales += 1;
      pushWarning(warnings, `Transazione su outlet ${outletName} senza riferimento esterno valido.`);
      continue;
    }

    const saleDate = resolveTransactionDate(transaction, batchDate);
    let fiscalYear = fiscalYearCache.get(saleDate.getUTCFullYear());
    if (!fiscalYear) {
      fiscalYear = await ensureFiscalYear(property.orgId, saleDate.getUTCFullYear());
      fiscalYearCache.set(saleDate.getUTCFullYear(), fiscalYear);
    }

    const parsed = parseMoneticaLines(
      transaction,
      productMap,
      productIdByName,
      ambiguousProductNames,
      warnings,
    );
    skippedLines += parsed.skippedLines;
    if (parsed.lines.length === 0) {
      skippedSales += 1;
      pushWarning(warnings, `Transazione ${asString(transaction.transaction_id) ?? asString(transaction.id) ?? "n/a"} scartata: nessuna riga importabile.`);
      continue;
    }

    const sale = await prisma.sale.upsert({
      where: {
        orgId_source_externalRef: {
          orgId: property.orgId,
          source: MONETICA_SALES_SOURCE,
          externalRef,
        },
      },
      update: {
        fiscalYearId: fiscalYear.id,
        outletId: outlet.id,
        date: saleDate,
      },
      create: {
        orgId: property.orgId,
        fiscalYearId: fiscalYear.id,
        outletId: outlet.id,
        date: saleDate,
        source: MONETICA_SALES_SOURCE,
        externalRef,
      },
    });

    await prisma.saleLine.deleteMany({ where: { saleId: sale.id } });
    await prisma.saleLine.createMany({
      data: parsed.lines.map((line) => ({
        saleId: sale.id,
        productId: line.productId,
        qty: line.qty,
        unitPriceNet: line.unitPriceNet,
      })),
    });

    for (const alias of parsed.resolvedAliases) {
      if (productMap.get(alias.externalSku) === alias.productId) continue;
      await prisma.externalProductMap.upsert({
        where: {
          orgId_source_externalSku: {
            orgId: property.orgId,
            source: MONETICA_SALES_SOURCE,
            externalSku: alias.externalSku,
          },
        },
        update: { productId: alias.productId },
        create: {
          orgId: property.orgId,
          source: MONETICA_SALES_SOURCE,
          externalSku: alias.externalSku,
          productId: alias.productId,
        },
      });
      productMap.set(alias.externalSku, alias.productId);
    }

    importedSales += 1;
    importedLines += parsed.lines.length;
  }

  return {
    propertyId,
    importedSales,
    importedLines,
    skippedSales,
    skippedLines,
    warnings,
  };
}

export async function syncOfficialMoneticaSales(
  propertyId: string,
  options?: {
    from?: string | null;
    to?: string | null;
    force?: boolean;
    limitPerDay?: number;
    throttleMs?: number;
    allowHistoricalBootstrap?: boolean;
  },
): Promise<SyncOfficialMoneticaSalesResult> {
  const endpoint = process.env.MONETICA_TRANSACTIONS_URL?.trim();
  const bearerToken = process.env.MONETICA_API_BEARER_TOKEN?.trim();
  if (!endpoint || !bearerToken) {
    throw new Error("MONETICA_TRANSACTIONS_URL or MONETICA_API_BEARER_TOKEN missing");
  }

  const hasExplicitRange = Boolean(options?.from || options?.to);
  const today = startOfUtcDay(new Date());
  const throttleMs = options?.throttleMs ?? DEFAULT_SYNC_THROTTLE_MS;
  const limitPerDay = options?.limitPerDay ?? DEFAULT_LIMIT_PER_DAY;

  if (hasExplicitRange) {
    const range = resolveSyncRange(options?.from, options?.to);
    const existingState = await getSyncState(propertyId, range.scope);
    const lastSyncedAt = existingState?.lastSyncedAt ?? null;

    if (
      !options?.force &&
      lastSyncedAt &&
      Date.now() - new Date(lastSyncedAt).getTime() < throttleMs
    ) {
      return {
        mode: "official",
        propertyId,
        importedSales: 0,
        importedLines: 0,
        skippedSales: 0,
        skippedLines: 0,
        warnings: [],
        syncedFrom: formatDateOnly(range.from),
        syncedTo: formatDateOnly(range.to),
        fetchedTransactions: 0,
        fetchedDays: 0,
        limitPerDay,
        performedSync: false,
        lastSyncedAt,
      };
    }

    const warnings: string[] = [];
    const fetched = await collectTransactionsByDay({
      endpoint,
      bearerToken,
      from: range.from,
      to: range.to,
      limitPerDay,
      warnings,
    });
    const importResult = await importMoneticaTransactionsIntoProperty(propertyId, fetched.transactions);
    const mergedWarnings = [...importResult.warnings];
    for (const warning of warnings) {
      pushWarning(mergedWarnings, warning);
    }

    await upsertSyncState(propertyId, range.scope, formatDateOnly(range.from), formatDateOnly(range.to));
    const updatedState = await getSyncState(propertyId, range.scope);

    return {
      mode: "official",
      propertyId,
      importedSales: importResult.importedSales,
      importedLines: importResult.importedLines,
      skippedSales: importResult.skippedSales,
      skippedLines: importResult.skippedLines,
      warnings: mergedWarnings,
      syncedFrom: formatDateOnly(range.from),
      syncedTo: formatDateOnly(range.to),
      fetchedTransactions: fetched.transactions.length,
      fetchedDays: fetched.fetchedDays,
      limitPerDay,
      performedSync: true,
      lastSyncedAt: updatedState?.lastSyncedAt ?? new Date(),
    };
  }

  const latestImportedSaleDate = await getLatestImportedMoneticaSaleDate(propertyId);
  const hasImportedSales = Boolean(latestImportedSaleDate);
  const incrementalState = await getSyncState(propertyId, DEFAULT_SYNC_SCOPE);
  const bootstrapState = await getSyncState(propertyId, DEFAULT_BOOTSTRAP_SCOPE);
  const bootstrapSyncedTo = parseDateOnly(bootstrapState?.syncedTo);
  const bootstrapInProgress = Boolean(
    bootstrapSyncedTo && bootstrapSyncedTo.getTime() < today.getTime(),
  );
  const shouldRunBootstrap =
    !hasImportedSales &&
    (Boolean(options?.allowHistoricalBootstrap) || bootstrapInProgress);
  const activeState = shouldRunBootstrap ? bootstrapState : incrementalState;
  const lastSyncedAt = activeState?.lastSyncedAt ?? null;

  if (
    !options?.force &&
    lastSyncedAt &&
    Date.now() - new Date(lastSyncedAt).getTime() < throttleMs
  ) {
    const throttledFrom = shouldRunBootstrap
      ? parseDateOnly(bootstrapState?.syncedTo) ?? today
      : parseDateOnly(incrementalState?.syncedTo) ?? startOfUtcDay(latestImportedSaleDate ?? today);
    return {
      mode: "official",
      propertyId,
      importedSales: 0,
      importedLines: 0,
      skippedSales: 0,
      skippedLines: 0,
      warnings: [],
      syncedFrom: formatDateOnly(throttledFrom),
      syncedTo: formatDateOnly(today),
      fetchedTransactions: 0,
      fetchedDays: 0,
      limitPerDay,
      performedSync: false,
      lastSyncedAt,
    };
  }

  if (!hasImportedSales && !shouldRunBootstrap) {
    return {
      mode: "official",
      propertyId,
      importedSales: 0,
      importedLines: 0,
      skippedSales: 0,
      skippedLines: 0,
      warnings: [],
      syncedFrom: formatDateOnly(today),
      syncedTo: formatDateOnly(today),
      fetchedTransactions: 0,
      fetchedDays: 0,
      limitPerDay,
      performedSync: false,
      lastSyncedAt: null,
    };
  }

  if (shouldRunBootstrap) {
    const bootstrapChunk = await resolveBootstrapChunk({
      propertyId,
      today,
      bootstrapState,
      restart: Boolean(options?.force && !hasImportedSales && options?.allowHistoricalBootstrap),
    });

    if (!bootstrapChunk) {
      return {
        mode: "official",
        propertyId,
        importedSales: 0,
        importedLines: 0,
        skippedSales: 0,
        skippedLines: 0,
        warnings: [],
        syncedFrom: formatDateOnly(today),
        syncedTo: formatDateOnly(today),
        fetchedTransactions: 0,
        fetchedDays: 0,
        limitPerDay,
        performedSync: false,
        lastSyncedAt,
      };
    }

    const warnings: string[] = [];
    const bootstrapLimit = Math.max(limitPerDay, DEFAULT_BOOTSTRAP_LIMIT);
    const bootstrapTransactions = await fetchMoneticaTransactionsForRange(
      endpoint,
      bearerToken,
      bootstrapChunk.from,
      bootstrapChunk.to,
      bootstrapLimit,
    );
    if (bootstrapTransactions.length >= bootstrapLimit) {
      pushWarning(
        warnings,
        `Il periodo ${formatDateOnly(bootstrapChunk.from)}:${formatDateOnly(bootstrapChunk.to)} ha raggiunto il limite di ${bootstrapLimit} movimenti restituiti da Monetica; il risultato potrebbe essere parziale.`,
      );
    }

    const importResult = await importMoneticaTransactionsIntoProperty(propertyId, bootstrapTransactions);
    const mergedWarnings = [...importResult.warnings];
    for (const warning of warnings) {
      pushWarning(mergedWarnings, warning);
    }

    await upsertSyncState(
      propertyId,
      DEFAULT_BOOTSTRAP_SCOPE,
      formatDateOnly(bootstrapChunk.overallFrom),
      formatDateOnly(bootstrapChunk.to),
    );
    if (bootstrapChunk.to.getTime() >= today.getTime()) {
      await upsertSyncState(
        propertyId,
        DEFAULT_SYNC_SCOPE,
        formatDateOnly(bootstrapChunk.overallFrom),
        formatDateOnly(bootstrapChunk.to),
      );
    }
    const updatedState = await getSyncState(propertyId, DEFAULT_BOOTSTRAP_SCOPE);

    return {
      mode: "official",
      propertyId,
      importedSales: importResult.importedSales,
      importedLines: importResult.importedLines,
      skippedSales: importResult.skippedSales,
      skippedLines: importResult.skippedLines,
      warnings: mergedWarnings,
      syncedFrom: formatDateOnly(bootstrapChunk.from),
      syncedTo: formatDateOnly(bootstrapChunk.to),
      fetchedTransactions: bootstrapTransactions.length,
      fetchedDays: 1,
      limitPerDay: bootstrapLimit,
      performedSync: true,
      lastSyncedAt: updatedState?.lastSyncedAt ?? new Date(),
    };
  }

  const warnings: string[] = [];
  const syncedFrom = parseDateOnly(incrementalState?.syncedTo) ?? startOfUtcDay(latestImportedSaleDate ?? today);
  const syncedTo = today;
  const fetched = await collectTransactionsByDay({
    endpoint,
    bearerToken,
    from: syncedFrom,
    to: syncedTo,
    limitPerDay,
    warnings,
  });
  const importResult = await importMoneticaTransactionsIntoProperty(propertyId, fetched.transactions);
  const mergedWarnings = [...importResult.warnings];
  for (const warning of warnings) {
    pushWarning(mergedWarnings, warning);
  }

  await upsertSyncState(propertyId, DEFAULT_SYNC_SCOPE, formatDateOnly(syncedFrom), formatDateOnly(syncedTo));
  const updatedState = await getSyncState(propertyId, DEFAULT_SYNC_SCOPE);

  return {
    mode: "official",
    propertyId,
    importedSales: importResult.importedSales,
    importedLines: importResult.importedLines,
    skippedSales: importResult.skippedSales,
    skippedLines: importResult.skippedLines,
    warnings: mergedWarnings,
    syncedFrom: formatDateOnly(syncedFrom),
    syncedTo: formatDateOnly(syncedTo),
    fetchedTransactions: fetched.transactions.length,
    fetchedDays: fetched.fetchedDays,
    limitPerDay,
    performedSync: true,
    lastSyncedAt: updatedState?.lastSyncedAt ?? new Date(),
  };
}
