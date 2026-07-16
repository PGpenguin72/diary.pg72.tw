import { Hono } from "hono";
import { authGuard, type AuthVariables } from "./lib/auth/middleware";
import { apiError, noStore } from "./lib/http";
import { authRoutes } from "./routes/auth";
import { entryRoutes } from "./routes/entries";
import { importRoutes } from "./routes/imports";
import {
  cleanupExpiredMediaUploads,
  cleanupQueuedMedia,
  importMediaUploadRoutes,
} from "./routes/import-media-uploads";
import { overviewRoutes } from "./routes/overview";

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use("/api/*", async (context, next) => {
  noStore(context);
  await next();
});

app.use("/api/*", authGuard);

app.get("/api/health", (context) => {
  return context.json({ status: "ok", service: "diary-pg72-tw" });
});

app.route("/api", authRoutes);
app.route("/api", overviewRoutes);
app.route("/api", entryRoutes);
app.route("/api", importRoutes);
app.route("/api", importMediaUploadRoutes);

app.notFound((context) => apiError(context, 404, "NOT_FOUND", "找不到這個 API endpoint。"));

app.onError((error, context) => {
  console.error(
    JSON.stringify({
      message: "Unhandled API error",
      error: error instanceof Error ? error.message : "Unknown error",
      method: context.req.method,
      path: new URL(context.req.url).pathname,
    }),
  );
  return apiError(context, 500, "INTERNAL_ERROR", "暫時無法讀取日記。" );
});

export default {
  fetch: (request, env, context) => app.fetch(request, env, context),
  scheduled: (controller, env, context) => {
    context.waitUntil(
      cleanupExpiredMediaUploads(env, new Date(controller.scheduledTime))
        .then(async (uploadResult) => ({
          uploadResult,
          mediaResult: await cleanupQueuedMedia(env),
        }))
        .then((result) => console.info(JSON.stringify({
          event: "media_upload_cleanup_completed",
          ...result,
        })))
        .catch(() => console.error(JSON.stringify({
          event: "media_upload_cleanup_run_failed",
        }))),
    );
  },
} satisfies ExportedHandler<Env>;
