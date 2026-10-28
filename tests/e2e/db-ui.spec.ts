import { expect, test, chromium, type Page } from "@playwright/test";
import { createServer as createHttpServer } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ViteDevServer } from "vite";
import { createServer as createViteServer } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Chromium harness for the Round 3 DB UI. This is not the Electron app and it
 * does not claim live storage: tests/db-ui/harness.tsx supplies contract-shaped
 * fixture callbacks so the presentation components can be exercised without
 * App.tsx / IPC (both owned by Core and not connected yet).
 */

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
      ? join(process.env.FOLIO_VITE_CACHE_DIR, "db-ui-harness")
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
  await page.goto(base + "tests/db-ui/index.html");
  await expect(page.locator(".r3-db")).toBeVisible();
  await page.waitForFunction(() => Boolean(window.__dbUiHarness));
});

type Call = {
  type: string;
  pageId?: string;
  patch?: unknown;
  settings?: unknown;
  revision?: number;
  input?: unknown;
};

const calls = (page: Page) =>
  page.evaluate(() => window.__dbUiHarness.calls as unknown as Call[]);

const openedPageId = (page: Page) =>
  page.evaluate(() => window.__dbUiHarness.openedPageId);

const storedRecord = (page: Page, pageId: string) =>
  page.evaluate(
    (id) =>
      window.__dbUiHarness.projection.records.find(
        (record) => record.pageId === id,
      ) ?? null,
    pageId,
  );

const tab = (page: Page, name: string) =>
  page.getByRole("tab", { name: "ビュー: " + name, exact: true });

async function openRecord(page: Page, title: string) {
  await page
    .getByRole("button", { name: "開く " + title, exact: true })
    .first()
    .click();
  await expect(page.locator(".r3-record-page")).toBeVisible();
}

async function backToDatabase(page: Page) {
  await page.getByRole("button", { name: "データベースに戻る" }).click();
  await expect(page.locator(".r3-db")).toBeVisible();
}

test("table, board, gallery and calendar open the same record identity and values", async ({
  page,
}) => {
  const expected =
    (await page.evaluate(
      () =>
        window.__dbUiHarness.projection.records.find(
          (record) => record.title === "Alpha 10",
        )?.pageId,
    )) ?? "";
  expect(expected).toBe("rec-alpha");
  const opened: (string | null)[] = [];
  for (const view of ["テーブル", "ボード", "ギャラリー", "カレンダー"]) {
    await tab(page, view).click();
    await openRecord(page, "Alpha 10");
    await expect(page.getByLabel("レコードのタイトル")).toHaveValue("Alpha 10");
    await expect(page.getByLabel("ステータス")).toHaveValue("進行中");
    await expect(page.getByLabel("期日")).not.toHaveValue("");
    await expect(page.getByLabel("費用")).toHaveValue("20");
    await expect(page.getByLabel("ページ本文")).toBeVisible();
    expect(await openedPageId(page)).toBe(expected);
    opened.push(await openedPageId(page));
    await backToDatabase(page);
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (document.activeElement as HTMLElement | null)?.dataset
              .recordOrigin ?? "",
        ),
      )
      .toBe("rec-alpha");
  }
  expect(opened).toEqual([expected, expected, expected, expected]);
  const openCalls = (await calls(page)).filter(
    (call) => call.type === "openRecord",
  );
  expect(openCalls).toHaveLength(4);
  expect(openCalls.every((call) => call.pageId === "rec-alpha")).toBe(true);
});

