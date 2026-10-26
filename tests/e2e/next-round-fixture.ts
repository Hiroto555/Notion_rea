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
      const main = await app.evaluate(({ app, BrowserWindow }) => ({
        version: app.getVersion(),
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        platform: process.platform,
        arch: process.arch,
        locale: app.getLocale(),
        zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
      }));
      const renderer = await window.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio,
        language: navigator.language,
        theme: document.documentElement.dataset.theme,
      }));
      writeFileSync(
        info.outputPath("environment.json"),
        JSON.stringify(
          {
            main,
            renderer,
            input:
              "Playwright pointer/keyboard; synthetic composition only; physical IME NOT_RUN",
          },
          null,
          2,
        ),
      );
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
