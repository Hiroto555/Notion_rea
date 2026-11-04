import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  TABLE_CONTROLS,
  chooseCalloutTone,
  disposeR9,
  insertSlashBlock,
  launchR9,
  nodesOfType,
  openPage,
  r9Data,
  r9Page,
  requireIntegratedBuild,
  richControl,
} from "./r9-fixture";

requireIntegratedBuild();

test("W3 acceptance: slash コールアウト creates an editable default-note callout and stores it", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR9(data);
    app = running.app;
    const window = running.window;

    await openPage(window, data.titles.home);
    await insertSlashBlock(window, "コールアウト");

    const callout = window.locator("aside[data-folio-callout]").first();
    await expect(callout).toBeVisible();
    await expect(callout).toHaveAttribute("data-tone", "note");

    const body = callout.locator("p").first();
    await body.click();
    await window.keyboard.type("受入コールアウト本文");
    await expect(callout).toContainText("受入コールアウト本文");

    await expect
      .poll(async () =>
        JSON.stringify((await r9Page(window, data.home.id))?.doc),
      )
      .toContain("受入コールアウト本文");

    const page = await r9Page(window, data.home.id);
    expect(page?.doc.schemaVersion).toBe(2);
    const callouts = nodesOfType(page?.doc, "callout");
    expect(callouts).toHaveLength(1);
    expect(callouts[0].attrs?.tone).toBe("note");
    expect(typeof callouts[0].attrs?.id).toBe("string");
    expect(JSON.stringify(callouts[0])).toContain("受入コールアウト本文");
  } finally {
    await disposeR9(data, app);
  }
});

test("W3 acceptance: slash 簡易表 creates an editable table block and stores its cells", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR9(data);
    app = running.app;
    const window = running.window;

    await openPage(window, data.titles.home);
    await insertSlashBlock(window, "簡易表");

    const table = window.locator(".folio-editor table").first();
    await expect(table).toBeVisible();
    const cells = table.locator("th,td");
    expect(await cells.count()).toBeGreaterThan(0);

    const firstCell = cells.first();
    await firstCell.click();
    await window.keyboard.type("簡易表セル");
    await expect(firstCell).toContainText("簡易表セル");

    await expect
      .poll(async () =>
        JSON.stringify((await r9Page(window, data.home.id))?.doc),
      )
      .toContain("簡易表セル");

    const page = await r9Page(window, data.home.id);
    expect(page?.doc.schemaVersion).toBe(2);
    const tables = nodesOfType(page?.doc, "table");
    expect(tables).toHaveLength(1);
    expect(JSON.stringify(tables[0])).toContain("簡易表セル");
  } finally {
    await disposeR9(data, app);
  }
});

test("W3 acceptance: callout tone change preserves the body and is undone as one rich-block step", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR9(data);
    app = running.app;
    const window = running.window;

    await openPage(window, data.titles.home);
    await insertSlashBlock(window, "コールアウト");

    const callout = window.locator("aside[data-folio-callout]").first();
    await expect(callout).toHaveAttribute("data-tone", "note");
    await callout.locator("p").first().click();
    await window.keyboard.type("本文を保持したコールアウト");

    await chooseCalloutTone(window, "tip");
    await expect(callout).toHaveAttribute("data-tone", "tip");
    await expect(callout).toContainText("本文を保持したコールアウト");
    expect(
      await window.evaluate(() => {
        const editor = document.querySelector(".folio-editor");
        return !!editor && editor.contains(document.activeElement);
      }),
    ).toBe(true);

    await window.keyboard.press("Meta+z");
    await expect(callout).toHaveAttribute("data-tone", "note");
    await expect(callout).toContainText("本文を保持したコールアウト");

    await expect
      .poll(async () => {
        const page = await r9Page(window, data.home.id);
        return nodesOfType(page?.doc, "callout")[0]?.attrs?.tone;
      })
      .toBe("note");
    const page = await r9Page(window, data.home.id);
    expect(JSON.stringify(page?.doc)).toContain("本文を保持したコールアウト");
  } finally {
    await disposeR9(data, app);
  }
});

