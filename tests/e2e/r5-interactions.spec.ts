import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
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

async function openOptions(window: Page) {
  const details = r5Settings(window).locator("details");
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.locator("summary").click();
}

test("numeric filter raw input survives navigation; changing its target resets both valid and incomplete text and clears the reload guard", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    const owner = await createR5Database(window);
    await openOptions(window);
    const settings = r5Settings(window);
    await settings
      .getByRole("button", { name: "条件を追加 1", exact: true })
      .click();
    const target = settings.getByLabel("フィルター対象 1.1", { exact: true });
    const input = settings.getByLabel("フィルター値 1.1", { exact: true });
    await target.selectOption({ label: "見積" });
    await input.fill("12");
    await r5SettingsSaved(window);
    expect(
      (await r5Database(window, owner.id)).settings.views[0].filter
        .conditions[0],
    ).toMatchObject({ kind: "condition", value: 12 });
    await target.selectOption({ label: "メモ" });
    await expect(input).toHaveValue("");
    await target.selectOption({ label: "見積" });
    await expect(input).toHaveValue("");
    await r5SettingsSaved(window);
    const canonical = await r5Database(window, owner.id);
    expect(canonical.settings.views[0].filter.conditions[0]).toMatchObject({
      kind: "condition",
      value: "",
    });
    await input.fill("-");
    await window.getByTitle("R5 Home", { exact: true }).click();
    await openR5Database(window);
    await openOptions(window);
    await expect(input).toHaveValue("-");
    expect((await r5Database(window, owner.id)).settings).toEqual(
      canonical.settings,
    );
    await app.evaluate(({ BrowserWindow }) => {
      (globalThis as any).r5RawPreventedReload = 0;
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.on("will-prevent-unload", () => {
        (globalThis as any).r5RawPreventedReload++;
      });
      contents.reload();
    });
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).r5RawPreventedReload))
      .toBe(1);
    await expect(input).toHaveValue("-");
    await target.selectOption({ label: "メモ" });
    await target.selectOption({ label: "見積" });
    await expect(input).toHaveValue("");
    await r5SettingsSaved(window);
    expect(
      (await r5Database(window, owner.id)).settings.views[0].filter
        .conditions[0],
    ).toMatchObject({ kind: "condition", value: "" });
    await Promise.all([
      window.waitForEvent("load"),
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.reload(),
      ),
    ]);
    await expect(r5Settings(window)).toBeVisible();
    await openOptions(window);
    await expect(input).toHaveValue("");
    expect(
      await app.evaluate(() => (globalThis as any).r5RawPreventedReload),
    ).toBe(1);
    await r5SettingsSaved(window);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});

test("continuous typing in a grouping property keeps the same focused input until row blur and then moves the saved row", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    const owner = await createR5Database(window);
    const moving = await addR5Record(window, owner.id, "R5 moving row");
    const stable = await addR5Record(window, owner.id, "R5 stable row");
    const row = window.locator(`tr[data-record-id="${moving.pageId}"]`);
    const input = row.getByLabel("メモ R5 moving row", { exact: true });
    await input.fill("a");
    await window
      .locator(`tr[data-record-id="${stable.pageId}"]`)
      .getByLabel("メモ R5 stable row", { exact: true })
      .fill("z");
    await r5Saved(window);
    await openOptions(window);
    await r5Settings(window)
      .getByLabel("グループの対象", { exact: true })
      .selectOption({ label: "メモ" });
    await r5SettingsSaved(window);
    await expect(
      window
        .getByRole("region", { name: "グループ a", exact: true })
        .locator(`tr[data-record-id="${moving.pageId}"]`),
    ).toBeVisible();
    await input.focus();
    await input.evaluate((element) => {
      (globalThis as any).r5GroupingInput = element;
    });
    await window.keyboard.press(
      process.platform === "darwin" ? "Meta+A" : "Control+A",
    );
    await window.keyboard.type("moving-value", { delay: 15 });
    await expect(input).toHaveValue("moving-value");
    await expect(input).toBeFocused();
    expect(
      await input.evaluate(
        (element) => element === (globalThis as any).r5GroupingInput,
      ),
    ).toBe(true);
    await row.getByLabel("見積 R5 moving row", { exact: true }).focus();
    expect(
      await input.evaluate(
        (element) => element === (globalThis as any).r5GroupingInput,
      ),
    ).toBe(true);
    await r5Settings(window).getByLabel("ビュー名", { exact: true }).focus();
    await r5Saved(window);
    await expect(
      window
        .getByRole("region", { name: "グループ moving-value", exact: true })
        .locator(`tr[data-record-id="${moving.pageId}"]`),
    ).toBeVisible();
    await expect(
      window
        .getByRole("region", { name: "グループ z", exact: true })
        .locator(`tr[data-record-id="${stable.pageId}"]`),
    ).toBeVisible();
    const persisted = await r5Database(window, owner.id);
    expect(
      persisted.records.find((record) => record.pageId === moving.pageId)
        ?.values.note,
    ).toBe("moving-value");
    expect(
      persisted.records.find((record) => record.pageId === stable.pageId)
        ?.values.note,
    ).toBe("z");
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});

