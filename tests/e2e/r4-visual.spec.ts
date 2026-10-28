import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/persistence/store";
import { RecordRepository } from "../../src/persistence/record-repository";
import { markRecordStoreVersion } from "../../src/persistence/record-version";

test("R4 fixed viewport synthetic Page, database and record captures", async () => {
  const root = mkdtempSync(resolve("output/r4-visual-workspace-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const page = store.create(null, "page", "週次プロジェクトノート");
  store.update(page.id, page.revision, { doc: { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "今週の取り組み" }] },
    { type: "paragraph", content: [{ type: "text", text: "調査したことと次の一歩を、ひとつのページへ。合成データによる画面確認です。" }] }
  ] } });
  const db = store.create(null, "database", "合成タスクDB");
  const repository = new RecordRepository(store);
  store.transaction(() => { repository.createSchema(); repository.registerDatabase(db.id); markRecordStoreVersion(store.db); });
  repository.create(db.id, "募集資料を確認する", {});
  repository.create(db.id, "週次レビューをまとめる", {});
  store.close();
  const app = await electron.launch({ args: [resolve("dist/main.cjs")], env: { ...process.env, FOLIO_DATA_DIR: root } });
  try {
    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 900 });
    await window.locator(".page-tree-label").filter({ hasText: "週次プロジェクトノート" }).click();
    await expect(window.locator(".folio-editor")).toContainText("今週の取り組み");
    const dir = resolve("output/r4-visual", process.env.FOLIO_VISUAL_PHASE || "after");
    mkdirSync(dir, { recursive: true });
    await window.screenshot({ path: join(dir, "page.png") });
    await window.locator(".page-tree-label").filter({ hasText: "合成タスクDB" }).click();
    await expect(window.getByRole("button", { name: "開く 募集資料を確認する", exact: true })).toBeVisible();
    await window.screenshot({ path: join(dir, "database.png") });
    await window.getByRole("button", { name: "開く 募集資料を確認する", exact: true }).click();
    await expect(window.locator(".r3-record-page, .record-body-preview")).toBeVisible();
    await window.screenshot({ path: join(dir, "record.png") });
  } finally { await app.close(); rmSync(root, { recursive: true, force: true }); }
});
