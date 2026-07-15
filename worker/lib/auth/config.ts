export interface AuthConfig {
  issuer: URL;
  clientId: string;
  clientSecret: string | null;
  /** Owner OIDC subject allowlist. Empty string while bootstrapping. */
  allowedSubject: string;
}

/** Origins allowed to start a login (anti Host-header manipulation). */
export const PRODUCTION_ORIGIN = "https://diary.pg72.tw";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const LOGIN_TRANSACTION_TTL_SECONDS = 10 * 60;

/**
 * Local development bypass. Keeps the exact hostname semantics of the removed
 * worker/lib/write-access.ts.
 */
export function isLocalHost(url: URL): boolean {
  const hostname = url.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Reads and validates OIDC settings from env. Returns null when the Worker is
 * not configured; callers must fail closed on null.
 */
export function readAuthConfig(env: Env): AuthConfig | null {
  const issuerRaw = typeof env.AUTH_ISSUER === "string" ? env.AUTH_ISSUER.trim() : "";
  const clientId = typeof env.AUTH_CLIENT_ID === "string" ? env.AUTH_CLIENT_ID.trim() : "";
  if (!issuerRaw || !clientId) {
    return null;
  }

  let issuer: URL;
  try {
    issuer = new URL(issuerRaw);
  } catch {
    return null;
  }
  if (issuer.origin !== issuerRaw || issuer.protocol !== "https:") {
    return null;
  }

  const clientSecret =
    typeof env.AUTH_CLIENT_SECRET === "string" && env.AUTH_CLIENT_SECRET.trim().length > 0
      ? env.AUTH_CLIENT_SECRET.trim()
      : null;
  const allowedSubject =
    typeof env.AUTH_ALLOWED_SUBJECT === "string" ? env.AUTH_ALLOWED_SUBJECT.trim() : "";

  return { issuer, clientId, clientSecret, allowedSubject };
}

export interface AuthCookieNames {
  secure: boolean;
  session: string;
  transaction: string;
}

/**
 * `__Host-` prefixed cookies on HTTPS; plain names without Secure for the
 * localhost HTTP dev server.
 */
export function cookieNames(secure: boolean): AuthCookieNames {
  return {
    secure,
    session: secure ? "__Host-diary_session" : "diary_session",
    transaction: secure ? "__Host-diary_tx" : "diary_tx",
  };
}

/** SHA-256 digest encoded as base64url without padding. */
export async function sha256base64url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
