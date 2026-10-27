import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  cacheDir: process.env.FOLIO_VITE_CACHE_DIR || undefined,
  plugins: [react()],
  base: "./",
  build: { outDir: "dist/renderer" },
  server: { host: "127.0.0.1", port: Number(process.env.FOLIO_DEV_PORT || 5173), strictPort: true },
});
