import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
let app: ElectronApplication, window: Page, folder: string;
async function launch() {
  app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: { ...process.env, FOLIO_DATA_DIR: folder },
  });
  window = await app.firstWindow();
  await window.waitForSelector(".page-title");
}
test.beforeEach(async () => {
  folder = mkdtempSync(resolve("output/gate-a-e2e-"));
  await launch();
});
test.afterEach(async () => {
  if (app) {
    try {
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.destroy();
      });
    } catch {}
    await app.close();
  }
  rmSync(folder, { recursive: true, force: true });
});
async function saveDialog(path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath: p,
    })) as typeof dialog.showSaveDialog;
  }, path);
}
async function openDialog(path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [p],
    })) as typeof dialog.showOpenDialog;
  }, path);
}
async function saved() {
  await expect(window.locator(".save-state")).toHaveText("保存済み");
}
test("F01 same-page sidebar/search reselection keeps editor, attachment, link and exports", async () => {
  await window.keyboard.press("Meta+n");
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Gate A original");
  await window.locator(".folio-editor").fill("Original body");
  await saved();
  await window
    .locator(".folio-editor")
    .evaluate((el) => ((globalThis as any).originalEditorDOM = el));
  for (let i = 0; i < 5; i++)
    await window
      .locator(".page-tree-label")
      .filter({ hasText: "Gate A original" })
      .click();
  await window.keyboard.press("Meta+p");
  await window.getByLabel("検索キーワード").fill("Gate A original");
  await window.locator(".search-results button").first().click();
  const md = join(folder, "export.md");
  await saveDialog(md);
  await window.getByLabel("ページメニュー", { exact: true }).click();
  await window
    .getByRole("button", { name: "Markdownを書き出す", exact: true })
    .click();
  await expect.poll(() => existsSync(md)).toBe(true);
  expect(readFileSync(md, "utf8")).toContain("Original body");
  expect(
    await window
      .locator(".folio-editor")
      .evaluate((el) => el === (globalThis as any).originalEditorDOM),
  ).toBe(true);
  await window.getByLabel("元に戻す", { exact: true }).click();
  await expect(window.locator(".folio-editor")).not.toContainText(
    "Original body",
  );
  await window.getByLabel("やり直す", { exact: true }).click();
  await expect(window.locator(".folio-editor")).toContainText("Original body");
  const file = join(folder, "note.txt");
  writeFileSync(file, "attachment");
  await openDialog(file);
  await window.getByRole("button", { name: "添付", exact: true }).click();
  await expect(window.locator(".folio-editor")).toContainText("note.txt");
  await window.getByTitle("ページへのリンク", { exact: true }).click();
  await window.getByLabel("検索キーワード").fill("アイデアノート");
  await window.locator(".search-results button").first().click();
  await expect(window.locator(".folio-editor")).toContainText("アイデアノート");
  const html = join(folder, "export.html");
  await saveDialog(html);
  await window.getByLabel("ページメニュー", { exact: true }).click();
  await window
    .getByRole("button", { name: "HTMLを書き出す", exact: true })
    .click();
  await expect.poll(() => existsSync(html)).toBe(true);
  expect(readFileSync(html, "utf8")).toContain("Original body");
  await saved();
});
for (const name of [
  "LICENSE",
  "資料.日本語",
  "file.abcdefghijklmnop",
  "archive.tar.gz",
  "IMAGE.PNG",
])
  test("F05 attachment roundtrip " + name, async () => {
    const source = join(folder, name),
      dest = join(folder, "download");
    const bytes = Buffer.from([0, 255, 1, 128, 10]);
    writeFileSync(source, bytes);
    await openDialog(source);
    const file = await window.evaluate(() =>
      globalThis.window.folio.request<{ url: string }>({ type: "attach" }),
    );
    await saveDialog(dest);
    await window.evaluate(
      (url) =>
        globalThis.window.folio.request({ type: "downloadAttachment", url }),
      file.url,
    );
    expect(readFileSync(dest)).toEqual(bytes);
  });
