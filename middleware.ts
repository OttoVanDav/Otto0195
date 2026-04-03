import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  APP_AUTH_DEFAULT_REDIRECT,
  APP_AUTH_SESSION_COOKIE,
  readAuthSession,
  resolveSafeRedirectPath,
} from "@/lib/app-auth";
import { canAccessAppRoute } from "@/lib/app-permissions";

const PUBLIC_FILE = /\.(.*)$/;

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api") ||
    pathname === "/favicon.ico" ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  const isLoginRoute = pathname === "/login";
  const forceLogin = request.nextUrl.searchParams.get("force") === "1";
  const sessionValue = request.cookies.get(APP_AUTH_SESSION_COOKIE)?.value;
  const session = await readAuthSession(sessionValue);
  const isAuthenticated = Boolean(session);

  if (!isAuthenticated && !isLoginRoute) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && isLoginRoute && !forceLogin) {
    const target = resolveSafeRedirectPath(request.nextUrl.searchParams.get("next") || APP_AUTH_DEFAULT_REDIRECT);
    return NextResponse.redirect(new URL(target, request.url));
  }

  if (session && !isLoginRoute) {
    const isAuthorized = canAccessAppRoute({
      user: session,
      pathname,
      searchParams: request.nextUrl.searchParams,
      method: request.method,
    });
    if (!isAuthorized) {
      return NextResponse.redirect(new URL(APP_AUTH_DEFAULT_REDIRECT, request.url));
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
