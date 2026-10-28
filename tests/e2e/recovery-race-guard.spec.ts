import { test, expect, _electron as electron, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/persistence/store";

/** Only isolated synthetic workspaces and dialogs stubbed in the test process.
 * Composition events below are synthetic; physical Japanese IME is NOT_RUN. */
type Fixture = {
  app: ElectronApplication;
  window: Page;
  root: string;
  exports: string;
  source: { id: string; title: string; doc: unknown; revision: number };
  stored: { id: string; title: string; doc: unknown; revision: number };
};

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(resolve("output/recovery-race-guard-"));
  const workspace = join(root, "workspace"), exports = join(root, "exports");
  mkdirSync(workspace); mkdirSync(exports);
  const store = new Store(join(workspace, "workspace.sqlite"));
  const sourcePage = store.create(null, "page", "Synthetic race source");
  const targetPage = store.create(null, "page", "Synthetic race target");
  store.update(sourcePage.id, sourcePage.revision, { doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: "source-block" }, content: [{ type: "text", text: "source persisted body" }] }] } });
  store.update(targetPage.id, targetPage.revision, { doc: { type: "doc", content: [{ type: "paragraph", attrs: { id: "target-block" }, content: [{ type: "text", text: "target persisted body" }] }] } });
  store.handle({ type: "setting", key: "activePage", value: sourcePage.id });
  store.close();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [resolve("dist/main.cjs")], env: { ...process.env, FOLIO_DATA_DIR: workspace } });
    const window = await app.firstWindow();
    const title = window.getByLabel("ページタイトル", { exact: true });
    await expect(title).toHaveValue("Synthetic race source");
    await expect(window.locator(".folio-editor")).toBeVisible();
    const source = await window.evaluate(async () => {
      const snapshot = await globalThis.window.folio.request<any>({ type: "load" });
      const page = snapshot.pages.find((p: any) => p.title === "Synthetic race source");
      if (!page) throw new Error("Synthetic source page missing");
      return page;
    });
    // Another revision creates a real optimistic-lock conflict, leaving the
    // Editor's local title and body in the App's pending queue.
    const stored = await window.evaluate(async (page) => globalThis.window.folio.request<any>({
      type: "update", id: page.id, revision: page.revision,
      patch: { title: "externally saved original" },
    }), source);
    await title.fill("initial local title");
    await expect(window.getByRole("alert")).toBeVisible();
    await window.locator(".folio-editor").fill("initial local body");
    await expect(window.locator(".folio-editor")).toContainText("initial local body");
    await expect(window.getByRole("alert")).toContainText("後続の変更を送信せず保持しています");
    // Establish a distinct pre-recovery alert so the later assertion cannot
    // accidentally accept the conflict message that already existed.
    await window.getByRole("button", { name: "保存を再試行", exact: true }).click();
    await expect(window.getByRole("alert")).toContainText("安全に再試行できません");
    return { app, window, root, exports, source, stored };
  } catch (error) {
    if (app) {
      const child = app.process();
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((done) => { child.once("exit", () => done()); child.kill("SIGKILL"); });
      }
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function closeFixture(f: Fixture) {
  // This child and its disposable workspace are test-owned. Pending input is
  // deliberately retained until journal evidence is read; do not close or kill
  // any other Electron process or use a real user workspace.
  const child = f.app.process();
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise<void>((done) => { child.once("exit", () => done()); child.kill("SIGKILL"); });
  rmSync(f.root, { recursive: true, force: true });
}

async function setHeldDialog(f: Fixture, destination: string) {
  await f.app.evaluate(({ dialog }, path) => {
    (globalThis as any).recoveryRaceEntered = false;
    (globalThis as any).releaseRecoveryRace = undefined;
    dialog.showSaveDialog = (async () => new Promise((done) => {
      (globalThis as any).recoveryRaceEntered = true;
      (globalThis as any).releaseRecoveryRace = () => done({ canceled: false, filePath: path });
    })) as typeof dialog.showSaveDialog;
  }, destination);
}
async function releaseDialog(f: Fixture) {
  await f.app.evaluate(() => {
    const release = (globalThis as any).releaseRecoveryRace;
    if (typeof release !== "function") throw new Error("Recovery dialog was not held");
    release();
  });
}
async function waitForHeldDialog(f: Fixture) {
  await expect.poll(() => f.app.evaluate(() => (globalThis as any).recoveryRaceEntered === true)).toBe(true);
}
async function savedPage(f: Fixture) {
  return f.window.evaluate(async (id) => {
    const snapshot = await globalThis.window.folio.request<any>({ type: "load" });
    return snapshot.pages.find((page: any) => page.id === id);
  }, f.source.id);
}
async function assertStoredOriginal(f: Fixture) {
  const actual = await savedPage(f);
  expect(actual.id).toBe(f.stored.id);
  expect(actual.title).toBe(f.stored.title);
  expect(actual.doc).toEqual(f.stored.doc);
  expect(actual.revision).toBe(f.stored.revision);
}
async function saveJournal(f: Fixture, info: TestInfo) {
  const path = join(f.exports, "pending-journal.json");
  await f.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
  }, path);
  await f.window.getByRole("button", { name: "未保存の変更を別ファイルに記録", exact: true }).click();
  await expect.poll(() => existsSync(path)).toBe(true);
  const bytes = readFileSync(path, "utf8");
  writeFileSync(info.outputPath("pending-journal.json"), bytes);
  const journal = JSON.parse(bytes);
  expect(journal.format).toBe("folio-pending-journal");
  expect(journal.use).toBe("manual-inspection-only");
  expect(journal.entries.some((entry: any) => entry.id === f.source.id && entry.patch?.title === "initial local title")).toBe(true);
  expect(journal.entries.some((entry: any) => entry.id === f.source.id && JSON.stringify(entry.patch?.doc ?? {}).includes("initial local body"))).toBe(true);
  return journal;
}
async function verifyRecoveryFile(path: string, info: TestInfo, f: Fixture) {
  await expect.poll(() => existsSync(path)).toBe(true);
  const bytes = readFileSync(path, "utf8");
  writeFileSync(info.outputPath("page-only-recovery.json"), bytes);
  const recovery = JSON.parse(bytes);
  expect(recovery.format).toBe("folio-recovery");
  expect(recovery.schemaVersion).toBe(2);
  expect(recovery.pages).toHaveLength(1);
  expect(recovery.pages[0].id).toBe(f.source.id);
  expect(recovery.pages[0].title).toBe("initial local title");
  expect(JSON.stringify(recovery.pages[0].doc)).toContain("initial local body");
  return recovery;
}

