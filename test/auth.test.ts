import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256base64url } from "../worker/lib/auth/config";
import {
  createIssuerKeys,
  FakeIdp,
  signIdToken,
  signLogoutToken,
  TEST_ALLOWED_SUBJECT,
  TEST_CLIENT_ID,
  TEST_ISSUER,
  type IssuerKeys,
} from "./oidc-helpers";

const REMOTE_ORIGIN = "https://diary.pg72.tw";
const SESSION_COOKIE = "__Host-diary_session";
const TX_COOKIE = "__Host-diary_tx";

let keys: IssuerKeys;
let idp: FakeIdp;

beforeAll(async () => {
  keys = await createIssuerKeys();
  idp = new FakeIdp(keys);
  vi.stubGlobal("fetch", idp.fetch);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// Storage is isolated per test file, not per test: keep auth tables clean so
// row counting assertions stay deterministic.
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_sessions"),
    env.DB.prepare("DELETE FROM auth_login_transactions"),
    env.DB.prepare("DELETE FROM auth_logout_jti"),
  ]);
});

function remoteRequest(path: string, init?: RequestInit): Promise<Response> {
  // redirect: "manual" — the loopback fetcher would otherwise follow 302/303
  // responses back into this Worker.
  return exports.default.fetch(
    new Request(`${REMOTE_ORIGIN}${path}`, { redirect: "manual", ...init }),
  );
}

