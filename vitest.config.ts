import { defineConfig } from "vitest/config";
export default defineConfig({
  cacheDir: process.env.FOLIO_VITE_CACHE_DIR || undefined,
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