test("W3 acceptance: table Tab moves cells, row/column controls work, and the first row is a header", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR9(data);
    app = running.app;
    const window = running.window;

    await openPage(window, data.titles.home);
    await insertSlashBlock(window, "簡易表");

    const table = window.locator(".folio-editor table").first();
    await expect(table).toBeVisible();
    const rows = table.locator("tr");
    const firstRow = rows.first();
    const initialRows = await rows.count();
    const initialColumns = await firstRow.locator("th,td").count();
    expect(initialRows).toBeGreaterThan(0);
    expect(initialColumns).toBeGreaterThan(0);
    await expect(firstRow.locator("th")).not.toHaveCount(0);

    const firstHeader = firstRow.locator("th").first();
    await firstHeader.click();
    await window.keyboard.type("見出し甲");
    await window.keyboard.press("Tab");
    await window.keyboard.type("見出し乙");
    await expect(firstRow.locator("th").nth(0)).toContainText("見出し甲");
    await expect(firstRow.locator("th,td").nth(1)).toContainText("見出し乙");

    await (await richControl(window, TABLE_CONTROLS.addRow)).click();
    await expect(rows).toHaveCount(initialRows + 1);

    await (await richControl(window, TABLE_CONTROLS.addColumn)).click();
    const widenedColumns = initialColumns + 1;
    await expect(firstRow.locator("th,td")).toHaveCount(widenedColumns);
    for (let index = 0; index < initialRows + 1; index += 1)
      await expect(rows.nth(index).locator("th,td")).toHaveCount(
        widenedColumns,
      );

    await (await richControl(window, TABLE_CONTROLS.toggleHeader)).click();
    await expect(firstRow.locator("th")).toHaveCount(0);
    await expect(firstRow.locator("td")).toHaveCount(widenedColumns);
    await (await richControl(window, TABLE_CONTROLS.toggleHeader)).click();
    await expect(firstRow.locator("th")).toHaveCount(widenedColumns);

    await rows.last().locator("th,td").first().click();
    await (await richControl(window, TABLE_CONTROLS.deleteRow)).click();
    await expect(rows).toHaveCount(initialRows);

    await firstRow.locator("th,td").first().click();
    await (await richControl(window, TABLE_CONTROLS.deleteColumn)).click();
    await expect(firstRow.locator("th,td")).toHaveCount(initialColumns);

    // Deleting the final row/column removes the table; Undo restores it.
    while ((await rows.count()) > 1) {
      await rows.last().locator("th,td").first().click();
      const remove = await richControl(window, TABLE_CONTROLS.deleteRow);
      if (!(await remove.isEnabled())) break;
      await remove.click();
    }
    await expect(rows).toHaveCount(1);
    const extraRowDelete = await richControl(window, TABLE_CONTROLS.deleteRow);
    await extraRowDelete.click();
    await expect(table).toHaveCount(0);
    await window.keyboard.press("Meta+z");
    await expect(rows).toHaveCount(1);

    while ((await firstRow.locator("th,td").count()) > 1) {
      await firstRow.locator("th,td").last().click();
      const remove = await richControl(window, TABLE_CONTROLS.deleteColumn);
      if (!(await remove.isEnabled())) break;
      await remove.click();
    }
    await expect(firstRow.locator("th,td")).toHaveCount(1);
    const extraColumnDelete = await richControl(
      window,
      TABLE_CONTROLS.deleteColumn,
    );
    await extraColumnDelete.click();
    await expect(table).toHaveCount(0);
    await window.keyboard.press("Meta+z");
    await expect(firstRow.locator("th,td")).toHaveCount(1);

    await expect
      .poll(
        async () =>
          nodesOfType((await r9Page(window, data.home.id))?.doc, "table")
            .length,
      )
      .toBe(1);
    const page = await r9Page(window, data.home.id);
    expect(page?.doc.schemaVersion).toBe(2);
    const stored = nodesOfType(page?.doc, "table")[0];
    expect(stored.content).toHaveLength(1);
    expect(stored.content[0].content).toHaveLength(1);
    const storedCell = stored.content[0].content[0];
    expect(storedCell.attrs).toMatchObject({
      colspan: 1,
      rowspan: 1,
      colwidth: null,
    });
    expect(typeof stored.attrs.id).toBe("string");
    expect(typeof stored.content[0].attrs.id).toBe("string");
    expect(typeof storedCell.attrs.id).toBe("string");
  } finally {
    await disposeR9(data, app);
  }
});