test("record page saves, retains a failed edit, retries and handles trash/restore and read-only", async ({
  page,
}) => {
  await openRecord(page, "Alpha 10");
  const title = page.getByLabel("レコードのタイトル");
  await expect(title).toBeFocused();

  await page.getByLabel("保存を遅延させる").check();
  await title.fill("Alpha renamed");
  await expect(page.locator(".r3-record-save")).toHaveText("保存中…");
  await expect(page.locator(".r3-record-save")).toHaveText("保存済み", {
    timeout: 5000,
  });

  await page
    .getByRole("checkbox", { name: "保存を失敗させる", exact: true })
    .check();
  await title.fill("Alpha failed");
  await expect(page.getByRole("alert")).toContainText("保存に失敗しました");
  await expect(title).toHaveValue("Alpha failed");
  await page
    .getByRole("checkbox", { name: "保存を失敗させる", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "保存を再試行" }).click();
  await expect(page.locator(".r3-record-save")).toHaveText("保存済み", {
    timeout: 5000,
  });
  expect((await storedRecord(page, "rec-alpha"))?.title).toBe("Alpha failed");

  await page.getByLabel("ステータス").selectOption("完了");
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.values.status)
    .toBe("完了");

  await page.getByLabel("読み取り専用の理由").selectOption("document-error");
  await expect(
    page.getByText("本文を読み込めないため、このレコードは読み取り専用です"),
  ).toBeVisible();
  await expect(title).toBeDisabled();
  await page.getByLabel("読み取り専用の理由").selectOption("");
  await expect(title).toBeEnabled();

  await page.getByRole("button", { name: "レコードをゴミ箱へ" }).click();
  await expect(page.getByText("このレコードはゴミ箱にあります")).toBeVisible();
  await expect(title).toBeDisabled();
  await expect(page.getByLabel("ステータス")).toBeDisabled();
  await page.getByRole("button", { name: "レコードを復元" }).click();
  await expect(title).toBeEnabled();
  await expect(page.getByText("このレコードはゴミ箱にあります")).toHaveCount(0);

  const recorded = await calls(page);
  expect(recorded.some((call) => call.type === "trashRecord")).toBe(true);
  expect(recorded.some((call) => call.type === "restoreRecord")).toBe(true);
  for (const call of recorded)
    if (call.type === "patchRecord")
      expect(JSON.stringify(call.patch)).not.toContain("rows");
});

test("inline table edits call record patches with pageId and never save rows", async ({
  page,
}) => {
  const row = page.locator('tr[data-record-id="rec-alpha"]');
  const title = row.locator("input.r3-title-input");
  await title.fill("Alpha inline");
  // The draft is handed to Core on the change itself, before Enter/blur.
  await expect
    .poll(async () =>
      (await calls(page)).some(
        (call) =>
          call.type === "patchRecord" &&
          (call.patch as { title?: string } | undefined)?.title ===
            "Alpha inline",
      ),
    )
    .toBe(true);
  await title.press("Enter");
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.title)
    .toBe("Alpha inline");

  await row.locator("select").selectOption("完了");
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.values.status)
    .toBe("完了");

  const done = row.locator('input[type="checkbox"]');
  await done.check();
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.values.done)
    .toBe(true);

  await title.fill("Should revert");
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.title)
    .toBe("Should revert");
  await title.press("Escape");
  await expect(title).toHaveValue("Alpha inline");
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.title)
    .toBe("Alpha inline");

  const recorded = await calls(page);
  const patches = recorded.filter((call) => call.type === "patchRecord");
  expect(patches.length).toBeGreaterThanOrEqual(4);
  expect((patches.at(-1)?.patch as { title?: string } | undefined)?.title).toBe(
    "Alpha inline",
  );
  expect(patches.every((call) => call.pageId === "rec-alpha")).toBe(true);
  expect(
    patches.every(
      (call) => typeof call.revision === "number" && call.revision >= 0,
    ),
  ).toBe(true);
  for (const call of recorded)
    if (call.type === "updateSettings")
      expect(Object.hasOwn(call.settings as object, "rows")).toBe(false);
});

