import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const root = mkdtempSync(join(tmpdir(), "folio-lv4-go-capacity-bundle-"));
try {
  const bundle = join(root, "measure.cjs");
  await build({entryPoints: ["scripts/lv4-go-capacity-main.ts"], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent"});
  const child = spawnSync(process.execPath, [bundle], {stdio: "inherit"});
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} finally {rmSync(root, {recursive: true, force: true});}
