import { SESSION_TTL_SECONDS, sha256base64url } from "./config";

export interface SessionRow {
  id: string;
  subject: string;
  central_sid: string | null;
  display_name: string | null;
  email: string | null;
  expires_at: string;
  last_seen_at: string;
}

const LAST_SEEN_BUMP_MS = 60 * 60 * 1000;

export interface CreateSessionInput {
  token: string;
  subject: string;
  centralSid: string | null;
  displayName: string | null;
  email: string | null;
}

/**
 * Stores only the SHA-256 hash of the session token, with a 7 day absolute
 * expiry. Opportunistically deletes expired sessions in the same batch.
 */
export async function createSession(database: D1Database, input: CreateSessionInput): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const tokenHash = await sha256base64url(input.token);

  await database.batch([
    database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?1").bind(nowIso),
    database
      .prepare(`
        INSERT INTO auth_sessions (
          id, token_hash, subject, central_sid, display_name, email,
          created_at, last_seen_at, expires_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)
      `)
      .bind(
        crypto.randomUUID(),
        tokenHash,
        input.subject,
        input.centralSid,
        input.displayName,
        input.email,
        nowIso,
        expiresAt,
      ),
  ]);
}

/** Looks up a live session by raw token. Bumps last_seen_at at most hourly. */
export async function findSessionByToken(
  database: D1Database,
  token: string,
): Promise<SessionRow | null> {
  const tokenHash = await sha256base64url(token);
  const now = new Date();
  const session = await database
    .prepare(`
      SELECT id, subject, central_sid, display_name, email, expires_at, last_seen_at
      FROM auth_sessions
      WHERE token_hash = ?1 AND expires_at > ?2
      LIMIT 1
    `)
    .bind(tokenHash, now.toISOString())
    .first<SessionRow>();

  if (!session) {
    return null;
  }

  const lastSeenMs = Date.parse(session.last_seen_at);
  if (!Number.isFinite(lastSeenMs) || now.getTime() - lastSeenMs >= LAST_SEEN_BUMP_MS) {
    await database
      .prepare("UPDATE auth_sessions SET last_seen_at = ?2 WHERE id = ?1")
      .bind(session.id, now.toISOString())
      .run();
  }

  return session;
}

export async function deleteSessionByToken(database: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256base64url(token);
  await database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?1").bind(tokenHash).run();
}

export async function deleteSessionsByCentralSid(
  database: D1Database,
  centralSid: string,
): Promise<void> {
  await database
    .prepare("DELETE FROM auth_sessions WHERE central_sid = ?1")
    .bind(centralSid)
    .run();
}

export async function deleteSessionsBySubject(database: D1Database, subject: string): Promise<void> {
  await database.prepare("DELETE FROM auth_sessions WHERE subject = ?1").bind(subject).run();
}
