import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackageArgs, verifyPackageArtifacts } from "./platform/package-evidence.mjs";

export { verifyPackageArtifacts };

export function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg === "--gui" || arg.startsWith("--gui=")))
    throw new Error("GUI_REFUSED: use the explicitly authorized npm run test:e2e:batch entry");
  const manifest = verifyPackageArtifacts(parsePackageArgs(args));
  console.log(`Artifact verified: ${manifest.plan.artifactPath}; GUI NOT_RUN; unsigned`);
  return manifest;
}

// Retained persistence smoke, for integration into the explicit batch only.
// Artifact verification alone never imports Playwright or calls this function.
export async function runPackagedGuiSmoke({ selection = {}, batch = false, env = {} } = {},
  dependencies = {}) {
  if (batch !== true || env.FOLIO_GUI_TEST_OPT_IN !== "1")
    throw new Error("GUI_REFUSED: explicit authorized batch required");
  const manifest = verifyPackageArtifacts(selection);
  if (manifest.plan.platform !== process.platform || manifest.plan.arch !== process.arch)
    throw new Error("GUI_HOST_TARGET_MISMATCH");
  const executablePath = join(manifest.plan.outputDir,
    manifest.plan.platform === "darwin" ? "Folio.app/Contents/MacOS/Folio" : "Folio.exe");
  const folder = mkdtempSync(join(resolve(selection.root ?? process.cwd()), "output/package-smoke-"));
  const electron = dependencies.launch ? undefined : (await import("@playwright/test"))._electron;
  const launch = dependencies.launch ?? (options => electron.launch(options));
  let app;
  try {
    const options = { executablePath, args: [], env: { ...env, FOLIO_DATA_DIR: folder } };
    app = await launch(options);
    let page = await app.firstWindow();
    await page.waitForSelector(".page-title");
    await page.locator(".page-title").fill("パッケージ保存検証");
    await page.locator(".save-state").filter({ hasText: "保存済み" }).waitFor();
    await app.close(); app = undefined;
    app = await launch(options);
    page = await app.firstWindow();
    await page.waitForSelector(".page-title");
    if ((await page.locator(".page-title").inputValue()) !== "パッケージ保存検証")
      throw new Error("Packaged persistence failed");
    const observation = { ok: true, executablePath, persistence: true,
      artifactHash: manifest.artifact.sha256, platform: process.platform, arch: process.arch };
    writeFileSync(join(folder, "package-smoke.json"), JSON.stringify(observation), { flag: "wx" });
    return observation;
  } finally {
    await app?.close();
    // Keep the isolated run and any partial evidence; do not infer nonapplication.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
