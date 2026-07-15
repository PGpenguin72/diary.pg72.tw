import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5187",
    channel: process.env.CI ? undefined : "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
      },
    },
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        channel: process.env.CI ? undefined : "chrome",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
      },
      grepInvert: /@desktop/,
    },
  ],
  webServer: {
    command: "pnpm dev --mode e2e --host 127.0.0.1 --port 5187 --strictPort",
    url: "http://127.0.0.1:5187/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
