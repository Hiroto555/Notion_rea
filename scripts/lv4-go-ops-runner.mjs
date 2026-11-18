// Fixture-only CLI: fresh temporary server per process, no persistent secrets.
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
if (process.argv.length > 2) {
  process.stderr.write("lv4-go-ops: arguments are not accepted\n");
  process.exitCode = 2;
} else {
  const root = mkdtempSync(join(tmpdir(), "folio-lv4-ops-bundle-"));
  try {
    const bundle = join(root, "ops.cjs");
    await build({entryPoints: ["src/sync/lv4-go-ops-cli.ts"], outfile: bundle, bundle: true, platform: "node", format: "cjs", logLevel: "silent"});
    const child = spawnSync(process.execPath, [bundle], {stdio: "inherit"});
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {rmSync(root, {recursive: true, force: true});}
}