function setCookieValue(response: Response, name: string): string {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${name}=`)) {
      return cookie.slice(name.length + 1).split(";")[0] ?? "";
    }
  }
  throw new Error(`Set-Cookie for ${name} was not found`);
}

interface InsertSessionInput {
  subject?: string;
  centralSid?: string | null;
  expiresAt?: string;
  displayName?: string;
  email?: string;
}

async function insertSession(input: InsertSessionInput = {}): Promise<string> {
  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`
    INSERT INTO auth_sessions (
      id, token_hash, subject, central_sid, display_name, email,
      created_at, last_seen_at, expires_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)
  `)
    .bind(
      crypto.randomUUID(),
      await sha256base64url(token),
      input.subject ?? TEST_ALLOWED_SUBJECT,
      input.centralSid ?? null,
      input.displayName ?? "測試擁有者",
      input.email ?? "owner@example.test",
      now.toISOString(),
      expiresAt,
    )
    .run();
  return token;
}

async function countSessions(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM auth_sessions").first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

async function expectErrorCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const payload = await response.json<{ error: { code: string } }>();
  expect(payload.error.code).toBe(code);
}

describe("session cookie guard", () => {
  it("keeps remote reads public with or without a session cookie", async () => {
    const anonymous = await remoteRequest("/api/entries");
    expect(anonymous.status).toBe(200);

    const token = await insertSession();
    const withSession = await remoteRequest("/api/entries", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(withSession.status).toBe(200);
  });

  it("rejects a remote mutation with an expired session with 401", async () => {
    const token = await insertSession({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const response = await remoteRequest("/api/entries", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: REMOTE_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    await expectErrorCode(response, 401, "AUTH_REQUIRED");
  });

  it("rejects a remote mutation for a different subject with 403", async () => {
    const token = await insertSession({ subject: "someone-else-9999" });
    const response = await remoteRequest("/api/entries", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: REMOTE_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    await expectErrorCode(response, 403, "SUBJECT_NOT_ALLOWED");
  });

  it("rejects a remote mutation without an Origin header", async () => {
    const token = await insertSession();
    const response = await remoteRequest("/api/entries", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    await expectErrorCode(response, 403, "INVALID_ORIGIN");
  });

  it("rejects a remote mutation with a cross-site Origin header", async () => {
    const token = await insertSession();
    const response = await remoteRequest("/api/entries", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    await expectErrorCode(response, 403, "INVALID_ORIGIN");
  });

  it("allows a remote mutation with a valid session and same-origin header", async () => {
    const token = await insertSession();
    const response = await remoteRequest("/api/entries", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: REMOTE_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "遠端登入後的日記",
        body: "透過 PG72 ID session 建立。",
        occurredAt: "2026-07-15T04:00:00.000Z",
        timezone: "Asia/Taipei",
        localDate: "2026-07-15",
        location: null,
        mood: null,
      }),
    });
    expect(response.status).toBe(201);
  });

  it("protects multipart media init, part, and complete with the owner session and Origin", async () => {
    const localStart = await exports.default.fetch(
      new Request("http://localhost/api/imports/apple-journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: "SyntheticAuthArchive.zip",
          fileFingerprint: "d".repeat(64),
          entryCount: 1,
          mediaCount: 1,
        }),
      }),
    );
    const importJob = await localStart.json<{ id: string }>();
    const localEntry = await exports.default.fetch(
      new Request(`http://localhost/api/imports/apple-journal/${importJob.id}/entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePath: "Synthetic/Entries/auth.html",
          mediaCount: 1,
          title: "合成授權測試",
          body: "不含私人資料的測試內容。",
          occurredAt: "2026-07-17T00:00:00.000Z",
          timezone: "Asia/Taipei",
          localDate: "2026-07-17",
          location: null,
          mood: null,
        }),
      }),
    );
    const entry = await localEntry.json<{ id: string; generationId: string }>();
    const base = `/api/imports/apple-journal/${importJob.id}/entries/${entry.id}/media/uploads`;
    const initBody = JSON.stringify({
      generationId: entry.generationId,
      fingerprint: "e".repeat(64),
      sourcePath: "Synthetic/Resources/auth.png",
      type: "photo",
      mimeType: "image/png",
      sizeBytes: 8,
      position: 0,
      placement: "cover",
      caption: "",
    });

    const denied = await remoteRequest(base, {
      method: "POST",
      headers: { Origin: REMOTE_ORIGIN, "Content-Type": "application/json" },
      body: initBody,
    });
    await expectErrorCode(denied, 401, "AUTH_REQUIRED");

    const token = await insertSession();
    const authHeaders = {
      Cookie: `${SESSION_COOKIE}=${token}`,
      Origin: REMOTE_ORIGIN,
    };
    const startedResponse = await remoteRequest(base, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: initBody,
    });
    expect(startedResponse.status).toBe(201);
    const started = await startedResponse.json<{ id: string }>();
    const partPath = `${base}/${started.id}/parts/1`;
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const crossSite = await remoteRequest(partPath, {
      method: "PUT",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: "https://cross-site.example",
        "Content-Type": "image/png",
        "X-Media-Size": "8",
      },
      body: png,
    });
    await expectErrorCode(crossSite, 403, "INVALID_ORIGIN");

    const uploaded = await remoteRequest(partPath, {
      method: "PUT",
      headers: {
        ...authHeaders,
        "Content-Type": "image/png",
        "X-Media-Size": "8",
      },
      body: png,
    });
    expect(uploaded.status).toBe(201);
    const completed = await remoteRequest(`${base}/${started.id}/complete`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(completed.status).toBe(201);
    const media = await env.DB.prepare(`SELECT owner_subject, status FROM media WHERE id = ?1`)
      .bind(started.id)
      .first<{ owner_subject: string; status: string }>();
    expect(media).toEqual({ owner_subject: TEST_ALLOWED_SUBJECT, status: "ready" });
  });

  it("reports an authenticated remote session with user info", async () => {
    const token = await insertSession({ displayName: "PG", email: "pg@example.test" });
    const response = await remoteRequest("/api/auth/session", {
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      canWrite: true,
      localBypass: false,
      user: { name: "PG", email: "pg@example.test" },
    });
  });

  it("reports the localhost bypass on the local session endpoint", async () => {
    const response = await exports.default.fetch(
      new Request("http://localhost/api/auth/session"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: false,
      canWrite: true,
      localBypass: true,
      user: null,
    });
  });
});

