import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  contentWidth,
  disposeR8,
  launchR8,
  maximizeDocumentArea,
  openR8Database,
  openR8Page,
  openR8Record,
  pageWidthState,
  r8Data,
  r8Database,
  r8PageWidth,
  r8Saved,
  setPageWidth,
} from "./r8-fixture";

test("ordinary page width changes from 標準 to ワイド, keeps one Editor and Undo, and survives restart", async () => {
  const data = r8Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR8(data);
    app = running.app;
    let window = running.window;

    await openR8Page(window, data.home.title);
    await maximizeDocumentArea(window);
    const standardWidth = await contentWidth(window);

    const editor = window.locator(".folio-editor");
    await editor.click();
    await window.keyboard.press("End");
    await window.keyboard.type("幅切替の一時入力");
    await r8Saved(window);
    await editor.evaluate((element) => {
      (window as any).__r8EditorBeforeWidth = element;
    });

    await setPageWidth(window, "ワイド");
    await expect
      .poll(() => r8PageWidth(window, data.home.id))
      .toBe("wide");
    await maximizeDocumentArea(window);
    const wideWidth = await contentWidth(window);
    expect(wideWidth).toBeGreaterThan(standardWidth + 40);
    expect(
      await window.evaluate(
        () =>
          (window as any).__r8EditorBeforeWidth ===
          document.querySelector(".folio-editor"),
      ),
    ).toBe(true);

    await editor.click();
    await window.keyboard.press("End");
    await window.keyboard.press("Meta+z");
    await expect(editor).not.toContainText("幅切替の一時入力");
    await r8Saved(window);

    await app.close();
    app = undefined;
    running = await launchR8(data);
    app = running.app;
    window = running.window;
    await openR8Page(window, data.home.title);
    await maximizeDocumentArea(window);
    const persistedWidth = await contentWidth(window);
    expect(persistedWidth).toBeGreaterThan(standardWidth + 40);
    expect(await r8PageWidth(window, data.home.id)).toBe("wide");
    await expect.poll(() => pageWidthState(window)).toBe("ワイド");
  } finally {
    await disposeR8(data, app);
  }
});

test("record/database width change preserves raw numeric input and canonical values across restart", async () => {
  const data = r8Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR8(data);
    app = running.app;
    let window = running.window;

    await openR8Database(window, data.owner.title);
    await maximizeDocumentArea(window);
    const wideWidth = await contentWidth(window);
    await setPageWidth(window, "標準");
    await expect
      .poll(() => r8PageWidth(window, data.owner.id))
      .toBe("standard");
    await maximizeDocumentArea(window);
    const standardWidth = await contentWidth(window);
    expect(wideWidth).toBeGreaterThan(standardWidth + 40);

    await openR8Record(window, data.records.alpha.title);
    const recordSurface = window.locator(".r3-record-page");
    let numeric = recordSurface.getByLabel("見積", { exact: true });
    await numeric.fill("-");
    await expect(numeric).toHaveValue("-");
    const recordEditor = recordSurface.locator(".folio-editor");
    await recordEditor.click();
    await window.keyboard.press("End");
    await window.keyboard.type("幅切替の記録本文");
    await recordEditor.click();
    await window.keyboard.press("End");
    await window.keyboard.press("Meta+z");
    await expect(recordEditor).not.toContainText("幅切替の記録本文");
    // The incomplete numeric draft is deliberately still present.
    await expect(numeric).toHaveValue("-");

    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    const row = window.locator(
      `tr[data-record-id="${data.records.alpha.pageId}"]`,
    );
    await expect(
      row.getByLabel(`見積 ${data.records.alpha.title}`, { exact: true }),
    ).toHaveValue("-");

    await setPageWidth(window, "ワイド");
    await expect
      .poll(() => r8PageWidth(window, data.owner.id))
      .toBe("wide");
    await maximizeDocumentArea(window);
    const widenedWidth = await contentWidth(window);
    expect(widenedWidth).toBeGreaterThan(standardWidth + 40);
    await expect
      .poll(async () => {
        const projection = await r8Database(window, data.owner.id);
        return projection.records.find(
          (candidate) => candidate.pageId === data.records.alpha.pageId,
        )?.values.estimate;
      })
      .toBe(7);

    // Reopening the record proves the width change did not discard the raw
    // numeric draft or the single Editor's canonical body.
    await openR8Record(window, data.records.alpha.title);
    numeric = window
      .locator(".r3-record-page")
      .getByLabel("見積", { exact: true });
    await expect(numeric).toHaveValue("-");
    await expect(
      window.locator(".r3-record-page .folio-editor"),
    ).toContainText("R8 Alpha record body");
    await numeric.fill("7");
    await expect(numeric).toHaveValue("7");
    await r8Saved(window);
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();

    await app.close();
    app = undefined;
    running = await launchR8(data);
    app = running.app;
    window = running.window;
    await openR8Database(window, data.owner.title);
    await maximizeDocumentArea(window);
    const persistedWidth = await contentWidth(window);
    expect(persistedWidth).toBeGreaterThan(standardWidth + 40);
    expect(await r8PageWidth(window, data.owner.id)).toBe("wide");
    await expect.poll(() => pageWidthState(window)).toBe("ワイド");
    await expect(
      window
        .locator(`tr[data-record-id="${data.records.alpha.pageId}"]`)
        .getByLabel(`見積 ${data.records.alpha.title}`, { exact: true }),
    ).toHaveValue("7");
  } finally {
    await disposeR8(data, app);
  }
});
