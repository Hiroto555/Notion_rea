import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  r9Data,
  launchR9,
  disposeR9,
  r9Snapshot,
  r9Saved,
  installNativeDialogStub,
  setNativePaths,
  openPageMenu,
  openPage,
} from "./r9-acceptance/r9-fixture";

test("W3 exact Markdown roundtrip preserves rich text whitespace, blank code lines, links and cell paragraphs", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR9(data);
    app = running.app;
    const w = running.window;
    const source = {
      type: "doc",
      content: [
        {
          type: "callout",
          attrs: { tone: "warning" },
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "  見出し  の空白  " }],
            },
            {
              type: "details",
              attrs: { open: true },
              content: [
                {
                  type: "detailsSummary",
                  content: [{ type: "text", text: "  要約  の空白  " }],
                },
                {
                  type: "detailsContent",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "詳細" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "  空白  <記号> & 日本語  ",
                  marks: [{ type: "bold" }],
                },
              ],
            },
            {
              type: "codeBlock",
              attrs: { language: "ts" },
              content: [
                { type: "text", text: "let x = 1;\n\n  \nlet y = 2;\n" },
              ],
            },
          ],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "A | B \\ C" }],
                    },
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "  続き  ",
                          marks: [
                            { type: "italic" },
                            {
                              type: "link",
                              attrs: { href: "https://example.com/?a=1&b=2" },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "末尾" }] },
      ],
    };
    await w
      .locator(".folio-editor")
      .evaluate(
        (el, doc) => (el as any).editor.commands.setContent(doc),
        source,
      );
    await r9Saved(w);
    const normalize = (node: any): any =>
      Array.isArray(node)
        ? node.map(normalize)
        : node && typeof node === "object"
          ? Object.fromEntries(
              Object.entries(node)
                .filter(([key]) => !["id", "schemaVersion"].includes(key))
                .map(([key, value]) => [key, normalize(value)]),
            )
          : node;
    const before = await w
      .locator(".folio-editor")
      .evaluate((el) => (el as any).editor.getJSON());
    await installNativeDialogStub(app);
    const path = join(data.filesDir, "exact.md");
    await setNativePaths(app, { save: path });
    await openPageMenu(w);
    await w
      .getByRole("button", { name: "Markdownを書き出す", exact: true })
      .click();
    await expect.poll(() => existsSync(path)).toBe(true);
    const snapshot = await r9Snapshot(w);
    await w.getByLabel("ページタイトル", { exact: true }).fill("元の文章");
    await r9Saved(w);
    await setNativePaths(app, { open: path });
    await w.getByRole("button", { name: "インポート", exact: true }).click();
    await expect
      .poll(async () => (await r9Snapshot(w)).pages.length)
      .toBe(snapshot.pages.length + 1);
    const imported = (await r9Snapshot(w)).pages.find(
      (p) => !snapshot.pages.some((old) => old.id === p.id),
    )!;
    expect(normalize(imported.doc)).toEqual(normalize(before));
    await openPage(w, imported.title);
    await expect(w.locator(".folio-editor")).toContainText("let y = 2;");
  } finally {
    await disposeR9(data, app);
  }
});
