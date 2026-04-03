import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireAdminAppAuthUser } from "@/lib/app-auth-server";
import { getConfiguredLoginUsername } from "@/lib/app-auth";
import {
  createManagedAppUser,
  deleteManagedAppUser,
  listManagedAppUsers,
  updateManagedAppUser,
} from "@/lib/app-users";
import { GeneratedCredentialsFields } from "./generated-credentials-fields";

type Props = {
  params: Promise<{ propertyId: string }>;
  searchParams?: Promise<{ year?: string; flash?: string; error?: string }>;
};

export const dynamic = "force-dynamic";

const ADMIN_FLASH_MESSAGES: Record<string, string> = {
  created: "Utente creato correttamente.",
  updated: "Utente aggiornato correttamente.",
  deleted: "Utente eliminato correttamente.",
};

const ADMIN_ERROR_MESSAGES: Record<string, string> = {
  reserved_username: "Questo username è riservato all’account admin principale.",
  username_taken: "Esiste già un utente con questo username.",
  invalid_input: "Compila correttamente i campi richiesti.",
};

function settingsHref(propertyId: string, year: number, params?: Record<string, string | null | undefined>) {
  const search = new URLSearchParams({ year: String(year) });
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) search.set(key, value);
  }
  return `/properties/${propertyId}/settings?${search.toString()}`;
}

function readPermissionsFromFormData(formData: FormData) {
  return {
    controlManagement: formData.get("controlManagement") === "on",
    salesPoints: formData.get("salesPoints") === "on",
    outletDashboards: formData.get("outletDashboards") === "on",
  };
}

