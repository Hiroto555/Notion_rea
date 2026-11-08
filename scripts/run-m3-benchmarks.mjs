import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Fixed Node-only programs; no Electron, browser or configurable shell command.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selection = process.argv.slice(2);
if (selection.length !== 1 || !["scale", "recovery", "all"].includes(selection[0])) {
  console.error("Usage: node scripts/run-m3-benchmarks.mjs scale|recovery|all");
  process.exitCode = 2;
} else {
  const programs = selection[0] === "all" ? ["scale", "recovery"] : selection;
  for (const name of programs) {
    const temporary = mkdtempSync(join(tmpdir(), "folio-m3-benchmark-build-"));
    try {
      const output = join(temporary, "benchmark.cjs");
      buildSync({entryPoints: [join(root, `tests/benchmarks/m3-${name}.ts`)], outfile: output,
        bundle: true, platform: "node", format: "cjs", external: ["node:sqlite"], logLevel: "silent"});
      const result = spawnSync(process.execPath, ["--max-old-space-size=768", output], {
        cwd: root, stdio: "inherit", shell: false, timeout: 180_000,
      });
      if (result.error || result.signal || result.status !== 0) {
        console.error(`M3 ${name} benchmark failed`);
        process.exitCode = result.status || 1;
        break;
      }
    } finally {
      rmSync(temporary, {recursive: true, force: true});
    }
  }
}