test("filter, multiple sorts, grouping and view CRUD persist through updateSettings", async ({
  page,
}) => {
  const filterText = page.getByLabel("データベースを絞り込む");
  await filterText.fill("Alpha");
  await filterText.press("Enter");
  await expect(page.locator("tbody tr")).toHaveCount(1);

  await page.getByLabel("並べ替え", { exact: true }).selectOption("cost");
  await page.getByRole("button", { name: "複数並べ替えを追加" }).click();
  await expect(page.getByLabel("並べ替え対象 2")).toBeVisible();
  await page.getByLabel("並べ替え対象 2").selectOption("status");
  await page.getByLabel("並べ替え順 2").selectOption("desc");
  await page.getByLabel("グループ化").selectOption("status");
  await expect(page.locator(".r3-group")).toHaveCount(1);
  await page.getByLabel("グループの並び順").selectOption("desc");

  await page.getByLabel("ビュー名").fill("一覧");
  await page.getByLabel("ビュー名").press("Enter");
  await expect(page.getByRole("tab", { name: "ビュー: 一覧" })).toBeVisible();

  await page.getByRole("button", { name: "ビューを複製" }).click();
  await expect(
    page.getByRole("tab", { name: /のコピー/ }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "ビューを削除" }).click();
  await expect(
    page.getByRole("tab", { name: "ビュー: 一覧", exact: true }),
  ).toBeVisible();

  await page.getByLabel("追加するビューの種類").selectOption("gallery");
  await page.getByRole("button", { name: "ビューを追加" }).click();
  await expect(
    page.getByRole("tab", { name: /ギャラリー/ }).last(),
  ).toBeVisible();

  const writes = (await calls(page)).filter(
    (call) => call.type === "updateSettings",
  );
  expect(writes.length).toBeGreaterThan(4);
  for (const write of writes)
    expect(Object.hasOwn(write.settings as object, "rows")).toBe(false);
  const revisions = writes.map((write) => write.revision ?? -1);
  expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
});

test("filter builder adds a typed condition and a settings failure can be retried", async ({
  page,
}) => {
  await page.getByRole("button", { name: /^フィルター/ }).click();
  await page.getByLabel("条件を追加 1").click();
  await page.getByLabel("フィルター対象 1.1").selectOption("title");
  await page.getByLabel("フィルター演算子 1.1").selectOption("contains");
  await page.getByLabel("フィルター値 1.1").fill("Alpha");
  await expect(page.locator("tbody tr")).toHaveCount(1);

  await page.getByLabel("設定の保存を失敗させる").check();
  await page.getByLabel("グループ化").selectOption("status");
  await expect(page.getByRole("alert")).toContainText(
    "ビュー設定を保存できませんでした",
  );
  await page.getByLabel("設定の保存を失敗させる").uncheck();
  await page.getByRole("alert").getByRole("button", { name: "再試行" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("グループ化")).toHaveValue("status");
  expect(
    (await calls(page)).some((call) => call.type === "updateSettings"),
  ).toBe(true);
});

test("a pending settings write is rebased onto an external projection", async ({
  page,
}) => {
  await page.getByLabel("保存を遅延させる").check();
  const name = page.getByLabel("ビュー名");
  await name.fill("外部変更テスト");
  await name.press("Enter");
  await page.evaluate(() => window.__dbUiHarness.setFilterText("Alpha"));
  await expect(page.getByRole("alert")).toContainText(
    "ビュー設定を保存できませんでした",
    { timeout: 5000 },
  );
  await page.getByRole("alert").getByRole("button", { name: "再試行" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const projection = window.__dbUiHarness.projection;
          const active = projection.settings.views.find(
            (view) => view.id === projection.settings.activeViewId,
          );
          return active?.name ?? "";
        }),
      { timeout: 5000 },
    )
    .toBe("外部変更テスト");
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 5000 });
  const state = await page.evaluate(() => {
    const projection = window.__dbUiHarness.projection;
    const active = projection.settings.views.find(
      (view) => view.id === projection.settings.activeViewId,
    );
    return { name: active?.name ?? "", filterText: active?.filterText ?? "" };
  });
  expect(state.filterText).toBe("Alpha");
  expect(state.name).toBe("外部変更テスト");
});

