import { expect, test, chromium } from "@playwright/test";
import { createServer as createHttpServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ViteDevServer } from "vite";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";

// Presentation + real Editor tests. No Electron, IPC or persistence claim.
function findChromium(): string | undefined {
  const expected = chromium.executablePath();
  if (expected && existsSync(expected)) return undefined;
  const configured = process.env.FOLIO_TEST_CHROMIUM;
  if (configured && existsSync(configured)) return configured;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const candidates = readdirSync(cache)
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort(
      (left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]),
    );
  const relative = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux/chrome",
  ];
  for (const directory of candidates)
    for (const path of relative) {
      const candidate = join(cache, directory, path);
      if (existsSync(candidate)) return candidate;
    }
  return undefined;
}

test.use({ launchOptions: { executablePath: findChromium() } });

let server: ViteDevServer;
let base = "";

async function freePort(): Promise<number> {
  const probe = createHttpServer();
  await new Promise<void>((done, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => done());
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

test.beforeAll(async () => {
  const port = await freePort();
  server = await createViteServer({
    root: resolve("."),
    configFile: false,
    cacheDir: process.env.FOLIO_VITE_CACHE_DIR
      ? join(process.env.FOLIO_VITE_CACHE_DIR, "record-page-harness")
      : undefined,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  base = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/`;
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(async ({ page }) => {
  await page.goto(base + "tests/record-page/index.html");
  await expect(page.locator(".folio-editor")).toBeVisible();
});

test("side/full changes preserve the real Editor instance and its undo history", async ({
  page,
}) => {
  const body = page.locator(".folio-editor");
  await body.fill("切替前に入力した本文");
  await page.getByRole("button", { name: "全画面で開く", exact: true }).click();
  await expect(page.locator(".r3-record-page")).toHaveAttribute(
    "data-record-mode",
    "full",
  );
  await page
    .getByRole("button", { name: "サイドピークで開く", exact: true })
    .click();
  await expect(page.locator(".r3-record-page")).toHaveAttribute(
    "data-record-mode",
    "side",
  );
  await expect(body).toContainText("切替前に入力した本文");
  expect(
    await page.evaluate(() => window.__recordPresentation.calls.ready),
  ).toBe(1);
  await body.focus();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(body).toContainText("元の本文");
});

test("unknown offers result lookup, preserves input and applies the parent edit lock", async ({
  page,
}) => {
  const title = page.getByLabel("レコードのタイトル");
  await title.fill("保存結果不明のタイトル");
  await page.evaluate(() => {
    window.__recordPresentation.setSaveState("unknown");
    window.__recordPresentation.setBlocked(true);
  });
  await expect(title).toHaveValue("保存結果不明のタイトル");
  await expect(title).toBeDisabled();
  await expect(page.getByLabel("メモ", { exact: true })).toBeDisabled();
  await expect(page.locator(".folio-editor")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await expect(page.getByRole("button", { name: "保存を再試行" })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "保存結果を確認", exact: true })
    .click();
  expect(
    await page.evaluate(() => ({
      resolve: window.__recordPresentation.calls.resolve,
      retry: window.__recordPresentation.calls.retry,
    })),
  ).toEqual({ resolve: 1, retry: 0 });
  await page.getByRole("button", { name: "レコードを閉じる" }).click();
  await expect(page.getByRole("button", { name: "元の行" })).toBeFocused();
});

test("Escape cancels the slash menu before closing and ignores composition", async ({
  page,
}) => {
  const body = page.locator(".folio-editor");
  await body.fill("/");
  await expect(page.locator(".slash-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".slash-menu")).toHaveCount(0);
  await expect(page.locator(".r3-record-page")).toBeVisible();
  await body.dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await expect(page.locator(".r3-record-page")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".r3-record-page")).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__recordPresentation.calls.close),
  ).toBe(1);
});
