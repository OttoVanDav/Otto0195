import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  APP_AUTH_DEFAULT_REDIRECT,
  APP_AUTH_SESSION_COOKIE,
  createAuthSessionValue,
  getConfiguredLoginUsername,
  resolveSafeRedirectPath,
} from "@/lib/app-auth";
import { authenticateAppLoginCredentials } from "@/lib/app-auth-server";

type Props = {
  searchParams?: Promise<{ error?: string; next?: string; force?: string }>;
};

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: Props) {
  const sp = searchParams ? await searchParams : {};
  const hasError = sp.error === "1";
  const nextPath = resolveSafeRedirectPath(sp.next);
  const adminUsername = getConfiguredLoginUsername();
  const isSwitchAccountMode = sp.force === "1";

  async function login(formData: FormData) {
    "use server";

    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const requestedNext = resolveSafeRedirectPath(String(formData.get("next") ?? APP_AUTH_DEFAULT_REDIRECT));
    const authenticatedUser = await authenticateAppLoginCredentials(username, password);

    if (!authenticatedUser) {
      redirect(`/login?error=1&next=${encodeURIComponent(requestedNext)}`);
    }

    const cookieStore = await cookies();
    const session = await createAuthSessionValue(authenticatedUser);
    cookieStore.set(APP_AUTH_SESSION_COOKIE, session.value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });

    redirect(requestedNext);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 py-12">
      <div className="w-full max-w-md rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
        <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">Accesso Riservato</div>
        <h1 className="mt-3 text-3xl font-semibold text-zinc-900">Login</h1>
        <p className="mt-2 text-sm text-zinc-600">
          {isSwitchAccountMode
            ? "Inserisci nuove credenziali per cambiare account."
            : "Inserisci username e password per accedere al software."}
        </p>

        <form action={login} className="mt-6 space-y-3">
          <input type="hidden" name="next" value={nextPath} />
          <div className="space-y-1">
            <label className="text-sm font-medium text-zinc-700" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              defaultValue={adminUsername}
              required
              className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none transition focus:border-zinc-400"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium text-zinc-700" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="w-full rounded-xl border border-zinc-200 px-3 py-2 text-sm outline-none transition focus:border-zinc-400"
            />
          </div>

          {hasError ? (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              Credenziali non valide.
            </div>
          ) : null}

          <button className="w-full rounded-xl bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800">
            Accedi
          </button>
        </form>

        <div className="mt-6 text-center text-xs text-zinc-500">
          <Link href="/" className="underline underline-offset-2">
            Torna alla home
          </Link>
        </div>
      </div>
    </div>
  );
}
