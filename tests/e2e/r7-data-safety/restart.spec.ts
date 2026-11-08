import { captureFixture } from "../recovery-ci-runtime";
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

test("R7 normal restart retains the Japanese record body and saved view settings", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data);
    app = running.app;
    let window = running.window;
    const owner = await createR5Database(window, "R7 再起動");
    // A newly created R6 database has text/number/checkbox columns. Add the
    // other two through the real preview/commit UI before testing persistence.
    for (const [name, type] of [["ステータス", "select"], ["期日", "date"]] as const) {
      await window.getByRole("button", { name: "列の設定", exact: true }).click();
      const schema = window.getByRole("dialog", { name: "列の設定", exact: true });
      await schema.getByRole("button", { name: "列を追加", exact: true }).click();
      await schema.getByLabel("列名", { exact: true }).fill(name);
      await schema.getByLabel("列の型", { exact: true }).selectOption(type);
      if (type === "select") await schema.getByLabel("列の選択肢", { exact: true }).fill("未着手\n進行中\n完了");
      await schema.getByRole("button", { name: "変更をプレビュー", exact: true }).click();
      await expect(schema.getByRole("region", { name: "列の設定", exact: true })).toHaveAttribute("data-property-state", "ready");
      await Promise.all([window.waitForEvent("domcontentloaded"), schema.getByRole("button", { name: "この変更を適用", exact: true }).click()]);
      await expect(schema).toBeHidden();
      await r5SettingsSaved(window);
    }
    const columns = (await r5Database(window, owner.id)).settings.properties;
    const statusId = columns.find(p => p.name === "ステータス")!.id;
    const dateId = columns.find(p => p.name === "期日")!.id;
    const record = await addR5Record(window, owner.id, "R7 再起動レコード");
    let row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await row
      .getByLabel("メモ R7 再起動レコード", { exact: true })
      .fill("再起動前のメモ");
    await row
      .getByLabel("見積 R7 再起動レコード", { exact: true })
      .fill("4");
    await row
      .getByLabel("ステータス R7 再起動レコード", { exact: true })
      .selectOption({ label: "進行中" });
    await row
      .getByLabel("期日 R7 再起動レコード", { exact: true })
      .fill("2026-11-15");
    await row
      .getByLabel("完了 R7 再起動レコード", { exact: true })
      .check();
    await r5Saved(window);

    await openR7Settings(window, "view-options");
    let settings = r5Settings(window);
    await settings
      .getByLabel("ビュー名", { exact: true })
      .fill("R7 再起動ビュー");
    await openR7Settings(window, "filter");
    await settings
      .getByRole("button", { name: "条件を追加 1", exact: true })
      .click();
    await settings
      .getByLabel("フィルター対象 1.1", { exact: true })
      .selectOption({ label: "メモ" });
    await settings
      .getByLabel("フィルター演算子 1.1", { exact: true })
      .selectOption("contains");
    await settings
      .getByLabel("フィルター値 1.1", { exact: true })
      .fill("再起動");
    await openR7Settings(window, "sort");
    await settings
      .getByRole("button", { name: "並べ替えを追加", exact: true })
      .click();
    await settings
      .getByLabel("並べ替え対象 1", { exact: true })
      .selectOption({ label: "見積" });
    await settings
      .getByLabel("並べ替え方向 1", { exact: true })
      .selectOption("desc");
    await r5SettingsSaved(window);

    await window.keyboard.press("Escape");
    await openR5Record(window, "R7 再起動レコード");
    await window
      .locator(".r3-record-page .folio-editor")
      .fill("再起動後も残る日本語の本文です。");
    await r5Saved(window);
    const before = await r5Database(window, owner.id);
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await captureFixture(app);
    await app.close();
    app = undefined;

    running = await launchR5(data);
    app = running.app;
    window = running.window;
    await openR5Database(window, "R7 再起動");
    row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await openR7Settings(window, "view-options");
    settings = r5Settings(window);
    await expect(
      settings.getByLabel("ビュー名", { exact: true }),
    ).toHaveValue("R7 再起動ビュー");
    await openR7Settings(window, "filter");
    await expect(
      settings.getByLabel("フィルター値 1.1", { exact: true }),
    ).toHaveValue("再起動");
    await openR7Settings(window, "sort");
    await expect(
      settings.getByLabel("並べ替え方向 1", { exact: true }),
    ).toHaveValue("desc");
    await expect(
      row.getByLabel("メモ R7 再起動レコード", { exact: true }),
    ).toHaveValue("再起動前のメモ");
    await expect(
      row.getByLabel("見積 R7 再起動レコード", { exact: true }),
    ).toHaveValue("4");
    await expect(
      row.getByLabel("ステータス R7 再起動レコード", { exact: true }),
    ).toHaveValue("進行中");
    await expect(
      row.getByLabel("期日 R7 再起動レコード", { exact: true }),
    ).toHaveValue("2026-11-15");
    await expect(
      row.getByLabel("完了 R7 再起動レコード", { exact: true }),
    ).toBeChecked();

    await window.keyboard.press("Escape");
    await openR5Record(window, "R7 再起動レコード");
    await expect(
      window.locator(".r3-record-page .folio-editor"),
    ).toContainText("再起動後も残る日本語の本文です。");
    const after = await r5Database(window, owner.id);
    expect(after.settings).toEqual(before.settings);
    expect(
      after.records.find((candidate) => candidate.pageId === record.pageId)
        ?.values,
    ).toEqual({
      note: "再起動前のメモ",
      estimate: 4,
      [statusId]: "進行中",
      [dateId]: "2026-11-15",
      done: true,
    });
  } finally {
    await disposeR5(data, app);
  }
});
