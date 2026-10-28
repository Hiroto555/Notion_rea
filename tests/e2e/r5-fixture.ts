import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../src/persistence/store";
import {
  emptyDatabase,
  type Snapshot,
  type DatabaseProjection,
} from "../../src/shared/types";

/** The first registered database must be created by the UI under test. */
export function r5Data() {
  mkdirSync(resolve("output"), { recursive: true });
  const root = mkdtempSync(resolve("output/r5-app-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const home = store.create(null, "page", "R5 Home");
  store.update(home.id, home.revision, {
    doc: {
      type: "doc",
      schemaVersion: 1,
      content: [
        {
          type: "paragraph",
          attrs: { id: "r5-home-block" },
          content: [{ type: "text", text: "R5 synthetic home" }],
        },
      ],
    },
  });
  let legacy = store.create(null, "database", "R5 Legacy retained");
  const database = emptyDatabase();
  database.rows = [
    {
      id: "r5-legacy-row",
      title: "Legacy original row",
      values: { status: "進行中" },
    },
  ];
  legacy = store.update(legacy.id, legacy.revision, { database });
  const legacyRaw = (
    store.db.prepare("SELECT data FROM pages WHERE id=?").get(legacy.id) as {
      data: string;
    }
  ).data;
  const version = store.db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  expect(version.user_version).toBe(3);
  expect(store.load().recordDatabaseIds).toBeUndefined();
  store.handle({ type: "setting", key: "activePage", value: home.id });
  store.close();
  return { root, home, legacy, legacyRaw };
}
export type R5Data = ReturnType<typeof r5Data>;

export async function launchR5(data: R5Data) {
  const app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: { ...process.env, FOLIO_DATA_DIR: data.root },
  });
  const window = await app.firstWindow();
  await expect(window.locator(".page-title")).toBeVisible();
  expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(
    data.root,
  );
  expect(await app.evaluate(({ app }) => app.getPath("sessionData"))).toBe(
    join(data.root, "session"),
  );
  await window.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  await r5Saved(window);
  return { app, window };
}
export async function r5Saved(window: Page) {
  await expect(window.locator(".save-state")).toHaveText("保存済み");
}
export const r5Settings = (window: Page) =>
  window.getByRole("region", { name: "データベースの表示設定", exact: true });
export async function r5SettingsSaved(window: Page) {
  await expect(r5Settings(window)).toHaveAttribute(
    "data-settings-state",
    /^(saved|idle)$/,
  );
  await r5Saved(window);
}
export async function r5Snapshot(window: Page): Promise<Snapshot> {
  return window.evaluate(() =>
    globalThis.window.folio.request<Snapshot>({ type: "load" }),
  );
}
export async function r5Database(
  window: Page,
  databasePageId: string,
): Promise<DatabaseProjection> {
  return window.evaluate(
    (id) =>
      globalThis.window.folio.request<DatabaseProjection>({
        type: "database:load",
        databasePageId: id,
      }),
    databasePageId,
  );
}
export async function createR5Database(window: Page, title = "R5 Tasks") {
  await window
    .getByRole("button", { name: "新しいデータベース", exact: true })
    .click();
  const dialog = window.getByRole("dialog", {
    name: "新しいデータベース",
    exact: true,
  });
  await dialog.getByLabel("データベース名", { exact: true }).fill(title);
  await dialog.getByRole("button", { name: "作成", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(window.locator(".page-title")).toHaveValue(title);
  await r5SettingsSaved(window);
  const snapshot = await r5Snapshot(window);
  const matches = snapshot.pages.filter(
    (page) => page.title === title && page.kind === "database",
  );
  expect(matches).toHaveLength(1);
  expect(snapshot.recordDatabaseIds).toContain(matches[0].id);
  return matches[0];
}
export async function openR5Database(window: Page, title = "R5 Tasks") {
  await window.getByTitle(title, { exact: true }).click();
  await expect(window.locator(".page-title")).toHaveValue(title);
  await expect(r5Settings(window)).toBeVisible();
}
export async function addR5Record(
  window: Page,
  ownerId: string,
  title: string,
) {
  const before = await r5Database(window, ownerId);
  await window.getByRole("button", { name: "新規行", exact: true }).click();
  await expect
    .poll(async () => (await r5Database(window, ownerId)).records.length)
    .toBe(before.records.length + 1);
  const next = await r5Database(window, ownerId);
  const record = next.records.find(
    (candidate) =>
      !before.records.some((old) => old.pageId === candidate.pageId),
  )!;
  expect(record.title).toBe("無題");
  const row = window.locator(`tr[data-record-id="${record.pageId}"]`);
  await row.getByLabel("名前 無題", { exact: true }).fill(title);
  await r5Saved(window);
  return { ...record, title };
}
export async function openR5Record(window: Page, title: string) {
  await window
    .getByRole("button", { name: `開く ${title}`, exact: true })
    .click();
  await expect(
    window.getByLabel("レコードのタイトル", { exact: true }),
  ).toHaveValue(title);
  await expect(window.locator(".r3-record-page .folio-editor")).toBeVisible();
}
export function assertR5LegacyUnchanged(data: R5Data) {
  const db = new DatabaseSync(join(data.root, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    expect(
      (
        db.prepare("SELECT data FROM pages WHERE id=?").get(data.legacy.id) as {
          data: string;
        }
      ).data,
    ).toBe(data.legacyRaw);
    expect(
      db
        .prepare("SELECT 1 FROM record_databases WHERE database_page_id=?")
        .get(data.legacy.id),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT 1 FROM record_memberships WHERE page_id=?")
        .get("r5-legacy-row"),
    ).toBeUndefined();
  } finally {
    db.close();
  }
}
export async function disposeR5(data: R5Data, app?: ElectronApplication) {
  const child = app?.process();
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGKILL");
    });
  rmSync(data.root, { recursive: true, force: true });
}

/** Fault is injected after the real SQLite operation has returned. */
export async function gateR5Database(
  app: ElectronApplication,
  kind: "createDatabase" | "createRecord" | "updateDatabase",
  mode: "lost" | "held",
) {
  await app.evaluate(
    ({ ipcMain }, config) => {
      const ipc = ipcMain as any,
        original = ipc._invokeHandlers.get("folio:request");
      const gate: any = ((globalThis as any).r5DatabaseGate = {
        commits: [],
        resolves: [],
        results: [],
        injected: false,
      });
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        const result = await original(event, request);
        if (request.type === "database:resolve")
          gate.resolves.push(request.operation);
        if (request.type === "database:commit") {
          gate.commits.push(request.operation);
          gate.results.push(result);
          if (
            !gate.injected &&
            request.operation.command.kind === config.kind
          ) {
            gate.injected = true;
            gate.operation = request.operation;
            gate.result = result;
            if (config.mode === "lost")
              throw new Error("R5 synthetic post-COMMIT ACK loss");
            await new Promise<void>((release) => {
              gate.release = release;
            });
          }
        }
        return result;
      });
    },
    { kind, mode },
  );
}
export async function r5Gate(app: ElectronApplication) {
  return app.evaluate(() => {
    const { commits, resolves, results, operation, result, injected } = (
      globalThis as any
    ).r5DatabaseGate;
    return { commits, resolves, results, operation, result, injected };
  });
}
