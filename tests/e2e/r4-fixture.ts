import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/persistence/store";
import { RecordRepository } from "../../src/persistence/record-repository";
import { markRecordStoreVersion } from "../../src/persistence/record-version";
import { emptyDatabase, type Doc } from "../../src/shared/types";

export const r4Doc = (text: string): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content: [
    {
      type: "paragraph",
      attrs: { id: "r4-synthetic-block" },
      content: [{ type: "text", text }],
    },
  ],
});
export function r4Data() {
  mkdirSync(resolve("output"), { recursive: true });
  const root = mkdtempSync(resolve("output/r4-app-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const home = store.create(null, "page", "R4 Home");
  const historic = store.update(home.id, home.revision, {
    doc: r4Doc("履歴の本文"),
  });
  const current = store.update(home.id, historic.revision, {
    doc: r4Doc("現在の本文"),
  });
  const discarded = store.create(null, "page", "R4 Refresh Trigger");
  store.trash(discarded.id);
  let owner = store.create(null, "database", "R4 Tasks");
  const database = emptyDatabase();
  database.properties = [
    { id: "note", name: "メモ", type: "text" },
    { id: "estimate", name: "見積", type: "number" },
    { id: "done", name: "完了", type: "checkbox" },
  ];
  database.rows = [];
  owner = store.update(owner.id, owner.revision, { database });
  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    markRecordStoreVersion(store.db);
  });
  const first = repository.create(owner.id, "R4 Alpha", {
    note: "initial note",
    estimate: 1,
    done: false,
  });
  const second = repository.create(owner.id, "R4 Beta", {
    note: "beta note",
    estimate: 2,
    done: false,
  });
  store.updateRecordPage(first.pageId, owner.id, first.revision, {
    doc: r4Doc("alpha original body"),
  });
  store.updateRecordPage(second.pageId, owner.id, second.revision, {
    doc: r4Doc("beta original body"),
  });
  let tail = second;
  for (let i = 0; i < 28; i++)
    tail = repository.create(
      owner.id,
      `R4 filler ${String(i).padStart(2, "0")}`,
      {},
    );
  store.updateRecordPage(tail.pageId, owner.id, tail.revision, {
    doc: r4Doc("tail original body"),
  });
  store.handle({ type: "setting", key: "activePage", value: home.id });
  const versions = store.versions(home.id);
  const history = versions.find((version) =>
    JSON.stringify(version.doc).includes("履歴の本文"),
  )!;
  store.close();
  return { root, owner, first, second, tail, home: current, history };
}
export type R4Data = ReturnType<typeof r4Data>;
export async function launchR4(data: R4Data) {
  const app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: { ...process.env, FOLIO_DATA_DIR: data.root },
  });
  const window = await app.firstWindow();
  await expect(window.locator(".page-title")).toBeVisible();
  // Let Editor setup/normalization transactions reach App before identifying
  // the baseline used by fault injection; launch-time fixture revisions are
  // not proof of the revision installed in the live Editor.
  await window.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  await r4Saved(window);
  await app.evaluate(({ BrowserWindow }) => {
    (globalThis as any).r4PreventedUnload = 0;
    BrowserWindow.getAllWindows()[0].webContents.on(
      "will-prevent-unload",
      () => {
        (globalThis as any).r4PreventedUnload++;
      },
    );
  });
  return { app, window };
}
export async function openR4Database(window: Page) {
  await window.getByTitle("R4 Tasks", { exact: true }).click();
  await expect(
    window.getByRole("region", { name: "レコード一覧", exact: true }),
  ).toBeVisible();
}
export async function openR4Record(window: Page, title = "R4 Alpha") {
  await window
    .getByRole("button", { name: `開く ${title}`, exact: true })
    .click();
  await expect(
    window.getByLabel("レコードのタイトル", { exact: true }),
  ).toHaveValue(title);
  await expect(window.locator(".r3-record-page .folio-editor")).toBeVisible();
}
export async function r4Saved(window: Page) {
  await expect(window.locator(".save-state")).toHaveText("保存済み");
}
export async function readR4Record(window: Page, pageId: string) {
  return window.evaluate(
    (id) =>
      globalThis.window.folio.request<any>({ type: "record:read", pageId: id }),
    pageId,
  );
}
export async function disposeR4(data: R4Data, app?: ElectronApplication) {
  // Pending/unknown are intentionally retained by several cases. Terminate
  // only this test-owned Electron child, never any pre-existing user process.
  const child = app?.process();
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGKILL");
    });
  rmSync(data.root, { recursive: true, force: true });
}
