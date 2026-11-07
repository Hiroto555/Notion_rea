import { ConflictRecoveryService } from "./conflict-recovery-service";
import { createRichDocumentProtection } from "./rich-document-protection";
import { openWorkspaceAtStartup, admitStartupStorage } from "./workspace-startup";
import { assertReadOnlyRequest } from "./read-only-workspace";
import { runStartupWorkspaceSyncDetailed, startupSyncRequested, type WorkspaceSyncStartupResult } from "./workspace-sync-startup";
import { WorkspaceSyncService } from "./workspace-sync-service";
import { WorkspaceSyncControl } from "./workspace-sync-control";
import { WorkspaceSyncGate } from "./workspace-sync-gate";
import { WorkspaceSyncRestartControl, WorkspaceSyncRestartCoordinator } from "./workspace-sync-restart-coordinator";
import { WorkspaceSyncIntentJournal } from "./normal-apply-intent";
import { finishWorkspaceQuit } from "./workspace-quit";
import { WorkspaceConflictDecisionControl } from "./workspace-conflict-decision-control";
import { exportConflictAfterPicker, exportConflictCheckpoint } from "./conflict-export";
import { storageActionForRequest } from "./storage-write-policy";
import type { WorkspaceSyncStatus } from "../sync/workspace-store";
import { readUserVersion } from "../persistence/schema-startup";
import { WorkspaceStorageService } from "./workspace-storage-service";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  net,
  session,
  Menu,
  shell,
} from "electron";
import { join, resolve, basename, extname, dirname } from "node:path";
import {
  mkdirSync,
  copyFileSync,
  cpSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../persistence/store";
import { seed } from "../persistence/seed";
import { attachFile, resolveAsset } from "../persistence/assets";
import { workspacePath, migrateWorkspace } from "../persistence/workspace";
import { requestSchema } from "../shared/types";
import { FILE_MAX_BYTES } from "../shared/limits";
import { parseRecovery } from "../shared/recovery";
import { writeRecoveryFile } from "../persistence/recovery-file";
import { writePendingJournalFile } from "../persistence/pending-journal-file";
import { parsePendingJournal } from "../shared/pending-journal";
import { assertExternalOutput } from "../persistence/output-path";
import { previewPropertyOperation, commitPropertyOperation, resolvePropertyOperation } from "../persistence/property-operations";
import { previewLegacyMigration, commitLegacyMigration, resolveLegacyMigration } from "../persistence/legacy-migration-operation";
import { CrashRecoveryFile, crashRecoveryWorkspaceId } from "../persistence/crash-recovery-file";
import { createRecoveryCopy } from "../persistence/crash-recovery-copy";
import { handlePageOrderRepair } from "./page-order-repair";
app.setName("Folio");
const userData = join(app.getPath("appData"), "Folio");
const dataDir = workspacePath(userData, process.env.FOLIO_DATA_DIR);
let startupError: unknown;
try {
  const profile = process.env.FOLIO_DATA_DIR ? dataDir : userData;
  if (!existsSync(profile)) admitStartupStorage(profile, 1024 * 1024);
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", join(profile, "session"));
} catch (e) {
  startupError = e;
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: "folio-asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
if (startupError) {
  void app.whenReady().then(() => {
    dialog.showErrorBox(
      "Folioを起動できません",
      "保存先を作成できません: " + dataDir + "\n" + String(startupError),
    );
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | null = null,
    store: Store,
    restartControl: WorkspaceSyncRestartControl | undefined,
    conflictDecisionControl: WorkspaceConflictDecisionControl | undefined,
    recreateWindow: (() => void) | undefined;
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      if (!process.env.FOLIO_DATA_DIR && !existsSync(dataDir)) {
        // Legacy paths are discovery candidates only, never new write targets.
        const legacy = app.isPackaged
          ? resolve(dirname(process.execPath), "../../../..", ".folio-data")
          : join(app.getAppPath(), ".folio-data");
        if (
          legacy !== "/.folio-data" &&
          existsSync(join(legacy, "workspace.sqlite"))
        ) {
          const choice = await dialog.showMessageBox({
            type: "question",
            title: "以前のFolioデータ",
            message: "以前のワークスペースが見つかりました",
            detail:
              legacy +
              "\n原本を残し、バックアップ付きで新しい保存先へコピーできます。",
            buttons: [
              "コピーして開く",
              "別のフォルダを選ぶ",
              "新規で始める",
              "終了",
            ],
            defaultId: 0,
            cancelId: 3,
          });
          if (choice.response === 3) {
            app.quit();
            return;
          }
          if (choice.response === 0) migrateWorkspace(legacy, dataDir, {beforeCopy: admitStartupStorage});
          if (choice.response === 1) {
            const selected = await dialog.showOpenDialog({
              properties: ["openDirectory"],
            });
            if (selected.canceled) {
              app.quit();
              return;
            }
            migrateWorkspace(selected.filePaths[0], dataDir, {beforeCopy: admitStartupStorage});
          }
        }
      }
      const opened = openWorkspaceAtStartup(dataDir);
      store = opened.store;
      const readOnly = opened.status.mode === "readOnly";
      if (!readOnly && !startupSyncRequested(process.env) && readUserVersion(store.db) < 5) seed(store);
      const crashRecovery = readOnly ? undefined : new CrashRecoveryFile(join(dataDir, "crash-recovery.json"), crashRecoveryWorkspaceId(store));
      const assets = join(dataDir, "assets");
      if (!readOnly) mkdirSync(assets, { recursive: true });
      const storage = new WorkspaceStorageService(dataDir, store.db, process.env, async (title, create = false, file = false) => {
        const selected = await dialog.showOpenDialog(win!, {
          title, properties: file ? ["openFile"] : create ? ["openDirectory", "createDirectory"] : ["openDirectory"],
        });
        return selected.canceled ? null : selected.filePaths[0];
      });
      const syncGate = new WorkspaceSyncGate();
      const conflictRecovery = new ConflictRecoveryService(store,dirname(realpathSync(store.path)));
      const startupSync: WorkspaceSyncStartupResult = crashRecovery
        ? await runStartupWorkspaceSyncDetailed(store, () => crashRecovery.read(), process.env,
            (bytes, purpose) => storage.admitSyncWrite(bytes, purpose))
        : {};
      const syncService: WorkspaceSyncService<WorkspaceSyncStatus> | undefined = startupSync.opened
        ? new WorkspaceSyncService<WorkspaceSyncStatus>(startupSync.opened)
        : startupSync.reconnect
          ? WorkspaceSyncService.reconnect<WorkspaceSyncStatus>(startupSync.reconnect)
          : undefined;
      const syncControl = new WorkspaceSyncControl(syncService, syncGate, readOnly);
      let restartCoordinator: WorkspaceSyncRestartCoordinator | undefined;
      if (!readOnly && syncService && crashRecovery) {
        try {
          restartCoordinator = new WorkspaceSyncRestartCoordinator(
            new WorkspaceSyncIntentJournal(dirname(realpathSync(store.path)),store,(bytes) => storage.admitSyncWrite(bytes,"content")),
            {
              target: () => syncService.restartTarget(),
              incoming: () => syncService.stagedChange(),
              status: () => {
                const status = syncService.status().workspace;
                if (!status) throw new Error("sync-not-connected");
                return status;
              },
              running: () => syncService.status().running,
              gateIdle: () => syncGate.isIdle(),
              recovery: () => crashRecovery.read(),
              windowsClosed: () => BrowserWindow.getAllWindows().length === 0,
              otherIntentClear: () => !conflictDecisionControl?.hasReservation(),
            },
          );
        } catch { restartCoordinator = undefined; }
      }
      if (!readOnly && !restartCoordinator) {
        restartCoordinator = new WorkspaceSyncRestartCoordinator(new WorkspaceSyncIntentJournal(dirname(realpathSync(store.path)),store),undefined);
      }
      restartControl = new WorkspaceSyncRestartControl(restartCoordinator, readOnly);
      conflictDecisionControl = new WorkspaceConflictDecisionControl(store, syncService && crashRecovery ? {
        preview: (choice) => syncService.conflictResolutionPreview(choice),
        assertTarget: (target) => syncService.assertConflictResolutionTarget(target),
        hasConflict: () => syncService.status().workspace?.conflict === true,
        idle: () => !syncService.status().running && syncGate.isIdle(),
        recovery: () => crashRecovery.read(),
        windowsClosed: () => BrowserWindow.getAllWindows().length === 0,
        normalIntentClear: () => {
          const view = restartControl!.status();
          return new WorkspaceSyncIntentJournal(dirname(realpathSync(store.path)),store,(bytes) => storage.admitSyncWrite(bytes,"content")).read().status === "empty" &&
            (!view.available || (view.state === "idle" && !view.scheduled));
        },
      } : undefined, readOnly, (bytes) => storage.admitSyncWrite(bytes, "content"));
      const syncMessage = startupSync.message;
      const startupStatus = syncMessage ? { ...opened.status, syncMessage } : opened.status;
      const workspaceBackups = storage.backups;
      let layoutBackupDone = false;
      const { protectValue: protectRichDocument, protectRequest: protectRichRequest } =
        createRichDocumentProtection(() => workspaceBackups.createAutomatic("before-rich-blocks"));
      protocol.handle("folio-asset", async (req) => {
        try {
          const asset = resolveAsset(store.db, assets, req.url);
          const response = await net.fetch(
            pathToFileURL(asset.path).toString(),
          );
          return new Response(response.body, {
            headers: {
              "Content-Type": asset.mime,
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      session.defaultSession.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const url = new URL(
        process.env.FOLIO_DEV_URL ||
          pathToFileURL(join(__dirname, "renderer/index.html")).toString(),
      ).href;
      ipcMain.handle("folio:request", async (event, input: unknown) => {
        if (
          !win ||
          event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame ||
          event.senderFrame.url !== url
        )
          throw new Error("Unauthorized IPC sender");
        const requestWindow = win;
        const isAuthorized = () => !requestWindow.isDestroyed() && win === requestWindow &&
          event.sender === requestWindow.webContents && event.senderFrame === requestWindow.webContents.mainFrame &&
          event.senderFrame.url === url;
        const req = requestSchema.parse(input);
        // Validate size and admission before any backup or workspace mutation.
        if (
          req.type !== "export" &&
          req.type !== "exportRecovery" &&
          req.type !== "exportPendingJournal" &&
          Buffer.byteLength(JSON.stringify(req)) > 32_000_000
        )
          throw new Error("リクエストが大きすぎます");
        if (req.type === "recovery:list") return conflictRecovery.list(req.cursor);
        if (req.type === "recovery:status") return conflictRecovery.status(req.operationId);
        if (req.type === "recovery:export" || req.type === "recovery:restore") return syncGate.write(() => {
          if (!isAuthorized()) throw new Error("Unauthorized IPC sender");
          return conflictRecovery.run(req.target,req.type === "recovery:restore" ? "restore" : req.mode,async () => {
            const selected = await dialog.showOpenDialog(requestWindow,{title:"保全データの新規取り出し先",properties:["openDirectory","createDirectory"]});
            return selected.canceled ? null : selected.filePaths[0] ?? null;
          },isAuthorized,req.operationId);
        });
        if (req.type === "sync:status") return syncControl.status();
        if (req.type === "sync:restartStatus") return restartControl!.status();
        if (req.type === "sync:restartRequest") return restartControl!.request();
        if (req.type === "sync:restartCancel") return restartControl!.cancel(req.reservationId);
        if (req.type === "sync:run") return syncControl.transfer(() => {
          if (!isAuthorized()) throw new Error("Unauthorized IPC sender");
          if (conflictDecisionControl!.hasReservation()) throw new Error("conflict-decision-present");
        });
        if (req.type === "sync:conflictDecisionStatus") return conflictDecisionControl!.status();
        if (req.type === "sync:conflictPreview") return conflictDecisionControl!.preview(req);
        if (req.type === "sync:conflictConfirm") return conflictDecisionControl!.confirm(req.previewId);
        if (req.type === "sync:conflictCancel") return syncGate.write(() => {
          if (!isAuthorized()) throw new Error("Unauthorized IPC sender");
          return conflictDecisionControl!.cancel(req.decisionId);
        });
        if (req.type === "sync:conflict") return syncControl.conflict();
        if (req.type === "sync:conflictCandidate") return syncControl.conflictCandidate({
          operationId: req.operationId, side: req.side, expectedRevision: req.expectedRevision,
          expectedCheckpointHash: req.expectedCheckpointHash,
        });
        if (req.type === "sync:conflictExport") {
          const target = {operationId: req.operationId, side: req.side, expectedRevision: req.expectedRevision,
            expectedCheckpointHash: req.expectedCheckpointHash};
          return exportConflictAfterPicker({target, authorized: isAuthorized,
            candidate: (selected) => syncControl.conflictCandidate(selected),
            pick: async () => {
              const result = await dialog.showSaveDialog(requestWindow, {
                defaultPath: join(app.getPath("downloads"), `folio-conflict-${req.side}.json`),
                filters: [{name: "Folio conflict checkpoint", extensions: ["json"]}],
              });
              return result.canceled ? null : result.filePath ?? null;
            },
            save: (path, candidate) => exportConflictCheckpoint(path, candidate, (out) => assertExternalOutput(dataDir, out)),
          });
        }
        const action = storageActionForRequest(req.type);
        const handle = async () => {
        if (!isAuthorized()) throw new Error("Unauthorized IPC sender");
        const win = requestWindow;
        if (req.type === "startup:status") return startupStatus;
        if (readOnly) assertReadOnlyRequest(req);
        const utility = storage.handleUtility(req);
        if (utility) return utility;
        storage.admitRequest(req);
        // Snapshot before the first W3 database mutation. The durable draft
        // journal must still work when a backup or database save fails.
        protectRichRequest(req);
        // Before the first persisted layout change in this process, preserve
        // a verified pre-change workspace. Failure prevents the mutation.
        const width = req.type === "save:commit" ? req.operation.patch.width
          : req.type === "update" || req.type === "record:pageUpdate" ? req.patch.width
          : req.type === "database:commit" && req.operation.command.kind === "updateDatabase"
            ? req.operation.command.patch.width : undefined;
        if (width !== undefined && !layoutBackupDone) {
          workspaceBackups.createAutomatic("before-page-layout");
          layoutBackupDone = true;
        }
        if (req.type === "workspaceBackup:create") return workspaceBackups.create();
        if (req.type === "workspaceBackup:choose") {
          const selected = await dialog.showOpenDialog(win, {title: "Folioの完全バックアップを選択", properties: ["openDirectory"]});
          return selected.canceled ? null : workspaceBackups.choose(selected.filePaths[0]);
        }
        if (req.type === "workspaceBackup:restore") {
          const selected = await dialog.showOpenDialog(win, {title: "復元先の親フォルダーを選択（新しいフォルダーを作成します）", properties: ["openDirectory", "createDirectory"]});
          return selected.canceled ? null : workspaceBackups.restore(req.ticket, selected.filePaths[0]);
        }
        if (req.type === "workspaceBackup:open") {
          await workspaceBackups.open(req.ticket, (directory) => new Promise<void>((resolveLaunch, reject) => {
            const env: NodeJS.ProcessEnv = {...process.env, FOLIO_DATA_DIR: directory};
            delete env.FOLIO_DEV_URL;
            for (const key of Object.keys(env))
              if (key.startsWith("FOLIO_SYNC_")) delete env[key];
            // When Electron starts dist/main.cjs directly, getAppPath() is
            // dist/, which has no package.json entry point. Relaunch this file.
            const child = spawn(process.execPath, process.defaultApp ? [__filename] : [], {env, detached: true, stdio: "ignore"});
            child.once("error", reject);
            child.once("spawn", () => {child.unref(); resolveLaunch();});
          }));
          return true;
        }
        // R4 only opens fixed-owner record editing. Historical record/DB
        // restore lacks the provenance needed to overwrite present contents.
        if (req.type === "restoreVersion") {
          protectRichDocument(store.versions(req.id).find(v => v.id === req.versionId));
          const snapshot = store.load();
          if (snapshot.records?.some((record) => record.pageId === req.id) ||
            snapshot.recordDatabaseIds?.includes(req.id))
            throw new Error("レコードと登録済みDBの履歴復元は未対応です。現在の内容を保持しています。");
        }
        if (req.type === "openExternal") {
          await shell.openExternal(req.url);
          return true;
        }
        if (req.type === "recovery:read") return crashRecovery!.read();
        if (req.type === "recovery:write") return crashRecovery!.write(req.expectedGeneration, req.snapshot);
        if (req.type === "recovery:copy") return createRecoveryCopy(store, req.recoveryId, {...req.input, payload: req.input.payload});
        if (req.type === "pageOrder:preview" || req.type === "pageOrder:apply")
          return handlePageOrderRepair(store, req, () => storage.admitSnapshot());
        if (req.type === "property:preview") return previewPropertyOperation(store, req);
        if (req.type === "property:commit") return commitPropertyOperation(store, req.operation);
        if (req.type === "property:resolve") return resolvePropertyOperation(store, req.operation);
        if (req.type === "migration:preview") return previewLegacyMigration(store, req.databasePageId);
        if (req.type === "migration:commit") return commitLegacyMigration(store, req.operation, {
          assetsPath: assets, snapshotRoot: join(dataDir, "backups", "legacy-migration"),
          beforeSnapshot: () => storage.admitSnapshot(),
        });
        if (req.type === "migration:resolve") return resolveLegacyMigration(store, req.operation);
        if (req.type === "downloadAttachment") {
          const asset = resolveAsset(store.db, assets, req.url);
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(app.getPath("downloads"), basename(asset.name)),
          });
          if (result.canceled || !result.filePath) return null;
          assertExternalOutput(dataDir, result.filePath);
          copyFileSync(asset.path, result.filePath);
          return result.filePath;
        }
        if (req.type === "backup") {
          storage.admitSnapshot();
          const folder = join(dataDir, "backups");
          mkdirSync(folder, { recursive: true });
          const dest = join(folder, `workspace-${Date.now()}`);
          mkdirSync(dest);
          store.db.prepare("VACUUM INTO ?").run(join(dest, "workspace.sqlite"));
          cpSync(assets, join(dest, "assets"), { recursive: true });
          writeFileSync(
            join(dest, "manifest.json"),
            JSON.stringify(
              { app: "Folio", schema: 1, createdAt: new Date().toISOString() },
              null,
              2,
            ),
          );
          return dest;
        }
        if (req.type === "attach") {
          const result = await dialog.showOpenDialog(win, {
            properties: ["openFile"],
          });
          if (result.canceled) return null;
          const file = result.filePaths[0];
          // Capacity may have changed while the native picker was open.
          return attachFile(store.db, assets, file, bytes => storage.admitAttachment(bytes));
        }
        if (req.type === "recover") {
          const selected = await dialog.showOpenDialog(win, {
            properties: ["openFile"],
            filters: [{ name: "Folio recovery", extensions: ["json"] }],
          });
          if (selected.canceled) return null;
          const path = selected.filePaths[0];
          if (statSync(path).size > FILE_MAX_BYTES)
            throw new Error("復旧ファイルが大きすぎます");
          const content = readFileSync(path, "utf8");
          const recoveredPages = parseRecovery(content);
          storage.admitRequest(req);
          protectRichDocument(recoveredPages);
          return store.recover(JSON.parse(content));
        }
        if (req.type === "exportPendingJournal") {
          parsePendingJournal(req.content);
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(app.getPath("downloads"), "folio-unsaved-changes.json"),
            filters: [{ name: "Folio unsaved changes", extensions: ["json"] }],
          });
          if (result.canceled || !result.filePath) return null;
          const saved = writePendingJournalFile(result.filePath, req.content, {
            validate: parsePendingJournal,
            checkDestination: (path) => assertExternalOutput(dataDir, path),
          });
          return saved.path;
        }
        if (req.type === "exportRecovery") {
          parseRecovery(req.content);
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(app.getPath("downloads"), "folio-unsaved-recovery.json"),
          });
          if (result.canceled || !result.filePath) return null;
          writeRecoveryFile(result.filePath, req.content, () => assertExternalOutput(dataDir, result.filePath!));
          return result.filePath;
        }
        if (req.type === "export") {
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(
              app.getPath("downloads"),
              req.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") +
                "." +
                req.format,
            ),
          });
          if (result.canceled || !result.filePath) return null;
          assertExternalOutput(dataDir, result.filePath);
          writeFileSync(result.filePath, req.content, "utf8");
          return result.filePath;
        }
        if (req.type === "import") {
          const result = await dialog.showOpenDialog(win, {
            properties: ["openFile"],
            filters: [
              {
                name: "Documents",
                extensions: ["md", "markdown", "html", "htm"],
              },
            ],
          });
          if (result.canceled) return null;
          const file = result.filePaths[0];
          if (statSync(file).size > 10_000_000)
            throw new Error("インポートの上限は10MBです");
          return {
            name: basename(file, extname(file)),
            format: extname(file),
            content: readFileSync(file, "utf8"),
          };
        }
        return store.handle(req);
        };
        return action === "write" || action === "maintenance" ? syncGate.write(handle) : handle();
      });
      function createWindow() {
        win = new BrowserWindow({
          width: 1440,
          height: 960,
          minWidth: 960,
          minHeight: 640,
          title: "Folio",
          backgroundColor: "#fcfcfa",
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 18, y: 17 },
          webPreferences: {
            preload: join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
          },
        });
        win.webContents.on("did-start-navigation", details => {
          if (details.isMainFrame && !details.isSameDocument) storage.resetTickets();
        });
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        // Structural changes reload this exact trusted renderer after clearing its
        // durable journal. All other renderer-initiated navigation stays blocked.
        win.webContents.on("will-navigate", (event, target) => {if (target !== url) event.preventDefault();});
        win.loadURL(url);
      }
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { label: "Folio", submenu: [{ role: "about" }, { role: "quit" }] },
          {
            label: "編集",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "表示",
            submenu: [
              { role: "reload" },
              { role: "toggleDevTools" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
            ],
          },
        ]),
      );
      recreateWindow = createWindow;
      createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((e) => {
      dialog.showErrorBox("Folioを起動できません", String(e) + "\n\n起動できないワークスペースは、ターミナルから npm run folio:rescue -- --help で診断用の救出方法を確認できます。");
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", (event) => {
    finishWorkspaceQuit({
      commitRestart: () => {
        const conflict = conflictDecisionControl?.commitAfterWindowsClosed() ?? "not-prepared";
        return conflict === "not-prepared" ? restartControl?.commitAfterWindowsClosed() ?? "not-prepared" : conflict;
      },
      preventQuit: () => event.preventDefault(),
      reopenWindow: () => {if (BrowserWindow.getAllWindows().length === 0) recreateWindow?.();},
      closeStore: () => store?.close(),
    });
  });
}
