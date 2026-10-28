import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demo = join(root, "output/r6-demo");
const marker = join(demo, "SYNTHETIC-R6-DEMO");
const data = join(demo, "data");
if (existsSync(demo) && (!existsSync(marker) || readFileSync(marker, "utf8") !== "Folio R6 synthetic demo\n"))
  throw new Error("Unrecognized demo directory; left unchanged");
mkdirSync(demo, { recursive: true });
if (!existsSync(marker)) writeFileSync(marker, "Folio R6 synthetic demo\n", { flag: "wx" });
mkdirSync(data, { recursive: true });
const require = createRequire(import.meta.url);
if (!existsSync(join(data, "workspace.sqlite"))) {
  const seed = join(demo, "seed.cjs");
  buildSync({ entryPoints: [join(root, "scripts/r6-demo-seed.ts")], outfile: seed, bundle: true, platform: "node", format: "cjs" });
  require(seed).seedDemo(join(data, "workspace.sqlite"));
}
console.log(`Synthetic demo workspace: ${data}`);
if (!process.argv.includes("--prepare-only")) {
  if (!existsSync(join(root, "dist/main.cjs"))) throw new Error("Build the R6 candidate before opening the demo");
  const env = { ...process.env, FOLIO_DATA_DIR: data };
  delete env.FOLIO_DEV_URL;
  const app = spawn(require("electron"), [join(root, "dist/main.cjs")], { cwd: root, env, stdio: "inherit" });
  app.on("exit", (code) => { process.exitCode = code ?? 1; });
}
