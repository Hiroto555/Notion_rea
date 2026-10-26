import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const args = process.argv.slice(2),
  source = args[args.indexOf("--source") + 1],
  destination = args[args.indexOf("--destination") + 1];
if (
  !args.includes("--source") ||
  !args.includes("--destination") ||
  !source ||
  !destination
)
  throw new Error(
    "Usage: node scripts/migrate-workspace.mjs --source OLD_DIRECTORY --destination NEW_DIRECTORY",
  );
const temporary = mkdtempSync(join(tmpdir(), "folio-migrate-"));
try {
  const bundle = join(temporary, "workspace.mjs");
  await build({
    entryPoints: ["src/persistence/workspace.ts"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { migrateWorkspace } = await import(pathToFileURL(bundle).href);
  console.log(JSON.stringify(migrateWorkspace(source, destination), null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
