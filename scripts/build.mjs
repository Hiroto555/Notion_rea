import { build } from "esbuild";
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "node:sqlite"],
  sourcemap: true,
});
await build({
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});

await build({
  entryPoints: ["src/main/storage-overview-worker.ts"],
  outfile: "dist/storage-overview-worker.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["node:sqlite"],
});

await build({
  entryPoints: ["src/main/raw-rescue-cli.ts"],
  outfile: "dist/raw-rescue.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["node:sqlite"],
});

await build({
  entryPoints: ["src/sync/server-ops-cli.ts"],
  outfile: "dist/server-ops.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["node:sqlite"],
});
