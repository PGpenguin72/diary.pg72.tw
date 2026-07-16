import type { Context, Env as HonoEnv, Input } from "hono";

export function noStore<E extends HonoEnv, P extends string, I extends Input>(
  context: Context<E, P, I>,
): void {
  context.header("Cache-Control", "private, no-store");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "no-referrer");
}

export function apiError<E extends HonoEnv, P extends string, I extends Input>(
  context: Context<E, P, I>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 500,
  code: string,
  message: string,
) {
  noStore(context);
  return context.json({ error: { code, message } }, status);
}
