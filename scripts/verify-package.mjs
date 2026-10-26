import { _electron as electron } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const folder = mkdtempSync(resolve("output/package-smoke-"));
const executablePath = resolve(
  "release/Folio-darwin-arm64/Folio.app/Contents/MacOS/Folio",
);
let app;
const launch = () =>
  electron.launch({
    executablePath,
    args: [],
    env: { ...process.env, FOLIO_DATA_DIR: folder },
  });
try {
  app = await launch();
  let page = await app.firstWindow();
  await page.waitForSelector(".page-title");
  await page.locator(".page-title").fill("パッケージ保存検証");
  await page.locator(".save-state").filter({ hasText: "保存済み" }).waitFor();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await page.waitForSelector(".page-title");
  if ((await page.locator(".page-title").inputValue()) !== "パッケージ保存検証")
    throw new Error("Packaged persistence failed");
  writeFileSync(
    "output/package-smoke.json",
    JSON.stringify({ ok: true, executablePath, persistence: true }),
  );
  console.log("Packaged .app launch / edit / restart passed");
} finally {
  await app?.close();
  rmSync(folder, { recursive: true, force: true });
}