test("board grouping follows the saved direction and the direction control", async ({
  page,
}) => {
  await tab(page, "ボード").click();
  await page.getByLabel("グループ化").selectOption("status");
  await page.getByLabel("グループの並び順").selectOption("desc");
  const labels = async () =>
    (await page.locator(".r3-board-column > h4").allTextContents()).map(
      (text) => text.replace(/\s*\d+\s*$/, "").trim(),
    );
  await expect.poll(labels).toEqual(["完了", "進行中", "未着手", "未設定"]);
  await page.getByLabel("グループの並び順").selectOption("asc");
  await expect.poll(labels).toEqual(["未着手", "進行中", "完了", "未設定"]);
});

test("board drag moves a record between groups through patchRecord", async ({
  page,
}) => {
  await tab(page, "ボード").click();
  await page.getByLabel("グループ化").selectOption("status");
  const target = page
    .locator(".r3-board-column")
    .filter({ has: page.locator("h4", { hasText: /^完了/ }) });
  await expect(target).toHaveCount(1);
  await page
    .locator('article.r3-card[data-record-id="rec-alpha"]')
    .dragTo(target);
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.values.status)
    .toBe("完了");
  expect(
    (await calls(page)).some(
      (call) => call.type === "patchRecord" && call.pageId === "rec-alpha",
    ),
  ).toBe(true);
});

test("keyboard handoff, Escape return, origin focus and scroll restoration", async ({
  page,
}) => {
  const scroll = page.locator(".r3-db-scroll");
  await scroll.evaluate((element) => {
    element.scrollTop = 260;
  });
  const before = await scroll.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(0);

  const target = await scroll.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll("tbody tr")].find(
      (candidate) => candidate.getBoundingClientRect().top > top + 24,
    );
    return row?.getAttribute("data-record-id") ?? "";
  });
  expect(target).not.toBe("");
  const origin = page.locator(
    `tr[data-record-id="${target}"] button[aria-label^="開く"]`,
  );
  await origin.evaluate((element) => (element as HTMLElement).click());
  await expect(page.locator(".r3-record-page")).toBeVisible();
  await expect(page.getByLabel("レコードのタイトル")).toBeFocused();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.getAttribute(
          "aria-label",
        ) ?? "",
    ),
  ).toBe("ページ本文");
  await page.keyboard.press("Escape");
  await expect(page.locator(".r3-db")).toBeVisible();
  const after = await page
    .locator(".r3-db-scroll")
    .evaluate((element) => element.scrollTop);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (document.activeElement as HTMLElement | null)?.dataset
            .recordOrigin ?? "",
      ),
    )
    .toBe(target);

  await origin.evaluate((element) => (element as HTMLElement).click());
  await expect(page.locator(".r3-record-page")).toBeVisible();
  await expect(page.getByLabel("レコードのタイトル")).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.id ?? "")).toBe(
    `record-property-${target}-status`,
  );
  await page.keyboard.press("Escape");
  await expect(page.locator(".r3-db")).toBeVisible();
});

test("a filtered-out record stays open and returning does not focus a hidden row", async ({
  page,
}) => {
  await openRecord(page, "Beta 2");
  await page.evaluate(() => window.__dbUiHarness.setFilterText("Alpha"));
  await expect(page.locator(".r3-record-page")).toBeVisible();
  await expect(page.getByLabel("レコードのタイトル")).toHaveValue("Beta 2");
  await backToDatabase(page);
  await expect(page.getByLabel("データベースを絞り込む")).toHaveValue("Alpha");
  await expect(page.locator('tr[data-record-id="rec-beta"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (document.activeElement as HTMLElement | null)?.dataset.recordOrigin ??
        "",
    ),
  ).not.toBe("rec-beta");
});

