import { test, expect, saved } from "./next-round-fixture";
import { observeDrag, dragEvidence, editorDoc } from "./drag-observer";
import { realDrag } from "./real-drag";
test("R2 short original regression: checkbox edit then real handle drag", async ({
  folio: s,
}, info) => {
  const w = s.window;
  await w.keyboard.press("Meta+n");
  await w.getByLabel("ページタイトル", { exact: true }).fill("Drag regression");
  await w.locator(".folio-editor").click();
  await w.keyboard.type("/heading");
  await w.keyboard.press("Enter");
  await w.keyboard.insertText("Alpha heading");
  await w.keyboard.press("Enter");
  await w.keyboard.insertText("Bravo 不動産");
  await w.keyboard.press("Enter");
  await w.keyboard.type("/todo");
  await w.keyboard.press("Enter");
  await w.keyboard.insertText("Charlie task");
  await observeDrag(s);
  try {
    await w.locator(".folio-editor input[type=checkbox]").check();
    const before = await editorDoc(s);
    await realDrag(
      w,
      w.getByLabel("ブロック 2 を選択", { exact: true }),
      w.getByLabel("ブロック 1 を選択", { exact: true }),
    );
    await expect
      .poll(async () => (await editorDoc(s)).content)
      .toEqual([
        before.content[1],
        before.content[0],
        ...before.content.slice(2),
      ]);
    await saved(s);
  } finally {
    await dragEvidence(s, info);
  }
});
test("R2 top-level matrix: single/multiple/start/end/same/cancel/scroll/undo/redo/restart", async ({
  folio: s,
}, info) => {
  const w = s.window;
  const id = await w.evaluate(async () => {
    const p = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Drag matrix",
    });
    const content = Array.from({ length: 30 }, (_, i) => ({
      type: i === 0 ? "heading" : "paragraph",
      ...(i === 0 ? { attrs: { level: 1 } } : {}),
      content: [
        {
          type: "text",
          text: ["Alpha", "Bravo", "Charlie"][i] ?? `Block ${i + 1}`,
          marks:
            i === 1 ? [{ type: "bold" }] : i === 2 ? [{ type: "italic" }] : [],
        },
      ],
    }));
    await window.folio.request({
      type: "update",
      id: p.id,
      revision: 0,
      patch: { doc: { type: "doc", content } },
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
  await observeDrag(s);
  const handle = (n: number) =>
    w.getByLabel(`ブロック ${n} を選択`, { exact: true });
  const before = await editorDoc(s);
  const assertDoc = async (content: any[]) => {
    await expect
      .poll(async () => (await editorDoc(s)).content)
      .toEqual(content);
    await saved(s);
  };
  try {
    const first = [
      before.content[1],
      before.content[0],
      ...before.content.slice(2),
    ];
    await realDrag(w, handle(2), handle(1));
    await assertDoc(first);
    await w.getByLabel("元に戻す", { exact: true }).click();
    await assertDoc(before.content);
    await w.getByLabel("やり直す", { exact: true }).click();
    await assertDoc(first);
    await w.getByLabel("元に戻す", { exact: true }).click();
    await assertDoc(before.content);
    await handle(2).click();
    await handle(3).click({ modifiers: ["Shift"] });
    await expect(w.locator(".block-actions")).toContainText("2 ブロック");
    const multi = [
      before.content[1],
      before.content[2],
      before.content[0],
      ...before.content.slice(3),
    ];
    await realDrag(w, handle(2), handle(1));
    await assertDoc(multi);
    // A no-op must not hide the preceding move from Undo.
    await realDrag(w, handle(1), handle(1));
    await assertDoc(multi);
    await w.getByLabel("元に戻す", { exact: true }).click();
    await assertDoc(before.content);
    await w.getByLabel("やり直す", { exact: true }).click();
    await assertDoc(multi);
    const source = await handle(2).boundingBox(),
      target = await handle(1).boundingBox();
    await w.mouse.move(source!.x + 11, source!.y + 13);
    await w.mouse.down();
    await w.mouse.move(source!.x + 18, source!.y + 20);
    await w.mouse.move(target!.x + 11, target!.y + 13);
    await w.mouse.move(target!.x + 12, target!.y + 14);
    await w.keyboard.press("Escape");
    await w.mouse.up();
    await assertDoc(multi);
    await handle(20).scrollIntoViewIfNeeded();
    expect(
      await w.locator(".document-scroll").evaluate((el) => el.scrollTop),
    ).toBeGreaterThan(0);
    await realDrag(w, handle(20), handle(18));
    const scrolled = [...multi];
    const [moved] = scrolled.splice(19, 1);
    scrolled.splice(17, 0, moved);
    await assertDoc(scrolled);
    await handle(28).scrollIntoViewIfNeeded();
    await realDrag(w, handle(28), w.locator(".block-end-drop"));
    const ended = [...scrolled];
    ended.push(...ended.splice(27, 1));
    await assertDoc(ended);
    await w.getByLabel("元に戻す", { exact: true }).click();
    await assertDoc(scrolled);
    await w.getByLabel("やり直す", { exact: true }).click();
    await assertDoc(ended);
    const stored = await w.evaluate(
      async (id) =>
        (await window.folio.request<any>({ type: "load" })).pages.find(
          (p: any) => p.id === id,
        ).doc,
      id,
    );
    expect(stored.content).toEqual(ended);
    await dragEvidence(s, info);
    await s.restart();
    expect((await editorDoc(s)).content).toEqual(ended);
  } finally {
    if (s.window === w) await dragEvidence(s, info);
  }
});
