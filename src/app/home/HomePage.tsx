import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-3xl rounded-xl bg-white p-6 shadow">
        <h1 className="text-2xl font-semibold">Controllo di Gestione</h1>
        <p className="mt-2 text-zinc-600">Strutture, magazzino, bar/ristorante, personale, sprechi.</p>
        <div className="mt-6">
          <Link className="rounded-lg bg-black px-4 py-2 text-white" href="/properties">
            Strutture
          </Link>
        </div>
      </div>
    </div>
  );
}
