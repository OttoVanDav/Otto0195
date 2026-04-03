import {
  FULL_APP_SECTION_PERMISSIONS,
  normalizeAppSectionPermissions,
  type AppSectionPermissions,
} from "@/lib/app-permissions";
import { signHmacSha256Hex, sha256Hex, utf8ToHex, hexToUtf8 } from "@/lib/app-auth-crypto";

const DEFAULT_APP_LOGIN_USERNAME = "WelcomeVillaggi";
const DEFAULT_APP_LOGIN_PASSWORD_SHA256 = "918475a6d62e570274bff6f507531b973940ac93b2f1c7d8cd782854535e15ff";
const DEFAULT_APP_LOGIN_SESSION_SECRET = "turismo-cdg-app-login-session-secret";

export const APP_AUTH_SESSION_COOKIE = "turismo_cdg_session";
export const APP_AUTH_DEFAULT_REDIRECT = "/home";
export const APP_AUTH_SESSION_TTL_SECONDS = 60 * 60 * 12;

type AppAuthSessionPayload = {
  sub: string;
  usr: string;
  adm: boolean;
  prm: AppSectionPermissions;
  exp: number;
};

export type AppAuthUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  permissions: AppSectionPermissions;
  source: "default-admin" | "managed";
};

function getSessionSecret() {
  return process.env.APP_LOGIN_SESSION_SECRET?.trim() || DEFAULT_APP_LOGIN_SESSION_SECRET;
}

async function signSessionPayload(payload: string) {
  return signHmacSha256Hex(getSessionSecret(), payload);
}

async function getExpectedPasswordHash() {
  const passwordFromEnv = process.env.APP_LOGIN_PASSWORD;
  if (passwordFromEnv) return sha256Hex(passwordFromEnv);
  return process.env.APP_LOGIN_PASSWORD_SHA256?.trim() || DEFAULT_APP_LOGIN_PASSWORD_SHA256;
}

export function getConfiguredLoginUsername() {
  return process.env.APP_LOGIN_USERNAME?.trim() || DEFAULT_APP_LOGIN_USERNAME;
}

export function getDefaultAdminAuthUser(): AppAuthUser {
  return {
    id: "default-admin",
    username: getConfiguredLoginUsername(),
    isAdmin: true,
    permissions: FULL_APP_SECTION_PERMISSIONS,
    source: "default-admin",
  };
}

export async function validateDefaultAdminCredentials(username: string, password: string) {
  const normalizedUsername = username.trim();
  const expectedUsername = getConfiguredLoginUsername();
  if (normalizedUsername !== expectedUsername) return false;

  const providedPasswordHash = await sha256Hex(password);
  const expectedPasswordHash = await getExpectedPasswordHash();
  return providedPasswordHash === expectedPasswordHash;
}

function buildSessionPayload(user: AppAuthUser, expiresAt: number): AppAuthSessionPayload {
  return {
    sub: user.id,
    usr: user.username,
    adm: user.isAdmin,
    prm: normalizeAppSectionPermissions(user.permissions),
    exp: expiresAt,
  };
}

function mapSessionPayloadToUser(payload: AppAuthSessionPayload): AppAuthUser {
  return {
    id: payload.sub,
    username: payload.usr,
    isAdmin: Boolean(payload.adm),
    permissions: normalizeAppSectionPermissions(payload.prm),
    source: payload.sub === "default-admin" ? "default-admin" : "managed",
  };
}

export async function createAuthSessionValue(user: AppAuthUser) {
  const expiresAt = Date.now() + APP_AUTH_SESSION_TTL_SECONDS * 1000;
  const payloadJson = JSON.stringify(buildSessionPayload(user, expiresAt));
  const payloadHex = utf8ToHex(payloadJson);
  const signature = await signSessionPayload(`v1:${payloadHex}`);

  return {
    value: `v1.${payloadHex}.${signature}`,
    expiresAt,
  };
}

async function readLegacyAdminSession(value: string) {
  const [expiresAtRaw = "", signature = ""] = value.split(".");
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !signature) return null;

  const expectedSignature = await signSessionPayload(`${getConfiguredLoginUsername()}:${expiresAt}`);
  if (signature !== expectedSignature) return null;
  return getDefaultAdminAuthUser();
}

export async function readAuthSession(value: string | null | undefined): Promise<AppAuthUser | null> {
  if (!value) return null;

  if (!value.startsWith("v1.")) {
    return readLegacyAdminSession(value);
  }

  const [, payloadHex = "", signature = ""] = value.split(".");
  if (!payloadHex || !signature) return null;

  const expectedSignature = await signSessionPayload(`v1:${payloadHex}`);
  if (signature !== expectedSignature) return null;

  const payloadJson = hexToUtf8(payloadHex);
  if (!payloadJson) return null;

  let payload: AppAuthSessionPayload | null = null;
  try {
    payload = JSON.parse(payloadJson) as AppAuthSessionPayload;
  } catch {
    payload = null;
  }
  if (!payload) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;

  return mapSessionPayloadToUser(payload);
}

export async function isValidAuthSession(value: string | null | undefined) {
  const session = await readAuthSession(value);
  return Boolean(session);
}

export function resolveSafeRedirectPath(pathname: string | null | undefined) {
  const raw = String(pathname ?? "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return APP_AUTH_DEFAULT_REDIRECT;
  if (raw.startsWith("/login")) return APP_AUTH_DEFAULT_REDIRECT;
  return raw || APP_AUTH_DEFAULT_REDIRECT;
}
