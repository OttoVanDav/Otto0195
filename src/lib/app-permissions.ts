export type AppSectionPermissionKey =
  | "controlManagement"
  | "salesPoints"
  | "outletDashboards";

export type AppSectionPermissions = {
  controlManagement: boolean;
  salesPoints: boolean;
  outletDashboards: boolean;
};

export type AppPermissionAwareUser = {
  isAdmin: boolean;
  permissions: AppSectionPermissions;
};

type SearchParamsLike = {
  get(name: string): string | null | undefined;
};

export const EMPTY_APP_SECTION_PERMISSIONS: AppSectionPermissions = {
  controlManagement: false,
  salesPoints: false,
  outletDashboards: false,
};

export const FULL_APP_SECTION_PERMISSIONS: AppSectionPermissions = {
  controlManagement: true,
  salesPoints: true,
  outletDashboards: true,
};

export function normalizeAppSectionPermissions(
  value: Partial<AppSectionPermissions> | null | undefined,
): AppSectionPermissions {
  return {
    controlManagement: Boolean(value?.controlManagement),
    salesPoints: Boolean(value?.salesPoints),
    outletDashboards: Boolean(value?.outletDashboards),
  };
}

export function hasAppSectionPermission(
  user: AppPermissionAwareUser | null | undefined,
  permission: AppSectionPermissionKey,
) {
  if (!user) return false;
  return user.isAdmin || Boolean(user.permissions[permission]);
}

export function hasAnyAppSectionPermission(user: AppPermissionAwareUser | null | undefined) {
  if (!user) return false;
  if (user.isAdmin) return true;
  return Object.values(user.permissions).some(Boolean);
}

export function canAccessAppRoute(args: {
  user: AppPermissionAwareUser;
  pathname: string;
  searchParams?: SearchParamsLike | null;
  method?: string | null;
}) {
  if (args.user.isAdmin) return true;

  const { pathname } = args;
  const searchParams = args.searchParams ?? null;
  const method = String(args.method ?? "GET").toUpperCase();
  const segments = pathname.split("/").filter(Boolean);

  if (pathname === "/" || pathname === "/home" || pathname === "/properties") {
    return true;
  }

  if (pathname === "/properties/new") {
    return false;
  }

  if (segments[0] !== "properties" || !segments[1]) {
    return true;
  }

  if (segments.length === 2) {
    return hasAnyAppSectionPermission(args.user);
  }

  if (segments[2] === "settings") {
    return false;
  }

  if (segments[2] === "outlets" && segments[3]) {
    if (segments.length === 4) {
      return hasAppSectionPermission(args.user, "outletDashboards");
    }
    return hasAppSectionPermission(args.user, "controlManagement");
  }

  if (segments[2] === "warehouse" && segments[3] === "transfers") {
    if (hasAppSectionPermission(args.user, "controlManagement")) {
      return true;
    }
    return (
      hasAppSectionPermission(args.user, "outletDashboards") &&
      (method !== "GET" && method !== "HEAD" ? true : Boolean(searchParams?.get("fromOutletId")))
    );
  }

  if (segments[2] === "warehouse" && segments[3] === "purchases") {
    return hasAppSectionPermission(args.user, "controlManagement");
  }

  if (segments[2] === "suppliers" || segments[2] === "doses") {
    return hasAppSectionPermission(args.user, "controlManagement");
  }

  if (
    segments[2] === "analytics" ||
    segments[2] === "products" ||
    segments[2] === "costs" ||
    segments[2] === "sales" ||
    segments[2] === "inventory" ||
    segments[2] === "labor"
  ) {
    return hasAppSectionPermission(args.user, "controlManagement");
  }

  return hasAppSectionPermission(args.user, "controlManagement");
}
