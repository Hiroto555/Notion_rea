import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const binary = resolve(
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
if (existsSync(binary)) {
  console.log("Electron binary is already available");
  process.exit(0);
}
const cache = resolve(".cache/electron");
mkdirSync(cache, { recursive: true });
const result = spawnSync(
  process.execPath,
  [resolve("node_modules/electron/install.js")],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_CACHE: cache,
      ELECTRON_SKIP_BINARY_DOWNLOAD: "",
    },
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(binary))
  throw new Error(
    "Electron installation did not produce the expected macOS binary",
  );
