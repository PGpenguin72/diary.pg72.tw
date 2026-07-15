import { Hono } from "hono";
import { apiError, noStore } from "./lib/http";
import { entryRoutes } from "./routes/entries";
import { importRoutes } from "./routes/imports";
import { overviewRoutes } from "./routes/overview";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", async (context, next) => {
  noStore(context);
  await next();
});

app.get("/api/health", (context) => {
  return context.json({ status: "ok", service: "diary-pg72-tw" });
});

app.route("/api", overviewRoutes);
app.route("/api", entryRoutes);
app.route("/api", importRoutes);

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

export default app;