for (const scenario of ["later-input", "selection-change", "synthetic-ime"] as const) {
  test(`Page-only recovery retains pending after ${scenario} during the save dialog`, async ({}, info) => {
    const f = await fixture();
    const recoveryPath = join(f.exports, `page-only-${scenario}.json`);
    try {
      await setHeldDialog(f, recoveryPath);
      await f.window.getByRole("button", { name: "退避して再読込", exact: true }).click();
      await waitForHeldDialog(f);
      if (scenario === "later-input") {
        await f.window.getByLabel("ページタイトル", { exact: true }).fill("later local title");
        await f.window.locator(".folio-editor").fill("later local body");
      } else if (scenario === "selection-change") {
        await f.window.locator(".page-tree-label").filter({ hasText: "Synthetic race target" }).click();
        await expect(f.window.getByLabel("ページタイトル", { exact: true })).toHaveValue("Synthetic race target");
        await expect(f.window.locator(".folio-editor")).not.toContainText("initial local body");
      } else {
        await f.window.locator(".folio-editor").dispatchEvent("compositionstart", { data: "変換中" });
      }
      await releaseDialog(f);
      await verifyRecoveryFile(recoveryPath, info, f);
      // Await the post-write guard itself before inspecting the queue. A
      // merely visible pre-existing conflict banner would not establish that
      // the reload/guard completed.
      await expect(f.window.getByRole("alert")).toContainText(
        scenario === "later-input"
          ? /ファイルは保存されていますが未保存変更は保持しています|後続の変更を送信せず保持しています/
          : "ファイルは保存されていますが未保存変更は保持しています",
      );
      if (scenario === "later-input") {
        await expect(f.window.getByLabel("ページタイトル", { exact: true })).toHaveValue("later local title");
        await expect(f.window.locator(".folio-editor")).toContainText("later local body");
      } else if (scenario === "selection-change") {
        await expect(f.window.getByLabel("ページタイトル", { exact: true })).toHaveValue("Synthetic race target");
        await expect(f.window.locator(".folio-editor")).not.toContainText("initial local body");
      } else {
        await expect(f.window.locator(".folio-editor")).toContainText("initial local body");
        await f.window.locator(".folio-editor").dispatchEvent("compositionend", { data: "変換中" });
      }
      await assertStoredOriginal(f);
      const journal = await saveJournal(f, info);
      if (scenario === "later-input") {
        expect(journal.entries.some((entry: any) => entry.id === f.source.id && entry.patch?.title === "later local title")).toBe(true);
        expect(journal.entries.some((entry: any) => entry.id === f.source.id && JSON.stringify(entry.patch?.doc ?? {}).includes("later local body"))).toBe(true);
      }
    } finally { await closeFixture(f); }
  });
}

test("Page-only recovery cancellation and write failure retain original and pending edits", async ({}, info) => {
  const f = await fixture();
  const sentinel = join(f.exports, "sentinel.txt");
  writeFileSync(sentinel, "unchanged");
  try {
    await f.app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as typeof dialog.showSaveDialog;
    });
    await f.window.getByRole("button", { name: "退避して再読込", exact: true }).click();
    await expect(f.window.getByLabel("ページタイトル", { exact: true })).toHaveValue("initial local title");
    await expect(f.window.locator(".folio-editor")).toContainText("initial local body");
    await assertStoredOriginal(f);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    const invalid = join(f.exports, "missing-parent", "recovery.json");
    await f.app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
    }, invalid);
    await f.window.getByRole("button", { name: "退避して再読込", exact: true }).click();
    await expect(f.window.getByRole("alert")).toContainText("ENOENT");
    expect(existsSync(invalid)).toBe(false);
    await expect(f.window.getByLabel("ページタイトル", { exact: true })).toHaveValue("initial local title");
    await expect(f.window.locator(".folio-editor")).toContainText("initial local body");
    await assertStoredOriginal(f);
    await saveJournal(f, info);
  } finally { await closeFixture(f); }
});
