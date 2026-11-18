import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parsePackageArgs, runPackage } from "./platform/package-evidence.mjs";

export { parsePackageArgs, runPackage };

export async function main(args = process.argv.slice(2)) {
  const manifest = await runPackage(parsePackageArgs(args));
  console.log([manifest.plan.outputDir, manifest.plan.artifactPath,
    manifest.plan.manifestPath].join("\n"));
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
