import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { realDrag } from "./real-drag";
import { observeDrag, dragEvidence } from "./drag-observer";
let dragObserved = false;
const dragSession = () => ({ app, window, folder, restart: async () => {} });
let app: ElectronApplication, window: Page, folder: string, root: string, exportsDir: string, inputsDir: string;
async function launch() {
  app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: { ...process.env, FOLIO_DATA_DIR: folder },
    timeout: 30000,
  });
  window = await app.firstWindow();
  await window.waitForSelector(".page-title");
  await app
    .context()
    .tracing.start({ screenshots: true, snapshots: true, sources: true });
}
test.beforeEach(async () => {
  dragObserved = false;
  root = mkdtempSync(resolve("output/e2e-"));
  folder = join(root, "workspace");
  exportsDir = join(root, "exports");
  inputsDir = join(root, "inputs");
  mkdirSync(folder);
  mkdirSync(exportsDir);
  mkdirSync(inputsDir);
  await launch();
});
test.afterEach(async ({}, info) => {
  try {
    if (dragObserved) await dragEvidence(dragSession(), info);
    await window.screenshot({ path: info.outputPath("screen.png") });
    await app.context().tracing.stop({ path: info.outputPath("trace.zip") });
  } catch {}
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});
test("real Electron: page edit, slash, undo, blocks, search, clone, trash and restart", async ({}, info) => {
  const errors: string[] = [];
  window.on("pageerror", (e) => errors.push(e.message));
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("ようこそ、Folioへ");
  await window.screenshot({ path: info.outputPath("folio-light.png") });
  await window.keyboard.press("Meta+n");
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("無題");
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("検証ノート English");
  const body = window.getByRole("textbox", { name: "ページ本文" }); // ProseMirror contenteditable has no default role in some versions
  await window.locator(".folio-editor").click();
  await window.keyboard.type("/heading");
  await expect(window.getByRole("listbox")).toBeVisible();
  await window.keyboard.press("Enter");
  await window.keyboard.insertText("見出し Test");
  await window.keyboard.press("Enter");
  await window.keyboard.insertText("日本語とEnglishを一緒に保存します。");
  await expect(window.locator(".folio-editor h1")).toHaveText("見出し Test");
  await window.keyboard.press("Enter");
  await window.keyboard.type("/todo");
  await window.keyboard.press("Enter");
  await window.keyboard.insertText("やること");
  await expect(
    window.locator(".folio-editor input[type=checkbox]"),
  ).toHaveCount(1);
  await window.locator(".folio-editor input[type=checkbox]").check();
  await observeDrag(dragSession());
  dragObserved = true;
  await realDrag(
    window,
    window.getByLabel("ブロック 2 を選択", { exact: true }),
    window.getByLabel("ブロック 1 を選択", { exact: true }),
  );
  await expect(window.locator(".folio-editor > :first-child")).toContainText(
    "日本語とEnglish",
  );
  await window.getByLabel("ブロック 1 を選択", { exact: true }).click();
  await window
    .getByLabel("ブロック 2 を選択", { exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(window.locator(".block-actions")).toContainText("2 ブロック");
  await window.getByLabel("ブロックを複製", { exact: true }).click();
  await expect(window.locator(".folio-editor h1")).toHaveCount(2);
  await window.getByLabel("元に戻す", { exact: true }).click();
  await expect(window.locator(".folio-editor h1")).toHaveCount(1);
  await window.getByLabel("やり直す", { exact: true }).click();
  await expect(window.locator(".folio-editor h1")).toHaveCount(2);
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  await window.keyboard.press("Meta+k");
  await window.getByLabel("検索キーワード").fill("日本語とEnglish");
  await expect(window.locator(".search-results")).toContainText(
    "検証ノート English",
  );
  await window.keyboard.press("Enter");
  await window.getByLabel("ページメニュー", { exact: true }).click();
  await window.getByRole("button", { name: "複製", exact: true }).click();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("検証ノート English のコピー");
  await window.getByLabel("ページメニュー", { exact: true }).click();
  await window
    .getByRole("button", { name: "ゴミ箱に移動", exact: true })
    .click();
  await window.getByRole("button", { name: /^ゴミ箱 / }).click();
  await expect(window.getByRole("dialog")).toContainText(
    "検証ノート English のコピー",
  );
  await window.getByRole("button", { name: "復元", exact: true }).click();
  await window.getByRole("button", { name: "閉じる", exact: true }).click();
  await window.keyboard.press("Meta+k");
  await window.getByLabel("検索キーワード").fill("検証ノート English");
  await window.locator(".search-results button").first().click();
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  const title = await window
    .getByLabel("ページタイトル", { exact: true })
    .inputValue();
  if (dragObserved) {
    await dragEvidence(dragSession(), test.info());
    dragObserved = false;
  }
  await app
    .context()
    .tracing.stop({ path: test.info().outputPath("before-restart.zip") });
  await app.close();
  await launch();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue(title);
  await expect(window.locator(".folio-editor")).toContainText(
    "日本語とEnglish",
  );
  await expect(
    window.locator(".folio-editor input[type=checkbox]").first(),
  ).toBeChecked();
  await window.getByLabel("テーマを切り替え").click();
  await expect(window.locator("html")).toHaveAttribute("data-theme", "dark");
  await window.screenshot({ path: "output/playwright/folio-dark.png" });
  expect(errors).toEqual([]);
});
test("database table edits, filters, sorts, board drop and calendar persistence", async () => {
  await window
    .getByRole("button", { name: "◈ プロジェクト", exact: true })
    .click();
  await expect(window.locator("tbody tr")).toHaveCount(3);
  await window.getByLabel("データベースを絞り込む").fill("進行中");
  await expect(window.locator("tbody tr")).toHaveCount(1);
  await window.getByLabel("データベースを絞り込む").fill("");
  await window.getByLabel("並べ替え", { exact: true }).selectOption("title");
  await window.getByRole("button", { name: "ボード", exact: true }).click();
  await expect(window.locator(".board-column")).toHaveCount(4);
  const card = window
    .locator(".db-card")
    .filter({ hasText: "次のアイデアを見つける" });
  const target = window
    .locator(".board-column")
    .filter({ has: window.locator("h4", { hasText: "完了" }) });
  await observeDrag(dragSession());
  dragObserved = true;
  await realDrag(window, card, target);
  await expect(target).toContainText("次のアイデアを見つける");
  await window.screenshot({ path: "output/playwright/folio-board.png" });
  await window.getByRole("button", { name: "カレンダー", exact: true }).click();
  await expect(window.locator(".day")).toHaveCount(42);
  await window.getByRole("button", { name: "ギャラリー", exact: true }).click();
  await expect(window.locator(".gallery .db-card")).toHaveCount(3);
  await window.getByRole("button", { name: "テーブル", exact: true }).click();
  await window.getByLabel("アイテム名").first().fill("変更を保存");
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  if (dragObserved) {
    await dragEvidence(dragSession(), test.info());
    dragObserved = false;
  }
  await app
    .context()
    .tracing.stop({ path: test.info().outputPath("before-restart.zip") });
  await app.close();
  await launch();
  await expect(window.locator("tbody tr")).toHaveCount(3);
  await expect(
    window.getByLabel("アイテム名").filter({ visible: true }).first(),
  ).toBeVisible();
  const values = await window
    .getByLabel("アイテム名")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
  expect(values).toContain("変更を保存");
});
test("security boundary, page hierarchy, cycle error and versions", async () => {
  const sec = await app.evaluate(({ BrowserWindow }) => {
    const p = (
      BrowserWindow.getAllWindows()[0].webContents as unknown as {
        getLastWebPreferences: () => {
          contextIsolation: boolean;
          nodeIntegration: boolean;
          sandbox: boolean;
        };
      }
    ).getLastWebPreferences();
    return {
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
      sandbox: p.sandbox,
    };
  });
  expect(sec).toEqual({
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  expect(
    await window.evaluate(
      () => typeof (window as unknown as { require?: unknown }).require,
    ),
  ).toBe("undefined");
  const rejected = await window.evaluate(async () => {
    try {
      await globalThis.window.folio.request({ type: "shell" } as never);
      return false;
    } catch {
      return true;
    }
  });
  expect(rejected).toBe(true);
  await window.getByLabel("ようこそ、Folioへ に子ページを作成").click();
  await window.getByLabel("ページタイトル", { exact: true }).fill("Nested");
  await expect(window.locator(".breadcrumbs")).toContainText(
    "ようこそ、Folioへ",
  );
  await window.locator(".folio-editor").click();
  await window.keyboard.insertText("Version one");
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  await window.keyboard.press("Meta+a");
  await window.keyboard.insertText("Version two");
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  await window.getByRole("button", { name: "変更履歴を見る" }).click();
  await expect(window.getByRole("dialog")).toContainText("Version one");
  await window
    .locator(".dialog-list>div")
    .filter({ hasText: "Version one" })
    .getByRole("button", { name: "復元" })
    .click();
  await expect(window.locator(".folio-editor")).toHaveText("Version one");
});
test("native rich HTML paste, Markdown shortcuts, toggle, links and block drag", async () => {
  await window.keyboard.press("Meta+n");
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("貼り付けテスト");
  await app.evaluate(async ({ clipboard, ClipboardItem }) => {
    (
      globalThis as unknown as { folioClipboard: Electron.ClipboardItem[] }
    ).folioClipboard = await Promise.all(
      // An empty native clipboard can contain an item with no exposed MIME
      // types. It has no payload to clone, and ClipboardItem rejects {}.
      (await clipboard.read()).filter((item) => item.types.length > 0).map(
        async (item) =>
          new ClipboardItem(
            Object.fromEntries(
              await Promise.all(
                item.types.map(async (type) => [
                  type,
                  await item.getType(type),
                ]),
              ),
            ),
          ),
      ),
    );
    await clipboard.write([
      new ClipboardItem({
        "text/html":
          "<h2>Clipboard 見出し</h2><p><strong>太字の日本語</strong> and <em>English</em></p><p>" +
          "長文コピー English 日本語 ".repeat(400) +
          "</p>",
        "text/plain": "fallback",
      }),
    ]);
  });
  try {
    await window.locator(".folio-editor").click();
    await window.keyboard.press("Meta+v");
    await expect(window.locator(".folio-editor strong")).toHaveText(
      "太字の日本語",
    );
    await expect(window.locator(".folio-editor em")).toHaveText("English");
    await expect(window.locator(".folio-editor")).toContainText("長文コピー");
  } finally {
    await app.evaluate(async ({ clipboard }) => {
      const saved =
        (globalThis as unknown as { folioClipboard: Electron.ClipboardItem[] })
          .folioClipboard;
      if (saved.length) await clipboard.write(saved);
      else clipboard.clear();
    });
  }
  await window.keyboard.press("Meta+End");
  await window.keyboard.press("ArrowDown");
  await window.keyboard.press("Enter");
  await window.keyboard.type("> ");
  await window.keyboard.insertText("折りたたむ内容");
  await expect(window.locator("[data-type=details]")).toHaveCount(1);
  await window.locator("[data-type=details]>button").click();
  await expect(window.locator("[data-type=details]")).toHaveClass(/is-open/);
  await window.getByTitle("ページへのリンク", { exact: true }).click();
  await window.getByLabel("検索キーワード").fill("アイデアノート");
  await expect(window.locator(".search-results button")).toHaveCount(1);
  await window.keyboard.press("Enter");
  await expect(window.locator(".folio-editor a")).toContainText(
    "アイデアノート",
  );
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  await window
    .getByRole("button", { name: "💡 アイデアノート", exact: true })
    .click();
  await expect(window.locator(".inspector")).toContainText("貼り付けテスト");
});
test("real import/export, image/file attachments and complete backup", async () => {
  const fs = await import("node:fs");
  const input = join(inputsDir, "import.md"),
    exported = join(exportsDir, "export.md");
  fs.writeFileSync(
    input,
    "# Imported 日本語\n\n**Bold** text and English.\n\n- [ ] task",
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, input);
  await window.getByRole("button", { name: "インポート", exact: true }).click();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("import");
  await expect(window.locator(".folio-editor h1")).toHaveText(
    "Imported 日本語",
  );
  await expect(window.locator(".folio-editor strong")).toHaveText("Bold");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: path,
    })) as typeof dialog.showSaveDialog;
  }, exported);
  await window.getByLabel("ページメニュー", { exact: true }).click();
  await window
    .getByRole("button", { name: "Markdownを書き出す", exact: true })
    .click();
  await expect.poll(() => fs.existsSync(exported)).toBe(true);
  expect(fs.readFileSync(exported, "utf8")).toContain("**Bold**");
  const png = join(inputsDir, "image.png");
  fs.copyFileSync("tests/fixtures/image.png", png);
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, png);
  await window.getByRole("button", { name: "添付", exact: true }).click();
  await expect(window.locator(".folio-editor img")).toHaveCount(1);
  await expect
    .poll(() =>
      window
        .locator(".folio-editor img")
        .evaluate((e: HTMLImageElement) => e.naturalWidth),
    )
    .toBeGreaterThan(0);
  const txt = join(inputsDir, "attachment.txt");
  fs.writeFileSync(txt, "添付テキスト");
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog;
  }, txt);
  await window.getByRole("button", { name: "添付", exact: true }).click();
  await expect(window.locator(".folio-editor a")).toContainText(
    "attachment.txt",
  );
  const downloaded = join(exportsDir, "downloaded.txt");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: path,
    })) as typeof dialog.showSaveDialog;
  }, downloaded);
  await window.locator(".folio-editor a").click();
  await expect.poll(() => fs.existsSync(downloaded)).toBe(true);
  expect(fs.readFileSync(downloaded, "utf8")).toBe("添付テキスト");
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  const backup = await window.evaluate(() =>
    globalThis.window.folio.request<string>({ type: "backup" }),
  );
  expect(fs.existsSync(join(backup, "workspace.sqlite"))).toBe(true);
  expect(fs.readdirSync(join(backup, "assets"))).toHaveLength(2);
  expect(fs.existsSync(join(backup, "manifest.json"))).toBe(true);
});
test("reproducible load: 150 pages, 1000 blocks, input and reopen", async () => {
  const fs = await import("node:fs");
  const started = Date.now();
  const id = await window.evaluate(async () => {
    const api = globalThis.window.folio;
    for (let i = 0; i < 150; i++)
      await api.request({
        type: "create",
        parentId: null,
        kind: "page",
        title: `Load page ${i}`,
      });
    const p = await api.request<{ id: string }>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "1000 blocks benchmark",
    });
    await api.request({
      type: "update",
      id: p.id,
      revision: 0,
      patch: {
        doc: {
          type: "doc",
          content: Array.from({ length: 1000 }, (_, i) => ({
            type: "paragraph",
            content: [
              { type: "text", text: `Block ${i} 日本語 English mixed text.` },
            ],
          })),
        },
      },
    });
    await api.request({ type: "setting", key: "activePage", value: p.id });
    return p.id;
  });
  const seededMs = Date.now() - started;
  const load = Date.now();
  await window.reload();
  await expect(window.locator(".folio-editor p")).toHaveCount(1000);
  const loadMs = Date.now() - load;
  const input = Date.now();
  await window.locator(".folio-editor p").first().click();
  await window.keyboard.press("Home");
  await window.keyboard.insertText("測定済み ");
  await expect(window.locator(".save-state")).toHaveText("保存済み");
  const inputMs = Date.now() - input;
  await app.close();
  const reopen = Date.now();
  await launch();
  await expect(window.locator(".folio-editor")).toContainText("測定済み");
  const reopenMs = Date.now() - reopen;
  const state = await window.evaluate(() =>
    globalThis.window.folio.request<{ pages: { id: string }[] }>({
      type: "load",
    }),
  );
  expect(state.pages.length).toBeGreaterThanOrEqual(155);
  expect(state.pages.some((p) => p.id === id)).toBe(true);
  fs.writeFileSync(
    "output/benchmark.json",
    JSON.stringify(
      {
        date: "2026-10-26",
        pages: state.pages.length,
        blocks: 1000,
        seededMs,
        loadMs,
        inputMs,
        reopenMs,
        method:
          "Single warm local Electron sample; input includes automation click + native insertText + persisted UI acknowledgement. Not physical IME or p95.",
      },
      null,
      2,
    ),
  );
});
test("stale-write recovery preserves unsaved edits before reload", async () => {
  const fs = await import("node:fs");
  await window.evaluate(async () => {
    const api = globalThis.window.folio;
    const state = await api.request<{
      pages: { id: string; revision: number; title: string }[];
    }>({ type: "load" });
    const p = state.pages.find((p) => p.title === "ようこそ、Folioへ")!;
    await api.request({
      type: "update",
      id: p.id,
      revision: p.revision,
      patch: { title: "DB側の更新" },
    });
  });
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("未保存の題名");
  await expect(window.getByRole("alert")).toContainText("競合");
  await window.getByRole("button", { name: "保存を再試行" }).click();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("未保存の題名");
  const path = join(exportsDir, "recovery.json");
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: path,
    })) as typeof dialog.showSaveDialog;
  }, path);
  await window.getByRole("button", { name: "退避して再読込" }).click();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("DB側の更新");
  expect(fs.readFileSync(path, "utf8")).toContain("未保存の題名");
  await expect(window.getByRole("alert")).toHaveCount(0);
});
