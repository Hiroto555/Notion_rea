import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// The emergency entry builds only its headless CLI, even when Folio's UI fails
// to start. Workspace/destination paths are always explicit command arguments.
const scratch = mkdtempSync(join(tmpdir(), "folio-rescue-cli-"));
try {
  const bundle = join(scratch, "raw-rescue.cjs");
  await build({
    entryPoints: [resolve("src/main/raw-rescue-cli.ts")],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["node:sqlite"],
  });
  const result = spawnSync(
    process.execPath,
    [bundle, ...process.argv.slice(2)],
    { stdio: "inherit", shell: false },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
