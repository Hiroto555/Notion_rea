import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../src/persistence/store";
import { RecordRepository } from "../../src/persistence/record-repository";
import { markRecordStoreVersion } from "../../src/persistence/record-version";

test("isolated record can be found and edited with the normal full-page editor", async () => {
  const root = mkdtempSync(resolve("output/record-core-e2e-"));
  const path = join(root, "workspace.sqlite");
  let app: ElectronApplication | undefined;
  const store = new Store(path);
  const db = store.create(null, "database", "Synthetic DB");
  const records = new RecordRepository(store);
  store.transaction(() => {
    records.createSchema();
    records.registerDatabase(db.id);
    markRecordStoreVersion(store.db);
  });
  const record = records.create(db.id, "Synthetic record", {
    status: "unique-property-value",
  });
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "synthetic-original-record-block" },
        content: [{ type: "text", text: "original record body" }],
      },
    ],
  };
  store.updateRecordPage(record.pageId, db.id, record.revision, { doc });
  store.close();
  const start = async () => {
    app = await electron.launch({
      args: [resolve("dist/main.cjs")],
      env: { ...process.env, FOLIO_DATA_DIR: root },
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    return window;
  };
  try {
    let window = await start();
    await expect(
      window
        .locator(".page-tree-label")
        .filter({ hasText: "Synthetic record" }),
    ).toHaveCount(0);
    await window.keyboard.press("Meta+p");
    await window.getByLabel("検索キーワード").fill("unique-property-value");
    await window
      .locator(".search-results button")
      .filter({ hasText: "Synthetic record" })
      .click();
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toHaveValue("Synthetic record");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "original record body",
    );
    await window
      .locator(".r3-record-page .folio-editor")
      .fill("edited record body");
    await expect(window.locator(".save-state")).toHaveText("保存済み");
    await app!.close();
    app = undefined;
    window = await start();
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toHaveValue("Synthetic record");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "edited record body",
    );
    const projection = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:get", pageId }),
      record.pageId,
    );
    expect(projection.values.status).toBe("unique-property-value");
    expect(projection.pageId).toBe(record.pageId);
    const pair = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      record.pageId,
    );
    expect(pair.page.id).toBe(record.pageId);
    expect(pair.page.revision).toBe(pair.record.revision);
    expect(pair.record.databasePageId).toBe(db.id);
    expect(JSON.stringify(pair.page.doc)).toContain("edited record body");
    await window.evaluate(
      ({ pageId, databasePageId, revision }) =>
        globalThis.window.folio.request({
          type: "record:patch",
          pageId,
          databasePageId,
          revision,
          patch: { values: { status: "external" } },
        }),
      {
        pageId: record.pageId,
        databasePageId: db.id,
        revision: projection.revision,
      },
    );
    await window
      .getByLabel("レコードのタイトル", { exact: true })
      .fill("unsaved record title");
    await expect(window.locator(".r3-record-alert")).toContainText("競合");
    await expect(
      window.getByRole("button", { name: "退避して再読込" }),
    ).toHaveCount(0);
    await expect(window.locator(".r3-record-alert")).toContainText("保持");
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toHaveValue("unsaved record title");
  } finally {
    // This is an isolated, disposable fixture with intentionally unsaved edits.
    // Terminate only the Electron child launched by this test, not any user app.
    if (app) {
      const child = app.process();
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolveExit) => {
          child.once("exit", () => resolveExit());
          child.kill("SIGKILL");
        });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("record Editor rejects an external update after its initial installation", async () => {
  const root = mkdtempSync(resolve("output/record-stale-refresh-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const owner = store.create(null, "database", "Synthetic conflict DB");
  const deleted = store.create(null, "page", "Synthetic trashed page");
  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    markRecordStoreVersion(store.db);
  });
  const record = repository.create(owner.id, "Synthetic stale record", {});
  const document = (text: string) => ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "synthetic-record-conflict-block" },
        content: [{ type: "text", text }],
      },
    ],
  });
  const original = store.updateRecordPage(
    record.pageId,
    owner.id,
    record.revision,
    {
      doc: document("original body"),
    },
  );
  store.trash(deleted.id);
  store.close();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [resolve("dist/main.cjs")],
      env: { ...process.env, FOLIO_DATA_DIR: root },
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    await window.keyboard.press("Meta+p");
    await window.getByLabel("検索キーワード").fill("Synthetic stale record");
    await window
      .locator(".search-results button")
      .filter({ hasText: "Synthetic stale record" })
      .click();
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "original body",
    );
    await expect(window.locator(".save-state")).toHaveText("保存済み");
    const installed = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      record.pageId,
    );
    await window.evaluate(
      ({ pageId, databasePageId, revision, doc }) =>
        globalThis.window.folio.request({
          type: "record:pageUpdate",
          pageId,
          databasePageId,
          revision,
          patch: { doc },
        }),
      {
        pageId: record.pageId,
        databasePageId: owner.id,
        revision: installed.page.revision,
        doc: document("external body"),
      },
    );
    await window.getByRole("button", { name: /^ゴミ箱 / }).click();
    const trash = window.getByRole("dialog", { name: "ゴミ箱" });
    await trash
      .locator(".dialog-list > div")
      .filter({ hasText: "Synthetic trashed page" })
      .getByRole("button", { name: "復元" })
      .click();
    await expect(
      window.getByRole("status").filter({ hasText: "ページを復元しました" }),
    ).toBeVisible();
    await trash.getByRole("button", { name: "閉じる" }).click();
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "original body",
    );
    await window
      .locator(".r3-record-page .folio-editor")
      .fill("local unsaved body");
    await expect(window.locator(".r3-record-alert")).toContainText("競合");
    const saved = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      record.pageId,
    );
    expect(JSON.stringify(saved.page.doc)).toContain("external body");
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "local unsaved body",
    );
  } finally {
    if (app) {
      const child = app.process();
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolveExit) => {
          child.once("exit", () => resolveExit());
          child.kill("SIGKILL");
        });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("registered database displays records without enabling legacy row writes", async () => {
  const root = mkdtempSync(resolve("output/record-core-list-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const owner = store.create(null, "database", "Synthetic list DB");
  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    markRecordStoreVersion(store.db);
  });
  const record = repository.create(owner.id, "Synthetic listed record", {
    status: "preserved",
  });
  store.close();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [resolve("dist/main.cjs")],
      env: { ...process.env, FOLIO_DATA_DIR: root },
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    await window
      .locator(".page-tree-label")
      .filter({ hasText: "Synthetic list DB" })
      .click();
    const list = window.getByRole("region", { name: "レコード一覧" });
    await expect(list.getByRole("table")).toBeVisible();
    await expect(
      list.getByLabel("名前 Synthetic listed record", { exact: true }),
    ).toHaveValue("Synthetic listed record");
    await expect(
      list.getByRole("button", { name: "開く Synthetic listed record" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "新規行", exact: true }),
    ).toBeVisible();
    const saved = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      record.pageId,
    );
    expect(saved.record.databasePageId).toBe(owner.id);
    expect(saved.record.values.status).toBe("preserved");
    await list
      .getByRole("button", { name: "開く Synthetic listed record" })
      .click();
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toHaveValue("Synthetic listed record");
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toBeEnabled();
    await expect(
      window.locator(".r3-record-page .folio-editor"),
    ).toHaveAttribute("contenteditable", "true");
    await expect(
      window.getByRole("button", { name: "お気に入り" }),
    ).toBeDisabled();
    await expect(window.locator(".topbar-actions")).toHaveAttribute(
      "inert",
      "",
    );
    const surface = window.locator(".r3-record-page");
    for (const name of [
      "レコードを複製",
      "レコードをゴミ箱へ",
      "レコードを復元",
      "変更履歴",
    ])
      await expect(
        surface.getByRole("button", { name, exact: true }),
      ).toHaveCount(0);
    await surface.getByRole("button", { name: "レコードを閉じる" }).click();
    await expect(window.locator(".topbar-actions")).not.toHaveAttribute(
      "inert",
    );
    await window.getByRole("button", { name: "ページメニュー" }).click();
    await expect(
      window.getByRole("button", { name: "ゴミ箱に移動" }),
    ).toBeDisabled();
    await expect(
      window.getByRole("button", { name: "複製", exact: true }),
    ).toBeDisabled();
    const unchanged = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      record.pageId,
    );
    expect(unchanged.record).toEqual(saved.record);
    expect(unchanged.page).toEqual(saved.page);
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("new v4 database is identified before enabling record cells and blocks unsupported owner actions", async () => {
  const root = mkdtempSync(resolve("output/record-core-new-db-"));
  const store = new Store(join(root, "workspace.sqlite"));
  store.create(null, "page", "Synthetic home");
  store.transaction(() => {
    new RecordRepository(store).createSchema();
    markRecordStoreVersion(store.db);
  });
  store.close();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [resolve("dist/main.cjs")],
      env: { ...process.env, FOLIO_DATA_DIR: root },
    });
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => {
        throw new Error("UNSAFE_RECOVERY_DIALOG_OPENED");
      }) as typeof dialog.showSaveDialog;
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    await window.keyboard.press("Meta+p");
    await window.getByTitle("新しいデータベース", { exact: true }).click();
    const title = window.getByLabel("ページタイトル", { exact: true });
    await expect(title).toHaveValue("新しいデータベース");
    await expect(
      window.getByRole("region", { name: "レコード一覧" }),
    ).toBeVisible();
    await expect(
      window.getByRole("button", { name: "新規行", exact: true }),
    ).toBeVisible();
    const snapshot = await window.evaluate(() =>
      globalThis.window.folio.request<any>({ type: "load" }),
    );
    const page = snapshot.pages.find(
      (p: any) => p.title === "新しいデータベース",
    );
    expect(snapshot.recordDatabaseIds).toContain(page.id);
    await expect(title).toBeEnabled();
    await title.fill("Synthetic renamed registered DB");
    await expect(window.locator(".save-state")).toHaveText("保存済み");
    const renamed = await window.evaluate(() =>
      globalThis.window.folio.request<any>({ type: "load" }),
    );
    const updated = renamed.pages.find(
      (candidate: any) => candidate.id === page.id,
    );
    expect(updated.title).toBe("Synthetic renamed registered DB");
    expect(updated.revision).toBe(page.revision + 1);
    expect(renamed.recordDatabaseIds).toContain(page.id);
    await expect(
      window.getByRole("button", { name: "お気に入り" }),
    ).toBeDisabled();
    await window.getByRole("button", { name: "ページメニュー" }).click();
    await expect(
      window.getByRole("button", { name: "複製", exact: true }),
    ).toBeDisabled();
    await expect(
      window.getByRole("button", { name: "変更履歴", exact: true }),
    ).toBeDisabled();
    await expect(
      window.getByRole("button", { name: "ゴミ箱に移動" }),
    ).toBeDisabled();
  } finally {
    if (app) {
      const child = app.process();
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolveExit) => {
          child.once("exit", () => resolveExit());
          child.kill("SIGKILL");
        });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("editable record body still rejects generic Page writes", async () => {
  const root = mkdtempSync(resolve("output/record-readonly-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const owner = store.create(null, "database", "Synthetic protected DB");
  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    markRecordStoreVersion(store.db);
  });
  const record = repository.create(owner.id, "Synthetic protected record", {});
  const page = store.updateRecordPage(
    record.pageId,
    owner.id,
    record.revision,
    {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "protected body" }],
          },
        ],
      },
    },
  );
  store.close();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [resolve("dist/main.cjs")],
      env: { ...process.env, FOLIO_DATA_DIR: root },
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    await window.keyboard.press("Meta+p");
    await window
      .getByLabel("検索キーワード")
      .fill("Synthetic protected record");
    await window
      .locator(".search-results button")
      .filter({ hasText: "Synthetic protected record" })
      .click();
    await expect(
      window.getByLabel("レコードのタイトル", { exact: true }),
    ).toBeEnabled();
    await expect(window.locator(".r3-record-page .folio-editor")).toContainText(
      "protected body",
    );
    await expect(
      window.locator(".r3-record-page .folio-editor"),
    ).toHaveAttribute("contenteditable", "true");
    const result = await window.evaluate(
      async ({ pageId, revision }) => {
        try {
          await globalThis.window.folio.request({
            type: "update",
            id: pageId,
            revision,
            patch: { title: "incorrect" },
          });
          return "unexpected-success";
        } catch {
          return "rejected";
        }
      },
      { pageId: record.pageId, revision: page.revision },
    );
    expect(result).toBe("rejected");
    const saved = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      record.pageId,
    );
    expect(saved.page.title).toBe("Synthetic protected record");
    expect(JSON.stringify(saved.page.doc)).toContain("protected body");
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("record patch IPC requires the observed owner and preserves the page body", async () => {
  const root = mkdtempSync(resolve("output/record-patch-owner-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const owner = store.create(null, "database", "Synthetic owner");
  const other = store.create(null, "database", "Synthetic other owner");
  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    repository.registerDatabase(other.id);
    markRecordStoreVersion(store.db);
  });
  const record = repository.create(owner.id, "Synthetic record", {
    status: "old",
    untouched: "kept",
  });
  const page = store.updateRecordPage(
    record.pageId,
    owner.id,
    record.revision,
    {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "existing body" }],
          },
        ],
      },
    },
  );
  store.close();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [resolve("dist/main.cjs")],
      env: { ...process.env, FOLIO_DATA_DIR: root },
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    const rejected = await window.evaluate(
      async ({ pageId, revision, wrongOwner }) => {
        const results: string[] = [];
        for (const request of [
          {
            type: "record:patch",
            pageId,
            revision,
            patch: { values: { status: "bad" } },
          },
          {
            type: "record:patch",
            pageId,
            databasePageId: wrongOwner,
            revision,
            patch: { values: { status: "bad" } },
          },
        ]) {
          try {
            await globalThis.window.folio.request(request as any);
            results.push("unexpected-success");
          } catch {
            results.push("rejected");
          }
        }
        return results;
      },
      { pageId: record.pageId, revision: page.revision, wrongOwner: other.id },
    );
    expect(rejected).toEqual(["rejected", "rejected"]);
    const ack = await window.evaluate(
      ({ pageId, databasePageId, revision }) =>
        globalThis.window.folio.request<any>({
          type: "record:patch",
          pageId,
          databasePageId,
          revision,
          patch: { values: { status: "new" } },
        }),
      {
        pageId: record.pageId,
        databasePageId: owner.id,
        revision: page.revision,
      },
    );
    expect(ack.databasePageId).toBe(owner.id);
    expect(ack.revision).toBe(page.revision + 1);
    expect(ack.values).toEqual({ status: "new", untouched: "kept" });
    const persisted = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:read", pageId }),
      record.pageId,
    );
    expect(persisted.record.values).toEqual(ack.values);
    expect(JSON.stringify(persisted.page.doc)).toContain("existing body");
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
