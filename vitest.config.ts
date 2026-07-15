import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // OIDC settings for tests: fake issuer served by fetchMock, and the
          // owner subject used by test/oidc-helpers.ts (TEST_ALLOWED_SUBJECT).
          AUTH_ISSUER: "https://sso.example.test",
          AUTH_CLIENT_ID: "pg72-diary",
          AUTH_ALLOWED_SUBJECT: "owner-subject-0000",
        },
      },
    })),
  ],
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
