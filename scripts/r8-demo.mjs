import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demo = join(root, "output/r8-demo");
const marker = join(demo, "SYNTHETIC-R8-DEMO");
const data = join(demo, "data");
const markerText = "Folio R8 synthetic demo\n";

// This launcher must never point Electron at a user workspace. The synthetic
// data directory is fixed under the repository's output directory.
if (!resolve(data).startsWith(resolve(root, "output") + sep))
  throw new Error("R8 demo data directory must stay under output/");

if (
  existsSync(demo) &&
  (!existsSync(marker) || readFileSync(marker, "utf8") !== markerText)
)
  throw new Error("Unrecognized demo directory; left unchanged");

mkdirSync(demo, { recursive: true });
if (existsSync(marker) && lstatSync(marker).isSymbolicLink())
  throw new Error("Synthetic marker must not be a symlink; left unchanged");
if (!existsSync(marker))
  writeFileSync(marker, markerText, { flag: "wx" });
if (existsSync(data) && lstatSync(data).isSymbolicLink())
  throw new Error("Synthetic data directory must not be a symlink");
mkdirSync(data, { recursive: true });
const outputRoot = realpathSync(join(root, "output"));
if (!realpathSync(data).startsWith(outputRoot + sep))
  throw new Error("R8 demo data directory resolves outside output/");

const require = createRequire(import.meta.url);
const database = join(data, "workspace.sqlite");
const manifest = join(demo, "manifest.json");
if (existsSync(database) && lstatSync(database).isSymbolicLink())
  throw new Error("Synthetic database must not be a symlink; left unchanged");
if (existsSync(manifest) && lstatSync(manifest).isSymbolicLink())
  throw new Error("Synthetic manifest must not be a symlink; left unchanged");
if (!existsSync(database)) {
  const seed = join(demo, "seed.cjs");
  buildSync({
    entryPoints: [join(root, "scripts/r7-demo-seed.ts")],
    outfile: seed,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  require(seed).seedDemo(
    database,
    manifest,
    join(root, "tests/fixtures/image.png"),
  );
}
if (!existsSync(manifest))
  throw new Error(
    "Synthetic R8 demo manifest is missing; remove output/r8-demo to reseed",
  );

console.log(`Synthetic R8 demo workspace: ${data}`);
console.log(`Synthetic R8 demo manifest: ${manifest}`);
if (!process.argv.includes("--prepare-only")) {
  if (!existsSync(join(root, "dist/main.cjs")))
    throw new Error("Build the R8 candidate before opening the demo");
  const env = { ...process.env, FOLIO_DATA_DIR: data };
  delete env.FOLIO_DEV_URL;
  const app = spawn(require("electron"), [join(root, "dist/main.cjs")], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  app.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
