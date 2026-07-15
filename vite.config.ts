import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    cloudflare({
      persistState: mode === "e2e" ? { path: ".wrangler/e2e-state" } : true,
    }),
  ],
}));
