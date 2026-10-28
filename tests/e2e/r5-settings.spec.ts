import { expect, test, type ElectronApplication } from "@playwright/test";
import {
  addR5Record,
  assertR5LegacyUnchanged,
  createR5Database,
  disposeR5,
  gateR5Database,
  launchR5,
  openR5Database,
  r5Data,
  r5Database,
  r5Gate,
  r5Saved,
  r5Settings,
  r5SettingsSaved,
  r5Snapshot,
} from "./r5-fixture";

test("UI view creation, rename, switch, typed filters, sort and grouping persist after Electron restart", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data);
    app = running.app;
    let window = running.window;
    const owner = await createR5Database(window);
    const records = [];
    for (const entry of [
      { title: "R5 low", note: "skip", estimate: "2", done: false },
      { title: "R5 high", note: "keep red", estimate: "9", done: true },
      { title: "R5 middle", note: "keep blue", estimate: "5", done: true },
    ]) {
      const record = await addR5Record(window, owner.id, entry.title);
      records.push(record);
      const row = window.locator(`tr[data-record-id="${record.pageId}"]`);
      await row
        .getByLabel(`メモ ${entry.title}`, { exact: true })
        .fill(entry.note);
      await row
        .getByLabel(`見積 ${entry.title}`, { exact: true })
        .fill(entry.estimate);
      await row
        .getByLabel(`完了 ${entry.title}`, { exact: true })
        .setChecked(entry.done);
      await r5Saved(window);
    }
    let settings = r5Settings(window);
    await settings.getByLabel("ビュー名", { exact: true }).fill("Qualified");
    await settings
      .getByText("フィルター・並べ替え・グループ", { exact: true })
      .click();
    await settings
      .getByRole("button", { name: "条件を追加 1", exact: true })
      .click();
    await settings
      .getByLabel("フィルター対象 1.1", { exact: true })
      .selectOption({ label: "メモ" });
    await settings
      .getByLabel("フィルター演算子 1.1", { exact: true })
      .selectOption("contains");
    await settings.getByLabel("フィルター値 1.1", { exact: true }).fill("keep");
    await settings
      .getByRole("button", { name: "条件を追加 1", exact: true })
      .click();
    await settings
      .getByLabel("フィルター対象 1.2", { exact: true })
      .selectOption({ label: "見積" });
    await settings
      .getByLabel("フィルター演算子 1.2", { exact: true })
      .selectOption("greater_than_or_equal");
    await settings.getByLabel("フィルター値 1.2", { exact: true }).fill("3");
    await settings
      .getByRole("button", { name: "条件を追加 1", exact: true })
      .click();
    await settings
      .getByLabel("フィルター対象 1.3", { exact: true })
      .selectOption({ label: "完了" });
    await settings
      .getByLabel("フィルター演算子 1.3", { exact: true })
      .selectOption("is_checked");
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
    await expect(window.locator("tr[data-record-id]")).toHaveCount(2);
    expect(
      await window
        .locator("tr[data-record-id]")
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute("data-record-id")),
        ),
    ).toEqual([records[1].pageId, records[2].pageId]);
    // Checkbox filtering is exercised independently, not inferred from the
    // two rows which also satisfy the text and numeric predicates.
    await settings
      .getByLabel("フィルター演算子 1.3", { exact: true })
      .selectOption("is_not_checked");
    await expect(window.locator("tr[data-record-id]")).toHaveCount(0);
    await settings
      .getByLabel("フィルター演算子 1.3", { exact: true })
      .selectOption("is_checked");
    await settings
      .getByLabel("グループの対象", { exact: true })
      .selectOption({ label: "メモ" });
    await settings
      .getByLabel("グループの順序", { exact: true })
      .selectOption("desc");
    await expect(
      window.getByRole("region", { name: "グループ keep red", exact: true }),
    ).toBeVisible();
    await expect(
      window.getByRole("region", { name: "グループ keep blue", exact: true }),
    ).toBeVisible();
    await r5SettingsSaved(window);
    const qualifiedId = await settings
      .getByRole("tab", { name: "ビュー: Qualified", exact: true })
      .getAttribute("data-view-id");
    await settings
      .getByLabel("ビューを追加", { exact: true })
      .selectOption("table");
    await settings.getByLabel("ビュー名", { exact: true }).fill("All rows");
    await r5SettingsSaved(window);
    await expect(window.locator("tr[data-record-id]")).toHaveCount(3);
    const allId = await settings
      .getByRole("tab", { name: "ビュー: All rows", exact: true })
      .getAttribute("data-view-id");
    expect(allId).not.toBe(qualifiedId);
    await settings
      .getByRole("tab", { name: "ビュー: Qualified", exact: true })
      .click();
    await expect(window.locator("tr[data-record-id]")).toHaveCount(2);
    // Creating a row remains discoverable even when the active filter hides it.
    await window.getByRole("button", { name: "新規行", exact: true }).click();
    await r5SettingsSaved(window);
    await expect
      .poll(async () => (await r5Database(window, owner.id)).records.length)
      .toBe(4);
    await expect(window.locator("tr[data-record-id]")).toHaveCount(2);
    await expect(
      window.getByText("追加した行は現在のフィルター条件では表示されません。", {
        exact: true,
      }),
    ).toBeVisible();
    await window
      .getByRole("button", { name: "追加したページを開く", exact: true })
      .click();
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toHaveValue("無題");
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await settings
      .getByRole("tab", { name: "ビュー: All rows", exact: true })
      .click();
    await r5SettingsSaved(window);
    const persisted = await r5Database(window, owner.id);
    expect(persisted.settings.views.map((view) => view.id)).toEqual([
      qualifiedId,
      allId,
    ]);
    expect(persisted.settings.activeViewId).toBe(allId);
    const qualified = persisted.settings.views.find(
      (view) => view.id === qualifiedId,
    )!;
    expect(qualified.filter.conditions).toHaveLength(3);
    expect(qualified.sorts).toHaveLength(1);
    expect(qualified.sorts[0].direction).toBe("desc");
    expect(qualified.groupBy?.direction).toBe("desc");
    await app.close();
    app = undefined;
    running = await launchR5(data);
    app = running.app;
    window = running.window;
    settings = r5Settings(window);
    await openR5Database(window);
    await expect(
      settings.getByRole("tab", { name: "ビュー: All rows", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(window.locator("tr[data-record-id]")).toHaveCount(4);
    expect((await r5Database(window, owner.id)).settings).toEqual(
      persisted.settings,
    );
    await settings
      .getByRole("tab", { name: "ビュー: Qualified", exact: true })
      .click();
    await expect(window.locator("tr[data-record-id]")).toHaveCount(2);
    await settings
      .getByText("フィルター・並べ替え・グループ", { exact: true })
      .click();
    await expect(
      settings.getByLabel("フィルター値 1.1", { exact: true }),
    ).toHaveValue("keep");
    await expect(
      settings.getByLabel("フィルター値 1.2", { exact: true }),
    ).toHaveValue("3");
    await expect(
      settings.getByLabel("フィルター演算子 1.3", { exact: true }),
    ).toHaveValue("is_checked");
    await expect(
      settings.getByLabel("並べ替え方向 1", { exact: true }),
    ).toHaveValue("desc");
    await expect(
      settings.getByLabel("グループの順序", { exact: true }),
    ).toHaveValue("desc");
    await r5SettingsSaved(window);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});

test("held settings ACK preserves later settings and owner title through navigation using one revision lane", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    const owner = await createR5Database(window);
    const baseline = await r5Database(window, owner.id);
    await gateR5Database(app, "updateDatabase", "held");
    await r5Settings(window)
      .getByLabel("ビュー名", { exact: true })
      .fill("Held view");
    await expect
      .poll(() =>
        app!.evaluate(() => typeof (globalThis as any).r5DatabaseGate.release),
      )
      .toBe("function");
    await r5Settings(window)
      .getByLabel("ビュー内検索", { exact: true })
      .fill("later search");
    await window.getByTitle("R5 Home", { exact: true }).click();
    await expect(window.locator(".page-title")).toHaveValue("R5 Home");
    await openR5Database(window);
    await expect(
      r5Settings(window).getByLabel("ビュー名", { exact: true }),
    ).toHaveValue("Held view");
    await expect(
      r5Settings(window).getByLabel("ビュー内検索", { exact: true }),
    ).toHaveValue("later search");
    await window
      .getByLabel("ページタイトル", { exact: true })
      .fill("R5 owner after pending input");
    expect((await r5Gate(app)).commits).toHaveLength(1);
    await app.evaluate(() => (globalThis as any).r5DatabaseGate.release());
    await r5SettingsSaved(window);
    const final = await r5Database(window, owner.id);
    expect(final.settings.views[0].name).toBe("Held view");
    expect(final.settings.views[0].filterText).toBe("later search");
    const snapshot = await r5Snapshot(window);
    expect(snapshot.pages.find((page) => page.id === owner.id)?.title).toBe(
      "R5 owner after pending input",
    );
    expect(snapshot.pages.find((page) => page.id === data.home.id)?.title).toBe(
      "R5 Home",
    );
    const gate = await r5Gate(app);
    expect(gate.commits).toHaveLength(3);
    expect(
      new Set(gate.commits.map((operation: any) => operation.operationId)).size,
    ).toBe(3);
    expect(
      new Set(gate.commits.map((operation: any) => operation.sessionId)).size,
    ).toBe(1);
    expect(
      gate.commits.map((operation: any) => operation.command.databasePageId),
    ).toEqual([owner.id, owner.id, owner.id]);
    expect(
      gate.commits.map((operation: any) => operation.command.revision),
    ).toEqual([
      baseline.revision,
      baseline.revision + 1,
      baseline.revision + 2,
    ]);
    expect(gate.commits[1].seq).toBeGreaterThan(gate.commits[0].seq);
    expect(gate.commits[2].seq).toBeGreaterThan(gate.commits[1].seq);
    expect(final.revision).toBe(baseline.revision + 3);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});

