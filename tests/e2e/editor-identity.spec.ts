import {
  test,
  expect,
  saved,
  saveDialog,
  openDialog,
} from "./next-round-fixture";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { editorDoc } from "./drag-observer";
import { realDrag } from "./real-drag";

test("Editor 2.0: legacy document obtains IDs on edit, survives restart and copy paste", async ({
  folio: s,
}) => {
  const w = s.window;
  const fixture = await w.evaluate(async () => {
    const page = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Identity legacy",
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Alpha", marks: [{ type: "bold" }] }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Nested" }],
                },
              ],
            },
          ],
        },
      ],
    };
    const saved = await window.folio.request<any>({
      type: "update",
      id: page.id,
      revision: 0,
      patch: { doc },
    });
    await window.folio.request({
      type: "setting",
      key: "activePage",
      value: page.id,
    });
    return { id: page.id, doc, revision: saved.revision };
  });
  await w.reload();
  await w.waitForSelector(".folio-editor");
  const readPage = async () =>
    w.evaluate(
      async (id) =>
        (await window.folio.request<any>({ type: "load" })).pages.find(
          (p: any) => p.id === id,
        ),
      fixture.id,
    );
  const gather = (doc: any) => {
    const result: string[] = [];
    const visit = (n: any) => {
      if (n.attrs?.id) result.push(n.attrs.id);
      n.content?.forEach(visit);
    };
    visit(doc);
    return result;
  };
  // StarterKit adds one trailing paragraph after a terminal list.
  await expect.poll(async () => gather(await editorDoc(s)).length).toBe(5);
  const initial = await editorDoc(s),
    initialIds = gather(initial);
  expect(new Set(initialIds).size).toBe(initialIds.length);
  const untouched = await readPage();
  expect(untouched.doc).toEqual(fixture.doc);
  expect(untouched.revision).toBe(fixture.revision);
  await w.locator(".folio-editor > p").first().click();
  await w.keyboard.press("End");
  await w.keyboard.insertText(" edited");
  await saved(s);
  const edited = await readPage();
  expect(gather(edited.doc)).toEqual(initialIds);
  expect(edited.doc.content[0].content[0].marks).toContainEqual({
    type: "bold",
  });
  await s.restart();
  expect(gather(await editorDoc(s))).toEqual(initialIds);
  const current = s.window;
  // Exercise the renderer's paste event with an in-memory synthetic clipboard;
  // this does not alter the user's OS clipboard.
  await current.evaluate(() => {
    const el = document.querySelector(".folio-editor") as any;
    const editor = el.editor;
    const html = editor.getHTML();
    editor.commands.focus("end");
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", "Alpha edited\nNested");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  });
  await expect
    .poll(async () => gather(await editorDoc(s)).length)
    .toBeGreaterThan(initialIds.length);
  const pasted = await editorDoc(s),
    afterIds = gather(pasted);
  expect(new Set(afterIds).size).toBe(afterIds.length);
  for (const id of initialIds) expect(afterIds).toContain(id);
  expect(JSON.stringify(pasted)).toContain("Nested");
  await saved(s);
  await s.restart();
  expect(gather(await editorDoc(s))).toEqual(afterIds);
});

test("Editor 2.0: nested sibling move, duplicate, undo/redo and restart", async ({
  folio: s,
}) => {
  const w = s.window;
  const id = await w.evaluate(async () => {
    const p = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Nested blocks",
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "Alpha", marks: [{ type: "bold" }] },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Bravo" }],
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
    return p.id;
  });
  await w.reload();
  await w.waitForSelector(".folio-editor");
  const current = async () => (await editorDoc(s)).content[0].content;
  await expect
    .poll(async () => (await current()).every((n: any) => !!n.attrs.id))
    .toBe(true);
  const initial = await current();
  await w.getByLabel("ネストブロック 1.2 を選択", { exact: true }).click();
  await w.getByLabel("ネストブロックを上へ", { exact: true }).click();
  await expect
    .poll(async () => (await current()).map((n: any) => n.attrs.id))
    .toEqual([initial[1].attrs.id, initial[0].attrs.id]);
  await w.getByLabel("ネストブロック 1.2 を選択", { exact: true }).click();
  await w.getByLabel("ネストブロックを複製", { exact: true }).click();
  await expect.poll(async () => (await current()).length).toBe(3);
  const duplicated = await current();
  expect(duplicated[2].attrs.id).not.toBe(initial[0].attrs.id);
  expect(duplicated[2].content[0].attrs.id).not.toBe(
    initial[0].content[0].attrs.id,
  );
  expect(duplicated[2].content[0].content[0].marks).toContainEqual({
    type: "bold",
  });
  await w.getByLabel("元に戻す", { exact: true }).click();
  await expect.poll(async () => (await current()).length).toBe(2);
  await w.getByLabel("やり直す", { exact: true }).click();
  await expect
    .poll(async () => (await current()).map((n: any) => n.attrs.id))
    .toEqual(duplicated.map((n: any) => n.attrs.id));
  await realDrag(
    w,
    w.getByLabel("ネストブロック 1.3 を選択", { exact: true }),
    w.getByLabel("ネストブロック 1.1 を選択", { exact: true }),
  );
  await expect
    .poll(async () => (await current()).map((n: any) => n.attrs.id))
    .toEqual([
      duplicated[2].attrs.id,
      duplicated[0].attrs.id,
      duplicated[1].attrs.id,
    ]);
  await w.locator(".folio-editor ul > li").first().locator("p").first().click();
  await w.getByLabel("カーソルのネストブロックを選択", { exact: true }).click();
  await w.getByLabel("ネストブロックを複製", { exact: true }).click();
  await expect.poll(async () => (await current())[0].content.length).toBe(2);
  const paragraphs = (await current())[0].content;
  expect(paragraphs[0].attrs.id).not.toBe(paragraphs[1].attrs.id);
  expect(paragraphs[1].content[0].marks).toContainEqual({ type: "bold" });
  await w.getByLabel("元に戻す", { exact: true }).click();
  await expect.poll(async () => (await current())[0].content.length).toBe(1);
  await w.getByLabel("やり直す", { exact: true }).click();
  await expect
    .poll(async () => (await current())[0].content.map((n: any) => n.attrs.id))
    .toEqual(paragraphs.map((n: any) => n.attrs.id));
  await saved(s);
  const before = await current();
  await s.restart();
  expect((await editorDoc(s)).content[0].content).toEqual(before);
  const stored = await s.window.evaluate(
    async (id) =>
      (await window.folio.request<any>({ type: "load" })).pages.find(
        (p: any) => p.id === id,
      ),
    id,
  );
  expect(stored.doc.content[0].content).toEqual(before);
});

