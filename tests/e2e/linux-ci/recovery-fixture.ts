import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../../../src/persistence/store";
import { attachFile } from "../../../src/persistence/assets";
import { buildWorkspaceCheckpoint } from "../../../src/sync/workspace-checkpoint";
import { WorkspaceSyncStore } from "../../../src/sync/workspace-store";
import { canonicalJson, hashCheckpoint } from "../../../src/sync/protocol";
import type {
  ArchiveTarget,
  RecoveryActionResult,
} from "../../../src/shared/conflict-recovery";
import {
  assertCiDataRoot,
  assertLinuxGuiCi,
  isolatedGuiEnv,
} from "../../../scripts/linux-gui-ci-policy.mjs";

export type RecoverySession = {
  app: ElectronApplication;
  window: Page;
  source: string;
  external: string;
  assetId: string;
  assetBytes: Buffer;
  checkpointHash: string;
  root: string;
  archives: string;
  pageId: string;
  openPanel(): Promise<void>;
  choose(): Promise<void>;
  picker(path: string | null, hold?: boolean): Promise<void>;
  releasePicker(): Promise<void>;
  calls(): Promise<
    { type: string; operationId?: string; result?: RecoveryActionResult }[]
  >;
  restart(directory?: string, env?: Record<string, string>): Promise<void>;
};

