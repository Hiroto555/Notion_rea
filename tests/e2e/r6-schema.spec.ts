import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { Property } from "../../src/shared/types";
import type { SaveResult } from "../../src/shared/save-contract";
import { addR5Record, assertR5LegacyUnchanged, createR5Database, disposeR5, launchR5,
  openR5Database, openR5Record, r5Data, r5Database, r5Saved, r5Settings, r5SettingsSaved } from "./r5-fixture";

const dialog = (window: Page) => window.getByRole("dialog", {name: "列の設定", exact: true});
const panel = (window: Page) => dialog(window).getByRole("region", {name: "列の設定", exact: true});
async function openSchema(window: Page) {
  await r5Saved(window);
  await window.getByRole("button", {name: "列の設定", exact: true}).click();
  await expect(dialog(window)).toBeVisible();
}
async function preview(window: Page) {
  await dialog(window).getByRole("button", {name: "変更をプレビュー", exact: true}).click();
  await expect(panel(window)).toHaveAttribute("data-property-state", "ready");
  await expect(dialog(window).getByRole("region", {name: "列変更のプレビュー", exact: true})).toBeVisible();
}
async function applyAndReload(window: Page) {
  await expect(dialog(window).getByRole("button", {name: "この変更を適用", exact: true})).toBeEnabled();
  await Promise.all([
    window.waitForEvent("domcontentloaded"),
    dialog(window).getByRole("button", {name: "この変更を適用", exact: true}).click(),
  ]);
  await expect(dialog(window)).toBeHidden();
  await expect(r5Settings(window)).toBeVisible();
  await r5SettingsSaved(window);
}
async function addColumn(window: Page, name: string, type: Property["type"], options?: string) {
  await openSchema(window);
  await dialog(window).getByRole("button", {name: "列を追加", exact: true}).click();
  await dialog(window).getByLabel("列名", {exact: true}).fill(name);
  await dialog(window).getByLabel("列の型", {exact: true}).selectOption(type);
  if (type === "select") await dialog(window).getByLabel("列の選択肢", {exact: true}).fill(options!);
  await preview(window);
  await applyAndReload(window);
}
async function previewType(window: Page, name: string, type: Property["type"], options?: string) {
  await openSchema(window);
  await dialog(window).getByRole("button", {name: `列の型を変更 ${name}`, exact: true}).click();
  await dialog(window).getByLabel("列の型", {exact: true}).selectOption(type);
  if (type === "select") await dialog(window).getByLabel("列の選択肢", {exact: true}).fill(options!);
  await preview(window);
}

/** Let the real SQLite commit finish, then remove only its acknowledgment. */
async function losePropertyAck(app: ElectronApplication) {
  await app.evaluate(({ipcMain}) => {
    const ipc = ipcMain as any, original = ipc._invokeHandlers.get("folio:request");
    const gate: any = ((globalThis as any).r6PropertyGate = {commits: [], resolves: [], results: [], injected: false});
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const result = await original(event, request);
      if (request.type === "property:resolve") gate.resolves.push(request.operation);
      if (request.type === "property:commit") {
        gate.commits.push(request.operation); gate.results.push(result);
        if (!gate.injected) {gate.injected = true; throw new Error("R6 synthetic post-COMMIT property ACK loss");}
      }
      return result;
    });
  });
}

