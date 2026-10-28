import { test, expect, saved } from "./next-round-fixture";
import { editorDoc } from "./drag-observer";
import type { Doc } from "../../src/shared/types";

test("Editor 3 synthetic block cut/paste retains IDs once and reopens", async ({
  folio: s,
}) => {
  const page = await s.window.evaluate(async () => {
    const p = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Clipboard R3",
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "block-a" },
          content: [{ type: "text", text: "Alpha", marks: [{ type: "bold" }] }],
        },
        {
          type: "paragraph",
          attrs: { id: "block-b" },
          content: [{ type: "text", text: "Beta" }],
        },
        {
          type: "paragraph",
          attrs: { id: "block-c" },
          content: [{ type: "text", text: "Tail" }],
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
  await s.window.reload();
  await s.window.waitForSelector(".folio-editor");
  await s.window
    .getByRole("button", { name: "ブロック 1 を選択", exact: true })
    .click();
  await s.window
    .getByRole("button", { name: "ブロック 2 を選択", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(s.window.locator(".block-actions")).toContainText("2 ブロック");
  const cut = await s.window.evaluate(() => {
    const host = document.querySelector(".editor-host")!;
    const data = new DataTransfer();
    const event = new ClipboardEvent("cut", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    host.dispatchEvent(event);
    (window as any).r3Clipboard = data;
    return {
      prevented: event.defaultPrevented,
      type: data.types.includes("application/x-folio-blocks+json"),
      html: data.getData("text/html"),
      plain: data.getData("text/plain"),
    };
  });
  expect(cut.prevented).toBe(true);
  expect(cut.type).toBe(true);
  expect(cut.html).toContain("<strong>Alpha</strong>");
  expect(cut.plain).toBe("Alpha\nBeta");
  await expect
    .poll(async () => JSON.stringify(await editorDoc(s)))
    .not.toContain("Alpha");
  const paste = async () =>
    s.window.evaluate(() => {
      const el = document.querySelector(".folio-editor") as any;
      el.editor.commands.focus("end");
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: (window as any).r3Clipboard,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    });
  expect(await paste()).toBe(true);
  await expect
    .poll(async () => JSON.stringify(await editorDoc(s)))
    .toContain("Alpha");
  let doc = await editorDoc(s);
  expect(doc.content.map((n: any) => n.attrs?.id)).toEqual(
    expect.arrayContaining(["block-a", "block-b", "block-c"]),
  );
  expect(await paste()).toBe(true);
  await expect
    .poll(
      async () => JSON.stringify(await editorDoc(s)).match(/Alpha/g)?.length,
    )
    .toBe(2);
  doc = await editorDoc(s);
  const ids = doc.content.map((n: any) => n.attrs?.id).filter(Boolean);
  expect(new Set(ids).size).toBe(ids.length);
  await saved(s);
  await s.restart();
  expect(JSON.stringify(await editorDoc(s)).match(/Alpha/g)).toHaveLength(2);
  expect(
    await s.window.evaluate(() =>
      document.querySelector(".folio-editor")?.getAttribute("data-document-id"),
    ),
  ).toBe(page);
});

test("Editor 3 clipboard write failure does not delete selected blocks", async ({
  folio: s,
}) => {
  const handle = s.window.getByRole("button", {
    name: "ブロック 1 を選択",
    exact: true,
  });
  await handle.click();
  const before = await editorDoc(s);
  const prevented = await s.window.evaluate(() => {
    const data = new DataTransfer();
    Object.defineProperty(data, "setData", {
      value: () => {
        throw new Error("simulated clipboard failure");
      },
    });
    const event = new ClipboardEvent("cut", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    document.querySelector(".editor-host")!.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  expect(await editorDoc(s)).toEqual(before);
});

test("Editor 3 selects and cuts nested siblings and preserves IDs on paste", async ({
  folio: s,
}) => {
  await s.window.evaluate(async () => {
    const page = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Nested selection R3",
    });
    const item = (id: string) => ({
      type: "listItem",
      attrs: { id },
      content: [
        {
          type: "paragraph",
          attrs: { id: id + "-p" },
          content: [{ type: "text", text: id }],
        },
      ],
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          attrs: { id: "list" },
          content: [item("first"), item("second"), item("third")],
        },
        {
          type: "paragraph",
          attrs: { id: "tail" },
          content: [{ type: "text", text: "tail" }],
        },
      ],
    };
    await window.folio.request({
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
  });
  await s.window.reload();
  await s.window.waitForSelector(".folio-editor");
  await s.window
    .getByRole("button", { name: "ネストブロック 1.1 を選択", exact: true })
    .click();
  await s.window
    .getByRole("button", { name: "ネストブロック 1.2 を選択", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(s.window.getByLabel("ネストブロック操作")).toContainText(
    "2 ブロック",
  );
  const cut = await s.window.evaluate(() => {
    const data = new DataTransfer();
    const event = new ClipboardEvent("cut", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    document.querySelector(".editor-host")!.dispatchEvent(event);
    (window as any).r3Clipboard = data;
    return {
      prevented: event.defaultPrevented,
      raw: data.getData("application/x-folio-blocks+json"),
    };
  });
  expect(cut.prevented).toBe(true);
  expect(JSON.parse(cut.raw).context).toBe("bulletList");
  await expect
    .poll(async () => JSON.stringify(await editorDoc(s)))
    .not.toContain("first-p");
  await s.window.evaluate(() => {
    const editor = document.querySelector(".folio-editor") as any;
    editor.editor.commands.focus("end");
    editor.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: (window as any).r3Clipboard,
      }),
    );
  });
  await expect
    .poll(async () => JSON.stringify(await editorDoc(s)))
    .toContain("first-p");
  const after = JSON.stringify(await editorDoc(s));
  expect(after).toContain("second-p");
  await saved(s);
  await s.restart();
  expect(JSON.stringify(await editorDoc(s))).toContain("first-p");
});

test("Editor 3 preserves plain text boundaries and rejects grouped nested drag", async ({
  folio: s,
}) => {
  await s.window.evaluate(async () => {
    const page = await window.folio.request<any>({
      type: "create",
      parentId: null,
      kind: "page",
      title: "Nested drag guard",
    });
    const item = (id: string, content: Doc[]): Doc => ({
      type: "listItem",
      attrs: { id },
      content: [{ type: "paragraph", attrs: { id: id + "-p" }, content }],
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          attrs: { id: "list" },
          content: [
            item("first", [
              { type: "text", text: "Alpha" },
              { type: "hardBreak" },
              { type: "text", text: "Next" },
            ]),
            item("second", [{ type: "text", text: "Beta" }]),
            item("third", [{ type: "text", text: "Gamma" }]),
          ],
        },
        { type: "paragraph", attrs: { id: "tail" } },
      ],
    };
    await window.folio.request({
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
  });
  await s.window.reload();
  await s.window.waitForSelector(".folio-editor");
  await s.window
    .getByRole("button", { name: "ブロック 1 を選択", exact: true })
    .click();
  const plain = await s.window.evaluate(() => {
    const data = new DataTransfer();
    document
      .querySelector(".editor-host")!
      .dispatchEvent(
        new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    return data.getData("text/plain");
  });
  expect(plain).toBe("Alpha\nNext\nBeta\nGamma");
  await s.window
    .getByRole("button", { name: "ネストブロック 1.1 を選択", exact: true })
    .click();
  await s.window
    .getByRole("button", { name: "ネストブロック 1.2 を選択", exact: true })
    .click({ modifiers: ["Shift"] });
  await expect(s.window.getByLabel("ネストブロック操作")).toContainText(
    "2 ブロック",
  );
  const before = await editorDoc(s);
  const drag = await s.window.evaluate(() => {
    const first = document.querySelector(
      '[aria-label="ネストブロック 1.1 を選択"]',
    )!;
    const target = document.querySelector(
      '[aria-label="ネストブロック 1.3 を選択"]',
    )!;
    const data = new DataTransfer();
    const start = new DragEvent("dragstart", {
      bubbles: true,
      cancelable: true,
      dataTransfer: data,
    });
    first.dispatchEvent(start);
    const supplied = data.getData("application/x-folio-nested-block");
    data.setData("application/x-folio-nested-block", "first");
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      }),
    );
    return { prevented: start.defaultPrevented, supplied };
  });
  expect(drag.prevented).toBe(true);
  expect(drag.supplied).toBe("");
  expect(await editorDoc(s)).toEqual(before);
});

test("Editor 3 does not cut when either fallback clipboard format fails silently", async ({
  folio: s,
}) => {
  const handle = s.window.getByRole("button", {
    name: "ブロック 1 を選択",
    exact: true,
  });
  await handle.click();
  const before = await editorDoc(s);
  for (const ignored of ["text/html", "text/plain"]) {
    const prevented = await s.window.evaluate((format) => {
      const data = new DataTransfer();
      const original = data.setData.bind(data);
      Object.defineProperty(data, "setData", {
        value: (type: string, value: string) => {
          if (type !== format) original(type, value);
        },
      });
      const event = new ClipboardEvent("cut", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      document.querySelector(".editor-host")!.dispatchEvent(event);
      return event.defaultPrevented;
    }, ignored);
    expect(prevented).toBe(true);
    expect(await editorDoc(s)).toEqual(before);
  }
});

test("Editor 3 rejects direct block mutation in a read-only editor", async ({
  folio: s,
}) => {
  await s.window
    .getByRole("button", { name: "ブロック 1 を選択", exact: true })
    .click();
  const before = await editorDoc(s);
  const outcome = await s.window.evaluate(() => {
    const el = document.querySelector(".folio-editor") as any;
    const host = document.querySelector(".editor-host")!;
    const data = new DataTransfer();
    host.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
    el.editor.setEditable(false);
    const cut = new ClipboardEvent("cut", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    host.dispatchEvent(cut);
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    });
    el.dispatchEvent(paste);
    return {
      cutBlocked: cut.defaultPrevented,
      pasteBlocked: paste.defaultPrevented,
    };
  });
  expect(outcome).toEqual({ cutBlocked: true, pasteBlocked: true });
  await s.window
    .getByRole("button", { name: "ブロックを複製", exact: true })
    .click();
  expect(await editorDoc(s)).toEqual(before);
});
