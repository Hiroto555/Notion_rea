import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  addR5Record,
  assertR5LegacyUnchanged,
  createR5Database,
  disposeR5,
  gateR5Database,
  launchR5,
  openR5Database,
  openR5Record,
  r5Data,
  r5Database,
  r5Gate,
  r5Saved,
  r5Settings,
  r5SettingsSaved,
  r5Snapshot,
} from "./r5-fixture";

test("UI creates the first registered DB and record; real Editor and three properties survive restart without migrating the legacy DB", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data);
    app = running.app;
    let window = running.window;
    const owner = await createR5Database(window);
    expect((await r5Database(window, owner.id)).records).toEqual([]);
    const record = await addR5Record(window, owner.id, "R5 created row");
    const row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await row
      .getByLabel("メモ R5 created row", { exact: true })
      .fill("cell note");
    await row.getByLabel("見積 R5 created row", { exact: true }).fill("12.5");
    await row.getByLabel("完了 R5 created row", { exact: true }).check();
    await r5Saved(window);
    await openR5Record(window, "R5 created row");
    const panel = window.locator(".r3-record-page");
    await expect(panel.getByLabel("メモ", { exact: true })).toHaveValue(
      "cell note",
    );
    await expect(panel.getByLabel("見積", { exact: true })).toHaveValue("12.5");
    await expect(panel.getByLabel("完了", { exact: true })).toBeChecked();
    await panel
      .getByLabel("レコードのタイトル", { exact: true })
      .fill("R5 persisted row");
    await panel
      .locator(".folio-editor")
      .fill("R5 body from the production Editor");
    await panel.getByLabel("メモ", { exact: true }).fill("panel note");
    await panel.getByLabel("見積", { exact: true }).fill("24.75");
    await panel.getByLabel("完了", { exact: true }).uncheck();
    await r5Saved(window);
    await panel
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    assertR5LegacyUnchanged(data);
    await app.close();
    app = undefined;
    running = await launchR5(data);
    app = running.app;
    window = running.window;
    await openR5Database(window);
    await openR5Record(window, "R5 persisted row");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "R5 body from the production Editor",
    );
    const pair = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      record.pageId,
    );
    const projection = await r5Database(window, owner.id);
    const ids = Object.fromEntries(
      projection.settings.properties.map((property) => [
        property.name,
        property.id,
      ]),
    );
    expect(pair.record.values).toEqual({
      [ids["メモ"]]: "panel note",
      [ids["見積"]]: 24.75,
      [ids["完了"]]: false,
    });
    expect(pair.page.title).toBe("R5 persisted row");
    expect(pair.page.revision).toBe(pair.record.revision);
    expect(pair.record.databasePageId).toBe(owner.id);
    expect(projection.records.map((entry) => entry.pageId)).toEqual([
      record.pageId,
    ]);
    expect((await r5Snapshot(window)).recordDatabaseIds).toEqual([owner.id]);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});

test("create DB lost post-COMMIT ACK resolves the same receipt and cannot create a duplicate", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    await gateR5Database(app, "createDatabase", "lost");
    await window
      .getByRole("button", { name: "新しいデータベース", exact: true })
      .click();
    const dialog = window.getByRole("dialog", {
      name: "新しいデータベース",
      exact: true,
    });
    await dialog
      .getByLabel("データベース名", { exact: true })
      .fill("R5 DB with lost ACK");
    await dialog.getByRole("button", { name: "作成", exact: true }).click();
    const resolve = window.getByRole("button", {
      name: "作成結果を確認",
      exact: true,
    });
    await expect(resolve).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "作成", exact: true }),
    ).toHaveCount(0);
    const committed = await r5Snapshot(window);
    expect(committed.recordDatabaseIds).toHaveLength(1);
    expect(
      committed.pages.filter((page) => page.title === "R5 DB with lost ACK"),
    ).toHaveLength(1);
    expect((await r5Gate(app)).commits).toHaveLength(1);
    await resolve.click();
    await expect(dialog).toBeHidden();
    await expect(window.locator(".page-title")).toHaveValue(
      "R5 DB with lost ACK",
    );
    await r5SettingsSaved(window);
    const gate = await r5Gate(app);
    expect(gate.commits).toHaveLength(1);
    expect(gate.resolves).toEqual([gate.operation]);
    expect(gate.result.status).toBe("applied");
    const duplicate = await window.evaluate(
      (operation) =>
        globalThis.window.folio.request<any>({
          type: "database:commit",
          operation,
        }),
      gate.operation,
    );
    expect(duplicate).toEqual(gate.result);
    const after = await r5Snapshot(window);
    expect(after.recordDatabaseIds).toEqual(committed.recordDatabaseIds);
    expect(after.pages).toEqual(committed.pages);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});

test("add row lost post-COMMIT ACK resolves without a second membership or owner revision increment", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    const owner = await createR5Database(window);
    await gateR5Database(app, "createRecord", "lost");
    await window.getByRole("button", { name: "新規行", exact: true }).click();
    await expect(r5Settings(window)).toHaveAttribute(
      "data-settings-state",
      "unknown",
    );
    await expect(
      window.getByRole("button", { name: "新規行", exact: true }),
    ).toBeDisabled();
    const committed = await r5Database(window, owner.id);
    expect(committed.records).toHaveLength(1);
    expect(committed.records[0].title).toBe("無題");
    await window
      .getByRole("button", { name: "設定の保存結果を確認", exact: true })
      .click();
    await r5SettingsSaved(window);
    await expect(
      window.getByRole("button", { name: "開く 無題", exact: true }),
    ).toBeVisible();
    const gate = await r5Gate(app);
    expect(gate.commits).toHaveLength(1);
    expect(gate.resolves).toEqual([gate.operation]);
    expect(gate.result.status).toBe("applied");
    expect(gate.result.record.pageId).toBe(committed.records[0].pageId);
    const duplicate = await window.evaluate(
      (operation) =>
        globalThis.window.folio.request<any>({
          type: "database:commit",
          operation,
        }),
      gate.operation,
    );
    expect(duplicate).toEqual(gate.result);
    expect(await r5Database(window, owner.id)).toEqual(committed);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});
