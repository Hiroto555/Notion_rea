import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  collectIds,
  disposeR9,
  launchR9,
  nodesOfType,
  openPage,
  r9Data,
  r9Page,
  requireIntegratedBuild,
} from "./r9-fixture";

requireIntegratedBuild();

test("W3 acceptance: HTML clipboard copy of a multi-cell table regenerates every block ID", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR9(data);
    app = running.app;
    const window = running.window;

    await openPage(window, data.titles.table);
    const table = window.locator(".folio-editor table").first();
    await expect(table).toBeVisible();

    const before = await r9Page(window, data.table.id);
    const originalTable = nodesOfType(before?.doc, "table")[0];
    const originalIds = collectIds(originalTable);
    expect(originalIds.length).toBeGreaterThan(1);

    await window
      .getByRole("button", { name: "ブロック 1 を選択", exact: true })
      .click();
    const copied = await window.evaluate(() => {
      const host = document.querySelector(".editor-host")!;
      const clipboard = new DataTransfer();
      const event = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      });
      host.dispatchEvent(event);
      return {
        prevented: event.defaultPrevented,
        html: clipboard.getData("text/html"),
        plain: clipboard.getData("text/plain"),
      };
    });
    expect(copied.prevented).toBe(true);
    expect(copied.html).toContain("<table");
    expect(copied.html).toContain(
      'data-folio-block-id="' + originalTable.attrs.id + '"',
    );
    expect(copied.plain).toContain("セルB2");

    // Paste only the HTML representation, so ProseMirror's parseHTML path must
    // regenerate IDs instead of trusting the source document's identities.
    // This test covers HTML clipboard parsing and identities. Establish the
    // insertion selection through the real Editor so pending native selection
    // events from the block-copy button cannot replace the source table.
    await window.locator(".folio-editor").evaluate((element) => {
      const editor = (element as any).editor;
      editor.commands.focus(undefined, { scrollIntoView: false });
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    // Tiptap focus runs in requestAnimationFrame; Enter must not reach the
    // previously focused block-selection button while that frame is pending.
    await expect(window.locator(".folio-editor")).toBeFocused();
    await window.keyboard.press("Enter");
    await expect
      .poll(() =>
        window.locator(".folio-editor").evaluate((element) => {
          const { selection, doc } = (element as any).editor.state;
          return (
            selection.empty &&
            selection.from === doc.content.size - 1 &&
            selection.$from.depth === 1 &&
            selection.$from.parent.content.size === 0
          );
        }),
      )
      .toBe(true);
    const pasted = await window.evaluate((html) => {
      const host = document.querySelector(".folio-editor")!;
      const clipboard = new DataTransfer();
      clipboard.setData("text/html", html);
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      });
      host.dispatchEvent(event);
      return {
        prevented: event.defaultPrevented,
        hasFolioJSON: clipboard.types.includes(
          "application/x-folio-blocks+json",
        ),
      };
    }, copied.html);
    expect(pasted.prevented).toBe(true);
    expect(pasted.hasFolioJSON).toBe(false);

    await expect(window.locator(".folio-editor table")).toHaveCount(2);
    await expect
      .poll(
        async () =>
          nodesOfType((await r9Page(window, data.table.id))?.doc, "table")
            .length,
        { timeout: 15000 },
      )
      .toBe(2);

    const tables = window.locator(".folio-editor table");
    const firstText = await tables.nth(0).innerText();
    const secondText = await tables.nth(1).innerText();
    expect(secondText).toBe(firstText);
    expect(secondText).toContain("セルA1");
    expect(secondText).toContain("セルB2");

    const page = await r9Page(window, data.table.id);
    const storedTables = nodesOfType(page?.doc, "table");
    expect(storedTables).toHaveLength(2);
    const originalIdSet = new Set(originalIds);
    const pastedTable = storedTables.find((candidate) =>
      collectIds(candidate).every((id) => !originalIdSet.has(id)),
    );
    expect(pastedTable).toBeDefined();
    const firstStoredIds = collectIds(storedTables[0]);
    for (const id of firstStoredIds) expect(originalIdSet.has(id)).toBe(true);

    const allIds = collectIds(page?.doc);
    expect(allIds.length).toBeGreaterThan(originalIds.length * 2);
    expect(new Set(allIds).size).toBe(allIds.length);
    if (pastedTable) {
      expect(collectIds(pastedTable).length).toBe(originalIds.length);
      expect(JSON.stringify(pastedTable)).toContain("セルB2");
    }
  } finally {
    await disposeR9(data, app);
  }
});
