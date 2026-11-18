import { fixtureRoot } from "./fixture-isolation";
import { launchFixture, killFixture } from "./recovery-ci-runtime";
import {
  test,
  expect,
  type ElectronApplication,
} from "@playwright/test";
import { rmSync } from "node:fs";

test("a failed first save blocks later queued input without discarding it", async () => {
  const root = fixtureRoot("queued-failure-guard-");
  let app: ElectronApplication | undefined;
  try {
    app = await launchFixture(root);
    const window = await app.firstWindow();
    const title = window.getByLabel("ページタイトル", { exact: true });
    await expect(title).toBeVisible();
    const original = await window.evaluate(async () => {
      const state = await globalThis.window.folio.request<any>({
        type: "load",
      });
      return state.pages.find(
        (page: any) => page.title === "ようこそ、Folioへ",
      );
    });
    expect(original).toBeTruthy();
    await app.evaluate(({ ipcMain }) => {
      const ipc = ipcMain as any,
        original = ipc._invokeHandlers.get("folio:request");
      (globalThis as any).guardedUpdates = [];
      ipc.removeHandler("folio:request");
      ipc.handle("folio:request", async (event: any, request: any) => {
        if (request.type === "save:commit") {
          (globalThis as any).guardedUpdates.push(request);
          await new Promise<void>((release) => {
            (globalThis as any).releaseGuardedUpdate = release;
          });
          throw new Error("synthetic first save failure");
        }
        return original(event, request);
      });
    });
    await title.fill("First local input");
    await expect
      .poll(() =>
        app!.evaluate(() => typeof (globalThis as any).releaseGuardedUpdate),
      )
      .toBe("function");
    await title.fill("Second local input");
    await app.evaluate(() => (globalThis as any).releaseGuardedUpdate());
    await expect(window.getByRole("alert")).toContainText("保持しています");
    await expect(title).toHaveValue("Second local input");
    const requests = await app.evaluate(
      () => (globalThis as any).guardedUpdates,
    );
    expect(requests).toHaveLength(1);
    const persisted = await window.evaluate(async (id) => {
      const state = await globalThis.window.folio.request<any>({
        type: "load",
      });
      return state.pages.find((page: any) => page.id === id);
    }, original.id);
    expect(persisted.title).toBe(original.title);
    await expect(
      window.getByRole("button", { name: "未保存の変更を別ファイルに記録" }),
    ).toBeVisible();
  } finally {
    await killFixture(app);
    rmSync(root, { recursive: true, force: true });
  }
});
