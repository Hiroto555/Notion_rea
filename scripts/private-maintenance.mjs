import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Build this headless maintenance entry in an owned temporary directory.
// Native configuration is selected only after explicit command parsing.
const scratch = mkdtempSync(join(tmpdir(), "folio-private-maintenance-"));
try {
  const bundle = join(scratch, "private-maintenance.cjs");
  await build({
    entryPoints: [resolve("src/platform/windows/private-maintenance-cli.ts")],
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