describe("login and callback flow", () => {
  it("starts a login with PKCE state, nonce, and a transaction cookie", async () => {
    const response = await remoteRequest("/api/auth/login");
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.origin).toBe(TEST_ISSUER);
    expect(location.pathname).toBe("/oauth2/authorize");
    expect(location.searchParams.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${REMOTE_ORIGIN}/api/auth/callback`,
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("openid profile email");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("nonce")).toBeTruthy();

    const transactionId = setCookieValue(response, TX_COOKIE);
    const row = await env.DB.prepare(
      "SELECT state, nonce FROM auth_login_transactions WHERE id = ?1",
    )
      .bind(transactionId)
      .first<{ state: string; nonce: string }>();
    expect(row?.state).toBe(location.searchParams.get("state"));
    expect(row?.nonce).toBe(location.searchParams.get("nonce"));
  });

  it("rejects a login started from an unexpected origin", async () => {
    const response = await exports.default.fetch(
      new Request("https://evil.example/api/auth/login"),
    );
    await expectErrorCode(response, 400, "INVALID_REDIRECT_ORIGIN");
  });

  it("completes the full code+PKCE flow and creates a hashed session", async () => {
    const loginResponse = await remoteRequest("/api/auth/login");
    const location = new URL(loginResponse.headers.get("Location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const nonce = location.searchParams.get("nonce") ?? "";
    const transactionId = setCookieValue(loginResponse, TX_COOKIE);

    const idToken = await signIdToken(keys, {
      sub: TEST_ALLOWED_SUBJECT,
      nonce,
      sid: "central-sid-1",
    });
    idp.queueTokenResponse(idToken);
    idp.queueUserInfo({
      sub: TEST_ALLOWED_SUBJECT,
      name: "測試擁有者",
      email: "owner@example.test",
    });

    const callbackResponse = await remoteRequest(
      `/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `${TX_COOKIE}=${transactionId}` } },
    );
    expect(callbackResponse.status).toBe(303);
    expect(callbackResponse.headers.get("Location")).toBe("/");

    const sessionToken = setCookieValue(callbackResponse, SESSION_COOKIE);
    expect(sessionToken.length).toBeGreaterThan(20);
    const sessionCookie = callbackResponse.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Path=/");

    const row = await env.DB.prepare(
      "SELECT token_hash, subject, central_sid, display_name, email FROM auth_sessions",
    ).first<{
      token_hash: string;
      subject: string;
      central_sid: string | null;
      display_name: string | null;
      email: string | null;
    }>();
    expect(row?.token_hash).toBe(await sha256base64url(sessionToken));
    expect(row?.subject).toBe(TEST_ALLOWED_SUBJECT);
    expect(row?.central_sid).toBe("central-sid-1");
    expect(row?.display_name).toBe("測試擁有者");
    expect(row?.email).toBe("owner@example.test");

    const sessionResponse = await remoteRequest("/api/auth/session", {
      headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(await sessionResponse.json()).toMatchObject({
      authenticated: true,
      canWrite: true,
      localBypass: false,
    });

    const dataResponse = await remoteRequest("/api/entries", {
      headers: { Cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(dataResponse.status).toBe(200);
  });

  it("redirects with the sub and creates no session for a disallowed subject", async () => {
    const loginResponse = await remoteRequest("/api/auth/login");
    const location = new URL(loginResponse.headers.get("Location") ?? "");
    const state = location.searchParams.get("state") ?? "";
    const nonce = location.searchParams.get("nonce") ?? "";
    const transactionId = setCookieValue(loginResponse, TX_COOKIE);

    const idToken = await signIdToken(keys, { sub: "intruder-subject-1", nonce });
    idp.queueTokenResponse(idToken);
    idp.queueUserInfo({ sub: "intruder-subject-1" });

    const callbackResponse = await remoteRequest(
      `/api/auth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `${TX_COOKIE}=${transactionId}` } },
    );
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("Location")).toBe("/?authError=SUBJECT_NOT_ALLOWED");
    expect(await countSessions()).toBe(0);
  });

  it("redirects to the callback failure state without a transaction cookie", async () => {
    const response = await remoteRequest("/api/auth/callback?code=x&state=y");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/?authError=AUTH_CALLBACK_FAILED");
  });
});

describe("back-channel logout", () => {
  function postLogoutToken(logoutToken: string): Promise<Response> {
    return remoteRequest("/api/auth/backchannel-logout", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: logoutToken }).toString(),
    });
  }

  it("deletes sessions by central sid and treats jti replays as idempotent", async () => {
    await insertSession({ centralSid: "central-sid-9" });
    const logoutToken = await signLogoutToken(keys, {
      jti: "logout-jti-1",
      sub: TEST_ALLOWED_SUBJECT,
      sid: "central-sid-9",
    });

    const firstResponse = await postLogoutToken(logoutToken);
    expect(firstResponse.status).toBe(200);
    expect(await countSessions()).toBe(0);

    // Replay with the same jti must be acknowledged without acting again.
    await insertSession({ centralSid: "central-sid-9" });
    const replayResponse = await postLogoutToken(logoutToken);
    expect(replayResponse.status).toBe(200);
    expect(await countSessions()).toBe(1);
  });

  it("deletes sessions by subject when the logout token has no sid", async () => {
    await insertSession({ centralSid: null });
    const logoutToken = await signLogoutToken(keys, {
      jti: "logout-jti-2",
      sub: TEST_ALLOWED_SUBJECT,
    });

    const response = await postLogoutToken(logoutToken);
    expect(response.status).toBe(200);
    expect(await countSessions()).toBe(0);
  });

  it("rejects a logout token without the backchannel-logout event", async () => {
    const logoutToken = await signLogoutToken(keys, {
      jti: "logout-jti-3",
      sub: TEST_ALLOWED_SUBJECT,
      includeEvents: false,
    });
    const response = await postLogoutToken(logoutToken);
    await expectErrorCode(response, 400, "INVALID_LOGOUT_TOKEN");
  });

  it("rejects a logout token that contains a nonce", async () => {
    const logoutToken = await signLogoutToken(keys, {
      jti: "logout-jti-4",
      sub: TEST_ALLOWED_SUBJECT,
      includeNonce: true,
    });
    const response = await postLogoutToken(logoutToken);
    await expectErrorCode(response, 400, "INVALID_LOGOUT_TOKEN");
  });

  it("rejects a malformed logout token", async () => {
    const response = await postLogoutToken("not-a-jwt");
    await expectErrorCode(response, 400, "INVALID_LOGOUT_TOKEN");
  });
});

describe("logout", () => {
  it("deletes the session row and clears the cookie", async () => {
    const token = await insertSession();
    const response = await remoteRequest("/api/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `${SESSION_COOKIE}=${token}`,
        Origin: REMOTE_ORIGIN,
      },
    });
    expect(response.status).toBe(204);
    expect(await countSessions()).toBe(0);
    const cleared = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
    expect(cleared).toContain("Max-Age=0");
  });

  it("rejects a logout without a same-origin header", async () => {
    const token = await insertSession();
    const response = await remoteRequest("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    await expectErrorCode(response, 403, "INVALID_ORIGIN");
    expect(await countSessions()).toBe(1);
  });
});

describe("confidential client authentication", () => {
  it("sends raw base64 basic credentials for Better Auth interop", async () => {
    // PG72 ID decodes the Basic header without form-url decoding, so the
    // credentials must not be RFC 6749 §2.3.1 percent-encoded ("-" and "_"
    // would become %2D / %5F and the IdP would reject the client).
    const { clientAuth } = await import("../worker/lib/auth/oidc");
    const config = {
      issuer: new URL(TEST_ISSUER),
      clientId: TEST_CLIENT_ID,
      clientSecret: "pg72_cs_raw-secret_value",
      allowedSubject: TEST_ALLOWED_SUBJECT,
    };

    const headers = new Headers();
    await clientAuth(config)(
      { issuer: TEST_ISSUER },
      { client_id: TEST_CLIENT_ID },
      new URLSearchParams(),
      headers,
    );

    expect(headers.get("authorization")).toBe(
      `Basic ${btoa(`${TEST_CLIENT_ID}:pg72_cs_raw-secret_value`)}`,
    );
  });
});
