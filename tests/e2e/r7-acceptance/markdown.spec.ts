import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  disposeR7,
  launchR7,
  mockOpenDialog,
  mockSaveDialog,
  r7Data,
  r7Saved,
  r7Snapshot,
} from "./r7-fixture";

test("UI Markdown export writes real document Markdown and import reads it back", async () => {
  const data = r7Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR7(data);
    app = running.app;
    const window = running.window;
    const pageTitle = window.getByLabel("ページタイトル", { exact: true });
    await expect(pageTitle).toHaveValue("R7 Home");
    await expect(window.locator(".folio-editor h2")).toContainText("R7 見出し");

    const exported = join(data.exportsDir, "r7-export.md");
    await mockSaveDialog(app, exported);
    await window.getByLabel("ページメニュー", { exact: true }).click();
    await window
      .getByRole("button", { name: "Markdownを書き出す", exact: true })
      .click();
    await expect.poll(() => existsSync(exported)).toBe(true);
    const markdown = readFileSync(exported, "utf8");
    expect(markdown).toContain("\n# R7 Home\n\n");
    expect(markdown).toContain("## R7 見出し");
    expect(markdown).toContain("**太字**");
    expect(markdown).toContain("やること");
    expect(markdown).not.toContain('"type": "doc"');
    await r7Saved(window);

    const beforeImport = await r7Snapshot(window);
    await mockOpenDialog(app, exported);
    await window.getByRole("button", { name: "インポート", exact: true }).click();
    await expect
      .poll(async () => (await r7Snapshot(window)).pages.length)
      .toBe(beforeImport.pages.length + 1);
    await expect(pageTitle).toHaveValue("R7 Home");
    await expect(window.locator(".folio-editor h2")).toContainText("R7 見出し");
    await expect(window.locator(".folio-editor strong")).toHaveText("太字");
    await expect(window.locator(".folio-editor")).toContainText("やること");
    await expect(window.locator(".folio-editor h1")).toHaveCount(0);
    await r7Saved(window);
    const external = join(data.inputsDir, "external.md");
    writeFileSync(external, "# 外部見出しを保持\n\n外部本文");
    await mockOpenDialog(app, external);
    await window.getByRole("button", {name: "インポート", exact: true}).click();
    await expect(pageTitle).toHaveValue("external");
    await expect(window.locator(".folio-editor h1")).toHaveText("外部見出しを保持");
    await r7Saved(window);
  } finally {
    await disposeR7(data, app);
  }
});
