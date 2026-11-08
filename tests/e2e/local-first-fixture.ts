import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtureElectronOptions, fixtureRoot } from "./fixture-isolation";

export type LocalSession = {
  root: string;
  directory: string;
  external: string;
  app: ElectronApplication;
  window: Page;
  pressure: (mode: "real" | "blocked" | "unknown") => void;
  restart: (options?: {
    readOnly?: boolean;
    recovery?: boolean;
  }) => Promise<void>;
};

/** Faults are child-local, apply only to this disposable workspace, and never
 * change the host network or fill the disk. The compiled production app is used. */
export const test = base.extend<{ local: LocalSession }>({
  local: async ({}, use, info) => {
    const root = fixtureRoot("local-first-");
    const directory = join(root, "workspace"),
      external = join(root, "external");
    mkdirSync(directory);
    mkdirSync(external);
    const modePath = join(root, "pressure.txt"),
      bootstrap = join(root, "bootstrap.cjs");
    writeFileSync(modePath, "real");
    writeFileSync(
      bootstrap,
      `
const fs = require('node:fs'), { app, session } = require('electron');
const actual = fs.statfsSync;
fs.statfsSync = function(path, options) {
  if (String(path) === ${JSON.stringify(directory)}) {
    const mode = fs.readFileSync(${JSON.stringify(modePath)}, 'utf8');
    if (mode === 'unknown') throw new Error('isolated statfs fault');
    if (mode === 'blocked') return { bsize: 4096n, bavail: 0n };
  }
  return actual.call(this, path, options);
};
globalThis.localFirstRequests = [];
globalThis.fetch = async () => { throw new Error('isolated offline main'); };
for (const name of ['http', 'https']) {
  const module = require('node:' + name);
  module.request = module.get = () => { throw new Error('isolated offline main'); };
}
app.whenReady().then(() => {
  session.defaultSession.enableNetworkEmulation({ offline: true });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*','https://*/*','ws://*/*','wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  globalThis.localFirstOffline = true;
});
require(${JSON.stringify(resolve("dist/main.cjs"))});
`,
    );
    let app: ElectronApplication | undefined, window: Page | undefined;
    const stop = async () => {
      if (!app) return;
      const child = app.process();
      // Retained drafts intentionally prevent a graceful window close. Only
      // this fixture's child may be killed; its durable journal is retained.
      if (child.exitCode === null && child.signalCode === null) {
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await app.close();
        } finally {
          clearTimeout(timer);
        }
      }
      app = undefined;
    };
    const start = async (options?: {
      readOnly?: boolean;
      recovery?: boolean;
    }) => {
      const electronOptions = fixtureElectronOptions(directory);
      app = await electron.launch({
        args: [
          ...electronOptions.args.slice(0, -1),
          bootstrap,
        ],
        env: electronOptions.env,
      });
      window = await app.firstWindow();
      // Also expose offline state to navigator.onLine in the automation
      // context; the session-level denial above already covers initial load.
      await app.context().setOffline(true);
      expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(
        directory,
      );
      expect(
        await app.evaluate(() => (globalThis as any).localFirstOffline),
      ).toBe(true);
      await app.evaluate(({ ipcMain }) => {
        const ipc = ipcMain as any,
          original = ipc._invokeHandlers.get("folio:request");
        ipc.removeHandler("folio:request");
        ipc.handle("folio:request", (event: any, request: any) => {
          (globalThis as any).localFirstRequests.push(structuredClone(request));
          return original(event, request);
        });
      });
      if (options?.readOnly)
        await expect(
          window.getByRole("heading", { name: "Folio · 読み取り専用" }),
        ).toBeVisible();
      else if (options?.recovery)
        await expect(
          window.getByRole("dialog", { name: "前回の入力を復旧", exact: true }),
        ).toBeVisible();
      else {
        await expect(window.locator(".page-title")).toBeVisible();
        await expect(window.locator(".save-state")).toHaveText("保存済み");
      }
    };
    try {
      await start();
      const session: LocalSession = {
        root,
        directory,
        external,
        app: app!,
        window: window!,
        pressure: (mode) => writeFileSync(modePath, mode),
        restart: async (options) => {
          await stop();
          await start(options);
          session.app = app!;
          session.window = window!;
        },
      };
      await use(session);
    } finally {
      if (window && !window.isClosed())
        await window
          .screenshot({ path: info.outputPath("screen.png") })
          .catch(() => {});
      if (app) {
        const requests = await app
          .evaluate(() => (globalThis as any).localFirstRequests)
          .catch(() => []);
        writeFileSync(
          info.outputPath("requests.json"),
          JSON.stringify(requests, null, 2),
        );
      }
      await stop();
      writeFileSync(
        info.outputPath("isolation.json"),
        JSON.stringify(
          {
            directory,
            external,
            pressure: readFileSync(modePath, "utf8"),
            network:
              "Electron session offline before load; main HTTP/fetch denied; host unchanged",
            chooser: "stubbed unless specifically stated",
            ime: "synthetic composition, not physical OS IME",
          },
          null,
          2,
        ),
      );
    }
  },
});
export { expect };
export async function openPicker(s: LocalSession, path: string | null) {
  await s.app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: path === null,
      filePaths: path ? [path] : [],
    })) as typeof dialog.showOpenDialog;
  }, path);
}
export async function savePicker(s: LocalSession, path: string | null) {
  await s.app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = (async () => ({
      canceled: path === null,
      filePath: path ?? undefined,
    })) as typeof dialog.showSaveDialog;
  }, path);
}
export async function maintenance(s: LocalSession) {
  const w = s.window;
  if (!(await w.locator(".workspace-maintenance").isVisible()))
    await w.getByLabel("ページ情報", { exact: true }).click();
  const section = w.getByRole("region", {
    name: "ワークスペースの保守",
    exact: true,
  });
  if (
    !(await section
      .locator("details")
      .evaluate((element: HTMLDetailsElement) => element.open))
  )
    await section.locator("summary").click();
  return section;
}
export const saved = async (s: LocalSession) =>
  expect(s.window.locator(".save-state")).toHaveText("保存済み");