test("F06 synthetic composing Enter does not navigate search or link (not physical IME)", async () => {
  for (const mode of ["search", "link"]) {
    if (mode === "search") await window.keyboard.press("Meta+p");
    else await window.getByTitle("ページへのリンク", { exact: true }).click();
    await window.getByLabel("検索キーワード").fill("アイデアノート");
    await expect(window.locator(".search-results button")).toHaveCount(1);
    await window.getByLabel("検索キーワード").evaluate((el) => {
      el.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(window.getByRole("dialog")).toBeVisible();
    await window
      .getByLabel("検索キーワード")
      .evaluate((el) =>
        el.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true }),
        ),
      );
    await window.keyboard.press("Escape");
  }
});
test("F11 editing during move and delayed load keeps local patch and durable revision", async () => {
  await window.keyboard.press("Meta+n");
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Before move");
  await saved();
  await app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any;
    const original = ipc._invokeHandlers.get("folio:request");
    let armed = false;
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, req: any) => {
      const result = await original(event, req);
      if (req.type === "move") armed = true;
      else if (req.type === "load" && armed) {
        armed = false;
        (globalThis as any).heldLoad = true;
        await new Promise<void>((r) => ((globalThis as any).releaseLoad = r));
      }
      return result;
    });
  });
  await window
    .locator(".page-tree-row")
    .filter({
      has: window.locator(".page-tree-label", { hasText: "Before move" }),
    })
    .dragTo(
      window.locator(".page-tree-row").filter({
        has: window.locator(".page-tree-label", {
          hasText: "アイデアノート",
        }),
      }),
    );
  await expect
    .poll(() => app.evaluate(() => (globalThis as any).heldLoad))
    .toBe(true);
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Local edit during move");
  await app.evaluate(() => (globalThis as any).releaseLoad());
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Local edit during move");
  await saved();
  const p = await window.evaluate(async () => {
    const s = await globalThis.window.folio.request<any>({ type: "load" });
    return s.pages.find((p: any) => p.title === "Local edit during move");
  });
  expect(p?.parentId).toBeTruthy();
  await app.close();
  await launch();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Local edit during move");
});

