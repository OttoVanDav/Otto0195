import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { sha256Hex } from "@/lib/app-auth-crypto";
import {
  EMPTY_APP_SECTION_PERMISSIONS,
  normalizeAppSectionPermissions,
  type AppSectionPermissions,
} from "@/lib/app-permissions";

export type ManagedAppUserRecord = {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  isActive: boolean;
  permissions: AppSectionPermissions;
  createdAt: Date;
  updatedAt: Date;
};

type AppUserRow = {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  isActive: boolean;
  canAccessControlManagement: boolean;
  canAccessSalesPoints: boolean;
  canAccessOutletDashboards: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function mapAppUserRow(row: AppUserRow): ManagedAppUserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    isAdmin: Boolean(row.isAdmin),
    isActive: Boolean(row.isActive),
    permissions: normalizeAppSectionPermissions({
      controlManagement: row.canAccessControlManagement,
      salesPoints: row.canAccessSalesPoints,
      outletDashboards: row.canAccessOutletDashboards,
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function ensureAppUsersTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppUser" (
      "id" TEXT NOT NULL,
      "username" TEXT NOT NULL,
      "passwordHash" TEXT NOT NULL,
      "isAdmin" BOOLEAN NOT NULL DEFAULT FALSE,
      "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
      "canAccessControlManagement" BOOLEAN NOT NULL DEFAULT FALSE,
      "canAccessSalesPoints" BOOLEAN NOT NULL DEFAULT FALSE,
      "canAccessOutletDashboards" BOOLEAN NOT NULL DEFAULT FALSE,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "AppUser_username_lower_key"
    ON "AppUser"(LOWER("username"));
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "AppUser_isActive_idx"
    ON "AppUser"("isActive");
  `);
}

async function findUserRowByUsername(username: string) {
  const normalized = username.trim().toLowerCase();
  if (!normalized) return null;
  await ensureAppUsersTable().catch(() => null);
  const rows = await prisma.$queryRaw<Array<AppUserRow>>`
    SELECT
      "id" AS "id",
      "username" AS "username",
      "passwordHash" AS "passwordHash",
      "isAdmin" AS "isAdmin",
      "isActive" AS "isActive",
      "canAccessControlManagement" AS "canAccessControlManagement",
      "canAccessSalesPoints" AS "canAccessSalesPoints",
      "canAccessOutletDashboards" AS "canAccessOutletDashboards",
      "createdAt" AS "createdAt",
      "updatedAt" AS "updatedAt"
    FROM "AppUser"
    WHERE LOWER("username") = ${normalized}
    LIMIT 1
  `.catch(() => []);
  return rows[0] ?? null;
}

export async function listManagedAppUsers() {
  await ensureAppUsersTable().catch(() => null);
  const rows = await prisma.$queryRaw<Array<AppUserRow>>`
    SELECT
      "id" AS "id",
      "username" AS "username",
      "passwordHash" AS "passwordHash",
      "isAdmin" AS "isAdmin",
      "isActive" AS "isActive",
      "canAccessControlManagement" AS "canAccessControlManagement",
      "canAccessSalesPoints" AS "canAccessSalesPoints",
      "canAccessOutletDashboards" AS "canAccessOutletDashboards",
      "createdAt" AS "createdAt",
      "updatedAt" AS "updatedAt"
    FROM "AppUser"
    ORDER BY LOWER("username") ASC
  `.catch(() => []);
  return rows.map(mapAppUserRow);
}

export async function findManagedAppUserByUsername(username: string) {
  const row = await findUserRowByUsername(username);
  return row ? mapAppUserRow(row) : null;
}

export async function createManagedAppUser(args: {
  username: string;
  password: string;
  permissions?: Partial<AppSectionPermissions>;
  isActive?: boolean;
}) {
  const username = args.username.trim();
  const password = args.password;
  if (!username || !password) {
    throw new Error("username_or_password_missing");
  }

  await ensureAppUsersTable().catch(() => null);
  const existing = await findUserRowByUsername(username);
  if (existing) {
    throw new Error("username_taken");
  }

  const id = randomUUID();
  const passwordHash = await sha256Hex(password);
  const permissions = normalizeAppSectionPermissions(args.permissions ?? EMPTY_APP_SECTION_PERMISSIONS);
  const isActive = args.isActive ?? true;

  await prisma.$executeRaw`
    INSERT INTO "AppUser"
      (
        "id",
        "username",
        "passwordHash",
        "isAdmin",
        "isActive",
        "canAccessControlManagement",
        "canAccessSalesPoints",
        "canAccessOutletDashboards",
        "createdAt",
        "updatedAt"
      )
    VALUES
      (
        ${id},
        ${username},
        ${passwordHash},
        FALSE,
        ${isActive},
        ${permissions.controlManagement},
        ${permissions.salesPoints},
        ${permissions.outletDashboards},
        NOW(),
        NOW()
      )
  `;

  const created = await findManagedAppUserByUsername(username);
  if (!created) {
    throw new Error("create_failed");
  }
  return created;
}

export async function updateManagedAppUser(args: {
  id: string;
  username: string;
  newPassword?: string | null;
  permissions?: Partial<AppSectionPermissions>;
  isActive?: boolean;
}) {
  const id = args.id.trim();
  const username = args.username.trim();
  if (!id || !username) {
    throw new Error("id_or_username_missing");
  }

  await ensureAppUsersTable().catch(() => null);
  const conflicting = await findUserRowByUsername(username);
  if (conflicting && conflicting.id !== id) {
    throw new Error("username_taken");
  }

  const permissions = normalizeAppSectionPermissions(args.permissions ?? EMPTY_APP_SECTION_PERMISSIONS);
  const isActive = args.isActive ?? true;

  await prisma.$executeRaw`
    UPDATE "AppUser"
    SET
      "username" = ${username},
      "isActive" = ${isActive},
      "canAccessControlManagement" = ${permissions.controlManagement},
      "canAccessSalesPoints" = ${permissions.salesPoints},
      "canAccessOutletDashboards" = ${permissions.outletDashboards},
      "updatedAt" = NOW()
    WHERE "id" = ${id}
  `;

  const newPassword = String(args.newPassword ?? "").trim();
  if (newPassword) {
    const passwordHash = await sha256Hex(newPassword);
    await prisma.$executeRaw`
      UPDATE "AppUser"
      SET
        "passwordHash" = ${passwordHash},
        "updatedAt" = NOW()
      WHERE "id" = ${id}
    `;
  }
}

export async function deleteManagedAppUser(id: string) {
  const normalizedId = id.trim();
  if (!normalizedId) return;
  await ensureAppUsersTable().catch(() => null);
  await prisma.$executeRaw`
    DELETE FROM "AppUser"
    WHERE "id" = ${normalizedId}
  `;
}
