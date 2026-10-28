import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { DatabaseOperationResult } from "../../src/shared/database-operation";
import { addR5Record, assertR5LegacyUnchanged, createR5Database, disposeR5, launchR5,
  r5Data, r5Database, r5Saved, r5SettingsSaved } from "./r5-fixture";

const dialog = (window: Page) => window.getByRole("dialog", {name: "列の設定", exact: true});
async function openSchema(window: Page) {
  await r5Saved(window);
  await expect(window.locator(".r6-recovery-status")).toHaveAttribute("data-recovery-state", "saved");
  await window.getByRole("button", {name: "列の設定", exact: true}).click();
  await expect(dialog(window)).toBeVisible();
}
async function preview(window: Page) {
  await dialog(window).getByRole("button", {name: "変更をプレビュー", exact: true}).click();
  await expect(dialog(window).getByRole("region", {name: "列の設定", exact: true}))
    .toHaveAttribute("data-property-state", "ready");
  await expect(dialog(window).getByRole("button", {name: "この変更を適用", exact: true})).toBeEnabled();
}

/** Fails the first journal request BEFORE calling the actual handler. All
 * retries and property writes use the real main handler and SQLite store. */
async function failFirstRecoveryWrite(app: ElectronApplication) {
  await app.evaluate(({ipcMain}) => {
    const ipc = ipcMain as any, original = ipc._invokeHandlers.get("folio:request");
    const gate: any = ((globalThis as any).r6StructuralRetryGate = {
      writes: [], commits: [], commitResults: [], resolves: [], events: [], failed: false,
    });
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      if (request.type === "recovery:write") {
        gate.writes.push(structuredClone(request));
        if (!gate.failed) {
          gate.failed = true; gate.events.push("recovery:failed-before-handler");
          throw new Error("R6 synthetic recovery write failed before storage");
        }
        const result = await original(event, request);
        gate.events.push("recovery:stored");
        return result;
      }
      if (request.type === "property:resolve") gate.resolves.push(structuredClone(request.operation));
      if (request.type === "property:commit") {
        gate.events.push("property:commit"); gate.commits.push(structuredClone(request.operation));
        const result = await original(event, request); gate.commitResults.push(result); return result;
      }
      return original(event, request);
    });
  });
}
async function retryGate(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as any).r6StructuralRetryGate);
}

test("failed durable retention stays unsent, modal retry repeats the exact checkpoint then commits once", async () => {
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data); app = running.app; const window = running.window;
    const owner = await createR5Database(window, "R6 durable retry"), record = await addR5Record(window, owner.id, "Preserved row");
    await window.locator(`tr[data-record-id="${record.pageId}"]`).getByLabel("メモ Preserved row", {exact: true}).fill("keep me");
    await r5Saved(window); const before = await r5Database(window, owner.id);
    await openSchema(window);
    await dialog(window).getByRole("button", {name: "列を追加", exact: true}).click();
    await dialog(window).getByLabel("列名", {exact: true}).fill("Retry column");
    await preview(window);
    // Drain setup journal writes before arming this one-shot failure.
    await expect(window.locator(".r6-recovery-status")).toHaveAttribute("data-recovery-state", "saved");
    await failFirstRecoveryWrite(app);
    await dialog(window).getByRole("button", {name: "この変更を適用", exact: true}).click();
    await expect(dialog(window)).toContainText("操作を送信する前の復旧用保存に失敗しました");
    const retry = dialog(window).getByRole("button", {name: "復旧用保存を再試行", exact: true});
    await expect(retry).toBeEnabled();
    await expect(dialog(window).getByRole("button", {name: "列変更の保存結果を確認", exact: true})).toHaveCount(0);
    await dialog(window).press("Escape");
    await expect(dialog(window)).toBeVisible();
    const failed = await retryGate(app);
    expect(failed.failed).toBe(true); expect(failed.writes).toHaveLength(1);
    expect(failed.commits).toEqual([]); expect(failed.resolves).toEqual([]);
    expect(failed.writes[0].snapshot.externalOperations).toHaveLength(1);
    const prepared = failed.writes[0].snapshot.externalOperations[0];
    expect(prepared.family).toBe("property");
    expect(prepared.operation.command.change).toMatchObject({kind: "add", property: {name: "Retry column", type: "text"}});
    expect(await r5Database(window, owner.id)).toEqual(before);
    // Scope to the modal: the inert App banner has a same-named retry button.
    await Promise.all([window.waitForEvent("domcontentloaded"), retry.click()]);
    await expect(dialog(window)).toBeHidden(); await r5SettingsSaved(window);
    await expect(window.locator(".r6-recovery-status")).toHaveAttribute("data-recovery-state", "saved");
    const finished = await retryGate(app);
    expect(finished.writes[1]).toEqual(finished.writes[0]);
    expect(finished.events.indexOf("recovery:stored")).toBeLessThan(finished.events.indexOf("property:commit"));
    expect(finished.commits).toEqual([prepared.operation]);
    expect(finished.resolves).toEqual([]); expect(finished.commitResults).toHaveLength(1);
    expect(finished.commitResults[0].status).toBe("applied");
    const after = await r5Database(window, owner.id);
    expect(after.revision).toBe(before.revision + 1); expect(after.records).toEqual(before.records);
    const id = prepared.operation.command.change.property.id;
    expect(after.settings.properties.filter((property) => property.id === id)).toEqual([{id, name: "Retry column", type: "text"}]);
    assertR5LegacyUnchanged(data);
  } finally {await disposeR5(data, app);}
});