test("board groups and gallery filtering use saved views and open the same records after restart", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data);
    app = running.app;
    let window = running.window;
    const owner = await createR5Database(window);
    const first = await addR5Record(window, owner.id, "R5 card A");
    const second = await addR5Record(window, owner.id, "R5 card B");
    await window
      .locator(`tr[data-record-id="${first.pageId}"]`)
      .getByLabel("完了 R5 card A", { exact: true })
      .check();
    await window
      .locator(`tr[data-record-id="${second.pageId}"]`)
      .getByLabel("完了 R5 card B", { exact: true })
      .check();
    await window
      .locator(`tr[data-record-id="${second.pageId}"]`)
      .getByLabel("完了 R5 card B", { exact: true })
      .uncheck();
    await r5Saved(window);
    let settings = r5Settings(window);
    await settings
      .getByLabel("ビューを追加", { exact: true })
      .selectOption("board");
    await settings.getByLabel("ビュー名", { exact: true }).fill("R5 Board");
    await openOptions(window);
    await settings
      .getByLabel("グループの対象", { exact: true })
      .selectOption({ label: "完了" });
    await r5SettingsSaved(window);
    const board = window.locator('.r3-db-scroll[data-view-type="board"]');
    await expect(
      board
        .getByRole("region", { name: "グループ チェック済み", exact: true })
        .getByRole("button", { name: "開く R5 card A", exact: true }),
    ).toBeVisible();
    await expect(
      board
        .getByRole("region", { name: "グループ 未チェック", exact: true })
        .getByRole("button", { name: "開く R5 card B", exact: true }),
    ).toBeVisible();
    await openR5Record(window, "R5 card A");
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await settings
      .getByLabel("ビューを追加", { exact: true })
      .selectOption("gallery");
    await settings.getByLabel("ビュー名", { exact: true }).fill("R5 Gallery");
    await settings
      .getByLabel("ビュー内検索", { exact: true })
      .fill("R5 card B");
    await r5SettingsSaved(window);
    const gallery = window.locator('.r3-db-scroll[data-view-type="gallery"]');
    await expect(
      gallery.getByRole("button", { name: "開く R5 card B", exact: true }),
    ).toBeVisible();
    await expect(
      gallery.getByRole("button", { name: "開く R5 card A", exact: true }),
    ).toHaveCount(0);
    const persisted = await r5Database(window, owner.id);
    const boardView = persisted.settings.views.find(
      (view) => view.name === "R5 Board",
    )!;
    const galleryView = persisted.settings.views.find(
      (view) => view.name === "R5 Gallery",
    )!;
    expect(boardView.type).toBe("board");
    expect(boardView.groupBy?.propertyId).toBe("done");
    expect(galleryView.type).toBe("gallery");
    expect(galleryView.filterText).toBe("R5 card B");
    expect(persisted.settings.activeViewId).toBe(galleryView.id);
    await app.close();
    app = undefined;
    running = await launchR5(data);
    app = running.app;
    window = running.window;
    settings = r5Settings(window);
    await openR5Database(window);
    await expect(
      settings.getByRole("tab", { name: "ビュー: R5 Gallery", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const reopenedGallery = window.locator(
      '.r3-db-scroll[data-view-type="gallery"]',
    );
    await expect(
      reopenedGallery.getByRole("button", {
        name: "開く R5 card B",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      reopenedGallery.getByRole("button", {
        name: "開く R5 card A",
        exact: true,
      }),
    ).toHaveCount(0);
    expect((await r5Database(window, owner.id)).settings).toEqual(
      persisted.settings,
    );
    await settings
      .getByRole("tab", { name: "ビュー: R5 Board", exact: true })
      .click();
    await expect(
      window.locator('.r3-db-scroll[data-view-type="board"] .r3-card-open'),
    ).toHaveCount(2);
    await openR5Record(window, "R5 card B");
    const pair = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      second.pageId,
    );
    expect(pair.page.title).toBe("R5 card B");
    expect(pair.record.databasePageId).toBe(owner.id);
    await r5Saved(window);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});

test("late database creation ACK does not replace an existing record opened after its dialog was closed", async () => {
  const data = r5Data();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    const owner = await createR5Database(window, "R5 Existing");
    const existing = await addR5Record(window, owner.id, "R5 Existing record");
    await gateR5Database(app, "createDatabase", "held");
    await window
      .getByRole("button", { name: "新しいデータベース", exact: true })
      .click();
    const dialog = window.getByRole("dialog", {
      name: "新しいデータベース",
      exact: true,
    });
    await dialog
      .getByLabel("データベース名", { exact: true })
      .fill("R5 Late database");
    await dialog.getByRole("button", { name: "作成", exact: true }).click();
    await expect
      .poll(() =>
        app!.evaluate(() => typeof (globalThis as any).r5DatabaseGate.release),
      )
      .toBe("function");
    await dialog
      .getByRole("button", { name: "閉じる", exact: true })
      .last()
      .click();
    await openR5Record(window, "R5 Existing record");
    await app.evaluate(() => (globalThis as any).r5DatabaseGate.release());
    await r5Saved(window);
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toHaveValue("R5 Existing record");
    await expect(window.locator(".page-title")).toHaveValue("R5 Existing");
    await expect(
      window.getByTitle("R5 Late database", { exact: true }),
    ).toBeVisible();
    const gate = await r5Gate(app);
    expect(gate.commits).toHaveLength(1);
    expect(gate.result.status).toBe("applied");
    const snapshot = await r5Snapshot(window);
    expect(snapshot.recordDatabaseIds).toContain(gate.result.page.id);
    expect(
      snapshot.records?.find((record) => record.pageId === existing.pageId)
        ?.databasePageId,
    ).toBe(owner.id);
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await openR5Database(window, "R5 Late database");
    expect((await r5Database(window, gate.result.page.id)).records).toEqual([]);
    assertR5LegacyUnchanged(data);
  } finally {
    await disposeR5(data, app);
  }
});
