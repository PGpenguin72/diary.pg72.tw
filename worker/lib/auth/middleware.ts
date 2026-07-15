import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { apiError } from "../http";
import { cookieNames, isLocalHost, readAuthConfig } from "./config";
import { findSessionByToken } from "./session";

export type AuthState =
  | { mode: "local" }
  | { mode: "public" }
  | { mode: "session"; subject: string; sid: string | null };

export interface AuthVariables {
  auth: AuthState;
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Guards /api mutations. Reads are deliberately public — the owner chose to
 * share the diary read-only — while every state-changing request requires a
 * valid PG72 ID session bound to the configured owner subject. Auth routes
 * and the health check stay open, localhost keeps its explicit dev bypass.
 */
export const authGuard = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(
  async (context, next) => {
    const url = new URL(context.req.url);
    if (url.pathname === "/api/health" || url.pathname.startsWith("/api/auth/")) {
      await next();
      return;
    }

    if (isLocalHost(url)) {
      context.set("auth", { mode: "local" });
      await next();
      return;
    }

    if (!MUTATING_METHODS.has(context.req.method)) {
      context.set("auth", { mode: "public" });
      await next();
      return;
    }

    // Fail closed when OIDC settings are missing on a remote hostname.
    const config = readAuthConfig(context.env);
    if (!config) {
      return apiError(context, 401, "AUTH_REQUIRED", "需要先使用 PG72 ID 登入。");
    }

    const names = cookieNames(true);
    const token = getCookie(context, names.session);
    if (!token) {
      return apiError(context, 401, "AUTH_REQUIRED", "需要先使用 PG72 ID 登入。");
    }

    const session = await findSessionByToken(context.env.DB, token);
    if (!session) {
      return apiError(context, 401, "AUTH_REQUIRED", "需要先使用 PG72 ID 登入。");
    }

    if (!config.allowedSubject || session.subject !== config.allowedSubject) {
      return apiError(context, 403, "SUBJECT_NOT_ALLOWED", "這個帳號沒有權限使用這本日記。");
    }

    // CSRF second layer (first is SameSite=Lax): remote mutations must come
    // from the site itself.
    const origin = context.req.header("Origin");
    if (origin !== url.origin) {
      return apiError(context, 403, "INVALID_ORIGIN", "這個操作必須從日記網站本身發出。");
    }

    context.set("auth", { mode: "session", subject: session.subject, sid: session.central_sid });
    await next();
  },
);
