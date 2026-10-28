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
import { RecordLifecycle } from "../../src/persistence/record-lifecycle";
import { markRecordStoreVersion } from "../../src/persistence/record-version";

for (const order of ["older-first", "newer-first"] as const) {
  test(`last requested record wins when ${order} response is released`, async () => {
    const root = mkdtempSync(resolve("output/record-open-order-"));
    const store = new Store(join(root, "workspace.sqlite"));
    const owner = store.create(null, "database", "Order DB");
    const repository = new RecordRepository(store);
    store.transaction(() => {
      repository.createSchema();
      repository.registerDatabase(owner.id);
      markRecordStoreVersion(store.db);
    });
    const first = repository.create(owner.id, "Record Alpha", {});
    const second = repository.create(owner.id, "Record Beta", {});
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
        .filter({ hasText: "Order DB" })
        .click();
      const region = window.getByRole("region", { name: "レコード一覧" });
      // Let list session hydration finish; these barriers belong only to the
      // explicit open actions, not background record reads.
      await expect(
        region.getByLabel("名前 Record Alpha", { exact: true }),
      ).toBeEnabled();
      await expect(
        region.getByLabel("名前 Record Beta", { exact: true }),
      ).toBeEnabled();
      await app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as any,
          original = ipc._invokeHandlers.get("folio:request");
        (globalThis as any).recordReadReleases = {};
        ipc.removeHandler("folio:request");
        ipc.handle("folio:request", async (event: any, request: any) => {
          const result = await original(event, request);
          if (request.type === "record:read")
            await new Promise<void>((release) => {
              (globalThis as any).recordReadReleases[request.pageId] = release;
            });
          return result;
        });
      });
      await region.getByRole("button", { name: "開く Record Alpha" }).click();
      await expect
        .poll(() =>
          app!.evaluate(
            (_electron, id) =>
              typeof (globalThis as any).recordReadReleases[id],
            first.pageId,
          ),
        )
        .toBe("function");
      await region.getByRole("button", { name: "開く Record Beta" }).click();
      await expect
        .poll(() =>
          app!.evaluate(
            (_electron, id) =>
              typeof (globalThis as any).recordReadReleases[id],
            second.pageId,
          ),
        )
        .toBe("function");
      const release = async (id: string) =>
        app!.evaluate(
          (_electron, pageId) =>
            (globalThis as any).recordReadReleases[pageId](),
          id,
        );
      if (order === "older-first") {
        await release(first.pageId);
        await window.evaluate(async () => {
          await globalThis.window.folio.request({ type: "load" });
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
        });
        await expect(window.locator(".r3-record-page")).toHaveCount(0);
        await expect(
          window.getByLabel("ページタイトル", { exact: true }),
        ).toHaveValue("Order DB");
        await release(second.pageId);
      } else {
        await release(second.pageId);
        await expect(
          window.getByLabel("レコードのタイトル", { exact: true }),
        ).toHaveValue("Record Beta");
        await release(first.pageId);
        await window.evaluate(async () => {
          await globalThis.window.folio.request({ type: "load" });
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
        });
      }
      await expect(
        window.getByLabel("レコードのタイトル", { exact: true }),
      ).toHaveValue("Record Beta");
      await expect(
        window.getByLabel("レコードのタイトル", { exact: true }),
      ).toBeEnabled();
    } finally {
      if (app) await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a delayed record read cannot supersede a committed database creation", async () => {
  const root = mkdtempSync(resolve("output/record-create-race-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const owner = store.create(null, "database", "Race owner");
  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    markRecordStoreVersion(store.db);
  });
  const record = repository.create(owner.id, "Delayed record", {});
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
      .filter({ hasText: "Race owner" })
      .click();
    await expect(
      window.getByLabel("名前 Delayed record", { exact: true }),
    ).toBeEnabled();
    await app.evaluate(({ ipcMain }, recordId) => {
      const ipc = ipcMain as any,
        original = ipc._invokeHandlers.get("folio:request");
      const race: any = ((globalThis as any).recordCreateRace = {});
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        const result = await original(event, request);
        if (request.type === "record:read" && request.pageId === recordId) {
          await new Promise<void>((release) => {
            race.releaseRead = release;
          });
          race.readReturned = true;
        } else if (request.type === "create" && request.kind === "database") {
          race.createdId = result.id;
          race.holdNextLoad = true;
        } else if (request.type === "load" && race.holdNextLoad) {
          race.holdNextLoad = false;
          await new Promise<void>((release) => {
            race.releaseLoad = release;
          });
        }
        return result;
      });
    }, record.pageId);
    await window
      .getByRole("region", { name: "レコード一覧" })
      .getByRole("button", { name: "開く Delayed record" })
      .click();
    await expect
      .poll(() =>
        app!.evaluate(
          () => typeof (globalThis as any).recordCreateRace.releaseRead,
        ),
      )
      .toBe("function");
    await window.keyboard.press("Meta+p");
    await window.getByTitle("新しいデータベース", { exact: true }).click();
    await expect
      .poll(() =>
        app!.evaluate(
          () => typeof (globalThis as any).recordCreateRace.releaseLoad,
        ),
      )
      .toBe("function");
    const createdId = await app.evaluate(
      () => (globalThis as any).recordCreateRace.createdId as string,
    );
    expect(createdId).toBeTruthy();

    // Release the old read while the creation's post-commit refresh is still held.
    await app.evaluate(() =>
      (globalThis as any).recordCreateRace.releaseRead(),
    );
    await expect
      .poll(() =>
        app!.evaluate(() => (globalThis as any).recordCreateRace.readReturned),
      )
      .toBe(true);
    // A separate round trip and rendering opportunities let the released read
    // reach the renderer before the creation refresh can complete.
    await window.evaluate(async () => {
      await globalThis.window.folio.request<any>({ type: "load" });
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    });
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue("Race owner");
    await app.evaluate(() =>
      (globalThis as any).recordCreateRace.releaseLoad(),
    );
    await expect(
      window.getByLabel("ページタイトル", { exact: true }),
    ).toHaveValue("新しいデータベース");
    await expect(
      window.getByRole("region", { name: "レコード一覧" }),
    ).toBeVisible();
    await expect(window.locator(".r3-record-page")).toHaveCount(0);
    const snapshot = await window.evaluate(() =>
      globalThis.window.folio.request<any>({ type: "load" }),
    );
    expect(
      snapshot.pages
        .filter((page: any) => page.title === "新しいデータベース")
        .map((page: any) => page.id),
    ).toEqual([createdId]);
    expect(snapshot.recordDatabaseIds).toContain(createdId);
  } finally {
    if (app) {
      await app
        .evaluate(() => {
          const race = (globalThis as any).recordCreateRace;
          race?.releaseRead?.();
          race?.releaseLoad?.();
        })
        .catch(() => {});
      await app.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a trashed registered record cannot be restored through the generic UI", async () => {
  const root = mkdtempSync(resolve("output/record-trash-guard-"));
  const store = new Store(join(root, "workspace.sqlite"));
  const owner = store.create(null, "database", "Protected owner");
  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    markRecordStoreVersion(store.db);
  });
  const record = repository.create(owner.id, "Protected trashed record", {});
  new RecordLifecycle(store).trashRecord(record.pageId, record.revision);
  store.close();
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [resolve("dist/main.cjs")],
      env: { ...process.env, FOLIO_DATA_DIR: root },
    });
    const window = await app.firstWindow();
    await window.waitForSelector(".page-title");
    await window.getByRole("button", { name: /^ゴミ箱 / }).click();
    const trash = window.getByRole("dialog", { name: "ゴミ箱" });
    const row = trash
      .locator(".dialog-list > div")
      .filter({ hasText: "Protected trashed record" });
    await expect(row.getByRole("button", { name: "復元" })).toBeDisabled();
    const after = await window.evaluate(
      (pageId) =>
        globalThis.window.folio.request<any>({ type: "record:get", pageId }),
      record.pageId,
    );
    expect(after.deletedAt).not.toBeNull();
    expect(after.databasePageId).toBe(owner.id);
  } finally {
    if (app) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
