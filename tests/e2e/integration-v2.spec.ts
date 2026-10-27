import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, expect, saved, openDialog } from "./next-round-fixture";
import { editorDoc } from "./drag-observer";

test("integrated editor, attachment, independent database views and theme persist together through restart", async ({
  folio: s,
}) => {
  const w = s.window;
  const page = await w.evaluate(async () => {
    const p = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "統合検証ノート",
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "大切な原文", marks: [{ type: "bold" }] },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "項目A" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "項目B" }],
                },
              ],
            },
          ],
        },
      ],
    };
    await window.folio.request({
      type: "update",
      id: p.id,
      revision: 0,
      patch: { doc },
    });
    await window.folio.request({
      type: "setting",
      key: "activePage",
      value: p.id,
    });
    return { id: p.id, doc };
  });
  await w.reload();
  await w.waitForSelector(".folio-editor");
  const load = async () =>
    s.window.evaluate(
      async () => await window.folio.request<any>({ type: "load" }),
    );
  const before = (await load()).pages.find((p: any) => p.id === page.id);
  expect(before.doc).toEqual(page.doc);
  await w.locator(".folio-editor > p").first().click();
  await w.keyboard.press("End");
  await w.keyboard.insertText(" 追記");
  await w.getByLabel("ネストブロック 2.2 を選択", { exact: true }).click();
  await w.getByLabel("ネストブロックを上へ", { exact: true }).click();
  await expect(w.locator(".folio-editor ul > li").first()).toContainText(
    "項目B",
  );
  const image = join(s.inputsDir, "integration.png");
  copyFileSync(resolve("tests/fixtures/image.png"), image);
  await openDialog(s, image);
  await w.getByRole("button", { name: "添付", exact: true }).click();
  await expect(w.locator(".folio-editor img")).toHaveCount(1);
  await expect
    .poll(() =>
      w
        .locator(".folio-editor img")
        .evaluate((e: HTMLImageElement) => e.naturalWidth),
    )
    .toBeGreaterThan(0);
  await saved(s);
  const noteDoc = await editorDoc(s);
  expect(noteDoc.content[0].content[0].marks).toContainEqual({ type: "bold" });
  expect(
    noteDoc.content
      .find((node: any) => node.type === "bulletList")
      .content.map((x: any) => x.content[0].content[0].text),
  ).toEqual(["項目B", "項目A"]);
  const ids: string[] = [];
  const visit = (node: any) => {
    if (node.attrs?.id) ids.push(node.attrs.id);
    node.content?.forEach(visit);
  };
  visit(noteDoc);
  expect(ids.length).toBeGreaterThan(4);
  expect(new Set(ids).size).toBe(ids.length);
  await w.getByLabel("テーマを切り替え").click();
  await expect(w.locator("html")).toHaveAttribute("data-theme", "dark");
  await w
    .locator(".page-tree-label")
    .filter({ hasText: "プロジェクト" })
    .click();
  await expect(w.locator("tbody tr")).toHaveCount(3);
  await w.getByLabel("ビュー名").fill("統合一覧");
  await w.getByRole("button", { name: "ボード", exact: true }).click();
  await w.getByLabel("ビュー名").fill("統合ボード");
  await w.getByLabel("データベースを絞り込む").fill("完了");
  await expect(w.locator(".db-card")).toHaveCount(1);
  await saved(s);
  const beforeRestart = await load();
  const noteBefore = beforeRestart.pages.find((p: any) => p.id === page.id);
  expect(noteBefore.doc).toEqual({ ...noteDoc, schemaVersion: 1 });
  const projectBefore = beforeRestart.pages.find(
    (p: any) => p.title === "プロジェクト",
  );
  expect(projectBefore.database.views.map((v: any) => v.name)).toContain(
    "統合一覧",
  );
  expect(projectBefore.database.views.map((v: any) => v.name)).toContain(
    "統合ボード",
  );
  await s.restart();
  const r = s.window;
  await expect(r.locator("html")).toHaveAttribute("data-theme", "dark");
  await r
    .locator(".page-tree-label")
    .filter({ hasText: "プロジェクト" })
    .click();
  await expect(r.getByLabel("ビュー名")).toHaveValue("統合ボード");
  await expect(r.getByLabel("データベースを絞り込む")).toHaveValue("完了");
  await r
    .getByRole("button", { name: "ビュー: 統合一覧", exact: true })
    .click();
  await expect(r.getByLabel("データベースを絞り込む")).toHaveValue("");
  await r
    .locator(".page-tree-label")
    .filter({ hasText: "統合検証ノート" })
    .click();
  await expect(r.locator(".folio-editor img")).toHaveCount(1);
  await expect
    .poll(() =>
      r
        .locator(".folio-editor img")
        .evaluate((e: HTMLImageElement) => e.naturalWidth),
    )
    .toBeGreaterThan(0);
  expect(await editorDoc(s)).toEqual(noteDoc);
  const afterRestart = await load();
  expect(afterRestart.pages.find((p: any) => p.id === page.id).doc).toEqual(
    noteBefore.doc,
  );
  expect(
    afterRestart.pages.find((p: any) => p.id === projectBefore.id).database
      .views,
  ).toEqual(projectBefore.database.views);
});
