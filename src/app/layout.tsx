import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { APP_AUTH_SESSION_COOKIE, readAuthSession } from "@/lib/app-auth";
import "./globals.css";

type RootLayoutProps = {
  children: ReactNode;
};

export default async function RootLayout({ children }: RootLayoutProps) {
  const cookieStore = await cookies();
  const sessionValue = cookieStore.get(APP_AUTH_SESSION_COOKIE)?.value;
  const currentUser = await readAuthSession(sessionValue);
  const isAuthenticated = Boolean(currentUser);

  async function logout() {
    "use server";
    const nextCookies = await cookies();
    nextCookies.delete(APP_AUTH_SESSION_COOKIE);
    redirect("/login");
  }

  return (
    <html lang="it">
      <body>
        <div className="site-bg-orb site-bg-orb-a" />
        <div className="site-bg-orb site-bg-orb-b" />

        <div className="site-shell">
          <header className="site-topbar">
            <div className="site-brand">Turismo CDG</div>
            {isAuthenticated ? (
              <nav className="site-nav">
                <Link href="/home">Dashboard</Link>
                <Link href="/properties">Strutture</Link>
                {currentUser?.isAdmin ? <Link href="/properties/new">Onboarding</Link> : null}
                <Link href="/login?force=1">Cambia account</Link>
              </nav>
            ) : (
              <div className="site-meta">Area protetta</div>
            )}
            {isAuthenticated ? (
              <div className="flex items-center gap-3">
                <div className="site-meta">{currentUser?.username}</div>
                <form action={logout}>
                  <button className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
                    Logout
                  </button>
                </form>
              </div>
            ) : (
              <div className="site-meta">Management Suite</div>
            )}
          </header>

          {isAuthenticated ? (
            <form action={logout} className="site-logout-floating">
              <button className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold text-zinc-800 shadow-sm hover:bg-zinc-50">
                Logout
              </button>
            </form>
          ) : null}

          <main className="site-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
