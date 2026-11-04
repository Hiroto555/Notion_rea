import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  addR5Record,
  openR7Settings,
  createR5Database,
  disposeR5,
  launchR5,
  openR5Database,
  openR5Record,
  r5Data,
  r5Database,
  r5Saved,
  r5Settings,
  r5SettingsSaved,
} from "../r5-fixture";
import { r7OpenOptions } from "./r7-fixture";

test("R7 raw numeric and filter input survives view switches, navigation and a guarded reload", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    const owner = await createR5Database(window, "R7 Raw inputs");
    const record = await addR5Record(window, owner.id, "R7 raw record");
    const row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await row
      .getByLabel("見積 R7 raw record", { exact: true })
      .fill("7");
    await r5Saved(window);
    await r7OpenOptions(window);
    const settings = r5Settings(window);
    await settings
      .getByRole("button", { name: "条件を追加 1", exact: true })
      .click();
    await settings
      .getByLabel("フィルター対象 1.1", { exact: true })
      .selectOption({ label: "見積" });
    await settings
      .getByLabel("フィルター演算子 1.1", { exact: true })
      .selectOption("greater_than_or_equal");
    await settings
      .getByLabel("フィルター値 1.1", { exact: true })
      .fill("7");
    await r5SettingsSaved(window);

    // A second view proves the raw filter text is retained per view rather than
    // being replaced by the canonical numeric value when the panel remounts.
    await settings
      .getByLabel("ビューを追加", { exact: true })
      .selectOption("table");
    await openR7Settings(window, "view-options");
    await settings
      .getByLabel("ビュー名", { exact: true })
      .fill("R7 代替ビュー");
    await r5SettingsSaved(window);
    await settings
      .getByRole("tab", { name: "ビュー: テーブル", exact: true })
      .click();
    await r5SettingsSaved(window);

    await openR7Settings(window, "filter");
    const filterInput = settings.getByLabel("フィルター値 1.1", {
      exact: true,
    });
    await filterInput.fill("-");
    await expect(filterInput).toHaveValue("-");
    const canonical = await r5Database(window, owner.id);
    expect(canonical.settings.views[0].filter.conditions[0]).toMatchObject({
      kind: "condition",
      value: 7,
    });
    await settings
      .getByRole("tab", { name: "ビュー: R7 代替ビュー", exact: true })
      .click();
    await settings
      .getByRole("tab", { name: "ビュー: テーブル", exact: true })
      .click();
    await openR7Settings(window, "filter");
    await expect(filterInput).toHaveValue("-");

    await window.keyboard.press("Escape");
    await openR5Record(window, "R7 raw record");
    const numeric = window
      .locator(".r3-record-page")
      .getByLabel("見積", { exact: true });
    await numeric.fill("-");
    await expect(numeric).toHaveValue("-");
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await expect(
      row.getByLabel("見積 R7 raw record", { exact: true }),
    ).toHaveValue("-");
    expect(
      (await r5Database(window, owner.id)).records.find(
        (candidate) => candidate.pageId === record.pageId,
      )?.values.estimate,
    ).toBe(7);

    await window.getByTitle("R5 Home", { exact: true }).click();
    await openR5Database(window, "R7 Raw inputs");
    await r7OpenOptions(window);
    await expect(
      r5Settings(window).getByLabel("フィルター値 1.1", { exact: true }),
    ).toHaveValue("-");
    await window.keyboard.press("Escape");
    await openR5Record(window, "R7 raw record");
    await expect(
      window.locator(".r3-record-page").getByLabel("見積", { exact: true }),
    ).toHaveValue("-");

    await app.evaluate(({ BrowserWindow }) => {
      (globalThis as any).r7RawPreventedReload = 0;
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.on("will-prevent-unload", () => {
        (globalThis as any).r7RawPreventedReload++;
      });
      contents.reload();
    });
    await expect
      .poll(() =>
        app!.evaluate(() => (globalThis as any).r7RawPreventedReload),
      )
      .toBe(1);
    await expect(
      window.locator(".r3-record-page").getByLabel("見積", { exact: true }),
    ).toHaveValue("-");
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await r7OpenOptions(window);
    await expect(
      r5Settings(window).getByLabel("フィルター値 1.1", { exact: true }),
    ).toHaveValue("-");
    expect(
      (await r5Database(window, owner.id)).records.find(
        (candidate) => candidate.pageId === record.pageId,
      )?.values.estimate,
    ).toBe(7);

    await window.keyboard.press("Escape");
    await openR5Record(window, "R7 raw record");
    await window
      .locator(".r3-record-page")
      .getByLabel("見積", { exact: true })
      .fill("9");
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await r7OpenOptions(window);
    await r5Settings(window)
      .getByLabel("フィルター値 1.1", { exact: true })
      .fill("9");
    await r5SettingsSaved(window);
    const finished = await r5Database(window, owner.id);
    expect(
      finished.records.find(
        (candidate) => candidate.pageId === record.pageId,
      )?.values.estimate,
    ).toBe(9);
    expect(finished.settings.views[0].filter.conditions[0]).toMatchObject({
      kind: "condition",
      value: 9,
    });
  } finally {
    await disposeR5(data, app);
  }
});
