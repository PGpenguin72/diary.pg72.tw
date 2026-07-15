import * as oauth from "oauth4webapi";
import type { AuthConfig } from "./config";

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8_000;

interface DiscoveryCache {
  issuer: string;
  authorizationServer: oauth.AuthorizationServer;
  fetchedAt: number;
}

let discoveryCache: DiscoveryCache | null = null;

export function requestOptions(): { signal: AbortSignal } {
  return { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

/** OIDC discovery with a short module-level cache to avoid a round-trip per login. */
export async function discover(config: AuthConfig): Promise<oauth.AuthorizationServer> {
  const now = Date.now();
  if (
    discoveryCache &&
    discoveryCache.issuer === config.issuer.href &&
    now - discoveryCache.fetchedAt < DISCOVERY_TTL_MS
  ) {
    return discoveryCache.authorizationServer;
  }

  const response = await oauth.discoveryRequest(config.issuer, {
    algorithm: "oidc",
    ...requestOptions(),
  });
  const authorizationServer = await oauth.processDiscoveryResponse(config.issuer, response);
  discoveryCache = { issuer: config.issuer.href, authorizationServer, fetchedAt: now };
  return authorizationServer;
}

export function clientMetadata(config: AuthConfig): oauth.Client {
  return {
    client_id: config.clientId,
    token_endpoint_auth_method: config.clientSecret ? "client_secret_basic" : "none",
    id_token_signed_response_alg: "EdDSA",
  };
}

/**
 * client_secret_basic with raw (unencoded) credentials. PG72 ID (Better Auth)
 * base64-decodes the Basic header without form-url decoding, so the RFC 6749
 * §2.3.1 percent-encoding applied by oauth.ClientSecretBasic turns
 * "pg72-diary" into "pg72%2Ddiary" and the IdP rejects it as invalid_client.
 */
function clientSecretBasicRaw(clientSecret: string): oauth.ClientAuth {
  return (_authorizationServer, client, _body, headers) => {
    headers.set("authorization", `Basic ${btoa(`${client.client_id}:${clientSecret}`)}`);
  };
}

/** Confidential client when the secret is configured, public client otherwise. */
export function clientAuth(config: AuthConfig): oauth.ClientAuth {
  return config.clientSecret ? clientSecretBasicRaw(config.clientSecret) : oauth.None();
}