test("five column types, select/date live fields and stable rename survive actual Electron restart", async () => {
  test.setTimeout(120_000);
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data); app = running.app; let window = running.window;
    const owner = await createR5Database(window, "R6 columns");
    const record = await addR5Record(window, owner.id, "All types");
    for (const [name, type] of [["R6 text", "text"], ["R6 number", "number"], ["R6 check", "checkbox"],
      ["R6 date", "date"], ["R6 select", "select"]] as const) await addColumn(window, name, type, "Open\nDone");
    let row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await row.getByLabel("R6 text All types", {exact: true}).fill("kept text");
    await row.getByLabel("R6 number All types", {exact: true}).fill("42.5");
    await row.getByLabel("R6 check All types", {exact: true}).check();
    await row.getByLabel("R6 date All types", {exact: true}).fill("2024-02-29");
    await row.getByLabel("R6 select All types", {exact: true}).selectOption("Done");
    await r5Saved(window);
    const beforeRename = await r5Database(window, owner.id);
    const textId = beforeRename.settings.properties.find((property) => property.name === "R6 text")!.id;
    await openSchema(window);
    await dialog(window).getByRole("button", {name: "列名を変更 R6 text", exact: true}).click();
    await dialog(window).getByLabel("列名", {exact: true}).fill("Renamed text");
    await preview(window); await applyAndReload(window);
    const renamed = await r5Database(window, owner.id);
    expect(renamed.settings.properties.find((property) => property.name === "Renamed text")!.id).toBe(textId);
    expect(renamed.records).toEqual(beforeRename.records);
    await openR5Record(window, record.title);
    const recordPage = window.getByLabel("レコードページ", {exact: true});
    await recordPage.getByLabel("R6 date", {exact: true}).fill("2025-12-31");
    await recordPage.getByLabel("R6 select", {exact: true}).selectOption("Open");
    await r5Saved(window);
    await recordPage.getByRole("button", {name: "レコードを閉じる", exact: true}).click();
    const expected = await r5Database(window, owner.id);
    await app.close(); app = undefined;
    running = await launchR5(data); app = running.app; window = running.window;
    await openR5Database(window, "R6 columns");
    expect(await r5Database(window, owner.id)).toEqual(expected);
    row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await expect(row.getByLabel("Renamed text All types", {exact: true})).toHaveValue("kept text");
    await expect(row.getByLabel("R6 number All types", {exact: true})).toHaveValue("42.5");
    await expect(row.getByLabel("R6 check All types", {exact: true})).toBeChecked();
    await expect(row.getByLabel("R6 date All types", {exact: true})).toHaveValue("2025-12-31");
    await expect(row.getByLabel("R6 select All types", {exact: true})).toHaveValue("Open");
    assertR5LegacyUnchanged(data);
  } finally {await disposeR5(data, app);}
});

test("lossless type changes persist, keep column IDs, and reject the pre-conversion record revision", async () => {
  test.setTimeout(90_000);
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data); app = running.app; let window = running.window;
    const owner = await createR5Database(window, "R6 conversions"), record = await addR5Record(window, owner.id, "Convert me");
    const row = window.locator(`tr[data-record-id="${record.pageId}"]`);
    await row.getByLabel("メモ Convert me", {exact: true}).fill("12");
    await row.getByLabel("完了 Convert me", {exact: true}).check(); await r5Saved(window);
    const before = await r5Database(window, owner.id), oldRecord = before.records[0];
    await previewType(window, "メモ", "number");
    await expect(dialog(window).getByRole("region", {name: "列変更のプレビュー"})).toContainText('"12"');
    await applyAndReload(window);
    await previewType(window, "完了", "number"); await applyAndReload(window);
    const after = await r5Database(window, owner.id);
    expect(after.settings.properties.map((property) => property.id)).toEqual(before.settings.properties.map((property) => property.id));
    expect(after.records[0].values).toMatchObject({note: 12, done: 1});
    expect(after.records[0].revision).toBe(oldRecord.revision + 2);
    const stale = await window.evaluate(async ({oldRecord, ownerId}) => globalThis.window.folio.request<SaveResult>({type: "save:commit",
      operation: {operationId: crypto.randomUUID(), sessionId: crypto.randomUUID(), seq: 1, pageId: oldRecord.pageId,
        databasePageId: ownerId, revision: oldRecord.revision, patch: {}, values: {note: "old schema input"}}}), {oldRecord, ownerId: owner.id});
    expect(stale.status).toBe("rejected");
    expect(await r5Database(window, owner.id)).toEqual(after);
    await app.close(); app = undefined; running = await launchR5(data); app = running.app; window = running.window;
    await openR5Database(window, "R6 conversions");
    expect(await r5Database(window, owner.id)).toEqual(after);
    assertR5LegacyUnchanged(data);
  } finally {await disposeR5(data, app);}
});

