import { expect, test, type ElectronApplication } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  disposeR5,
  launchR5,
  openR5Database,
  openR5Record,
  r5Database,
  r5Saved,
  r5Settings,
} from "./r5-fixture";
import {
  migrationGate,
  openMigration,
  r6MigrationData,
  readMigrationDisk,
  readMigrationGate,
} from "./r6-migration-fixture";

test("explicit selected legacy migration preserves mixed workspace bytes, history and verified assets and supports record editing after restart", async () => {
  const data = r6MigrationData();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data);
    app = running.app;
    let window = running.window;
    await migrationGate(app, "observe");
    const dialog = await openMigration(window, data);
    await expect(
      dialog.getByRole("button", { name: "コピーを作成して移行", exact: true }),
    ).toBeEnabled();
    const before = readMigrationDisk(data);
    await Promise.all([
      window.waitForEvent("load"),
      dialog
        .getByRole("button", { name: "コピーを作成して移行", exact: true })
        .click(),
    ]);
    await expect(r5Settings(window)).toBeVisible();
    await r5Saved(window);
    const gate = await readMigrationGate(app);
    expect(gate.commits).toHaveLength(1);
    expect(gate.results[0].status).toBe("applied");
    const result = gate.results[0],
      after = readMigrationDisk(data);
    expect(after.registered.map((row) => row.database_page_id).sort()).toEqual(
      [data.legacy.id, data.registered.id].sort(),
    );
    expect(after.versions).toEqual(before.versions);
    expect(
      after.archive.find((row) => row.database_page_id === data.legacy.id)
        ?.data,
    ).toBe(data.legacyRaw);
    expect(after.mapping).toHaveLength(3);
    expect(
      after.mapping.every((row) => row.database_page_id === data.legacy.id),
    ).toBe(true);
    for (const page of before.pages.filter((row) => row.id !== data.legacy.id))
      expect(after.pages.find((row) => row.id === page.id)).toEqual(page);
    const copied = readMigrationDisk(
      data,
      join(result.snapshotPath, "workspace.sqlite"),
    );
    expect(copied.pages).toEqual(before.pages);
    expect(copied.versions).toEqual(before.versions);
    expect(copied.integrity).toBe("ok");
    expect(
      readFileSync(join(result.snapshotPath, "assets", data.asset.id), "utf8"),
    ).toBe("R6 migration attachment");
    expect(existsSync(join(result.snapshotPath, "manifest.json"))).toBe(true);
    expect(result.page.revision).toBe(data.legacy.revision + 1);
    expect(
      result.database.records.every((record: any) => record.revision === 0),
    ).toBe(true);
    const recordId = String(
      after.mapping.find((row) => row.legacy_row_id === "r5-legacy-row")!
        .page_id,
    );
    await openR5Record(window, "Legacy original row");
    await window
      .getByLabel("レコードのタイトル", { exact: true })
      .fill("R6 migrated editable row");
    await window
      .locator(".r3-record-page .folio-editor")
      .fill("R6 body saved after explicit migration");
    await r5Saved(window);
    await window
      .getByRole("button", { name: "レコードを閉じる", exact: true })
      .click();
    await app.close();
    app = undefined;
    running = await launchR5(data);
    app = running.app;
    window = running.window;
    await openR5Database(window, data.legacy.title);
    await openR5Record(window, "R6 migrated editable row");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "R6 body saved after explicit migration",
    );
    const saved = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      recordId,
    );
    expect(saved.record.values).toEqual({ status: "進行中" });
    expect(saved.record.databasePageId).toBe(data.legacy.id);
    expect(saved.page.revision).toBe(saved.record.revision);
    expect(readMigrationDisk(data).mapping).toEqual(after.mapping);
    expect(readMigrationDisk(data).archive).toEqual(after.archive);
  } finally {
    await disposeR5(data, app);
  }
});