export const test = base.extend<{ recovery: RecoverySession }>({
  recovery: async ({}, use, info) => {
    assertLinuxGuiCi();
    assertCiDataRoot(
      process.env.FOLIO_GUI_CI_DATA_ROOT,
      process.env.RUNNER_TEMP,
    );
    const root = mkdtempSync(
      join(process.env.FOLIO_GUI_CI_DATA_ROOT!, "recovery-"),
    );
    const source = join(root, "source"),
      external = join(root, "external");
    mkdirSync(source);
    mkdirSync(external);
    mkdirSync(join(source, "assets"));
    const store = new Store(join(source, "workspace.sqlite"));
    const page = store.create(null, "page", "GUI 回収元");
    store.update(page.id, page.revision, {
      doc: {
        type: "doc",
        schemaVersion: 1,
        content: [
          {
            type: "paragraph",
            attrs: { id: randomUUID() },
            content: [{ type: "text", text: "GUIで保全する本文" }],
          },
        ],
      },
    });
    const assetBytes = Buffer.from("synthetic GUI recovery attachment");
    const input = join(root, "fixture.png");
    writeFileSync(input, assetBytes);
    const asset = attachFile(store.db, join(source, "assets"), input);
    const sync = new WorkspaceSyncStore(store, {
      workspaceId: "gui-workspace",
      clientId: "gui-client",
      bindingId: "gui-binding",
      serverEpoch: "gui-epoch",
    });
    sync.enable("publish", () => {});
    const checkpoint = buildWorkspaceCheckpoint(store.db),
      checkpointHash = hashCheckpoint(checkpoint);
    for (let i = 0; i < 54; i++)
      store.db
        .prepare(
          "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
        )
        .run(randomUUID(), "gui-valid", canonicalJson(checkpoint), i + 1);
    store.db
      .prepare(
        "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
      )
      .run(randomUUID(), "gui-corrupt", "{", 55);
    const archives = JSON.stringify(
      store.db
        .prepare("SELECT * FROM workspace_sync_archives ORDER BY id")
        .all(),
    );
    store.close();
    let app: ElectronApplication | undefined, window: Page | undefined;
    async function stop() {
      if (!app) return;
      const child = app.process();
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 4000);
      try {
        await app.close();
      } finally {
        clearTimeout(timer);
        app = undefined;
        window = undefined;
      }
    }
    async function start(
      directory = source,
      extra: Record<string, string> = {},
    ) {
      const env = isolatedGuiEnv(
        process.env,
        process.env.FOLIO_GUI_CI_DATA_ROOT!,
      );
      app = await electron.launch({
        args: ["--no-sandbox", resolve("dist/main.cjs")],
        env: { ...env, ...extra, FOLIO_DATA_DIR: directory },
      });
      window = await app.firstWindow();
      await app
        .context()
        .tracing.start({ screenshots: true, snapshots: true, sources: true });
      await app.evaluate(({ app, dialog, ipcMain }, expected) => {
        if (app.getPath("userData") !== expected)
          throw new Error("GUI profile escaped temporary workspace");
        const g = globalThis as any;
        g.guiCiCalls = [];
        g.guiCiPicker = { path: null, hold: false };
        g.guiCiPickerCount = 0;
        dialog.showOpenDialog = (async () => {
          g.guiCiPickerCount++;
          const selected = g.guiCiPicker.path;
          if (g.guiCiPicker.hold)
            await new Promise<void>((done) => {
              g.guiCiReleasePicker = done;
            });
          return {
            canceled: selected === null,
            filePaths: selected === null ? [] : [selected],
          };
        }) as typeof dialog.showOpenDialog;
        dialog.showSaveDialog = (async () => {
          throw new Error("Native save dialog is outside Linux CI acceptance");
        }) as typeof dialog.showSaveDialog;
        const ipc = ipcMain as any,
          original = ipc._invokeHandlers.get("folio:request");
        ipc.removeHandler("folio:request");
        ipc.handle("folio:request", async (event: any, request: any) => {
          const result = await original(event, request);
          g.guiCiCalls.push({
            type: request.type,
            operationId: request.operationId,
            result: request.type.startsWith("recovery:") ? result : undefined,
          });
          if (
            g.guiCiDropReply &&
            (request.type === "recovery:export" ||
              request.type === "recovery:restore")
          ) {
            g.guiCiDropReply = false;
            throw new Error("GUI fixture: response lost after host completion");
          }
          return result;
        });
      }, directory);
      await expect(window.locator(".page-title")).toBeVisible();
      await expect(window.locator(".save-state[data-state]")).toHaveText("保存済み");
    }
    try {
      await start();
      const s: RecoverySession = {
        app: app!,
        window: window!,
        source,
        external,
        assetId: asset.id,
        assetBytes,
        checkpointHash,
        root,
        archives,
        pageId: page.id,
        openPanel: async () => {
          await s.window
            .locator(".conflict-recovery-details > summary")
            .click();
          await expect(
            s.window.getByText("55 件表示", { exact: false }),
          ).toBeVisible();
        },
        choose: async () => {
          await s.window
            .locator(".conflict-recovery-details button:not([disabled])")
            .filter({ hasText: "この対象を選択" })
            .first()
            .click();
        },
        picker: async (path, hold = false) => {
          await s.app.evaluate(
            (_electron, value) => {
              (globalThis as any).guiCiPicker = value;
            },
            { path, hold },
          );
        },
        releasePicker: async () => {
          await s.app.evaluate(() => {
            (globalThis as any).guiCiReleasePicker();
          });
        },
        calls: () => s.app.evaluate(() => (globalThis as any).guiCiCalls),
        restart: async (directory = source, extra = {}) => {
          await app!
            .context()
            .tracing.stop({ path: info.outputPath("before-restart.zip") });
          await stop();
          await start(directory, extra);
          s.app = app!;
          s.window = window!;
        },
      };
      await use(s);
    } finally {
      if (window && !window.isClosed())
        await window
          .screenshot({ path: info.outputPath("screen.png") })
          .catch(() => {});
      if (app)
        await app
          .context()
          .tracing.stop({ path: info.outputPath("trace.zip") })
          .catch(() => {});
      await stop();
    }
  },
});
export { expect };

export function readArchives(directory: string): string {
  const store = new Store(join(directory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    return JSON.stringify(
      store.db
        .prepare("SELECT * FROM workspace_sync_archives ORDER BY id")
        .all(),
    );
  } finally {
    store.close();
  }
}
export async function lastResult(
  s: RecoverySession,
): Promise<RecoveryActionResult> {
  const calls = await s.calls();
  const result = calls
    .filter(
      (x) => x.type === "recovery:export" || x.type === "recovery:restore",
    )
    .at(-1)?.result;
  if (!result) throw new Error("No host recovery result recorded");
  return result;
}