test("unknown settings retain their identity across navigation and resolve without duplicate apply", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data);
    app = running.app;
    let window = running.window;
    const owner = await createR5Database(window);
    const baseline = await r5Database(window, owner.id);
    await gateR5Database(app, "updateDatabase", "lost");
    await r5Settings(window)
      .getByLabel("ビュー名", { exact: true })
      .fill("Unknown view");
    await expect(r5Settings(window)).toHaveAttribute(
      "data-settings-state",
      "unknown",
    );
    await window.getByTitle("R5 Home", { exact: true }).click();
    await openR5Database(window);
    await expect(
      r5Settings(window).getByLabel("ビュー名", { exact: true }),
    ).toHaveValue("Unknown view");
    await expect(
      r5Settings(window).getByLabel("ビュー名", { exact: true }),
    ).toBeDisabled();
    expect((await r5Gate(app)).commits).toHaveLength(1);
    await app.evaluate(({ BrowserWindow }) => {
      (globalThis as any).r5PreventedReload = 0;
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.on("will-prevent-unload", () => {
        (globalThis as any).r5PreventedReload++;
      });
      contents.reload();
    });
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).r5PreventedReload))
      .toBe(1);
    await expect(r5Settings(window)).toHaveAttribute(
      "data-settings-state",
      "unknown",
    );
    await window
      .getByRole("button", { name: "設定の保存結果を確認", exact: true })
      .click();
    await r5SettingsSaved(window);
    const resolved = await r5Database(window, owner.id);
    expect(resolved.revision).toBe(baseline.revision + 1);
    expect(resolved.settings.views[0].name).toBe("Unknown view");
    const gate = await r5Gate(app);
    expect(gate.commits).toHaveLength(1);
    expect(gate.resolves).toEqual([gate.operation]);
    const duplicate = await window.evaluate(
      (operation) =>
        globalThis.window.folio.request<any>({
          type: "database:commit",
          operation,
        }),
      gate.operation,
    );
    expect(duplicate).toEqual(gate.result);
    expect(await r5Database(window, owner.id)).toEqual(resolved);
    await app.close();
    app = undefined;
    running = await launchR5(data);
    app = running.app;
    window = running.window;
    await openR5Database(window);
    await expect(
      r5Settings(window).getByLabel("ビュー名", { exact: true }),
    ).toHaveValue("Unknown view");
    expect(await r5Database(window, owner.id)).toEqual(resolved);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});