test("Editor 2.0: drag a nested item between lists without changing identity", async ({
  folio: s,
}) => {
  const w = s.window;
  await w.evaluate(async () => {
    const p = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Cross-list move",
    });
    const item = (text: string) => ({
      type: "listItem",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const doc = {
      type: "doc",
      content: [
        { type: "bulletList", content: [item("A"), item("B")] },
        { type: "paragraph", content: [{ type: "text", text: "Separator" }] },
        { type: "bulletList", content: [item("C"), item("D")] },
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
  });
  await w.reload();
  await w.waitForSelector(".folio-editor");
  const read = async () => (await editorDoc(s)).content;
  await expect
    .poll(async () => !!(await read())[0].content[1].attrs.id)
    .toBe(true);
  const before = await read(),
    movedId = before[0].content[1].attrs.id;
  const childId = before[0].content[1].content[0].attrs.id;
  await realDrag(
    w,
    w.getByLabel("ネストブロック 1.2 を選択", { exact: true }),
    w.getByLabel("ネストブロック 3.1 を選択", { exact: true }),
  );
  await expect
    .poll(async () => (await read())[2].content.map((n: any) => n.attrs.id))
    .toEqual([
      movedId,
      before[2].content[0].attrs.id,
      before[2].content[1].attrs.id,
    ]);
  expect((await read())[0].content).toHaveLength(1);
  expect((await read())[2].content[0].content[0].attrs.id).toBe(childId);
  await w.getByLabel("元に戻す", { exact: true }).click();
  await expect
    .poll(async () => (await read())[0].content.map((n: any) => n.attrs.id))
    .toEqual(before[0].content.map((n: any) => n.attrs.id));
  await w.getByLabel("やり直す", { exact: true }).click();
  await expect
    .poll(async () => (await read())[2].content[0].attrs.id)
    .toBe(movedId);
  await saved(s);
  const after = await read();
  await s.restart();
  expect((await editorDoc(s)).content).toEqual(after);
});

test("Editor 2.0: a stale legacy edit retains IDs and content in recovery", async ({
  folio: s,
}) => {
  const w = s.window;
  const fixture = await w.evaluate(async () => {
    const p = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Legacy conflict",
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Original", marks: [{ type: "bold" }] },
          ],
        },
      ],
    };
    const saved = await window.folio.request<any>({
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
    return { id: p.id, revision: saved.revision, doc };
  });
  await w.reload();
  await w.waitForSelector(".folio-editor");
  await expect
    .poll(async () => (await editorDoc(s)).content[0].attrs?.id)
    .toBeTruthy();
  await w.evaluate(async (p) => {
    await window.folio.request({
      type: "update",
      id: p.id,
      revision: p.revision,
      patch: { title: "Competing update" },
    });
  }, fixture);
  await w.locator(".folio-editor p").first().click();
  await w.keyboard.press("End");
  await w.keyboard.insertText(" local edit");
  await expect(w.getByRole("alert")).toContainText("競合");
  const stored = await w.evaluate(
    async (id) =>
      (await window.folio.request<any>({ type: "load" })).pages.find(
        (p: any) => p.id === id,
      ),
    fixture.id,
  );
  expect(stored.doc).toEqual(fixture.doc);
  const file = join(s.exportsDir, "editor-conflict.json");
  await saveDialog(s, file);
  await w.getByRole("button", { name: "退避して再読込", exact: true }).click();
  await expect(w.getByLabel("ページタイトル", { exact: true })).toHaveValue(
    "Competing update",
  );
  const recovery = JSON.parse(readFileSync(file, "utf8"));
  expect(recovery.pages[0].doc.content[0].attrs.id).toBeTruthy();
  expect(JSON.stringify(recovery.pages[0].doc)).toContain("local edit");
  expect(JSON.stringify(recovery.pages[0].doc)).toContain("bold");
  await openDialog(s, file);
  const copies = await w.evaluate(() =>
    window.folio.request<any[]>({ type: "recover" }),
  );
  expect(copies[0].doc).toEqual(recovery.pages[0].doc);
  await s.restart();
  const final = await s.window.evaluate(
    async (id) =>
      (await window.folio.request<any>({ type: "load" })).pages.find(
        (p: any) => p.id === id,
      ),
    fixture.id,
  );
  expect(final.doc).toEqual(fixture.doc);
});
