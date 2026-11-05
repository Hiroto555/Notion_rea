import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { r4Data, launchR4, disposeR4, r4Saved } from "./r4-fixture";
import { DatabaseSync } from "node:sqlite";

const rich = {
  type: "doc",
  schemaVersion: 2,
  content: [
    {
      type: "callout",
      attrs: { tone: "tip", id: "callout-root" },
      content: [
        {
          type: "paragraph",
          attrs: { id: "callout-text" },
          content: [
            {
              type: "text",
              text: "  日本語  と <記号> & 空白  ",
              marks: [{ type: "bold" }],
            },
          ],
        },
      ],
    },
    {
      type: "table",
      attrs: { id: "table-root" },
      content: [
        {
          type: "tableRow",
          attrs: { id: "row-root" },
          content: [
            {
              type: "tableHeader",
              attrs: { id: "cell-a", colspan: 1, rowspan: 1, colwidth: null },
              content: [
                {
                  type: "paragraph",
                  attrs: { id: "cell-text-a" },
                  content: [{ type: "text", text: "A | B" }],
                },
              ],
            },
            {
              type: "tableHeader",
              attrs: { id: "cell-b", colspan: 1, rowspan: 1, colwidth: null },
              content: [
                {
                  type: "paragraph",
                  attrs: { id: "cell-text-b" },
                  content: [{ type: "text", text: "二つ目" }],
                },
                {
                  type: "paragraph",
                  attrs: { id: "cell-text-b2" },
                  content: [{ type: "text", text: "別の段落" }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "paragraph",
      attrs: { id: "tail" },
      content: [{ type: "text", text: "最後" }],
    },
  ],
};

test("W3 refuses merged/ragged/nested HTML paste and drop before normalization", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const w = running.window;
    const body = w.locator(".folio-editor");
    await body.fill("保持する本文");
    await r4Saved(w);
    for (const html of [
      '<table><tr><td colspan="2">結合</td></tr></table>',
      "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>",
      "<table><tr><td><table><tr><td>入れ子</td></tr></table></td></tr></table>",
    ]) {
      const result = await body.evaluate((el, html) => {
        const e = (el as any).editor;
        const before = e.getJSON();
        const clipboardData = new DataTransfer();
        clipboardData.setData("text/html", html);
        const event = new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        });
        el.dispatchEvent(event);
        return {
          prevented: event.defaultPrevented,
          before,
          after: e.getJSON(),
        };
      }, html);
      expect(result.prevented).toBe(true);
      expect(result.after).toEqual(result.before);
    }
    await expect(body).toHaveText("保持する本文");
    const snapshot = await w.evaluate(() =>
      window.folio.request<any>({ type: "load" }),
    );
    const id = await body.getAttribute("data-document-id");
    expect(
      JSON.stringify(snapshot.pages.find((p: any) => p.id === id).doc),
    ).toContain("保持する本文");
    expect(
      JSON.stringify(snapshot.pages.find((p: any) => p.id === id).doc),
    ).not.toContain("table");
  } finally {
    await disposeR4(data, app);
  }
});

test("W3 first rich save creates verified pre-change snapshot, then restart preserves new doc", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR4(data);
    app = running.app;
    let w = running.window;
    const old = await w.evaluate(() =>
      window.folio.request<any>({ type: "load" }),
    );
    const id = await w
      .locator(".folio-editor")
      .getAttribute("data-document-id");
    await w
      .locator(".folio-editor")
      .evaluate((el, doc) => (el as any).editor.commands.setContent(doc), rich);
    await r4Saved(w);
    const after = await w.evaluate(() =>
      window.folio.request<any>({ type: "load" }),
    );
    expect(after.pages.find((p: any) => p.id === id).doc.schemaVersion).toBe(2);
    // Inspect independent raw snapshot bytes, not the backup verifier's report.
    const backups = join(data.root, "backups");
    const names = readdirSync(backups).filter((n) =>
      n.startsWith("before-rich-blocks-"),
    );
    expect(names).toHaveLength(1);
    const backup = join(backups, names[0]);
    expect(
      JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8")).format,
    ).toBe("folio-workspace-backup");
    const db = new DatabaseSync(join(backup, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      const raw = db.prepare("SELECT data FROM pages WHERE id=?").get(id!) as {
        data: string;
      };
      expect(JSON.parse(raw.data).doc).toEqual(
        old.pages.find((p: any) => p.id === id).doc,
      );
    } finally {
      db.close();
    }
    const saved = after.pages.find((p: any) => p.id === id).doc;
    await app.close();
    app = undefined;
    running = await launchR4(data);
    app = running.app;
    w = running.window;
    await expect(w.locator("aside[data-folio-callout]")).toBeVisible();
    await expect(w.locator(".folio-editor table")).toBeVisible();
    const restarted = await w.evaluate(() =>
      window.folio.request<any>({ type: "load" }),
    );
    expect(restarted.pages.find((p: any) => p.id === id).doc).toEqual(saved);
  } finally {
    await disposeR4(data, app);
  }
});

test("W3 rich block cut/paste consumes identity once and copy assigns every descendant a new ID", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const w = running.window;
    await w
      .locator(".folio-editor")
      .evaluate((el, doc) => (el as any).editor.commands.setContent(doc), rich);
    await r4Saved(w);
    await w
      .getByRole("button", { name: "ブロック 2 を選択", exact: true })
      .click();
    const cut = await w.evaluate(() => {
      const data = new DataTransfer();
      document
        .querySelector(".editor-host")!
        .dispatchEvent(
          new ClipboardEvent("cut", {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          }),
        );
      (window as any).r9Clip = data;
      return JSON.parse(data.getData("application/x-folio-blocks+json"));
    });
    expect(cut.version).toBe(2);
    await expect(w.locator(".folio-editor table")).toHaveCount(0);
    const paste = () =>
      w.locator(".folio-editor").evaluate((el) => {
        (el as any).editor.commands.focus("end");
        el.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: (window as any).r9Clip,
          }),
        );
      });
    await paste();
    await expect(w.locator(".folio-editor table")).toHaveCount(1);
    expect(
      await w
        .locator(".folio-editor table")
        .getAttribute("data-folio-block-id"),
    ).toBe("table-root");
    await paste();
    await expect(w.locator(".folio-editor table")).toHaveCount(2);
    const ids = await w
      .locator(".folio-editor [data-folio-block-id]")
      .evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-folio-block-id")),
      );
    expect(new Set(ids).size).toBe(ids.length);
    await r4Saved(w);
  } finally {
    await disposeR4(data, app);
  }
});

