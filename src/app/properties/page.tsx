// src/app/properties/page.tsx

import { prisma } from "@/lib/prisma";
import { getCurrentAppAuthUser } from "@/lib/app-auth-server";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function PropertiesPage() {
  const currentUser = await getCurrentAppAuthUser();
  const properties = await prisma.property.findMany({
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-4xl rounded-xl bg-white p-6 shadow">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Strutture</h1>

          {currentUser?.isAdmin ? (
            <Link
              href="/properties/new"
              className="rounded-lg bg-black px-4 py-2 text-sm text-white"
            >
              Nuova struttura
            </Link>
          ) : null}
        </div>

        <div className="mt-6 space-y-3">
          {properties.length === 0 && (
            <p className="text-sm text-zinc-500">
              Nessuna struttura ancora creata.
            </p>
          )}

          {properties.map((p) => (
            <Link
              key={p.id}
              href={`/properties/${p.id}`}
              className="block rounded-lg border p-4 hover:bg-zinc-50"
            >
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-zinc-500">
                Creata il {p.createdAt.toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