test("F02 full-text search, preview, count and in-page selection cross inline marks", async () => {
  const id = await window.evaluate(async () => {
    const p = await globalThis.window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Formatted words",
    });
    await globalThis.window.folio.request({
      type: "update",
      id: p.id,
      revision: 0,
      patch: {
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "不" },
                { type: "text", text: "動", marks: [{ type: "bold" }] },
                { type: "text", text: "産" },
                { type: "hardBreak" },
                { type: "text", text: "soft" },
                {
                  type: "text",
                  text: "ware",
                  marks: [
                    { type: "link", attrs: { href: "https://example.com" } },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    await globalThis.window.folio.request({
      type: "setting",
      key: "activePage",
      value: p.id,
    });
    return p.id;
  });
  await window.reload();
  await expect(window.locator(".folio-editor strong")).toHaveText("動");
  await expect(
    window
      .locator(".inspector dt")
      .filter({ hasText: "文字数" })
      .locator("+ dd"),
  ).toHaveText("12");
  await window.keyboard.press("Meta+p");
  await window.getByLabel("検索キーワード").fill("不動産");
  await expect(window.locator(".search-results button")).toHaveCount(1);
  await expect(window.locator(".search-results small")).toContainText("不動産");
  await window.keyboard.press("Enter");
  await window.keyboard.press("Meta+f");
  await window.getByLabel("ページ内検索").fill("不動産");
  await expect(window.locator(".page-find")).toContainText("1 件");
  await window.getByRole("button", { name: "表示", exact: true }).click();
  expect(
    await window.evaluate(() => globalThis.getSelection()?.toString()),
  ).toBe("不動産");
  const loaded = await window.evaluate(
    (id) =>
      globalThis.window.folio
        .request<any>({ type: "load" })
        .then((s) => s.pages.find((p: any) => p.id === id)),
    id,
  );
  expect(loaded.doc.content[0].content[1].marks[0].type).toBe("bold");
});
test("F04 DB delete Undo, restart history restore and property history retain IDs and values", async () => {
  await window
    .getByRole("button", { name: "◈ プロジェクト", exact: true })
    .click();
  const original = await window.evaluate(async () => {
    const s = await globalThis.window.folio.request<any>({ type: "load" });
    return s.pages.find((p: any) => p.title === "プロジェクト");
  });
  await window
    .getByLabel("削除 ワークスペースを整える", { exact: true })
    .click();
  await expect(window.locator("tbody tr")).toHaveCount(2);
  await window
    .getByRole("button", { name: "DB変更を元に戻す", exact: true })
    .click();
  await expect(window.locator("tbody tr")).toHaveCount(3);
  await saved();
  await window
    .getByLabel("削除 ワークスペースを整える", { exact: true })
    .click();
  await saved();
  await app.close();
  await launch();
  await expect(window.locator("tbody tr")).toHaveCount(2);
  await window
    .getByRole("button", { name: "変更履歴を見る", exact: true })
    .click();
  await window
    .getByRole("dialog")
    .locator(".dialog-list > div")
    .filter({ hasText: "3 行:" })
    .first()
    .getByRole("button", { name: "復元", exact: true })
    .click();
  await expect(window.locator("tbody tr")).toHaveCount(3);
  await saved();
  await expect(
    window.getByRole("button", { name: "DB変更を元に戻す", exact: true }),
  ).toBeDisabled();
  const restored = await window.evaluate(
    (id) =>
      globalThis.window.folio
        .request<any>({ type: "load" })
        .then((s) => s.pages.find((p: any) => p.id === id)),
    original.id,
  );
  expect(restored.database).toEqual(original.database);
  await window
    .getByRole("button", { name: "＋ プロパティ", exact: true })
    .click();
  await window.getByLabel("プロパティ名", { exact: true }).fill("追加列");
  await window.getByRole("button", { name: "追加", exact: true }).click();
  await expect(window.locator("thead")).toContainText("追加列");
  await saved();
  await window
    .getByRole("button", { name: "変更履歴を見る", exact: true })
    .click();
  await window
    .getByRole("dialog")
    .locator(".dialog-list > div")
    .first()
    .getByRole("button", { name: "復元", exact: true })
    .click();
  await expect(window.locator("thead")).not.toContainText("追加列");
  await saved();
  await app.close();
  await launch();
  await expect(window.locator("thead")).not.toContainText("追加列");
});
test("F06 editor selection Cmd+K sets page link without replacing text; modal and prevented keys win", async () => {
  await window.keyboard.press("Meta+n");
  await window.locator(".folio-editor").fill("Keep selected text");
  await window.locator(".folio-editor").click();
  await window.keyboard.press("Meta+a");
  await window.keyboard.press("Meta+k");
  await expect(
    window.getByRole("dialog", { name: "ページリンク", exact: true }),
  ).toBeVisible();
  await window.getByLabel("検索キーワード").fill("アイデアノート");
  await window.locator(".search-results button").first().click();
  await expect(window.locator(".folio-editor a")).toHaveText(
    "Keep selected text",
  );
  await saved();
  await window.evaluate(() => {
    document.addEventListener("keydown", (e) => e.preventDefault(), {
      once: true,
    });
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "p",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(window.getByRole("dialog")).toHaveCount(0);
  await window.keyboard.press("Meta+p");
  const before = await window.locator(".page-tree-label").count();
  await window.keyboard.press("Meta+n");
  await expect(
    window.getByRole("dialog", { name: "ワークスペース検索", exact: true }),
  ).toBeVisible();
  await expect(window.locator(".page-tree-label")).toHaveCount(before);
  await window.keyboard.press("Escape");
});
test("F07 invalid IPC is rejected and unknown stored schema is read-only with exact source export", async () => {
  const p = await window.evaluate(async () => {
    const s = await globalThis.window.folio.request<any>({ type: "load" });
    return s.pages.find((p: any) => p.title === "ようこそ、Folioへ");
  });
  const error = await window.evaluate(async (p) => {
    try {
      await globalThis.window.folio.request({
        type: "update",
        id: p.id,
        revision: p.revision,
        patch: {
          doc: { type: "doc", content: [{ type: "text", text: "bad" }] },
        },
      });
      return "accepted";
    } catch (e) {
      return String(e);
    }
  }, p);
  expect(error).toContain("Invalid");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(folder, "workspace.sqlite"));
  const raw = JSON.stringify({ ...p, doc: { ...p.doc, schemaVersion: 999 } });
  db.prepare("UPDATE pages SET data=? WHERE id=?").run(raw, p.id);
  db.close();
  await window.reload();
  await expect(window.getByRole("alert")).toContainText("原本を保全");
  await expect(window.locator(".folio-editor")).toHaveCount(0);
  const exportFile = join(folder, "raw.json");
  await saveDialog(exportFile);
  await window
    .getByRole("button", { name: "原本JSONを保存", exact: true })
    .click();
  await expect.poll(() => existsSync(exportFile)).toBe(true);
  expect(readFileSync(exportFile, "utf8")).toBe(raw);
  const after = await window.evaluate(
    (id) => globalThis.window.folio.request<string>({ type: "pageSource", id }),
    p.id,
  );
  expect(after).toBe(raw);
  await window.screenshot({ path: "output/gate-a/unsupported-document.png" });
});
test("F11 failed write exports pending patch and persisted state, then recovers a separate page", async () => {
  const original = await window.evaluate(async () => {
    const s = await globalThis.window.folio.request<any>({ type: "load" });
    const p = s.pages.find((p: any) => p.title === "ようこそ、Folioへ");
    await globalThis.window.folio.request({
      type: "update",
      id: p.id,
      revision: p.revision,
      patch: { title: "Stored competing title" },
    });
    return p;
  });
  await window
    .getByLabel("ページタイトル", { exact: true })
    .fill("Local unsaved title");
  await window.locator(".folio-editor").fill("Local unsaved body");
  await expect(window.getByRole("alert")).toContainText("競合");
  const recovery = join(folder, "recovery.json");
  await saveDialog(recovery);
  await window
    .getByRole("button", { name: "退避して再読込", exact: true })
    .click();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Stored competing title");
  const exported = JSON.parse(readFileSync(recovery, "utf8"));
  expect(exported.schemaVersion).toBe(2);
  expect(exported.pages).toHaveLength(1);
  expect(exported.pages[0].title).toBe("Local unsaved title");
  expect(JSON.stringify(exported.pages[0].doc)).toContain("Local unsaved body");
  await openDialog(recovery);
  await window.getByLabel("ページメニュー", { exact: true }).click();
  await window
    .getByRole("button", { name: "退避JSONから復旧", exact: true })
    .click();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue("Local unsaved title");
  await expect(window.locator(".folio-editor")).toContainText(
    "Local unsaved body",
  );
  await saved();
  const state = await window.evaluate(() =>
    globalThis.window.folio.request<any>({ type: "load" }),
  );
  expect(state.pages.find((p: any) => p.id === original.id).title).toBe(
    "Stored competing title",
  );
  await app.close();
  await launch();
  await expect(window.locator(".folio-editor")).toContainText(
    "Local unsaved body",
  );
});

test("F03 default userData path and pre-ready directory failure are observable without touching user data", async () => {
  const { spawn } = await import("node:child_process");
  const { default: executable } = await import("electron");
  const blocker = join(folder, "not-a-directory"),
    report = join(folder, "startup-error.json"),
    bootstrap = join(folder, "startup.cjs");
  writeFileSync(blocker, "keep");
  writeFileSync(
    bootstrap,
    `const {dialog}=require('electron'); dialog.showErrorBox=(title,message)=>require('node:fs').writeFileSync(${JSON.stringify(report)},JSON.stringify({title,message})); require(${JSON.stringify(resolve("dist/main.cjs"))});`,
  );
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(executable as unknown as string, [bootstrap], {
      env: { ...process.env, FOLIO_DATA_DIR: join(blocker, "workspace") },
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("startup failure did not exit"));
    }, 15000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  expect(exit).toBe(0);
  expect(JSON.parse(readFileSync(report, "utf8")).message).toContain(
    "保存先を作成できません",
  );
  expect(readFileSync(blocker, "utf8")).toBe("keep");
  const appData = join(folder, "isolated-app-data"),
    defaultBootstrap = join(folder, "default.cjs");
  writeFileSync(
    defaultBootstrap,
    `const {app}=require('electron'); require('node:fs').mkdirSync(${JSON.stringify(appData)},{recursive:true});app.setPath('appData',${JSON.stringify(appData)});require(${JSON.stringify(resolve("dist/main.cjs"))});`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.FOLIO_DATA_DIR;
  const other = await electron.launch({ args: [defaultBootstrap], env });
  try {
    const view = await other.firstWindow();
    await view.waitForSelector(".page-title");
    expect(await other.evaluate(({ app }) => app.getPath("userData"))).toBe(
      join(appData, "Folio"),
    );
    expect(
      existsSync(join(appData, "Folio", "workspace", "workspace.sqlite")),
    ).toBe(true);
  } finally {
    await other.close();
  }
});
test("F07 malformed JSON opens an error screen with backup, and null doc never mounts editor", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const original = await window.evaluate(async () => {
    const s = await globalThis.window.folio.request<any>({ type: "load" });
    return s.pages.find((p: any) => p.title === "ようこそ、Folioへ");
  });
  let db = new DatabaseSync(join(folder, "workspace.sqlite"));
  const nullDoc = JSON.stringify({ ...original, doc: null });
  db.prepare("UPDATE pages SET data=? WHERE id=?").run(nullDoc, original.id);
  db.close();
  await window.reload();
  await expect(window.getByRole("alert")).toContainText("原本を保全");
  await expect(window.locator(".folio-editor")).toHaveCount(0);
  db = new DatabaseSync(join(folder, "workspace.sqlite"));
  db.prepare("UPDATE pages SET data=? WHERE id=?").run(
    "{broken-json",
    original.id,
  );
  db.close();
  await app.close();
  app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: { ...process.env, FOLIO_DATA_DIR: folder },
  });
  window = await app.firstWindow();
  await expect(window.locator(".loading")).toContainText("壊れたJSON");
  await window
    .getByRole("button", { name: "原本のバックアップを保存", exact: true })
    .click();
  await expect(window.locator(".loading")).toContainText("バックアップ保存先:");
  db = new DatabaseSync(join(folder, "workspace.sqlite"), { readOnly: true });
  expect(
    db.prepare("SELECT data FROM pages WHERE id=?").get(original.id)?.data,
  ).toBe("{broken-json");
  db.close();
});
