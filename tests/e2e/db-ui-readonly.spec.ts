import { expect, test, chromium } from "@playwright/test";
import { createServer as createHttpServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

// Isolated presentation fixture; not an Electron/SQLite integration test.
function chromiumFallback(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const configured = process.env.FOLIO_TEST_CHROMIUM;
  if (configured && existsSync(configured)) return configured;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const directory of readdirSync(cache).filter((x) => /^chromium-\d+$/.test(x)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    for (const relative of [
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
      "chrome-linux/chrome",
    ]) {
      const candidate = join(cache, directory, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
test.use({ launchOptions: { executablePath: chromiumFallback() } });
let server: ViteDevServer;
let base = "";
test.beforeAll(async () => {
  const probe = createHttpServer();
  await new Promise<void>((done, fail) => { probe.once("error", fail); probe.listen(0, "127.0.0.1", done); });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  server = await createViteServer({
    root: resolve("."), configFile: false, plugins: [react()], logLevel: "error",
    cacheDir: process.env.FOLIO_VITE_CACHE_DIR ? join(process.env.FOLIO_VITE_CACHE_DIR, "db-ui-readonly") : undefined,
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/`;
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  await page.goto(base + "tests/db-ui/index.html?readOnly=1");
  await expect(page.locator('.r3-db[data-read-only="true"]')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__dbUiHarness));
});

test("view-only modes permit local navigation without creating drafts or mutation callbacks", async ({ page }) => {
  const before = await page.evaluate(() => structuredClone(window.__dbUiHarness.projection));
  const root = page.locator('.r3-db[data-read-only="true"]');
  await expect(root.getByRole("status")).toContainText("読み取り専用");
  await expect(root.locator('input,textarea,select,[contenteditable="true"]')).toHaveCount(0);
  await expect(root.locator('[draggable="true"]')).toHaveCount(0);
  await expect(root.getByRole("button", { name: /複製|削除|ゴミ箱へ移動|追加|保存|復元/ })).toHaveCount(0);
  for (const [name, type] of [["テーブル", "table"], ["ボード", "board"], ["ギャラリー", "gallery"], ["カレンダー", "calendar"]]) {
    await root.getByRole("tab", { name: "ビュー: " + name, exact: true }).click();
    await expect(root.locator(".r3-db-scroll")).toHaveAttribute("data-view-type", type);
    await expect(root.locator('input,textarea,select,[contenteditable="true"],[draggable="true"]')).toHaveCount(0);
    await root.locator(".r3-db-scroll").evaluate((el) => {
      const transfer = new DataTransfer();
      transfer.setData("application/x-folio-record", "rec-alpha");
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
  }
  await root.getByRole("button", { name: "前の月" }).click();
  await root.getByRole("button", { name: "次の月" }).click();
  expect(await page.evaluate(() => window.__dbUiHarness.calls)).toEqual([]);
  expect(await page.evaluate(() => window.__dbUiHarness.projection)).toEqual(before);
  await page.reload();
  await expect(page.locator('.r3-db[data-read-only="true"] .r3-db-scroll')).toHaveAttribute("data-view-type", "table");
});

test("opening a live uniquely owned row sends only the navigation callback", async ({ page }) => {
  const root = page.locator('.r3-db[data-read-only="true"]');
  await root.getByRole("button", { name: "開く Alpha 10", exact: true }).click();
  expect(await page.evaluate(() => window.__dbUiHarness.calls)).toEqual([{ type: "openRecord", pageId: "rec-alpha" }]);
});

test("a mismatched owner or duplicated page identity cannot navigate", async ({ page }) => {
  await page.evaluate(() => window.__dbUiHarness.setRecordOwner("rec-alpha", "db-other"));
  const root = page.locator('.r3-db[data-read-only="true"]');
  await expect(root.getByRole("button", { name: "開く Alpha 10", exact: true })).toBeDisabled();
  await page.evaluate(() => window.__dbUiHarness.setRecordOwner("rec-alpha", "db-projects"));
  await page.evaluate(() => window.__dbUiHarness.duplicateRecordIdentity("rec-alpha"));
  const buttons = root.getByRole("button", { name: "開く Alpha 10", exact: true });
  expect(await buttons.count()).toBeGreaterThan(0);
  for (const button of await buttons.all()) await expect(button).toBeDisabled();
  expect(await page.evaluate(() => window.__dbUiHarness.calls)).toEqual([]);
});
