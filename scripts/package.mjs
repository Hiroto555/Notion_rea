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
const stage = resolve("output/package-stage");
// This directory is generated only by this script and contains no workspace data.
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync("dist", stage + "/dist", { recursive: true });
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
  platform: "darwin",
  arch: "arm64",
  electronVersion: pkg.devDependencies.electron,
  download: { cacheRoot: resolve(".cache/electron") },
  overwrite: true,
  asar: true,
  prune: false,
  icon: existsSync("assets/icon.icns")
    ? resolve("assets/icon.icns")
    : undefined,
  appBundleId: "local.folio.desktop",
  appCategoryType: "public.app-category.productivity",
});
console.log(results.join("\n"));