test("W3 backup failure retains the rich draft and leaves the saved page untouched", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const w = running.window;
    const before = await w.evaluate(() =>
      window.folio.request<any>({ type: "load" }),
    );
    const id = await w
      .locator(".folio-editor")
      .getAttribute("data-document-id");
    const block = join(data.root, "backups");
    expect(existsSync(block)).toBe(false);
    writeFileSync(block, "synthetic blocked backup destination", {
      flag: "wx",
    });
    await w
      .locator(".folio-editor")
      .evaluate((el, doc) => (el as any).editor.commands.setContent(doc), rich);
    await expect(w.locator(".folio-editor table")).toBeVisible();
    await expect
      .poll(() => w.locator(".save-state").textContent())
      .not.toBe("保存済み");
    await expect(
      w.getByRole("button", { name: "保存を再試行", exact: true }),
    ).toBeVisible();
    const blocked = await w.evaluate(() =>
      window.folio.request<any>({ type: "load" }),
    );
    expect(blocked.pages.find((p: any) => p.id === id)).toEqual(
      before.pages.find((p: any) => p.id === id),
    );
    await expect(w.locator(".folio-editor aside")).toContainText("日本語");
    expect(readFileSync(block, "utf8")).toBe(
      "synthetic blocked backup destination",
    );
    unlinkSync(block);
    await w.getByRole("button", { name: "保存を再試行", exact: true }).click();
    // Resolve-first retry now keeps the original revision and operation ID.
    // With no competing edit, fixing the backup destination permits one save.
    await expect(w.locator(".save-state")).toHaveText("保存済み");
    await expect(w.locator(".folio-editor table")).toBeVisible();
    const afterRetry = await w.evaluate(() =>
      window.folio.request<any>({ type: "load" }),
    );
    const restored = afterRetry.pages.find((p: any) => p.id === id);
    expect(restored.revision).toBe(before.pages.find((p: any) => p.id === id).revision + 1);
    expect(restored.doc.content).toEqual(await w.locator(".folio-editor").evaluate((el) => (el as any).editor.getJSON().content));
    expect(JSON.stringify(restored.doc)).toContain("callout-root");
    expect(existsSync(block)).toBe(true);
  } finally {
    await disposeR4(data, app);
  }
});

test("W3 composing keys and read-only commands leave rich content and selection untouched", async () => {
  const data = r4Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR4(data);
    app = running.app;
    const w = running.window;
    const body = w.locator(".folio-editor");
    await body.evaluate(
      (el, doc) => (el as any).editor.commands.setContent(doc),
      rich,
    );
    await r4Saved(w);
    await body.locator("th").first().click();
    const composition = await body.evaluate((el) => {
      const e = (el as any).editor;
      const before = e.getJSON(),
        from = e.state.selection.from;
      for (const key of ["Tab", "Enter"])
        el.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            isComposing: true,
          }),
        );
      return {
        before,
        after: e.getJSON(),
        from,
        afterFrom: e.state.selection.from,
      };
    });
    expect(composition.after).toEqual(composition.before);
    expect(composition.afterFrom).toBe(composition.from);
    const cellPaste = await body.evaluate((el) => {
      const e = (el as any).editor,
        before = e.getJSON();
      const data = new DataTransfer();
      data.setData(
        "text/html",
        "<table><tr><td><p>セル内に入れない表</p></td></tr></table>",
      );
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      });
      el.dispatchEvent(event);
      return { before, after: e.getJSON(), prevented: event.defaultPrevented };
    });
    expect(cellPaste.prevented).toBe(true);
    expect(cellPaste.after).toEqual(cellPaste.before);
    const readonly = await body.evaluate((el) => {
      const e = (el as any).editor;
      const before = e.getJSON();
      e.setEditable(false);
      const results = [
        e.commands.addSimpleRow(),
        e.commands.deleteSimpleColumn(),
        e.commands.insertSimpleTable(),
        e.commands.setCallout("tip"),
      ];
      return { before, after: e.getJSON(), results };
    });
    expect(readonly.results).toEqual([false, false, false, false]);
    expect(readonly.after).toEqual(readonly.before);
  } finally {
    await disposeR4(data, app);
  }
});