test("nonconvertible values and dependent view filters reject visibly without changing stored data", async () => {
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data); app = running.app; const window = running.window;
    const owner = await createR5Database(window, "R6 rejection"), record = await addR5Record(window, owner.id, "Invalid value row");
    await window.locator(`tr[data-record-id="${record.pageId}"]`).getByLabel("メモ Invalid value row", {exact: true}).fill("012");
    await r5Saved(window);
    const before = await r5Database(window, owner.id);
    await previewType(window, "メモ", "number");
    await expect(dialog(window).getByRole("region", {name: "列変更のプレビュー"})).toContainText("Invalid value row");
    await expect(dialog(window)).toContainText("表記を失わず数値に変換できません");
    await expect(dialog(window).getByRole("button", {name: "この変更を適用", exact: true})).toBeDisabled();
    expect(await r5Database(window, owner.id)).toEqual(before);
    await dialog(window).getByRole("button", {name: "列の設定を閉じる", exact: true}).click();
    await window.locator(`tr[data-record-id="${record.pageId}"]`).getByLabel("メモ Invalid value row", {exact: true}).fill("12");
    await r5Saved(window);
    const settings = r5Settings(window);
    await settings.getByText("フィルター・並べ替え・グループ", {exact: true}).click();
    await settings.getByRole("button", {name: "条件を追加 1", exact: true}).click();
    await settings.getByLabel("フィルター対象 1.1", {exact: true}).selectOption("note");
    await settings.getByLabel("フィルター値 1.1", {exact: true}).fill("12");
    await r5SettingsSaved(window);
    const filtered = await r5Database(window, owner.id);
    await previewType(window, "メモ", "number");
    await expect(dialog(window)).toContainText("フィルターがこの列を使用しています");
    await expect(dialog(window).getByRole("button", {name: "この変更を適用", exact: true})).toBeDisabled();
    expect(await r5Database(window, owner.id)).toEqual(filtered);
    assertR5LegacyUnchanged(data);
  } finally {await disposeR5(data, app);}
});

test("post-COMMIT ACK loss resolves the same property operation once and reloads the confirmed schema", async () => {
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data); app = running.app; const window = running.window;
    const owner = await createR5Database(window, "R6 property unknown"), record = await addR5Record(window, owner.id, "Unknown row");
    await window.locator(`tr[data-record-id="${record.pageId}"]`).getByLabel("メモ Unknown row", {exact: true}).fill("7");
    await r5Saved(window); const before = await r5Database(window, owner.id);
    await previewType(window, "メモ", "number"); await losePropertyAck(app);
    await dialog(window).getByRole("button", {name: "この変更を適用", exact: true}).click();
    await expect(panel(window)).toHaveAttribute("data-property-state", "unknown");
    await expect(dialog(window).getByLabel("列の型", {exact: true})).toBeDisabled();
    await expect(dialog(window).getByRole("button", {name: "列の設定を閉じる", exact: true})).toBeDisabled();
    const committed = await r5Database(window, owner.id);
    expect(committed.revision).toBe(before.revision + 1);
    expect(committed.records[0].values.note).toBe(7);
    await Promise.all([window.waitForEvent("domcontentloaded"), dialog(window)
      .getByRole("button", {name: "列変更の保存結果を確認", exact: true}).click()]);
    await expect(dialog(window)).toBeHidden(); await r5SettingsSaved(window);
    expect(await r5Database(window, owner.id)).toEqual(committed);
    const gate = await app.evaluate(() => (globalThis as any).r6PropertyGate);
    expect(gate.commits).toHaveLength(1); expect(gate.resolves).toHaveLength(1);
    expect(gate.resolves[0]).toEqual(gate.commits[0]); expect(gate.results[0].status).toBe("applied");
    expect(gate.results[0].backup.verified).toBe(true);
    assertR5LegacyUnchanged(data);
  } finally {await disposeR5(data, app);}
});

test("a record changed after UI preview makes apply reject while preserving the external value", async () => {
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data); app = running.app; const window = running.window;
    const owner = await createR5Database(window, "R6 preview stale"), record = await addR5Record(window, owner.id, "Stale preview row");
    await window.locator(`tr[data-record-id="${record.pageId}"]`).getByLabel("メモ Stale preview row", {exact: true}).fill("8");
    await r5Saved(window); const before = await r5Database(window, owner.id);
    await previewType(window, "メモ", "number");
    const external = await window.evaluate(async ({row, ownerId}) => globalThis.window.folio.request<SaveResult>({type: "save:commit",
      operation: {operationId: crypto.randomUUID(), sessionId: crypto.randomUUID(), seq: 1, pageId: row.pageId,
        databasePageId: ownerId, revision: row.revision, patch: {}, values: {note: "9"}}}), {row: before.records[0], ownerId: owner.id});
    expect(external.status).toBe("applied");
    const updated = await r5Database(window, owner.id);
    await dialog(window).getByRole("button", {name: "この変更を適用", exact: true}).click();
    await expect(panel(window)).toHaveAttribute("data-property-state", "rejected");
    await expect(dialog(window)).toContainText("プレビュー後に列・レコード・所属が変わりました");
    expect(await r5Database(window, owner.id)).toEqual(updated);
    expect(updated.records[0].values.note).toBe("9");
    expect(updated.settings.properties.find((property) => property.id === "note")!.type).toBe("text");
    assertR5LegacyUnchanged(data);
  } finally {await disposeR5(data, app);}
});
