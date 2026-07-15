import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as oauth from "oauth4webapi";
import type { SessionResponse } from "../../shared/api";
import { apiError, noStore } from "../lib/http";
import {
  cookieNames,
  isLocalHost,
  LOGIN_TRANSACTION_TTL_SECONDS,
  PRODUCTION_ORIGIN,
  readAuthConfig,
  SESSION_TTL_SECONDS,
  type AuthConfig,
} from "../lib/auth/config";
import { clientAuth, clientMetadata, discover, requestOptions } from "../lib/auth/oidc";
import {
  createSession,
  deleteSessionByToken,
  deleteSessionsByCentralSid,
  deleteSessionsBySubject,
  findSessionByToken,
} from "../lib/auth/session";

interface LoginTransactionRow {
  id: string;
  state: string;
  code_verifier: string;
  nonce: string;
  redirect_uri: string;
}

const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
const LOGOUT_JTI_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// jose remote JWK sets cache fetched keys internally; keep one per jwks_uri.
const remoteJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function remoteJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = remoteJwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri), { timeoutDuration: 8_000 });
    remoteJwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

function logAuthEvent(event: string, error?: unknown, step?: string): void {
  // Never log tokens, claims, cookies, or user data here. Standard OAuth
  // error codes issued by our own IdP are safe diagnostics.
  const detail: Record<string, unknown> = { event, step };
  if (error instanceof oauth.ResponseBodyError) {
    detail.error = error.name;
    detail.oauthError = error.error;
    detail.oauthErrorDescription = error.error_description;
    detail.status = error.status;
  } else if (error instanceof oauth.WWWAuthenticateChallengeError) {
    detail.error = error.name;
    detail.status = error.status;
  } else if (error instanceof Error) {
    detail.error = error.name;
  } else if (error !== undefined) {
    detail.error = "UnknownError";
  }
  console.error(JSON.stringify(detail));
}

