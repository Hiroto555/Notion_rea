import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../../src/persistence/store";
import { RecordRepository } from "../../../src/persistence/record-repository";
import { markRecordStoreVersion } from "../../../src/persistence/record-version";
import {
  emptyDatabase,
  type DatabaseProjection,
  type Doc,
  type Snapshot,
} from "../../../src/shared/types";

/** A blank synthetic entry point. The fixture never touches a real workspace. */
export const r7Paragraph = (text: string): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** Rich-enough body to prove that the Markdown UI exports actual document
 * formatting instead of a placeholder or a raw JSON dump. */
export const r7RichDoc = (): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "R7 見出し" }],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "本文 " },
        { type: "text", text: "太字", marks: [{ type: "bold" }] },
      ],
    },
    {
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: false },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "やること" }] },
          ],
        },
      ],
    },
  ],
});

const emptyFilter = (id: string) => ({
  kind: "group" as const,
  id,
  conjunction: "and" as const,
  conditions: [],
});

export function r7Data() {
  mkdirSync(resolve("output"), { recursive: true });
  const root = mkdtempSync(resolve("output/r7-acceptance-"));
  const dataDir = join(root, "workspace");
  mkdirSync(dataDir);
  const exportsDir = join(root, "exports");
  const inputsDir = join(root, "inputs");
  mkdirSync(exportsDir);
  mkdirSync(inputsDir);
  const store = new Store(join(dataDir, "workspace.sqlite"));

  const home = store.create(null, "page", "R7 Home");
  store.update(home.id, home.revision, { doc: r7RichDoc() });

  // Created before the title match so a title-priority result cannot be an
  // accident of insertion order.
  let bodyMatch = store.create(null, "page", "Zeta Body");
  bodyMatch = store.update(bodyMatch.id, bodyMatch.revision, {
    doc: r7Paragraph("前置きの長い本文。".repeat(50) + "Prefix words Needle appears in body context Suffix words"),
  });

  const staleFirst = store.create(null, "page", "Stale First Response");
  store.update(staleFirst.id, staleFirst.revision, {
    doc: r7Paragraph("first response marker"),
  });
  const staleSecond = store.create(null, "page", "Stale Second Response");
  store.update(staleSecond.id, staleSecond.revision, {
    doc: r7Paragraph("second response marker"),
  });

  let owner = store.create(null, "database", "R7 Tasks");
  const database = emptyDatabase();
  database.properties = [
    {
      id: "status",
      name: "ステータス",
      type: "select",
      options: ["未着手", "進行中", "完了"],
    },
    { id: "note", name: "メモ", type: "text" },
  ];
  database.views = [
    {
      id: "view-table",
      name: "テーブル",
      type: "table",
      filterText: "",
      filter: emptyFilter("filter-table"),
      sorts: [],
      groupBy: null,
    },
    {
      id: "view-board",
      name: "進行ボード",
      type: "board",
      filterText: "",
      filter: emptyFilter("filter-board"),
      sorts: [],
      groupBy: { propertyId: "status", direction: "asc" },
    },
  ];
  database.activeViewId = "view-board";
  database.view = "board";
  database.filter = "";
  database.sort = "";
  owner = store.update(owner.id, owner.revision, { database });

  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    markRecordStoreVersion(store.db);
  });
  const alpha = repository.create(owner.id, "Alpha task", {
    status: "進行中",
    note: "Alpha board excerpt",
  });
  store.updateRecordPage(alpha.pageId, owner.id, alpha.revision, {
    doc: r7Paragraph("Alpha body text"),
  });
  const beta = repository.create(owner.id, "Beta task", {
    status: "未着手",
    note: "Beta board excerpt",
  });
  store.updateRecordPage(beta.pageId, owner.id, beta.revision, {
    doc: r7Paragraph("Beta body text"),
  });
  const propertyMatch = repository.create(owner.id, "Omega Property", {
    status: "未着手",
    note: "property Needle context here",
  });

  // Last title match, deliberately after the body/property matches above.
  let titleMatch = store.create(null, "page", "Needle Title");
  titleMatch = store.update(titleMatch.id, titleMatch.revision, {
    doc: r7Paragraph("title page body has no search term"),
  });

  store.handle({ type: "setting", key: "activePage", value: home.id });
  store.close();
  return {
    root,
    dataDir,
    exportsDir,
    inputsDir,
    home,
    owner,
    records: { alpha, beta, propertyMatch },
    pages: { bodyMatch, titleMatch, staleFirst, staleSecond },
  };
}
export type R7Data = ReturnType<typeof r7Data>;

export async function launchR7(data: R7Data) {
  const app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: { ...process.env, FOLIO_DATA_DIR: data.dataDir },
  });
  const window = await app.firstWindow();
  await expect(window.locator(".page-title")).toBeVisible();
  // Let Editor setup/normalization reach App before asserting a saved baseline.
  await window.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  await r7Saved(window);
  return { app, window };
}

export async function r7Saved(window: Page) {
  await expect(window.locator(".save-state")).toHaveText("保存済み");
}

export async function r7Snapshot(window: Page): Promise<Snapshot> {
  return window.evaluate(() =>
    globalThis.window.folio.request<Snapshot>({ type: "load" }),
  );
}

export async function r7Database(
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

export async function openR7Database(window: Page, title = "R7 Tasks") {
  await window.getByTitle(title, { exact: true }).click();
  await expect(
    window.getByRole("region", { name: "レコード一覧", exact: true }),
  ).toBeVisible();
}

export const r7Settings = (window: Page) =>
  window.getByRole("region", { name: "データベースの表示設定", exact: true });

/** Contract anchor for Round 7's compact settings surface. */
export const r7ViewSettingsButton = (window: Page) =>
  window
    .getByRole("button", { name: "ビューのオプション", exact: true })
    .first();

export async function openR7ViewSettings(window: Page) {
  const button = r7ViewSettingsButton(window);
  await expect(button).toBeVisible();
  await button.click();
  return button;
}

/** Native dialogs are replaced inside the test-owned Electron process only. */
export async function mockSaveDialog(
  app: ElectronApplication,
  path: string | null,
) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = (async () => ({
      canceled: target === null,
      filePath: target ?? undefined,
    })) as typeof dialog.showSaveDialog;
  }, path);
}

export async function mockOpenDialog(
  app: ElectronApplication,
  path: string | null,
) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = (async () => ({
      canceled: target === null,
      filePaths: target ? [target] : [],
    })) as typeof dialog.showOpenDialog;
  }, path);
}

export async function disposeR7(data: R7Data, app?: ElectronApplication) {
  const child = app?.process();
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGKILL");
    });
  rmSync(data.root, { recursive: true, force: true });
}
