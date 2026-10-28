import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/persistence/store";
import { attachFile } from "../../src/persistence/assets";
import { commitDatabaseOperation } from "../../src/persistence/database-operations";
import { prepareDatabaseCreation } from "../../src/shared/database-operation";
import { r5Data } from "./r5-fixture";

export function r6MigrationData(invalid = false) {
  const base = r5Data();
  const store = new Store(join(base.root, "workspace.sqlite"));
  const legacy = store.get(base.legacy.id);
  const history = store.update(legacy.id, legacy.revision, {
    database: {
      ...legacy.database!,
      rows: [
        legacy.database!.rows[0],
        {
          id: "r6-history-only",
          title: "History-only row",
          values: { status: "完了" },
        },
      ],
    },
  });
  const selected = store.update(legacy.id, history.revision, {
    database: {
      ...history.database!,
      rows: [
        {
          ...legacy.database!.rows[0],
          values: { status: invalid ? 17 : "進行中" },
        },
        {
          id: "r6-current-second",
          title: "Selected second row",
          values: { status: "未着手" },
        },
      ],
    },
  });
  const other = store.create(null, "database", "R6 Unselected legacy");
  store.update(other.id, other.revision, {
    database: {
      ...other.database!,
      rows: [
        {
          id: "r5-legacy-row",
          title: "Other legacy scoped row",
          values: { status: "完了" },
        },
      ],
    },
  });
  const registered = commitDatabaseOperation(
    store,
    prepareDatabaseCreation("R6 Existing registered"),
  ).page!;
  const assets = join(base.root, "assets");
  mkdirSync(assets, { recursive: true });
  const file = join(base.root, "r6-synthetic.txt");
  writeFileSync(file, "R6 migration attachment");
  const asset = attachFile(store.db, assets, file);
  const legacyRaw = String(
    store.db.prepare("SELECT data FROM pages WHERE id=?").get(selected.id)!
      .data,
  );
  store.close();
  return { ...base, legacy: selected, legacyRaw, other, registered, asset };
}
export type R6MigrationData = ReturnType<typeof r6MigrationData>;
export function readMigrationDisk(
  data: R6MigrationData,
  path = join(data.root, "workspace.sqlite"),
) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = (name: string) =>
      !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    return {
      pages: db.prepare("SELECT id,data,body FROM pages ORDER BY id").all(),
      versions: db.prepare("SELECT * FROM versions ORDER BY id").all(),
      registered: db
        .prepare(
          "SELECT database_page_id FROM record_databases ORDER BY database_page_id",
        )
        .all(),
      mapping: table("legacy_record_map")
        ? db
            .prepare(
              "SELECT * FROM legacy_record_map ORDER BY database_page_id,legacy_row_id",
            )
            .all()
        : [],
      archive: table("legacy_database_archive")
        ? db
            .prepare(
              "SELECT * FROM legacy_database_archive ORDER BY database_page_id",
            )
            .all()
        : [],
      integrity: db.prepare("PRAGMA integrity_check").get()?.integrity_check,
    };
  } finally {
    db.close();
  }
}
export async function openMigration(window: Page, data: R6MigrationData) {
  await window.getByTitle(data.legacy.title, { exact: true }).click();
  await window
    .getByRole("button", { name: "旧DBをページ形式へ移行", exact: true })
    .click();
  const dialog = window.getByRole("dialog", {
    name: "旧形式データベースを移行",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("移行前のデータを確認しています…", { exact: true }),
  ).toHaveCount(0);
  return dialog;
}
/** Capture only this test's migration IPC; execute the real handler before
 * losing/holding its ACK. Main state survives a renderer reload. */
export async function migrationGate(
  app: ElectronApplication,
  mode: "observe" | "lost" | "held",
) {
  await app.evaluate(({ ipcMain }, mode) => {
    const ipc = ipcMain as any,
      original = ipc._invokeHandlers.get("folio:request");
    const gate: any = ((globalThis as any).r6MigrationGate = {
      commits: [],
      resolves: [],
      results: [],
    });
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const result = await original(event, request);
      if (request.type === "migration:resolve")
        gate.resolves.push(request.operation);
      if (request.type === "migration:commit") {
        gate.commits.push(request.operation);
        gate.results.push(result);
        if (gate.commits.length === 1 && mode === "lost")
          throw new Error("R6 migration ACK lost after actual COMMIT");
        if (gate.commits.length === 1 && mode === "held")
          await new Promise<void>((release) => {
            gate.release = release;
          });
      }
      return result;
    });
  }, mode);
}
export const readMigrationGate = (app: ElectronApplication) =>
  app.evaluate(() => {
    const { commits, resolves, results } = (globalThis as any).r6MigrationGate;
    return { commits, resolves, results };
  });
