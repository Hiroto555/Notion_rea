import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
export type Session = {
  app: ElectronApplication;
  window: Page;
  folder: string;
  restart: () => Promise<void>;
};
export const test = base.extend<{ folio: Session }>({
  folio: async ({}, use, info) => {
    const folder = mkdtempSync(resolve("output/next-round-e2e-"));
    let app: ElectronApplication, window: Page;
    const start = async () => {
      app = await electron.launch({
        args: [resolve("dist/main.cjs")],
        env: { ...process.env, FOLIO_DATA_DIR: folder },
      });
      window = await app.firstWindow();
      await app
        .context()
        .tracing.start({ screenshots: true, snapshots: true, sources: true });
      await window.waitForSelector(".page-title");
    };
    await start();
    const session: Session = {
      app: app!,
      window: window!,
      folder,
      restart: async () => {
        await app
          .context()
          .tracing.stop({ path: info.outputPath("before-restart.zip") });
        await app.close();
        await start();
        session.app = app;
        session.window = window;
      },
    };
    try {
      await use(session);
    } finally {
      try {
        await window!.screenshot({ path: info.outputPath("screen.png") });
        await app!
          .context()
          .tracing.stop({ path: info.outputPath("trace.zip") });
      } catch {}
      writeFileSync(
        join(folder, "test-status.json"),
        JSON.stringify({
          title: info.title,
          status: info.status,
          retry: info.retry,
        }),
      );
      try {
        await app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().forEach((w) => w.destroy()),
        );
        await app!.close();
      } catch {}
    }
  },
});
export { expect };
export async function saveDialog(s: Session, path: string | null) {
  await s.app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({
      canceled: p === null,
      filePath: p ?? undefined,
    })) as typeof dialog.showSaveDialog;
  }, path);
}
export async function openDialog(s: Session, path: string | null) {
  await s.app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({
      canceled: p === null,
      filePaths: p ? [p] : [],
    })) as typeof dialog.showOpenDialog;
  }, path);
}
export const saved = async (s: Session) => {
  await expect(s.window.locator(".save-state")).toHaveText("保存済み");
};