test("external owner revision conflicts with local settings without promoting the draft onto the new revision", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    const owner = await createR5Database(window);
    const baseline = await r5Database(window, owner.id);
    const external = await window.evaluate(
      async ({ ownerId, projection }) => {
        const settings = structuredClone(projection.settings);
        settings.views[0].name = "External view";
        return globalThis.window.folio.request<any>({
          type: "database:commit",
          operation: {
            operationId: crypto.randomUUID(),
            sessionId: crypto.randomUUID(),
            seq: 1,
            command: {
              kind: "updateDatabase",
              databasePageId: ownerId,
              revision: projection.revision,
              patch: { title: "External owner title" },
              settings,
            },
          },
        });
      },
      { ownerId: owner.id, projection: baseline },
    );
    expect(external.status).toBe("applied");
    await gateR5Database(app, "updateDatabase", "held");
    await r5Settings(window)
      .getByLabel("ビュー名", { exact: true })
      .fill("Local retained view");
    await expect
      .poll(() =>
        app!.evaluate(() => typeof (globalThis as any).r5DatabaseGate.release),
      )
      .toBe("function");
    await app.evaluate(() => (globalThis as any).r5DatabaseGate.release());
    await expect(r5Settings(window)).toHaveAttribute(
      "data-settings-state",
      "conflict",
    );
    await expect(
      r5Settings(window).getByLabel("ビュー名", { exact: true }),
    ).toHaveValue("Local retained view");
    await expect(
      r5Settings(window).getByLabel("ビュー名", { exact: true }),
    ).toBeDisabled();
    await expect(
      window.getByRole("button", { name: "新規行", exact: true }),
    ).toBeDisabled();
    const saved = await r5Database(window, owner.id);
    expect(saved).toEqual(external.database);
    expect(saved.revision).toBe(baseline.revision + 1);
    expect(
      (await r5Snapshot(window)).pages.find((page) => page.id === owner.id),
    ).toEqual(external.page);
    await window.getByTitle("R5 Home", { exact: true }).click();
    await openR5Database(window);
    await expect(r5Settings(window)).toHaveAttribute(
      "data-settings-state",
      "conflict",
    );
    await expect(
      r5Settings(window).getByLabel("ビュー名", { exact: true }),
    ).toHaveValue("Local retained view");
    const gate = await r5Gate(app);
    expect(gate.commits).toHaveLength(1);
    expect(gate.commits[0].command.revision).toBe(baseline.revision);
    expect(gate.results[0].status).toBe("rejected");
    expect(await r5Database(window, owner.id)).toEqual(external.database);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});
