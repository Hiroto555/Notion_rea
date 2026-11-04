import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  backlinkEntry,
  disposeR8,
  launchR8,
  openPageMenu,
  openR8Inspector,
  openR8Page,
  r8Data,
  r8Saved,
} from "./r8-fixture";

async function selectLinkText(
  window: Page,
  link: Locator,
  range: { start: number; end: number | "all" },
) {
  await window.locator(".folio-editor").click();
  const selectedText = await link.evaluate((element, config) => {
    const textNode = [...element.childNodes].find(
      (node) => node.nodeType === Node.TEXT_NODE,
    );
    if (!textNode) throw new Error("link text node unavailable");
    const text = textNode.textContent ?? "";
    const end =
      config.end === "all" ? text.length : Math.min(config.end, text.length);
    const start = Math.min(config.start, Math.max(0, end - 1));
    const selection = document.getSelection();
    if (!selection) throw new Error("selection unavailable");
    const domRange = document.createRange();
    domRange.setStart(textNode, start);
    domRange.setEnd(textNode, Math.max(start + 1, end));
    selection.removeAllRanges();
    selection.addRange(domRange);
    // The range is set synthetically, so notify the Editor synchronously
    // before sending a real editing key. Browser selectionchange is async.
    document.dispatchEvent(new Event("selectionchange"));
    return domRange.toString();
  }, range);
  await expect
    .poll(() =>
      window.locator(".folio-editor").evaluate((element) => {
        const { doc, selection } = (element as any).editor.state;
        return doc.textBetween(selection.from, selection.to);
      }),
    )
    .toBe(selectedText);
}

test("contextual backlinks show exact text from every linking page and follow to the source", async () => {
  const data = r8Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR8(data);
    app = running.app;
    const window = running.window;

    await openR8Page(window, data.target.title);
    const inspector = await openR8Inspector(window);
    await expect(
      inspector.getByRole("heading", { name: /バックリンク/ }),
    ).toBeVisible();

    // Two different source pages must contribute their own exact excerpt, not
    // a title-only list and not the first source's text repeated for both.
    await expect(inspector).toContainText("Alpha文脈");
    await expect(inspector).toContainText("共有リンク甲");
    await expect(inspector).toContainText("Alpha周辺");
    await expect(inspector).toContainText("Beta文脈");
    await expect(inspector).toContainText("共有リンク乙");
    await expect(inspector).toContainText("Beta周辺");

    const alpha = backlinkEntry(inspector, "R8 Backlink Alpha");
    const beta = backlinkEntry(inspector, "R8 Backlink Beta");
    await expect(alpha).toBeVisible();
    await expect(beta).toBeVisible();

    await alpha.click();
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue("R8 Backlink Alpha");
    await expect(window.locator(".folio-editor")).toContainText("Alpha文脈");
    await expect(
      window.locator(".folio-editor a").filter({ hasText: "共有リンク甲" }),
    ).toBeVisible();
  } finally {
    await disposeR8(data, app);
  }
});

test("backlinks refresh after a source edit, link removal and source trash", async () => {
  const data = r8Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR8(data);
    app = running.app;
    const window = running.window;

    await openR8Page(window, data.target.title);
    let inspector = await openR8Inspector(window);
    let alpha = backlinkEntry(inspector, "R8 Backlink Alpha");
    await alpha.click();
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue("R8 Backlink Alpha");

    // Replace text inside the link mark. Editing must keep the link and the
    // target's contextual backlink must reflect the new exact text live.
    const alphaLink = window
      .locator(".folio-editor a")
      .filter({ hasText: "共有リンク甲" })
      .first();
    await expect(alphaLink).toBeVisible();
    await selectLinkText(window, alphaLink, { start: 1, end: 3 });
    await window.keyboard.type("改訂");
    await expect(window.locator(".folio-editor")).toContainText("共改訂ンク甲");
    await expect(
      window.locator(".folio-editor a").filter({ hasText: "共改訂ンク甲" }),
    ).toBeVisible();
    await r8Saved(window);

    await openR8Page(window, data.target.title);
    inspector = await openR8Inspector(window);
    await expect(inspector).toContainText("共改訂ンク甲");
    await expect(backlinkEntry(inspector, "R8 Backlink Alpha")).toBeVisible();

    // Removing the link text itself must remove the contextual entry without
    // retaining a stale snippet or title.
    const beta = backlinkEntry(inspector, "R8 Backlink Beta");
    await beta.click();
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue("R8 Backlink Beta");
    const betaLink = window
      .locator(".folio-editor a")
      .filter({ hasText: "共有リンク乙" })
      .first();
    await expect(betaLink).toBeVisible();
    await selectLinkText(window, betaLink, { start: 0, end: "all" });
    await window.keyboard.press("Backspace");
    await expect(window.locator(".folio-editor")).not.toContainText(
      "共有リンク乙",
    );
    await r8Saved(window);

    await openR8Page(window, data.target.title);
    inspector = await openR8Inspector(window);
    await expect(inspector).not.toContainText("共有リンク乙");
    await expect(backlinkEntry(inspector, "R8 Backlink Beta")).toHaveCount(0);

    // Trashing a source page must also remove its live contextual entry.
    const gamma = backlinkEntry(inspector, "R8 Backlink Gamma");
    await expect(gamma).toBeVisible();
    await gamma.click();
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue("R8 Backlink Gamma");
    await openPageMenu(window);
    await window
      .getByRole("button", { name: "ゴミ箱に移動", exact: true })
      .click();
    await expect(
      window.getByTitle("R8 Backlink Gamma", { exact: true }),
    ).toHaveCount(0);

    await openR8Page(window, data.target.title);
    inspector = await openR8Inspector(window);
    await expect(inspector).not.toContainText("共有リンク丙");
    await expect(backlinkEntry(inspector, "R8 Backlink Gamma")).toHaveCount(0);
  } finally {
    await disposeR8(data, app);
  }
});