test("migration preview rejects an incompatible legacy value without changing original bytes or creating a snapshot", async () => {
  const data = r6MigrationData(true);
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    const before = readMigrationDisk(data);
    const dialog = await openMigration(window, data);
    await expect(
      dialog.getByRole("button", { name: "コピーを作成して移行", exact: true }),
    ).toBeDisabled();
    await expect(dialog).toContainText("型が一致しない値");
    expect(readMigrationDisk(data)).toEqual(before);
    expect(existsSync(join(data.root, "backups", "legacy-migration"))).toBe(
      false,
    );
    await dialog
      .getByRole("button", { name: "閉じる", exact: true })
      .last()
      .click();
    await expect(dialog).toBeHidden();
  } finally {
    await disposeR5(data, app);
  }
});

test("post-COMMIT migration ACK loss locks the modal and resolves the original receipt without duplicate conversion", async () => {
  const data = r6MigrationData();
  let app: ElectronApplication | undefined;
  try {
    let running = await launchR5(data);
    app = running.app;
    let window = running.window;
    await migrationGate(app, "lost");
    const dialog = await openMigration(window, data);
    await dialog
      .getByRole("button", { name: "コピーを作成して移行", exact: true })
      .click();
    const resolve = dialog.getByRole("button", {
      name: "移行結果を確認",
      exact: true,
    });
    await expect(resolve).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "コピーを作成して移行", exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "閉じる", exact: true }).last(),
    ).toBeDisabled();
    await window.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    const committed = readMigrationDisk(data);
    expect(committed.mapping).toHaveLength(3);
    expect((await readMigrationGate(app)).commits).toHaveLength(1);
    await Promise.all([window.waitForEvent("load"), resolve.click()]);
    await expect(r5Settings(window)).toBeVisible();
    await r5Saved(window);
    const gate = await readMigrationGate(app);
    expect(gate.commits).toHaveLength(1);
    expect(gate.resolves).toEqual([gate.commits[0]]);
    expect(readMigrationDisk(data)).toEqual(committed);
    const projection = await r5Database(window, data.legacy.id);
    expect(projection.records).toHaveLength(2);
    const duplicate = await window.evaluate(
      (operation) =>
        globalThis.window.folio.request<any>({
          type: "migration:commit",
          operation,
        }),
      gate.commits[0],
    );
    expect(duplicate).toEqual(gate.results[0]);
    expect(readMigrationDisk(data)).toEqual(committed);
    expect(
      readdirSync(join(data.root, "backups", "legacy-migration")),
    ).toHaveLength(1);
    await app.close();
    app = undefined;
    running = await launchR5(data);
    app = running.app;
    window = running.window;
    expect(
      await window.evaluate(
        (operation) =>
          globalThis.window.folio.request<any>({
            type: "migration:resolve",
            operation,
          }),
        gate.commits[0],
      ),
    ).toEqual(gate.results[0]);
    expect((await r5Database(window, data.legacy.id)).records).toEqual(
      projection.records,
    );
    expect(readMigrationDisk(data)).toEqual(committed);
  } finally {
    await disposeR5(data, app);
  }
});

test("migration apply rejects an external owner change after preview and leaves the external state intact", async () => {
  const data = r6MigrationData();
  let app: ElectronApplication | undefined;
  try {
    const running = await launchR5(data);
    app = running.app;
    const window = running.window;
    await migrationGate(app, "observe");
    const dialog = await openMigration(window, data);
    await expect(
      dialog.getByRole("button", { name: "コピーを作成して移行", exact: true }),
    ).toBeEnabled();
    const external = await window.evaluate(
      ({ id, revision }) =>
        globalThis.window.folio.request<any>({
          type: "update",
          id,
          revision,
          patch: { title: "R6 externally changed legacy" },
        }),
      data.legacy,
    );
    const changed = readMigrationDisk(data);
    await dialog
      .getByRole("button", { name: "コピーを作成して移行", exact: true })
      .click();
    await expect(dialog).toContainText(
      "移行プレビューから原本または履歴が変わりました",
    );
    expect((await readMigrationGate(app)).results[0].status).toBe("rejected");
    expect(external.revision).toBe(data.legacy.revision + 1);
    expect(readMigrationDisk(data)).toEqual(changed);
    expect(changed.registered.map((row) => row.database_page_id)).toEqual([
      data.registered.id,
    ]);
    expect(existsSync(join(data.root, "backups", "legacy-migration"))).toBe(
      false,
    );
  } finally {
    await disposeR5(data, app);
  }
});
