import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

/** Must match the AUTH_* miniflare bindings in vitest.config.ts. */
export const TEST_ISSUER = "https://sso.example.test";
export const TEST_CLIENT_ID = "pg72-diary";
export const TEST_ALLOWED_SUBJECT = "owner-subject-0000";

export const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

const TEST_KID = "diary-test-oidc-key";

export interface IssuerKeys {
  publicJwk: JWK;
  privateKey: CryptoKey;
}

/** In-test Ed25519 keypair; workerd WebCrypto supports Ed25519 natively. */
export async function createIssuerKeys(): Promise<IssuerKeys> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = TEST_KID;
  publicJwk.alg = "EdDSA";
  publicJwk.use = "sig";
  return { publicJwk, privateKey };
}

export function discoveryDocument(): Record<string, unknown> {
  return {
    issuer: TEST_ISSUER,
    authorization_endpoint: `${TEST_ISSUER}/oauth2/authorize`,
    token_endpoint: `${TEST_ISSUER}/oauth2/token`,
    userinfo_endpoint: `${TEST_ISSUER}/oauth2/userinfo`,
    jwks_uri: `${TEST_ISSUER}/.well-known/jwks.json`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    id_token_signing_alg_values_supported: ["EdDSA"],
    subject_types_supported: ["public"],
  };
}

export interface IdTokenClaims {
  sub: string;
  nonce: string;
  sid?: string;
}

export async function signIdToken(keys: IssuerKeys, claims: IdTokenClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce: claims.nonce, ...(claims.sid ? { sid: claims.sid } : {}) })
    .setProtectedHeader({ alg: "EdDSA", kid: TEST_KID })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_CLIENT_ID)
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(keys.privateKey);
}

export interface LogoutTokenOptions {
  jti: string;
  sub?: string;
  sid?: string;
  includeEvents?: boolean;
  includeNonce?: boolean;
}

export async function signLogoutToken(
  keys: IssuerKeys,
  options: LogoutTokenOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {};
  if (options.includeEvents !== false) {
    payload.events = { [BACKCHANNEL_LOGOUT_EVENT]: {} };
  }
  if (options.includeNonce) {
    payload.nonce = "nonce-must-be-rejected";
  }
  if (options.sid) {
    payload.sid = options.sid;
  }

  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: TEST_KID, typ: "logout+jwt" })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_CLIENT_ID)
    .setJti(options.jti)
    .setIssuedAt(now)
    .setExpirationTime(now + 120);
  if (options.sub) {
    builder = builder.setSubject(options.sub);
  }
  return builder.sign(keys.privateKey);
}

export interface UserInfoBody {
  sub: string;
  name?: string;
  email?: string;
}

/**
 * Minimal fake PG72 ID issuer served through a stubbed global fetch
 * (`vi.stubGlobal("fetch", idp.fetch)`). oauth4webapi and jose both resolve
 * the global fetch at call time, so this intercepts discovery, JWKS, token,
 * and userinfo requests. Any other outbound request fails the test.
 *
 * Discovery and JWKS are stateless; token and userinfo replies are one-shot
 * queues so each callback test controls exactly what the IdP returns.
 */
export class FakeIdp {
  private tokenQueue: string[] = [];
  private userInfoQueue: UserInfoBody[] = [];

  constructor(private readonly keys: IssuerKeys) {}

  queueTokenResponse(idToken: string): void {
    this.tokenQueue.push(idToken);
  }

  queueUserInfo(userInfo: UserInfoBody): void {
    this.userInfoQueue.push(userInfo);
  }

  readonly fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return Promise.resolve(this.handle(new Request(input, init)));
  };

  private handle(request: Request): Response {
    const url = new URL(request.url);
    if (url.origin !== TEST_ISSUER) {
      throw new Error(`Unexpected outbound request in test: ${url.origin}${url.pathname}`);
    }

    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return Response.json(discoveryDocument());
    }
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return Response.json({ keys: [this.keys.publicJwk] });
    }
    if (request.method === "POST" && url.pathname === "/oauth2/token") {
      const idToken = this.tokenQueue.shift();
      if (!idToken) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({
        access_token: "pg72_at_test-token",
        token_type: "bearer",
        expires_in: 600,
        scope: "openid profile email",
        id_token: idToken,
      });
    }
    if (request.method === "GET" && url.pathname === "/oauth2/userinfo") {
      const userInfo = this.userInfoQueue.shift();
      if (!userInfo) {
        return new Response("no queued userinfo reply", { status: 500 });
      }
      return Response.json(userInfo);
    }

    return new Response("not found", { status: 404 });
  }
}