function callbackFailureRedirect(context: Context<{ Bindings: Env }>) {
  noStore(context);
  return context.redirect("/?authError=AUTH_CALLBACK_FAILED", 302);
}

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get("/auth/login", async (context) => {
  const config = readAuthConfig(context.env);
  if (!config) {
    return apiError(context, 500, "AUTH_NOT_CONFIGURED", "登入功能尚未設定完成。");
  }

  const url = new URL(context.req.url);
  const local = isLocalHost(url);
  if (!local && url.origin !== PRODUCTION_ORIGIN) {
    return apiError(context, 400, "INVALID_REDIRECT_ORIGIN", "登入請求的來源不正確。");
  }
  const redirectUri = `${url.origin}/api/auth/callback`;

  const authorizationServer = await discover(config);
  if (!authorizationServer.authorization_endpoint) {
    return apiError(context, 500, "AUTH_NOT_CONFIGURED", "登入功能尚未設定完成。");
  }

  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const transactionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOGIN_TRANSACTION_TTL_SECONDS * 1000);

  await context.env.DB.batch([
    context.env.DB.prepare(
      "DELETE FROM auth_login_transactions WHERE expires_at <= ?1 OR consumed_at IS NOT NULL",
    ).bind(now.toISOString()),
    context.env.DB.prepare(`
      INSERT INTO auth_login_transactions (
        id, state, code_verifier, nonce, redirect_uri, expires_at, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).bind(
      transactionId,
      state,
      codeVerifier,
      nonce,
      redirectUri,
      expiresAt.toISOString(),
      now.toISOString(),
    ),
  ]);

  const names = cookieNames(!local);
  setCookie(context, names.transaction, transactionId, {
    httpOnly: true,
    maxAge: LOGIN_TRANSACTION_TTL_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure: names.secure,
  });

  const authorizationUrl = new URL(authorizationServer.authorization_endpoint);
  authorizationUrl.searchParams.set("client_id", config.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("scope", "openid profile email");
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);

  noStore(context);
  return context.redirect(authorizationUrl.href, 302);
});

authRoutes.get("/auth/callback", async (context) => {
  const config = readAuthConfig(context.env);
  const url = new URL(context.req.url);
  const names = cookieNames(!isLocalHost(url));
  const transactionId = getCookie(context, names.transaction);
  deleteCookie(context, names.transaction, { path: "/", secure: names.secure });

  if (!config || !transactionId) {
    return callbackFailureRedirect(context);
  }

  const nowIso = new Date().toISOString();
  const transaction = await context.env.DB.prepare(`
    SELECT id, state, code_verifier, nonce, redirect_uri
    FROM auth_login_transactions
    WHERE id = ?1 AND consumed_at IS NULL AND expires_at > ?2
    LIMIT 1
  `)
    .bind(transactionId, nowIso)
    .first<LoginTransactionRow>();
  if (!transaction) {
    return callbackFailureRedirect(context);
  }

  // Single use: reject replays even under concurrent callbacks.
  const consumed = await context.env.DB.prepare(
    "UPDATE auth_login_transactions SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL",
  )
    .bind(nowIso, transaction.id)
    .run();
  if (consumed.meta.changes !== 1) {
    return callbackFailureRedirect(context);
  }

  let subject: string;
  let centralSid: string | null;
  let displayName: string | null;
  let email: string | null;
  let step = "discovery";
  try {
    const authorizationServer = await discover(config);
    const client = clientMetadata(config);
    step = "validate_auth_response";
    const callbackParameters = oauth.validateAuthResponse(
      authorizationServer,
      client,
      url,
      transaction.state,
    );

    step = "token_exchange";
    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      authorizationServer,
      client,
      clientAuth(config),
      callbackParameters,
      transaction.redirect_uri,
      transaction.code_verifier,
      requestOptions(),
    );
    step = "process_token_response";
    const tokens = await oauth.processAuthorizationCodeResponse(
      authorizationServer,
      client,
      tokenResponse,
      { expectedNonce: transaction.nonce, requireIdToken: true },
    );
    step = "validate_id_token_signature";
    await oauth.validateApplicationLevelSignature(
      authorizationServer,
      tokenResponse,
      requestOptions(),
    );

    const claims = oauth.getValidatedIdTokenClaims(tokens);
    if (!claims) {
      throw new Error("Validated ID token claims were not returned");
    }

    step = "userinfo";
    const userInfoResponse = await oauth.userInfoRequest(
      authorizationServer,
      client,
      tokens.access_token,
      requestOptions(),
    );
    const userInfo = await oauth.processUserInfoResponse(
      authorizationServer,
      client,
      claims.sub,
      userInfoResponse,
    );

    subject = claims.sub;
    centralSid = typeof claims.sid === "string" ? claims.sid : null;
    displayName = typeof userInfo.name === "string" ? userInfo.name : null;
    email = typeof userInfo.email === "string" ? userInfo.email : null;
    // Access and refresh tokens are intentionally not persisted.
  } catch (error) {
    logAuthEvent("auth_callback_failed", error, step);
    return callbackFailureRedirect(context);
  }

  // Owner gate / bootstrap: surface the sub without creating a session.
  if (!config.allowedSubject || subject !== config.allowedSubject) {
    noStore(context);
    return context.redirect(
      `/?authError=SUBJECT_NOT_ALLOWED&sub=${encodeURIComponent(subject)}`,
      302,
    );
  }

  const sessionToken = oauth.generateRandomState();
  await createSession(context.env.DB, {
    token: sessionToken,
    subject,
    centralSid,
    displayName,
    email,
  });

  setCookie(context, names.session, sessionToken, {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
    sameSite: "Lax",
    secure: names.secure,
  });

  noStore(context);
  return context.redirect("/", 303);
});

authRoutes.post("/auth/logout", async (context) => {
  const url = new URL(context.req.url);
  const origin = context.req.header("Origin");
  if (origin !== url.origin) {
    return apiError(context, 403, "INVALID_ORIGIN", "這個操作必須從日記網站本身發出。");
  }

  const names = cookieNames(!isLocalHost(url));
  const token = getCookie(context, names.session);
  if (token) {
    await deleteSessionByToken(context.env.DB, token);
  }
  deleteCookie(context, names.session, { path: "/", secure: names.secure });

  noStore(context);
  return context.body(null, 204);
});

authRoutes.get("/auth/session", async (context) => {
  const url = new URL(context.req.url);
  const local = isLocalHost(url);
  const config = readAuthConfig(context.env);
  const names = cookieNames(!local);
  const token = getCookie(context, names.session);

  let response: SessionResponse | null = null;
  if (token && config && config.allowedSubject) {
    const session = await findSessionByToken(context.env.DB, token);
    if (session && session.subject === config.allowedSubject) {
      response = {
        authenticated: true,
        canWrite: true,
        localBypass: false,
        user: { name: session.display_name, email: session.email },
      };
    }
  }

  if (!response) {
    response = local
      ? { authenticated: false, canWrite: true, localBypass: true, user: null }
      : { authenticated: false, canWrite: false, localBypass: false, user: null };
  }

  noStore(context);
  return context.json(response);
});

authRoutes.post("/auth/backchannel-logout", async (context) => {
  const config = readAuthConfig(context.env);
  if (!config) {
    return apiError(context, 500, "AUTH_NOT_CONFIGURED", "登出通知功能尚未設定完成。");
  }

  const body = await context.req.parseBody();
  const logoutToken = body["logout_token"];
  if (typeof logoutToken !== "string" || logoutToken.length === 0) {
    return apiError(context, 400, "INVALID_LOGOUT_TOKEN", "登出通知的內容不完整。");
  }

  const verified = await verifyLogoutToken(config, logoutToken);
  if (!verified) {
    return apiError(context, 400, "INVALID_LOGOUT_TOKEN", "登出通知驗證失敗。");
  }

  const now = new Date();
  // jti dedupe: a replay is acknowledged idempotently without acting again.
  const inserted = await context.env.DB.prepare(
    "INSERT OR IGNORE INTO auth_logout_jti (jti, seen_at) VALUES (?1, ?2)",
  )
    .bind(verified.jti, now.toISOString())
    .run();

  if (inserted.meta.changes === 1) {
    if (verified.sid) {
      await deleteSessionsByCentralSid(context.env.DB, verified.sid);
    } else if (verified.subject) {
      await deleteSessionsBySubject(context.env.DB, verified.subject);
    }
    const retentionCutoff = new Date(now.getTime() - LOGOUT_JTI_RETENTION_MS).toISOString();
    await context.env.DB.prepare("DELETE FROM auth_logout_jti WHERE seen_at < ?1")
      .bind(retentionCutoff)
      .run();
  }

  noStore(context);
  return context.body(null, 200);
});

interface VerifiedLogoutToken {
  jti: string;
  sid: string | null;
  subject: string | null;
}

/**
 * OIDC Back-Channel Logout 1.0 token validation via jose (oauth4webapi has no
 * logout token API). Returns null on any validation failure.
 */
async function verifyLogoutToken(
  config: AuthConfig,
  logoutToken: string,
): Promise<VerifiedLogoutToken | null> {
  try {
    const authorizationServer = await discover(config);
    if (!authorizationServer.jwks_uri) {
      return null;
    }

    const { payload } = await jwtVerify(logoutToken, remoteJwks(authorizationServer.jwks_uri), {
      algorithms: ["EdDSA"],
      audience: config.clientId,
      issuer: authorizationServer.issuer,
      requiredClaims: ["iss", "aud", "iat", "exp", "jti", "events"],
    });

    if ("nonce" in payload) {
      return null;
    }

    const events = payload.events;
    if (typeof events !== "object" || events === null || Array.isArray(events)) {
      return null;
    }
    const logoutEvent = (events as Record<string, unknown>)[BACKCHANNEL_LOGOUT_EVENT];
    if (typeof logoutEvent !== "object" || logoutEvent === null || Array.isArray(logoutEvent)) {
      return null;
    }

    const sid = typeof payload.sid === "string" && payload.sid.length > 0 ? payload.sid : null;
    const subject = typeof payload.sub === "string" && payload.sub.length > 0 ? payload.sub : null;
    if (!sid && !subject) {
      return null;
    }

    const jti = payload.jti;
    if (typeof jti !== "string" || jti.length === 0) {
      return null;
    }

    return { jti, sid, subject };
  } catch (error) {
    logAuthEvent("backchannel_logout_rejected", error);
    return null;
  }
}