export default async function PropertySettingsPage({ params, searchParams }: Props) {
  await requireAdminAppAuthUser();

  const { propertyId } = await params;
  const sp = searchParams ? await searchParams : {};
  const year = Number(sp.year ?? new Date().getUTCFullYear());
  const flash = sp.flash ? ADMIN_FLASH_MESSAGES[sp.flash] ?? null : null;
  const error = sp.error ? ADMIN_ERROR_MESSAGES[sp.error] ?? null : null;

  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { org: true },
  });
  if (!property) return notFound();

  const managedUsers = await listManagedAppUsers().catch(() => []);
  const adminUsername = getConfiguredLoginUsername();

  async function createUser(formData: FormData) {
    "use server";

    await requireAdminAppAuthUser();

    const username = String(formData.get("username") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const permissions = readPermissionsFromFormData(formData);
    const isActive = formData.get("isActive") === "on";

    if (!username || !password) {
      redirect(settingsHref(propertyId, year, { error: "invalid_input" }));
    }
    if (username.toLowerCase() === getConfiguredLoginUsername().toLowerCase()) {
      redirect(settingsHref(propertyId, year, { error: "reserved_username" }));
    }

    try {
      await createManagedAppUser({
        username,
        password,
        permissions,
        isActive,
      });
    } catch (caughtError) {
      const code = caughtError instanceof Error ? caughtError.message : "invalid_input";
      redirect(settingsHref(propertyId, year, { error: code }));
    }

    revalidatePath(`/properties/${propertyId}/settings`);
    redirect(settingsHref(propertyId, year, { flash: "created" }));
  }

  async function saveUser(formData: FormData) {
    "use server";

    await requireAdminAppAuthUser();

    const id = String(formData.get("id") ?? "").trim();
    const username = String(formData.get("username") ?? "").trim();
    const newPassword = String(formData.get("newPassword") ?? "");
    const permissions = readPermissionsFromFormData(formData);
    const isActive = formData.get("isActive") === "on";

    if (!id || !username) {
      redirect(settingsHref(propertyId, year, { error: "invalid_input" }));
    }
    if (username.toLowerCase() === getConfiguredLoginUsername().toLowerCase()) {
      redirect(settingsHref(propertyId, year, { error: "reserved_username" }));
    }

    try {
      await updateManagedAppUser({
        id,
        username,
        newPassword,
        permissions,
        isActive,
      });
    } catch (caughtError) {
      const code = caughtError instanceof Error ? caughtError.message : "invalid_input";
      redirect(settingsHref(propertyId, year, { error: code }));
    }

    revalidatePath(`/properties/${propertyId}/settings`);
    redirect(settingsHref(propertyId, year, { flash: "updated" }));
  }

  async function removeUser(formData: FormData) {
    "use server";

    await requireAdminAppAuthUser();

    const id = String(formData.get("id") ?? "").trim();
    if (!id) {
      redirect(settingsHref(propertyId, year, { error: "invalid_input" }));
    }

    await deleteManagedAppUser(id);
    revalidatePath(`/properties/${propertyId}/settings`);
    redirect(settingsHref(propertyId, year, { flash: "deleted" }));
  }

  return (
    <div className="min-h-screen bg-zinc-50 p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-zinc-500">
              {property.org.name} · {property.name}
            </div>
            <h1 className="text-2xl font-semibold text-zinc-900">Impostazioni</h1>
            <p className="mt-1 text-sm text-zinc-600">
              Gestisci gli utenti che possono accedere al software e le macrosezioni abilitate.
            </p>
          </div>
          <Link
            href={`/properties/${propertyId}?year=${year}`}
            className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100"
          >
            ← Dashboard struttura
          </Link>
        </header>

        {flash ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {flash}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Account admin principale</h2>
          <div className="mt-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="text-sm font-semibold text-zinc-900">{adminUsername}</div>
            <div className="mt-1 text-sm text-zinc-600">
              Questo account resta admin con accesso completo a tutto il software.
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Nuovo utente</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Genera username e password, poi scegli a quali macrosezioni può accedere.
          </p>

          <form action={createUser} className="mt-4 grid gap-4 lg:grid-cols-2">
            <GeneratedCredentialsFields />

            <div className="space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
              <div className="text-sm font-semibold text-zinc-900">Permessi</div>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" name="controlManagement" />
                Controllo di gestione
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" name="salesPoints" />
                Punti vendita
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" name="outletDashboards" />
                Dashboard punti vendita
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" name="isActive" defaultChecked />
                Utente attivo
              </label>

              <div className="pt-2">
                <button className="rounded-xl bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800">
                  Crea utente
                </button>
              </div>
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-zinc-900">Utenti gestiti</h2>
          {managedUsers.length === 0 ? (
            <div className="mt-4 rounded-2xl border border-dashed border-zinc-300 px-4 py-6 text-sm text-zinc-500">
              Nessun utente secondario ancora configurato.
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              {managedUsers.map((user) => (
                <div key={user.id} className="rounded-2xl border border-zinc-200 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="text-sm font-semibold text-zinc-900">{user.username}</div>
                      <div className="mt-1 text-xs text-zinc-500">
                        Creato il {user.createdAt.toLocaleDateString("it-IT")}
                      </div>
                    </div>

                    <form action={removeUser}>
                      <input type="hidden" name="id" value={user.id} />
                      <button className="rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50">
                        Elimina utente
                      </button>
                    </form>
                  </div>

                  <form action={saveUser} className="mt-4 grid gap-4 lg:grid-cols-2">
                    <input type="hidden" name="id" value={user.id} />

                    <div className="space-y-2">
                      <label className="text-sm font-medium text-zinc-700">Username</label>
                      <input
                        name="username"
                        defaultValue={user.username}
                        required
                        className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium text-zinc-700">Nuova password</label>
                      <input
                        name="newPassword"
                        type="text"
                        placeholder="Lascia vuoto per mantenerla"
                        className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm"
                      />
                    </div>

                    <div className="space-y-3 rounded-2xl border border-zinc-200 bg-zinc-50 p-4 lg:col-span-2">
                      <div className="text-sm font-semibold text-zinc-900">Permessi</div>
                      <label className="flex items-center gap-2 text-sm text-zinc-700">
                        <input type="checkbox" name="controlManagement" defaultChecked={user.permissions.controlManagement} />
                        Controllo di gestione
                      </label>
                      <label className="flex items-center gap-2 text-sm text-zinc-700">
                        <input type="checkbox" name="salesPoints" defaultChecked={user.permissions.salesPoints} />
                        Punti vendita
                      </label>
                      <label className="flex items-center gap-2 text-sm text-zinc-700">
                        <input type="checkbox" name="outletDashboards" defaultChecked={user.permissions.outletDashboards} />
                        Dashboard punti vendita
                      </label>
                      <label className="flex items-center gap-2 text-sm text-zinc-700">
                        <input type="checkbox" name="isActive" defaultChecked={user.isActive} />
                        Utente attivo
                      </label>
                    </div>

                    <div className="lg:col-span-2">
                      <button className="rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-50">
                        Salva modifiche
                      </button>
                    </div>
                  </form>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
