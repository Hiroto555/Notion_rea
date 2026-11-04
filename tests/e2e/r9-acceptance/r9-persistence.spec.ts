import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  disposeR9,
  launchR9,
  nodesOfType,
  openDatabase,
  openPage,
  openRecord,
  r9Data,
  r9Page,
  readRawPage,
  requireIntegratedBuild,
} from "./r9-fixture";

requireIntegratedBuild();

test("W3 acceptance: record side/full/width switches keep one Editor and an unsaved rich doc across restart", async () => {
  const data = r9Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR9(data);
    app = running.app;
    let window = running.window;

    await openDatabase(window, data.titles.database);
    await openRecord(window, data.titles.record);

    let surface = window.locator(".r3-record-page");
    let callout = surface.locator("aside[data-folio-callout]").first();
    await expect(surface.locator("table")).toBeVisible();
    await expect(callout).toHaveAttribute("data-tone", "warning");
    await callout.locator("p").first().click();
    await window.keyboard.type("未保存リッチ本文");
    await expect(callout).toContainText("未保存リッチ本文");

    await surface.locator(".folio-editor").evaluate((element) => {
      (window as any).__r9RecordEditor = element;
    });
    const sameEditor = () =>
      window.evaluate(
        () =>
          (window as any).__r9RecordEditor ===
          document.querySelector(".r3-record-page .folio-editor"),
      );

    await surface.getByRole("button", { name: "ワイド", exact: true }).click();
    await expect(surface).toHaveAttribute("data-page-width", "wide");
    expect(await sameEditor()).toBe(true);
    await expect(callout).toContainText("未保存リッチ本文");

    const modeBefore = await surface.getAttribute("data-record-mode");
    await surface.locator(".r4-record-mode").click();
    await expect
      .poll(() => surface.getAttribute("data-record-mode"))
      .not.toBe(modeBefore);
    expect(await sameEditor()).toBe(true);
    await expect(callout).toContainText("未保存リッチ本文");

    await expect
      .poll(
        async () =>
          JSON.stringify((await r9Page(window, data.record.pageId))?.doc),
        { timeout: 15000 },
      )
      .toContain("未保存リッチ本文");
    await expect
      .poll(async () => (await r9Page(window, data.record.pageId))?.width)
      .toBe("wide");

    await app.close();
    app = undefined;
    running = await launchR9(data);
    app = running.app;
    window = running.window;
    await openDatabase(window, data.titles.database);
    await openRecord(window, data.titles.record);

    surface = window.locator(".r3-record-page");
    callout = surface.locator("aside[data-folio-callout]").first();
    await expect(surface).toHaveAttribute("data-page-width", "wide");
    await expect(callout).toHaveAttribute("data-tone", "warning");
    await expect(callout).toContainText("未保存リッチ本文");
    await expect(surface.locator("table")).toBeVisible();
    const page = await r9Page(window, data.record.pageId);
    expect(page?.doc.schemaVersion).toBe(2);
    expect(JSON.stringify(page?.doc)).toContain("未保存リッチ本文");
    expect(nodesOfType(page?.doc, "callout")).toHaveLength(1);
    expect(nodesOfType(page?.doc, "table")).toHaveLength(1);
  } finally {
    await disposeR9(data, app);
  }
});

test("W3 acceptance: an unknown future document stays read-only and its raw page bytes are untouched", async () => {
  const data = r9Data(true);
  let app: ElectronApplication | undefined;
  const before = readRawPage(data.dataDir, data.future.id);
  expect(before).not.toBeNull();
  try {
    const running = await launchR9(data);
    app = running.app;
    const window = running.window;

    await openPage(window, data.titles.future);
    const article = window
      .locator('.document[data-document-error="true"]')
      .first();
    await expect(article).toBeVisible();
    await expect(article.getByRole("alert")).toContainText(
      /原本|未対応|読み取り専用/,
    );
    await expect(article.locator(".folio-editor")).toHaveCount(0);
    await expect(article.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(
      window.locator("aside[data-folio-callout], .folio-editor table"),
    ).toHaveCount(0);

    await article.getByRole("alert").click();
    await window.keyboard.type("/コールアウト");
    await window.keyboard.press("Enter");
    await expect(article.getByRole("alert")).toBeVisible();
    await expect(window.locator("aside[data-folio-callout]")).toHaveCount(0);
    expect(readRawPage(data.dataDir, data.future.id)).toBe(before);

    await app.close();
    app = undefined;
    expect(readRawPage(data.dataDir, data.future.id)).toBe(before);
  } finally {
    await disposeR9(data, app);
  }
});
