import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectMarkTypes,
  disposeR9,
  ensureSidebar,
  installNativeDialogStub,
  launchR9,
  nodesOfType,
  openPage,
  openPageMenu,
  r9Data,
  r9Page,
  r9Snapshot,
  readExportedMarkdown,
  requireIntegratedBuild,
  setNativePaths,
} from "./r9-fixture";

requireIntegratedBuild();

test("W3 acceptance: Markdown export/import preserves rich callout, table, nested list, marks and Japanese title", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR9(data);
    app = running.app;
    const window = running.window;

    await openPage(window, data.titles.rich);
    await expect(window.locator("aside[data-folio-callout]")).toBeVisible();
    await expect(window.locator(".folio-editor table")).toBeVisible();
    await installNativeDialogStub(app);

    const exportPath = join(data.filesDir, "r9-rich-roundtrip.md");
    await setNativePaths(app, { save: exportPath });
    await openPageMenu(window);
    await window
      .getByRole("button", { name: "Markdownを書き出す", exact: true })
      .click();
    await expect.poll(() => existsSync(exportPath)).toBe(true);
    const markdown = readExportedMarkdown(exportPath);

    expect(markdown).toContain("<!-- folio:markdown:v1 title=");
    expect(markdown).toContain("# " + data.titles.rich);
    expect(markdown).toContain("警告: 日本語の本文");
    expect(markdown).toContain("複数行セル");
    expect(markdown).toContain("二行目の日本語");
    expect(markdown).toContain("入れ子項目");
    expect(markdown).toMatch(/<aside[^>]*data-folio-callout/);
    expect(markdown).toMatch(/data-tone=["']?warning["']?/);
    expect(markdown).toContain("<table");
    expect(markdown).toContain("<th");
    expect(markdown).toContain("<td");
    expect(markdown).toContain("<strong");
    expect(markdown).toContain("<em");
    expect(markdown).toContain("<ul");
    // The export is readable HTML, not a hidden JSON duplicate.
    expect(markdown).not.toContain('"type":"doc"');
    expect(markdown).not.toContain('"schemaVersion"');
    expect(markdown).not.toContain("application/x-folio");
    expect(markdown).not.toContain("base64");

    const beforeImport = await r9Snapshot(window);
    // Rename the source so the imported title is unambiguous in the sidebar.
    const titleInput = window.getByLabel("ページタイトル", { exact: true });
    await titleInput.fill("R9 マークダウン元");
    await expect
      .poll(async () => (await r9Page(window, data.rich.id))?.title)
      .toBe("R9 マークダウン元");

    await setNativePaths(app, { open: exportPath });
    await ensureSidebar(window);
    await window
      .getByRole("button", { name: "インポート", exact: true })
      .click();
    await expect
      .poll(async () => (await r9Snapshot(window)).pages.length, {
        timeout: 15000,
      })
      .toBe(beforeImport.pages.length + 1);
    const imported = (await r9Snapshot(window)).pages.find(
      (page) => page.id !== data.rich.id && page.title === data.titles.rich,
    );
    expect(imported).toBeDefined();
    if (!imported) throw new Error("imported rich page was not created");

    await openPage(window, data.titles.rich);
    const callout = window.locator("aside[data-folio-callout]").first();
    await expect(callout).toHaveAttribute("data-tone", "warning");
    await expect(callout).toContainText("警告: 日本語の本文");
    await expect(callout).toContainText("太字の続き");
    await expect(callout.locator("ul ul")).toContainText("入れ子項目");

    const table = window.locator(".folio-editor table").first();
    await expect(table).toBeVisible();
    await expect(table.locator("th")).not.toHaveCount(0);
    await expect(table).toContainText("複数行セル");
    await expect(table).toContainText("二行目の日本語");
    await expect(table).toContainText("右セル");
    await expect(
      window.locator(".folio-editor strong").first(),
    ).not.toBeEmpty();
    await expect(window.locator(".folio-editor em").first()).not.toBeEmpty();

    const page = await r9Page(window, imported.id);
    expect(page?.title).toBe(data.titles.rich);
    expect(page?.doc.schemaVersion).toBe(2);
    const callouts = nodesOfType(page?.doc, "callout");
    expect(callouts).toHaveLength(1);
    expect(callouts[0].attrs?.tone).toBe("warning");
    expect(JSON.stringify(callouts[0])).toContain("警告: 日本語の本文");
    expect(
      nodesOfType(callouts[0], "bulletList").length,
    ).toBeGreaterThanOrEqual(2);

    const tables = nodesOfType(page?.doc, "table");
    expect(tables).toHaveLength(1);
    expect(tables[0].content).toHaveLength(2);
    for (const row of tables[0].content) expect(row.content).toHaveLength(2);
    expect(nodesOfType(tables[0], "tableHeader").length).toBe(2);
    const firstBodyCell = nodesOfType(tables[0], "tableCell")[0];
    expect(firstBodyCell.content).toHaveLength(2);
    expect(JSON.stringify(tables[0])).toContain("複数行セル");
    expect(JSON.stringify(tables[0])).toContain("二行目の日本語");

    const marks = collectMarkTypes(page?.doc);
    expect(marks).toContain("bold");
    expect(marks).toContain("italic");
  } finally {
    await disposeR9(data, app);
  }
});

test("W3 acceptance: plain GFM table Markdown imports through the table extension", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR9(data);
    app = running.app;
    const window = running.window;
    await installNativeDialogStub(app);

    const externalPath = join(data.filesDir, "gfm-table.md");
    writeFileSync(
      externalPath,
      "外部GFM\n\n| 見出しA | 見出しB |\n| --- | --- |\n| 値1 | 値2 |\n",
      "utf8",
    );
    const beforeImport = await r9Snapshot(window);
    await setNativePaths(app, { open: externalPath });
    await ensureSidebar(window);
    await window
      .getByRole("button", { name: "インポート", exact: true })
      .click();
    await expect
      .poll(async () => (await r9Snapshot(window)).pages.length, {
        timeout: 15000,
      })
      .toBe(beforeImport.pages.length + 1);
    const imported = (await r9Snapshot(window)).pages.find(
      (page) => page.title === "gfm-table",
    );
    expect(imported).toBeDefined();
    if (!imported) throw new Error("GFM table page was not created");

    await openPage(window, "gfm-table");
    const table = window.locator(".folio-editor table").first();
    await expect(table).toBeVisible();
    await expect(table.locator("tr")).toHaveCount(2);
    await expect(table.locator("th")).toHaveCount(2);
    await expect(table).toContainText("見出しA");
    await expect(table).toContainText("値2");

    const page = await r9Page(window, imported.id);
    expect(page?.doc.schemaVersion).toBe(2);
    const tables = nodesOfType(page?.doc, "table");
    expect(tables).toHaveLength(1);
    expect(tables[0].content).toHaveLength(2);
    for (const row of tables[0].content) expect(row.content).toHaveLength(2);
    expect(nodesOfType(tables[0], "tableHeader")).toHaveLength(2);
    expect(JSON.stringify(tables[0])).toContain("値1");
    expect(JSON.stringify(tables[0])).toContain("値2");
  } finally {
    await disposeR9(data, app);
  }
});
