import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  APP_AUTH_DEFAULT_REDIRECT,
  APP_AUTH_SESSION_COOKIE,
  getDefaultAdminAuthUser,
  readAuthSession,
  validateDefaultAdminCredentials,
  type AppAuthUser,
} from "@/lib/app-auth";
import { sha256Hex } from "@/lib/app-auth-crypto";
import { findManagedAppUserByUsername } from "@/lib/app-users";

export async function getCurrentAppAuthUser(): Promise<AppAuthUser | null> {
  const cookieStore = await cookies();
  const sessionValue = cookieStore.get(APP_AUTH_SESSION_COOKIE)?.value;
  return readAuthSession(sessionValue);
}

export async function requireCurrentAppAuthUser() {
  const user = await getCurrentAppAuthUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

export async function requireAdminAppAuthUser() {
  const user = await requireCurrentAppAuthUser();
  if (!user.isAdmin) {
    redirect(APP_AUTH_DEFAULT_REDIRECT);
  }
  return user;
}

export async function authenticateAppLoginCredentials(username: string, password: string): Promise<AppAuthUser | null> {
  if (!username.trim() || !password) return null;

  if (await validateDefaultAdminCredentials(username, password)) {
    return getDefaultAdminAuthUser();
  }

  const managedUser = await findManagedAppUserByUsername(username).catch(() => null);
  if (!managedUser || !managedUser.isActive) return null;

  const providedPasswordHash = await sha256Hex(password);
  if (providedPasswordHash !== managedUser.passwordHash) return null;

  return {
    id: managedUser.id,
    username: managedUser.username,
    isAdmin: Boolean(managedUser.isAdmin),
    permissions: managedUser.permissions,
    source: "managed",
  };
}