test("create, duplicate, trash and restore show ACKs and update the projection", async ({
  page,
}) => {
  await page.getByRole("button", { name: "新しいレコード" }).click();
  await expect(page.locator(".r3-record-page")).toBeVisible();
  await expect(page.getByLabel("レコードのタイトル")).toHaveValue(
    "新しいアイテム",
  );
  const created = await openedPageId(page);
  expect(created).toMatch(/^rec-created-/);
  await backToDatabase(page);
  await expect(page.locator(`tr[data-record-id="${created}"]`)).toBeVisible();

  const alpha = page.locator('tr[data-record-id="rec-alpha"]');
  await alpha.locator('button[aria-label^="複製 Alpha"]').click();
  await expect(page.getByText("複製しました")).toBeVisible();
  await expect(
    page.locator('tr[data-record-id*="rec-alpha-copy"]'),
  ).toHaveCount(1);

  await page
    .locator('tr[data-record-id="rec-beta"] button[aria-label^="ゴミ箱へ移動"]')
    .click();
  await expect(page.locator('tr[data-record-id="rec-beta"]')).toHaveCount(0);
  const trash = page.locator(".r3-trash");
  await expect(trash).toBeVisible();
  await expect(trash.locator("summary")).toContainText("2");
  await trash.locator("summary").click();
  await page.getByRole("button", { name: "復元 Beta 2" }).click();
  await expect(page.locator('tr[data-record-id="rec-beta"]')).toBeVisible();

  const recorded = await calls(page);
  for (const type of [
    "createRecord",
    "duplicateRecord",
    "trashRecord",
    "restoreRecord",
  ])
    expect(recorded.some((call) => call.type === type)).toBe(true);
});

test("a failed cell stays retryable after another cell succeeds", async ({
  page,
}) => {
  const row = page.locator('tr[data-record-id="rec-alpha"]');
  await page
    .getByRole("checkbox", { name: "保存を失敗させる", exact: true })
    .check();
  await row.locator("select").selectOption("未着手");
  await expect(page.getByRole("alert")).toContainText("保存に失敗しました");
  await page
    .getByRole("checkbox", { name: "保存を失敗させる", exact: true })
    .uncheck();
  const title = row.locator("input.r3-title-input");
  await title.fill("Alpha after failure");
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.title)
    .toBe("Alpha after failure");
  await expect(page.locator(".r3-db-unsaved")).toContainText(
    "未保存の変更が 1 件",
  );
  await page
    .locator(".r3-db-unsaved")
    .getByRole("button", { name: "再試行" })
    .click();
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.values.status)
    .toBe("未着手");
  await expect(page.locator(".r3-db-unsaved")).toHaveCount(0);
});

test("retry retains a failed cell when another writer changed the same cell", async ({
  page,
}) => {
  const row = page.locator('tr[data-record-id="rec-alpha"]');
  await page
    .getByRole("checkbox", { name: "保存を失敗させる", exact: true })
    .check();
  await row.locator("select").selectOption("未着手");
  await expect(page.getByRole("alert")).toContainText("保存に失敗しました");
  await page
    .getByRole("checkbox", { name: "保存を失敗させる", exact: true })
    .uncheck();
  await page.evaluate(() =>
    window.__dbUiHarness.setRecordValue("rec-alpha", "status", "完了"),
  );
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.values.status)
    .toBe("完了");
  const before = (await calls(page)).filter(
    (call) => call.type === "patchRecord",
  ).length;
  await page.getByRole("button", { name: "未保存の変更を再試行" }).click();
  await expect(page.getByRole("alert")).toContainText("他の変更で更新");
  expect(
    (await calls(page)).filter((call) => call.type === "patchRecord"),
  ).toHaveLength(before);
  expect((await storedRecord(page, "rec-alpha"))?.values.status).toBe("完了");
  await page.getByRole("button", { name: "エラーを閉じる" }).click();
  await expect(page.locator(".r3-db-unsaved")).toContainText(
    "未保存の変更が 1 件",
  );
});

