import {
  test as base, expect, _electron as electron,
  type ElectronApplication, type Page,
} from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
export type Session = {
  app: ElectronApplication;
  window: Page;
  folder: string;
  exportsDir: string;
  inputsDir: string;
  restart: () => Promise<void>;
};
export const test = base.extend<{ folio: Session }>({
  folio: async ({}, use, info) => {
    const root = mkdtempSync(resolve("output/next-round-e2e-"));
    const folder = join(root, "workspace"), exportsDir = join(root, "exports"), inputsDir = join(root, "inputs");
    mkdirSync(folder); mkdirSync(exportsDir); mkdirSync(inputsDir);
    let app: ElectronApplication | undefined, window: Page | undefined, tracing = false;
    const diagnostics: any[] = [];
    const record = (stage: string, detail?: unknown) => diagnostics.push({ stage, time: new Date().toISOString(), detail });
    const start = async () => {
      record("launch-start", { url: process.env.FOLIO_DEV_URL || "production" });
      app = await electron.launch({ args: [resolve("dist/main.cjs")], env: { ...process.env, FOLIO_DATA_DIR: folder } });
      const child = app.process();
      record("launch-complete", { pid: child.pid });
      await app.evaluate(({ app, BrowserWindow }) => {
        const g = globalThis as any; g.folioStartupEvents = [];
        const observe = (win: Electron.BrowserWindow) => {
          for (const type of ["did-start-loading", "did-finish-load", "did-fail-load", "render-process-gone"] as const)
            (win.webContents as any).on(type, (...args: any[]) => g.folioStartupEvents.push({ type, detail: args.slice(1).map(x => typeof x === "object" ? String(x) : x), time: Date.now() }));
        };
        BrowserWindow.getAllWindows().forEach(observe);
        app.on("browser-window-created", (_event, win) => observe(win));
      });
      child.stdout?.on("data", chunk => record("stdout", String(chunk)));
      child.stderr?.on("data", chunk => record("stderr", String(chunk)));
      child.once("exit", (code, signal) => record("process-exit", { code, signal }));
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      tracing = true;
      record("trace-started");
      window = await app.firstWindow();
      record("first-window", { url: window.url() });
      window.on("pageerror", e => record("pageerror", e.message));
      window.on("crash", () => record("renderer-crash"));
      window.on("requestfailed", req => record("requestfailed", { url: req.url(), failure: req.failure() }));
      window.on("framenavigated", frame => { if (frame === window?.mainFrame()) record("navigation", frame.url()); });
      window.on("load", () => record("load", window?.url()));
      if (process.env.FOLIO_TEST_FORCE_READY_FAILURE === "1") throw new Error("Intentional renderer-ready failure for cleanup verification");
      await window.waitForSelector(".page-title");
      const preload = await window.evaluate(() => typeof globalThis.window.folio?.request === "function");
      record("ui-ready", { preload });
      const main = await app.evaluate(({ app, BrowserWindow }) => ({ version: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, platform: process.platform, arch: process.arch, locale: app.getLocale(), zoom: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor() }));
      const renderer = await window.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio, language: navigator.language, theme: document.documentElement.dataset.theme }));
      writeFileSync(info.outputPath("environment.json"), JSON.stringify({ main, renderer, input: "Playwright pointer/keyboard; synthetic composition only; physical IME NOT_RUN" }, null, 2));
    };
    try {
      await start();
      const session: Session = {
        app: app!, window: window!, folder, exportsDir, inputsDir,
        restart: async () => {
          if (tracing) { await app!.context().tracing.stop({ path: info.outputPath("before-restart.zip") }); tracing = false; }
          await app!.close(); record("restart-closed"); app = undefined; window = undefined;
          await start(); session.app = app!; session.window = window!;
        },
      };
      await use(session);
    } catch (error) {
      record("failure", String(error));
      throw error;
    } finally {
      if (window) { try { await window.screenshot({ path: info.outputPath("screen.png") }); } catch (error) { record("screenshot-error", String(error)); } }
      if (app && tracing) { try { await app.context().tracing.stop({ path: info.outputPath("trace.zip") }); } catch (error) { record("trace-error", String(error)); } tracing = false; }
      if (app) {
        try { record("main-webcontents-events", await app.evaluate(() => (globalThis as any).folioStartupEvents)); } catch (error) { record("main-events-error", String(error)); }
        const child = app.process();
        try { await app.close(); record("closed", { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode }); }
        catch (error) { record("close-error", String(error)); child.kill(); }
      }
      writeFileSync(join(folder, "test-status.json"), JSON.stringify({ title: info.title, status: info.status, retry: info.retry }));
      writeFileSync(info.outputPath("startup-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
    }
  },
});
export { expect };
export async function saveDialog(s: Session, path: string | null) {
  await s.app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = (async () => ({ canceled: p === null, filePath: p ?? undefined })) as typeof dialog.showSaveDialog; }, path);
}
export async function openDialog(s: Session, path: string | null) {
  await s.app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: p === null, filePaths: p ? [p] : [] })) as typeof dialog.showOpenDialog; }, path);
}
export const saved = async (s: Session) => { await expect(s.window.locator(".save-state")).toHaveText("保存済み"); };