test("explicit re-preview reads the external owner revision without applying, then commits that exact preview", async () => {
  const data = r5Data(); let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data); app = running.app; const window = running.window;
    const owner = await createR5Database(window, "R6 fresh preview"), record = await addR5Record(window, owner.id, "Stable record");
    const before = await r5Database(window, owner.id);
    await openSchema(window);
    await dialog(window).getByRole("button", {name: "列名を変更 メモ", exact: true}).click();
    await dialog(window).getByLabel("列名", {exact: true}).fill("Fresh memo");
    await app.evaluate(({ipcMain}, ownerId) => {
      const ipc = ipcMain as any, original = ipc._invokeHandlers.get("folio:request");
      const gate: any = ((globalThis as any).r6FreshPreviewGate = {reads: [], previews: [], commits: []});
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        const result = await original(event, request);
        if (request.type === "database:read" && request.databasePageId === ownerId)
          gate.reads.push({revision: result.page.revision, title: result.page.title});
        if (request.type === "property:preview") gate.previews.push({request: structuredClone(request), result});
        if (request.type === "property:commit") gate.commits.push({operation: structuredClone(request.operation), result});
        return result;
      });
    }, owner.id);
    await preview(window);
    const first = await app.evaluate(() => (globalThis as any).r6FreshPreviewGate);
    expect(first.previews).toHaveLength(1);
    expect(first.previews[0].request.revision).toBe(before.revision);
    expect(first.previews[0].result.command.revision).toBe(before.revision);
    const externalTitle = "R6 externally updated owner";
    const external = await window.evaluate(async ({id, revision, settings, title}) =>
      globalThis.window.folio.request<DatabaseOperationResult>({type: "database:commit", operation: {
        operationId: crypto.randomUUID(), sessionId: crypto.randomUUID(), seq: 1,
        command: {kind: "updateDatabase", databasePageId: id, revision, patch: {title}, settings},
      }}), {id: owner.id, revision: before.revision, settings: before.settings, title: externalTitle});
    expect(external.status).toBe("applied"); expect(external.page!.revision).toBe(before.revision + 1);
    // No stale apply here: this case tests the user's explicit preview refresh.
    await preview(window);
    const refreshed = await app.evaluate(() => (globalThis as any).r6FreshPreviewGate);
    expect(refreshed.reads.map((read: {revision: number}) => read.revision)).toEqual([before.revision, before.revision + 1]);
    expect(refreshed.reads[1].title).toBe(externalTitle);
    expect(refreshed.previews).toHaveLength(2); expect(refreshed.commits).toEqual([]);
    const newest = refreshed.previews[1];
    expect(newest.request.revision).toBe(before.revision + 1);
    expect(newest.result.command.revision).toBe(before.revision + 1);
    expect(newest.result.command.previewHash).not.toBe(first.previews[0].result.command.previewHash);
    expect((await r5Database(window, owner.id)).settings.properties.find((property) => property.id === "note")!.name).toBe("メモ");
    await Promise.all([window.waitForEvent("domcontentloaded"), dialog(window)
      .getByRole("button", {name: "この変更を適用", exact: true}).click()]);
    await expect(dialog(window)).toBeHidden(); await r5SettingsSaved(window);
    const finished = await app.evaluate(() => (globalThis as any).r6FreshPreviewGate);
    expect(finished.commits).toHaveLength(1);
    expect(finished.commits[0].operation.command).toEqual(newest.result.command);
    expect(finished.commits[0].result.status).toBe("applied");
    const after = await r5Database(window, owner.id);
    expect(after.revision).toBe(before.revision + 2);
    expect(after.records).toEqual(before.records);
    expect(after.settings.properties.find((property) => property.id === "note")!.name).toBe("Fresh memo");
    await expect(window.locator(".page-title")).toHaveValue(externalTitle);
    await expect(window.locator(`tr[data-record-id="${record.pageId}"]`).getByLabel("Fresh memo Stable record", {exact: true})).toBeVisible();
    assertR5LegacyUnchanged(data);
  } finally {await disposeR5(data, app);}
});
