import { NextResponse } from "next/server";
import {
  extractMoneticaArticles,
  importMoneticaArticlesIntoProperty,
  syncOfficialMoneticaCatalog,
} from "@/lib/monetica-catalog";

function unauthorized() {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export async function POST(req: Request) {
  const secret = process.env.MONETICA_WEBHOOK_SECRET;
  const got = req.headers.get("x-monetica-secret");
  if (!secret || !got || got !== secret) return unauthorized();

  const url = new URL(req.url);
  const propertyId = (url.searchParams.get("propertyId") ?? req.headers.get("x-property-id") ?? "").trim();
  const parsedYear = Number(url.searchParams.get("year") ?? req.headers.get("x-price-year") ?? new Date().getUTCFullYear());
  const year = Number.isFinite(parsedYear) && parsedYear > 0 ? parsedYear : new Date().getUTCFullYear();
  if (!propertyId) {
    return NextResponse.json({ ok: false, error: "missing propertyId" }, { status: 400 });
  }

  try {
    if (url.searchParams.get("mode") === "official") {
      const result = await syncOfficialMoneticaCatalog(propertyId, year);
      return NextResponse.json({ ok: true, mode: "official", ...result });
    }

    const body: unknown = await req.json().catch(() => null);
    if (!body) return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });

    const articles = extractMoneticaArticles(body);
    if (!articles) {
      return NextResponse.json(
        { ok: false, error: "payload must be an article array or { articles: [...] }" },
        { status: 400 },
      );
    }

    const result = await importMoneticaArticlesIntoProperty(propertyId, articles, year);
    return NextResponse.json({ ok: true, mode: "push", ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "import failed";
    const status =
      message === "property not found" ? 404 :
      message === "no bar outlets found" ? 400 :
      500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