test("Escape on an absent cell writes nothing and deletes after a value", async ({
  page,
}) => {
  const row = page.locator('tr[data-record-id="rec-beta"]');
  const note = row.locator('input[aria-label^="メモ"]');
  const before = (await calls(page)).filter(
    (call) => call.type === "patchRecord",
  ).length;
  await note.focus();
  await page.keyboard.press("Escape");
  expect(
    (await calls(page)).filter((call) => call.type === "patchRecord").length,
  ).toBe(before);
  const hasNote = () =>
    page.evaluate(() => {
      const record = window.__dbUiHarness.projection.records.find(
        (candidate) => candidate.pageId === "rec-beta",
      );
      return record ? Object.hasOwn(record.values, "note") : false;
    });
  expect(await hasNote()).toBe(false);

  await note.fill("temporary");
  await expect
    .poll(async () => (await storedRecord(page, "rec-beta"))?.values.note)
    .toBe("temporary");
  await note.focus();
  await page.keyboard.press("Escape");
  await expect(note).toHaveValue("");
  await expect.poll(hasNote).toBe(false);
});

test("an optimistic view keeps its id through a failed add and queued rename", async ({
  page,
}) => {
  await page.getByLabel("設定の保存を失敗させる").check();
  const before = await page.evaluate(
    () => window.__dbUiHarness.projection.settings.views.length,
  );
  await page.getByLabel("追加するビューの種類").selectOption("gallery");
  await page.getByRole("button", { name: "ビューを追加" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "ビュー設定を保存できませんでした",
  );
  const name = page.getByLabel("ビュー名");
  await name.fill("再試行後のビュー");
  await expect(name).toHaveValue("再試行後のビュー");
  await page.getByLabel("設定の保存を失敗させる").uncheck();
  await page.getByRole("alert").getByRole("button", { name: "再試行" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const projection = window.__dbUiHarness.projection;
          const active = projection.settings.views.find(
            (view) => view.id === projection.settings.activeViewId,
          );
          return {
            count: projection.settings.views.length,
            type: active?.type ?? "",
            name: active?.name ?? "",
          };
        }),
      { timeout: 5000 },
    )
    .toEqual({
      count: before + 1,
      type: "gallery",
      name: "再試行後のビュー",
    });
  await expect(
    page.getByRole("tab", { name: "ビュー: 再試行後のビュー" }),
  ).toBeVisible();
});

test("an optimistic duplicate keeps its id through a failed write and queued rename", async ({
  page,
}) => {
  await page.getByLabel("設定の保存を失敗させる").check();
  const before = await page.evaluate(
    () => window.__dbUiHarness.projection.settings.views.length,
  );
  await page.getByRole("button", { name: "ビューを複製" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "ビュー設定を保存できませんでした",
  );
  const name = page.getByLabel("ビュー名");
  await name.fill("複製の再試行");
  await page.getByLabel("設定の保存を失敗させる").uncheck();
  await page.getByRole("alert").getByRole("button", { name: "再試行" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const projection = window.__dbUiHarness.projection;
          const active = projection.settings.views.find(
            (view) => view.id === projection.settings.activeViewId,
          );
          return {
            count: projection.settings.views.length,
            type: active?.type ?? "",
            name: active?.name ?? "",
          };
        }),
      { timeout: 5000 },
    )
    .toEqual({
      count: before + 1,
      type: "table",
      name: "複製の再試行",
    });
  await expect(
    page.getByRole("tab", { name: "ビュー: 複製の再試行" }),
  ).toBeVisible();
});

