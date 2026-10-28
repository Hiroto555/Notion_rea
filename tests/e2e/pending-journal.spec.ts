import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

test("manual unsaved journal preserves later input and never overwrites an existing file", async () => {
  const root = mkdtempSync(resolve("output/pending-journal-e2e-"));
  const workspace = join(root, "workspace"), exports = join(root, "exports");
  mkdirSync(workspace); mkdirSync(exports);
  const destination = join(exports, "unsaved.json");
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [resolve("dist/main.cjs")], env: { ...process.env, FOLIO_DATA_DIR: workspace } });
    const window = await app.firstWindow();
    const title = window.getByLabel("ページタイトル", { exact: true });
    await expect(title).toBeVisible();
    const original = await window.evaluate(async () => {
      const snapshot = await globalThis.window.folio.request<any>({ type: "load" });
      const page = snapshot.pages.find((item: any) => item.title === "ようこそ、Folioへ");
      if (!page) throw new Error("Synthetic welcome page missing");
      await globalThis.window.folio.request({ type: "update", id: page.id, revision: page.revision, patch: { title: "Externally saved" } });
      return page;
    });
    await title.fill("First unsaved title");
    await expect(window.getByRole("alert")).toContainText("競合");
    await window.getByRole("button", { name: "保存を再試行" }).click();
    await expect(window.getByRole("alert")).toContainText("安全に再試行できません");
    const afterRetry = await window.evaluate(async (id) => {
      const snapshot = await globalThis.window.folio.request<any>({ type: "load" });
      return snapshot.pages.find((item: any) => item.id === id);
    }, original.id);
    expect(afterRetry.title).toBe("Externally saved");
    await expect(title).toHaveValue("First unsaved title");
    const journalButton = window.getByRole("button", { name: "未保存の変更を別ファイルに記録" });
    await title.dispatchEvent("compositionstart", { data: "変換中" });
    await journalButton.click();
    await expect(window.getByRole("alert")).toContainText("変換を確定");
    expect(existsSync(destination)).toBe(false);
    await title.dispatchEvent("compositionend", { data: "変換中" });
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => new Promise((done) => {
        (globalThis as any).finishJournalDialog = () => done({ canceled: false, filePath: target });
      })) as typeof dialog.showSaveDialog;
    }, destination);
    await journalButton.click();
    await expect.poll(() => app!.evaluate(() => typeof (globalThis as any).finishJournalDialog)).toBe("function");
    await title.fill("Later unsaved title");
    await app.evaluate(() => (globalThis as any).finishJournalDialog());
    await expect.poll(() => existsSync(destination)).toBe(true);
    const bytes = readFileSync(destination, "utf8");
    const journal = JSON.parse(bytes);
    expect(journal.format).toBe("folio-pending-journal");
    expect(journal.use).toBe("manual-inspection-only");
    expect(journal.entries.some((entry: any) => entry.id === original.id && entry.patch?.title === "First unsaved title")).toBe(true);
    expect(bytes).not.toContain("Later unsaved title");
    await expect(title).toHaveValue("Later unsaved title");
    await expect(window.getByRole("alert")).toBeVisible();
    const saved = await window.evaluate(async (id) => {
      const snapshot = await globalThis.window.folio.request<any>({ type: "load" });
      return snapshot.pages.find((item: any) => item.id === id);
    }, original.id);
    expect(saved.title).toBe("Externally saved");
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog;
    }, destination);
    await journalButton.click();
    await expect(window.getByRole("alert")).toContainText("already exists");
    expect(readFileSync(destination, "utf8")).toBe(bytes);
    await expect(title).toHaveValue("Later unsaved title");
  } finally {
    if (app) {
      const child = app.process();
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((done) => { child.once("exit", () => done()); child.kill("SIGKILL"); });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a manual journal leaves the original and pending input unchanged", async () => {
  const root = mkdtempSync(resolve("output/pending-journal-cancel-"));
  const workspace = join(root, "workspace"), exports = join(root, "exports");
  mkdirSync(workspace); mkdirSync(exports);
  const sentinel = join(exports, "untouched.json"); writeFileSync(sentinel, "original");
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [resolve("dist/main.cjs")], env: { ...process.env, FOLIO_DATA_DIR: workspace } });
    const window = await app.firstWindow(), title = window.getByLabel("ページタイトル", { exact: true });
    await expect(title).toBeVisible();
    await window.evaluate(async () => {
      const snapshot = await globalThis.window.folio.request<any>({ type: "load" });
      const page = snapshot.pages.find((item: any) => item.title === "ようこそ、Folioへ");
      await globalThis.window.folio.request({ type: "update", id: page.id, revision: page.revision, patch: { title: "Saved elsewhere" } });
    });
    await title.fill("Unchanged pending");
    await expect(window.getByRole("alert")).toContainText("競合");
    await app.evaluate(({ dialog }) => { dialog.showSaveDialog = (async () => ({ canceled: true, filePath: "" })) as typeof dialog.showSaveDialog; });
    await window.getByRole("button", { name: "未保存の変更を別ファイルに記録" }).click();
    await expect(title).toHaveValue("Unchanged pending");
    await expect(window.getByRole("alert")).toBeVisible();
    expect(readFileSync(sentinel, "utf8")).toBe("original");
  } finally {
    if (app) {
      const child = app.process();
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((done) => { child.once("exit", () => done()); child.kill("SIGKILL"); });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
