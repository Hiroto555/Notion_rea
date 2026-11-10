import {planPackage} from "./platform/package-target.mjs";
import { packager } from "@electron/packager";
import {
  mkdirSync,
  cpSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve } from "node:path";
const args=process.argv.slice(2);const values={platform:"darwin",arch:"arm64"};
for(let index=0;index<args.length;index+=2){const key=args[index];if(!["--platform","--arch"].includes(key)||!args[index+1])throw new Error("Usage: package.mjs [--platform darwin|win32] [--arch arm64|x64]");values[key.slice(2)]=args[index+1];}
const packageManifest=JSON.parse(readFileSync("package.json","utf8"));
const target=planPackage({platform:values.platform,arch:values.arch,version:packageManifest.version,outputRoot:resolve("release")});
const stage = resolve("output/package-stage-"+values.platform+"-"+values.arch);
// This directory is generated only by this script and contains no workspace data.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync("dist", stage + "/dist", { recursive: true });
cpSync("scripts/platform/windows",stage+"/dist/platform/windows",{recursive:true});
cpSync("docs/THIRD_PARTY_NOTICES.txt", stage + "/THIRD_PARTY_NOTICES.txt");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(
  stage + "/package.json",
  JSON.stringify({
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    main: "dist/main.cjs",
  }),
);
const results = await packager({
  dir: stage,
  out: resolve("release"),
  name: "Folio",
  ...target.packagerOptions,
  electronVersion: pkg.devDependencies.electron,
  download: { cacheRoot: resolve(".cache/electron") },
  overwrite: false,
  asar: true,
  prune: false,
  icon: values.platform==="darwin"&&existsSync("assets/icon.icns")
    ? resolve("assets/icon.icns")
    : undefined,
  appBundleId: "local.folio.desktop",
  appCategoryType: "public.app-category.productivity",
});
console.log(results.join("\n"));