test("a same-field external change is reported instead of overwritten", async ({
  page,
}) => {
  await page.getByLabel("保存を遅延させる").check();
  const name = page.getByLabel("ビュー名");
  await name.fill("ローカルの名前");
  await page.evaluate(() => window.__dbUiHarness.setViewName("外部の名前"));
  await expect(page.getByRole("alert")).toContainText(
    "ビュー設定を保存できませんでした",
    { timeout: 5000 },
  );
  await page.getByRole("alert").getByRole("button", { name: "再試行" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "同じビュー設定が他の変更で更新されました",
    { timeout: 5000 },
  );
  expect(
    await page.evaluate(() => {
      const projection = window.__dbUiHarness.projection;
      return (
        projection.settings.views.find(
          (view) => view.id === projection.settings.activeViewId,
        )?.name ?? ""
      );
    }),
  ).toBe("外部の名前");
  await page
    .getByRole("alert")
    .getByRole("button", { name: "変更を破棄" })
    .click();
  await expect(name).toHaveValue("外部の名前");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("filter and view-name edits are sent before navigation without blur", async ({
  page,
}) => {
  const filterText = page.getByLabel("データベースを絞り込む");
  await filterText.fill("Alpha");
  await expect
    .poll(async () =>
      (await calls(page)).some((call) => {
        if (call.type !== "updateSettings") return false;
        const settings = call.settings as {
          activeViewId: string;
          views: { id: string; filterText: string }[];
        };
        return settings.views.some(
          (view) =>
            view.id === settings.activeViewId && view.filterText === "Alpha",
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => window.__dbUiHarness.openRecord("rec-alpha"));
  await expect(page.locator(".r3-record-page")).toBeVisible();
  await backToDatabase(page);

  const name = page.getByLabel("ビュー名");
  await name.fill("Unmount view");
  await expect
    .poll(async () =>
      (await calls(page)).some((call) => {
        if (call.type !== "updateSettings") return false;
        const settings = call.settings as {
          activeViewId: string;
          views: { id: string; name: string }[];
        };
        return settings.views.some(
          (view) =>
            view.id === settings.activeViewId && view.name === "Unmount view",
        );
      }),
    )
    .toBe(true);
  await page.evaluate(() => window.__dbUiHarness.openRecord("rec-alpha"));
  await expect(page.locator(".r3-record-page")).toBeVisible();
});

test("deleting a view is rejected after the same view changed externally", async ({
  page,
}) => {
  await page.getByLabel("保存を遅延させる").check();
  const before = await page.evaluate(
    () => window.__dbUiHarness.projection.settings.views.length,
  );
  await page.getByRole("button", { name: "ビューを削除" }).click();
  await page.evaluate(() => window.__dbUiHarness.setViewName("外部の名前"));
  await expect(page.getByRole("alert")).toContainText(
    "ビュー設定を保存できませんでした",
    { timeout: 5000 },
  );
  await page.getByRole("alert").getByRole("button", { name: "再試行" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "削除対象のビューが他の変更で更新されました",
    { timeout: 5000 },
  );
  const state = await page.evaluate(() => {
    const projection = window.__dbUiHarness.projection;
    const active = projection.settings.views.find(
      (view) => view.id === projection.settings.activeViewId,
    );
    return {
      count: projection.settings.views.length,
      name: active?.name ?? "",
    };
  });
  expect(state.count).toBe(before);
  expect(state.name).toBe("外部の名前");
  await page
    .getByRole("alert")
    .getByRole("button", { name: "変更を破棄" })
    .click();
  await expect(page.getByLabel("ビュー名")).toHaveValue("外部の名前");
});

test("a newer cell edit supersedes an older failed patch before its ACK", async ({
  page,
}) => {
  await page.getByLabel("保存を遅延させる").check();
  const row = page.locator('tr[data-record-id="rec-alpha"]');
  const status = row.locator("select");
  await page
    .getByRole("checkbox", { name: "保存を失敗させる", exact: true })
    .check();
  await status.selectOption("未着手");
  await expect(page.getByRole("alert")).toContainText("保存に失敗しました");
  await page
    .getByRole("checkbox", { name: "保存を失敗させる", exact: true })
    .uncheck();
  await status.selectOption("完了");
  // The old failure is superseded synchronously; no retry of the older value
  // exists while the new value is still in flight.
  await expect(page.locator(".r3-db-unsaved")).toHaveCount(0, {
    timeout: 1000,
  });
  await expect(
    page.getByRole("button", { name: "未保存の変更を再試行" }),
  ).toHaveCount(0);
  await expect
    .poll(async () => (await storedRecord(page, "rec-alpha"))?.values.status)
    .toBe("完了");
  const patches = (await calls(page)).filter(
    (call) =>
      call.type === "patchRecord" &&
      call.pageId === "rec-alpha" &&
      (call.patch as { values?: { status?: string } } | undefined)?.values
        ?.status !== undefined,
  );
  let completion = -1;
  for (let index = patches.length - 1; index >= 0; index -= 1) {
    const status = (
      patches[index].patch as { values?: { status?: string } } | undefined
    )?.values?.status;
    if (status === "完了") {
      completion = index;
      break;
    }
  }
  expect(completion).toBeGreaterThanOrEqual(0);
  expect(
    patches
      .slice(completion + 1)
      .some(
        (call) =>
          (call.patch as { values?: { status?: string } } | undefined)?.values
            ?.status === "未着手",
      ),
  ).toBe(false);
});

test("a failed new view keeps stable filter/sort ids for queued edits", async ({
  page,
}) => {
  await page.getByRole("button", { name: /^フィルター/ }).click();
  await page.getByLabel("条件を追加 1").click();
  await page.getByLabel("フィルター対象 1.1").selectOption("status");
  await page.getByLabel("フィルター演算子 1.1").selectOption("equals");
  await page.getByLabel("フィルター値 1.1").selectOption("進行中");
  await page.getByLabel("並べ替え", { exact: true }).selectOption("cost");

  await page.getByLabel("設定の保存を失敗させる").check();
  await page.getByLabel("追加するビューの種類").selectOption("gallery");
  await page.getByRole("button", { name: "ビューを追加" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "ビュー設定を保存できませんでした",
  );
  await page.getByLabel("並べ替え", { exact: true }).selectOption("status");
  await page.getByLabel("フィルター対象 1.1").selectOption("title");
  await page.getByLabel("設定の保存を失敗させる").uncheck();
  await page.getByRole("alert").getByRole("button", { name: "再試行" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0, { timeout: 5000 });
  const state = await page.evaluate(() => {
    const projection = window.__dbUiHarness.projection;
    const active = projection.settings.views.find(
      (view) => view.id === projection.settings.activeViewId,
    );
    return {
      type: active?.type ?? "",
      sort: active?.sorts[0]?.propertyId ?? "",
      sortId: active?.sorts[0]?.id ?? "",
      filterProperty:
        (active?.filter.conditions[0] as { propertyId?: string } | undefined)
          ?.propertyId ?? "",
      filterId: active?.filter.id ?? "",
      conditionId:
        (active?.filter.conditions[0] as { id?: string } | undefined)?.id ?? "",
    };
  });
  expect(state.type).toBe("gallery");
  expect(state.sort).toBe("status");
  expect(state.sortId).toContain(":sort:");
  expect(state.filterProperty).toBe("title");
  expect(state.filterId).toContain(":filter:");
  expect(state.conditionId).toContain(":filter:");
});

test("960/1024/1440 and narrow layout, dark theme, long text and an image do not overflow", async ({
  page,
}) => {
  for (const width of [960, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator(".r3-db")).toBeVisible();
    await expect(page.locator(".r3-db-tabs")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".r3-db")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  const lightBackground = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg"),
  );
  await page.getByLabel("テーマを切り替える").click();
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
  ).toBe("dark");
  const darkBackground = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--bg"),
  );
  expect(darkBackground).not.toBe(lightBackground);

  await openRecord(page, "Alpha 10");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  const image = page.getByAltText("添付画像");
  await expect(image).toBeVisible();
  expect(
    await page.evaluate(() => {
      const element = document.querySelector<HTMLImageElement>(
        ".r3-record-body img",
      );
      return element
        ? element.getBoundingClientRect().width <= window.innerWidth
        : false;
    }),
  ).toBe(true);
  await expect(page.getByLabel("メモ")).toHaveValue(/長いテキスト/);
});
