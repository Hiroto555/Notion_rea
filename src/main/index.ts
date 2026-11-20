import {readWindowsRestoreHandoff, type WindowsRestoreHandoff} from "../platform/windows/restored-workspace-handoff";
import {acquireWindowsPrivateOwner, type WindowsPrivateOwner} from "../platform/windows/private-owner";
import {withNativeTransfer} from "../platform/windows/private-transfer";
import {createPrivatePersistenceLifecycle} from "./private-persistence-lifecycle";
import {createPrivateRequestHandlers} from "./private-request-handlers";
import {handlePrivateRecoveryRequest, isPrivateRecoveryRequest} from "./private-recovery-handlers";
import {launchRestoredWorkspace} from "./private-workspace-launch";
import {startupRetainsNativeLease} from "../persistence/startup-connection-owner";
import { createWindowsProductNative } from "../platform/windows/product-native";
import { WindowsRuntimePlatform } from "../platform/windows/runtime-platform";
import { withPrivatePersistence, type NativePrivateIdentity } from "../platform/private-persistence";
import {assertPrivateOperationAuthority, withPrivateOperationAuthority} from "../platform/private-operation-authority";
import { createWindowsAppPrivate } from "../platform/windows/app-private";
import { withProductPrivateJournals } from "../platform/product-private-journals";
import { installProductOwnedShutdown } from "./owned-shutdown";
import { createWindowsRecoveryProof } from "../platform/windows/recovery-proof";
import {readPrivateCopySources, readPrivateCopyCatalog} from "./shared-copy-source";
import {SharedRuntimeService} from "./shared-runtime-service";
import {CredentialProvider} from "../platform/credential-provider";
import { readRecoveryOrigin, assertRecoverySyncAllowed } from "../persistence/recovery-origin";
import { SyncConnectionVault } from "./sync-connection-vault";
import { savedConnectionEnvironment } from "./sync-connection-startup";
import { SyncManagementControl } from "./sync-management-control";
import { TransferMaintenanceService } from "./transfer-maintenance-service";
import { canonicalJson, sha256, requireCondition } from "../sync/protocol";
import { ConflictRecoveryService } from "./conflict-recovery-service";
import { createRichDocumentProtection } from "./rich-document-protection";
import { openWorkspaceAtStartup, admitStartupStorage } from "./workspace-startup";
import { assertReadOnlyRequest } from "./read-only-workspace";
import { createDesktopCapabilities } from "./desktop-capabilities";
import { runStartupWorkspaceSyncDetailed, startupSyncRequested, type WorkspaceSyncStartupResult } from "./workspace-sync-startup";
import { WorkspaceSyncService } from "./workspace-sync-service";
import { WorkspaceSyncControl } from "./workspace-sync-control";
import { WorkspaceSyncGate } from "./workspace-sync-gate";
import { WorkspaceSyncRestartControl, WorkspaceSyncRestartCoordinator } from "./workspace-sync-restart-coordinator";
import { WorkspaceSyncIntentJournal } from "./normal-apply-intent";
import { finishWorkspaceQuit, registerAcceptedQuitCleanup } from "./workspace-quit";
import { WorkspaceConflictDecisionControl } from "./workspace-conflict-decision-control";
import { exportConflictAfterPicker, exportConflictCheckpoint } from "./conflict-export";
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
  safeStorage,
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
import { attachBuffer, decodeAttachment, attachFile, resolveAsset } from "../persistence/assets";
import { workspacePath, migrateWorkspace } from "../persistence/workspace";
import { FILE_MAX_BYTES } from "../shared/limits";
import { parseRecovery } from "../shared/recovery";
import { writeRecoveryFile } from "../persistence/recovery-file";
import { writePendingJournalFileV3 } from "../persistence/pending-journal-file-v3";
import { createWindowsOperatorNative, windowsOperatorConfigFromEnvironment } from "../platform/windows/operator-native";
import { parsePendingJournal } from "../shared/pending-journal";
import { showSharedUi } from "../shared/startup-status";
import { exportWorkspaceMarkdown } from "../persistence/workspace-markdown";
import { assertExternalOutput } from "../persistence/output-path";
import { previewPropertyOperation, commitPropertyOperation, resolvePropertyOperation } from "../persistence/property-operations";
import { previewLegacyMigration, commitLegacyMigration, resolveLegacyMigration } from "../persistence/legacy-migration-operation";
import { CrashRecoveryFile, crashRecoveryWorkspaceId } from "../persistence/crash-recovery-file";
import { createRecoveryCopy } from "../persistence/crash-recovery-copy";
import {createOriginalWorkspaceCopy} from "../persistence/raw-workspace-salvage";
import { handlePageOrderRepair } from "./page-order-repair";
import {planWindowsMaintenanceSelection, createNativeMaintenance, proveMaintenanceOutputParent, admitNativeSaveParent, admitNativeSaveDirectory} from "./windows-maintenance-selection";
app.setName("Folio");
const userData = join(app.getPath("appData"), "Folio");
const dataDir = workspacePath(userData, process.env.FOLIO_DATA_DIR);
let startupError: unknown;
let nativeConfiguration: ReturnType<typeof windowsOperatorConfigFromEnvironment> | undefined;
let maintenanceSelection: ReturnType<typeof planWindowsMaintenanceSelection> | undefined;
let restoredStartupHandoff: WindowsRestoreHandoff | undefined;
let restoredStartupPending = false;
let nativeEnrollment = process.env.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES === "1";
try {
  const profile = process.env.FOLIO_DATA_DIR ? dataDir : userData;
  // Trusted maintenance configuration is adjudicated BEFORE any
  // admitStartupStorage/native runtime/Store write: root must be a single
  // private container with the workspace a strict descendant.
  if (process.platform === "win32") {
    nativeConfiguration = windowsOperatorConfigFromEnvironment(process.env);
    requireCondition(nativeConfiguration !== undefined, "windows-native-configuration-required", 503);
    // Validate the immutable restore receipt and acquire raw startup guards
    // before any source/state SQLite or startup-directory mutation.
    restoredStartupHandoff = readWindowsRestoreHandoff(nativeConfiguration, dataDir, process.env);
    if (restoredStartupHandoff) {
      restoredStartupPending = true;
      nativeConfiguration = restoredStartupHandoff.config;
      nativeEnrollment = restoredStartupHandoff.initialEnrollment;
    }
    maintenanceSelection = planWindowsMaintenanceSelection(nativeConfiguration, dataDir, process.env, [userData]);
  }
  if (!existsSync(profile)) admitStartupStorage(profile, 1024 * 1024);
  if (process.platform === "win32") {
    const configuration = nativeConfiguration!;
    const native = new WindowsRuntimePlatform({...configuration, databaseName: "workspace.sqlite"});
    let failure: unknown;
    try {
      if (profile.toLowerCase() !== configuration.root.toLowerCase()) native.prepareDirectory(profile);
      native.bind(profile); native.assertRoot();
    } catch (error) {failure = error; throw error;}
    finally {
      try {native.close();} catch (cleanup) {
        if (failure !== undefined) throw new AggregateError([failure, cleanup], "Startup directory proof and cleanup failed");
        throw cleanup;
      }
    }
  } else mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", join(profile, "session"));
} catch (e) {
  if (restoredStartupHandoff && restoredStartupPending) {
    try {restoredStartupHandoff.retainFailure(e);} catch (retained) {e = retained;}
  }
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
  installProductOwnedShutdown(app, {env: process.env});
  let win: BrowserWindow | null = null,
    store: Store,
    restartControl: WorkspaceSyncRestartControl | undefined,
    conflictDecisionControl: WorkspaceConflictDecisionControl | undefined,
    recreateWindow: (() => void) | undefined;
  let rendererGeneration = 0;
  const privateLifecycle = createPrivatePersistenceLifecycle();
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      let nativeClosed = false;
      let privateOwner: WindowsPrivateOwner | undefined;
      let maintenanceWorkspaceDirectory: NativePrivateIdentity | undefined;
      let primaryStartupUncertain = false;
      const productBaseFence = () => {privateLifecycle.assertUsable(); assertPrivateOperationAuthority(); requireCondition(!nativeClosed, "native-session-closed", 503);};
      const cleanups: (() => void)[] = [];
      registerAcceptedQuitCleanup(app, () => {
        const failures: unknown[] = [];
        privateLifecycle.assertUsable();
        if (primaryStartupUncertain) throw new Error("Native startup SQLite close is unconfirmed; retain owner and factories");
        for (const close of [...cleanups].reverse()) {
          try {close();} catch (error) {failures.push(error); break;}
        }
        if (failures.length) throw new AggregateError(failures, "Folio native resource cleanup failed");
      });
      const nativeConfig = nativeConfiguration ? {root: nativeConfiguration.root,
        probeExecutable: nativeConfiguration.probeExecutable, expectedHash: nativeConfiguration.expectedHash,
        systemRoot: nativeConfiguration.systemRoot} : undefined;
      const productNative = nativeConfiguration ? createWindowsProductNative(nativeConfiguration, {
        enrollExistingSources: nativeEnrollment,
        assertCurrent() {productBaseFence(); privateOwner?.assertCurrent();},
      }) : undefined;
      if (productNative) cleanups.push(() => {productNative.close(); nativeClosed = true;});
      const privatePersistence = productNative ? {nativePrivateFilesystem: productNative.privateFilesystem} : undefined;
      const windowsPrivate = nativeConfig && nativeConfiguration ? createWindowsAppPrivate(nativeConfig, {
        sourceBindings: {publicationStateRoot: nativeConfiguration.publicationStateRoot,
          publicationStateDirectory: nativeConfiguration.publicationStateDirectory,
          enrollExistingSources: nativeEnrollment},
      }) : undefined;
      // Ordinary private journals retain the small profile. Only the
      // workspace snapshot controller opts into the distinct archive bound.
      const workspaceSnapshots = nativeConfig && nativeConfiguration ? createWindowsAppPrivate(nativeConfig, {
        sourceBindings: {publicationStateRoot: nativeConfiguration.publicationStateRoot,
          publicationStateDirectory: nativeConfiguration.publicationStateDirectory,
          enrollExistingSources: nativeEnrollment},
        hotJournalSnapshotProfile: "recovery-archive",
      }) : undefined;
      const privateJournals = windowsPrivate ? {privatePlatformFactory: windowsPrivate.ledgerPlatform} : undefined;
      const nativeTransfer = productNative ? {...productNative.nativeTransfer, privateJournals} : undefined;
      const nativeExports = nativeConfiguration ? createWindowsOperatorNative(nativeConfiguration,
        {enrollExistingSources: nativeEnrollment}) : undefined;
      if (nativeExports) cleanups.push(() => nativeExports.close());
      const windowsRecovery = nativeConfig && windowsPrivate ? createWindowsRecoveryProof(nativeConfig, windowsPrivate) : undefined;
      if (windowsRecovery?.close) cleanups.push(() => windowsRecovery.close!());
      return withPrivatePersistence(privatePersistence, () => withNativeTransfer(nativeTransfer, async () => {
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
      if (productNative && nativeConfiguration) {
        maintenanceWorkspaceDirectory = existsSync(dataDir) ? productNative.privateFilesystem.inspectDirectory(dataDir)
          : productNative.privateFilesystem.createDirectory(dataDir);
        restoredStartupHandoff?.stateReady(productNative);
        privateOwner = acquireWindowsPrivateOwner(nativeConfiguration, dataDir, productNative.privateFilesystem, {
          enrollExistingSources: nativeEnrollment,
          assertCurrent: productBaseFence,
        });
        cleanups.push(() => {
          // Never release the workspace arbiter before SQLite is definitively closed.
          store?.close();
          privateOwner!.close();
          privateOwner = undefined;
        });
      }
      const openPrimary = () => openWorkspaceAtStartup(dataDir, admitStartupStorage, privatePersistence && workspaceSnapshots ? {
        ...privatePersistence,
        nativeHotJournalSnapshot(path, callback) {
          const handle = workspaceSnapshots.snapshotController(dataDir, "workspace.sqlite");
          let failure: unknown;
          try {handle.snapshot.withSnapshot({path, expectedDirectory: handle.runtime.validatedDirectoryIdentity(),
            expectedFile: handle.runtime.validatedFileIdentity(path)}, callback);}
          catch (error) {failure = error; throw error;}
          finally {try {handle.close();} catch (cleanup) {
            if (failure !== undefined) throw new AggregateError([failure, cleanup], "Workspace snapshot and cleanup failed");
            throw cleanup;
          }}
        },
      } : undefined);
      let opened: ReturnType<typeof openWorkspaceAtStartup>;
      try {opened = openPrimary();} catch (error) {primaryStartupUncertain = startupRetainsNativeLease(error); throw error;}
      store = opened.store;
      if (restoredStartupHandoff) {
        restoredStartupHandoff.workspaceReady(store);
        restoredStartupPending = false;
      }
      const readOnly = opened.status.mode === "readOnly";
      const recoveryIdentity = readOnly ? undefined : crashRecoveryWorkspaceId(store);
      const vaultDirectory = resolve(process.env.FOLIO_CREDENTIAL_DIR ?? join(app.getPath("appData"), "Folio Sync Credentials"));
      const vault = new SyncConnectionVault({directory: vaultDirectory, forbiddenRoots: [dirname(realpathSync(store.path))], safeStorage,
        ...(windowsPrivate ? {privatePlatformFactory: windowsPrivate.ledgerPlatform, workspaceNativeIdentity: windowsPrivate.workspaceIdentity} : {}),
        privatePersistence,
        assertWorkspaceAllowed: path => {requireCondition(!readOnly && path === store.path, "read-only", 409); assertRecoverySyncAllowed(store.db);},
        workspaceIdentity: () => recoveryIdentity ?? ""});
      const savedConnection: ReturnType<typeof savedConnectionEnvironment> = readOnly ? {env: {...process.env, FOLIO_SYNC_ENABLED: "0"}} :
        savedConnectionEnvironment(vault, vaultDirectory, store.path, process.env);
      if (!readOnly && readRecoveryOrigin(store.db) === "absent" && !startupSyncRequested(savedConnection.env) &&
          process.env.FOLIO_EMPTY_WORKSPACE !== "1" && readUserVersion(store.db) < 5) seed(store);
      if (productNative && recoveryIdentity && windowsPrivate) {
        const nativeIdentity = windowsPrivate.workspaceIdentity(store.path);
        const assertWorkspaceConnection = store.recoveryWorkspaceFence(recoveryIdentity);
        productNative.bindWorkspace(dataDir, recoveryIdentity, () => {
          assertWorkspaceConnection();
          const current = windowsPrivate.workspaceIdentity(store.path);
          requireCondition(current.fileId === nativeIdentity.fileId && current.volumeId === nativeIdentity.volumeId,
            "workspace-native-identity-changed", 409);
        });
      }
      // Diagnostic rescue uses the exact native directory retained before SQL
      // startup. It never invents a semantic workspace identity or writes source SQL.
      const readOnlyMaintenanceDirectory = readOnly ? maintenanceWorkspaceDirectory : undefined;
      const nativeMaintenance = productNative && nativeConfiguration && maintenanceSelection
        ? createNativeMaintenance({product: productNative, operatorConfig: nativeConfiguration,
            selection: maintenanceSelection, workspace: dataDir, workspaceId: recoveryIdentity, current: productBaseFence,
            readOnlyWorkspace: readOnlyMaintenanceDirectory,
            available: readOnly ? !!readOnlyMaintenanceDirectory : !!(recoveryIdentity && windowsPrivate)})
        : undefined;
      if (nativeMaintenance && productNative && maintenanceSelection)
        proveMaintenanceOutputParent(productNative, maintenanceSelection, productBaseFence, undefined, readOnlyMaintenanceDirectory);
      const crashRecovery = readOnly ? undefined : new CrashRecoveryFile(join(dataDir, "crash-recovery.json"), recoveryIdentity!,
        productNative ? {nativePort: productNative.crashRecoveryPort} : undefined);
      const assets = join(dataDir, "assets");
      if (!readOnly) {
        if (productNative) {
          if (existsSync(assets)) productNative.privateFilesystem.inspectDirectory(assets);
          else productNative.privateFilesystem.createDirectory(assets);
        } else mkdirSync(assets, { recursive: true });
      }
      const storage = new WorkspaceStorageService(dataDir, store.db, process.env, async (title, create = false, file = false) => {
        const selected = await dialog.showOpenDialog(win!, {
          title, properties: file ? ["openFile"] : create ? ["openDirectory", "createDirectory"] : ["openDirectory"],
          defaultPath: file ? assets : create
            ? maintenanceSelection?.outputParent ?? dataDir
            : title.includes("バックアップ") ? join(dataDir, "backups") : maintenanceSelection?.outputParent ?? dataDir,
        });
        assertPrivateOperationAuthority();
        return selected.canceled ? null : selected.filePaths[0];
      }, undefined, privatePersistence, productNative ? (selection, current) => {
        current();
        productNative.admitSelectedSource({kind: "backup", path: selection.directory,
          manifestPath: selection.manifestPath, manifestSha256: selection.manifestSha256, assertCurrent: current});
      } : undefined, nativeMaintenance);
      const syncGate = new WorkspaceSyncGate();
      const conflictRecovery = new ConflictRecoveryService(store,dirname(realpathSync(store.path)));
      const startupSync: WorkspaceSyncStartupResult = crashRecovery
        ? await withProductPrivateJournals(privateJournals, () => runStartupWorkspaceSyncDetailed(store, () => crashRecovery.read(), savedConnection.env,
            (bytes, purpose) => storage.admitSyncWrite(bytes, purpose), () => {
              if (savedConnection.saved) vault.markActivated(store.path, savedConnection.saved.revision);
            }))
        : {};
      const syncService: WorkspaceSyncService<WorkspaceSyncStatus> | undefined = startupSync.opened
        ? new WorkspaceSyncService<WorkspaceSyncStatus>(startupSync.opened, undefined, undefined, privateJournals, nativeTransfer)
        : startupSync.reconnect
          ? WorkspaceSyncService.reconnect<WorkspaceSyncStatus>(startupSync.reconnect, undefined, privateJournals, nativeTransfer)
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
      const activeScope = () => {
        const status = syncService?.status().workspace;
        const baseUrl = savedConnection.env.FOLIO_SYNC_URL;
        if (!status || !baseUrl) return null;
        const row = store.db.prepare("SELECT workspace_id,client_id,binding_id,server_epoch FROM workspace_sync_state WHERE singleton=1").get();
        return row ? sha256(canonicalJson({baseUrlHash: sha256(new URL(baseUrl).origin), workspaceId: row.workspace_id,
          clientId: row.client_id, bindingId: row.binding_id, serverEpoch: row.server_epoch})) : null;
      };
      const management = new SyncManagementControl({store, readOnly, vaultDirectory, vault, gate: syncGate, service: syncService,
        recovery: () => crashRecovery?.read() ?? {status: "blocked", generation: 0},
        intentClear: () => {
          const view = restartControl!.status();
          return new WorkspaceSyncIntentJournal(dirname(realpathSync(store.path)),store).read().status === "empty" &&
            (!view.available || (view.state === "idle" && !view.scheduled)) && !conflictDecisionControl!.hasReservation();
        },
        maintenance: new TransferMaintenanceService(dirname(realpathSync(store.path)), activeScope, undefined, privateJournals, nativeTransfer)});
      const syncMessage = savedConnection.held ? "保存した接続の資格情報を確認できず同期を保留しています。同期設定から確認してください。" : startupSync.message;
      const startupStatus = {...opened.status, ...(syncMessage ? {syncMessage} : {}),
        experimentalSharedUi: showSharedUi(process.env, savedConnection)};
      const workspaceBackups = storage.backups;
      let layoutBackupDone = false;
      const { protectValue: protectRichDocument, protectRequest: protectRichRequest } =
        createRichDocumentProtection(() => workspaceBackups.createAutomatic("before-rich-blocks"));
      protocol.handle("folio-asset", (req) => privateLifecycle.run(() => withPrivatePersistence(privatePersistence, () => withNativeTransfer(nativeTransfer, async () => {
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
        } catch (error) {
          privateLifecycle.observe(error);
          return new Response("Not found", { status: 404 });
        }
      }))));
      session.defaultSession.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const url = new URL(
        process.env.FOLIO_DEV_URL ||
          pathToFileURL(join(__dirname, "renderer/index.html")).toString(),
      ).href;
      const sharedCredentialProvider = new CredentialProvider({
        isAsyncEncryptionAvailable:()=>safeStorage.isAsyncEncryptionAvailable(),
        encryptStringAsync:(text)=>safeStorage.encryptStringAsync(text),
        decryptStringAsync:async(bytes)=>(await safeStorage.decryptStringAsync(Buffer.from(bytes))).result,
        ...(process.platform==="linux"?{getSelectedStorageBackend:()=>safeStorage.getSelectedStorageBackend()}:{})
      },process.platform);
      const sharedRuntime = new SharedRuntimeService(dataDir+"-shared-runtime", sharedCredentialProvider,{nativeBackup: productNative?.nativeBackup,copySources:ids=>readPrivateCopySources(store!,assets,ids,windowsPrivate?{file:windowsPrivate.privateFileIdentity,directory:windowsPrivate.assertPrivateDirectory}:undefined),copyCatalog:()=>readPrivateCopyCatalog(store!),...(windowsPrivate?{runtimeStoreOptions:(directory:string)=>({platformAdapter:windowsPrivate.runtimePlatform(directory)}),recoveryFilesystemProof:windowsRecovery}:{}),forbiddenRoots:[dataDir,userData],pickBackup:async()=>{if(!win||win.isDestroyed())throw new Error('UNAUTHORIZED_IPC_SENDER');const picked=await dialog.showSaveDialog(win,{title:'共有領域のバックアップを書き出す',defaultPath:join(maintenanceSelection?.outputParent??app.getPath("downloads"),'folio-shared-'+Date.now()+'.json'),filters:[{name:'Folio shared backup',extensions:['json']}]});assertPrivateOperationAuthority();if(picked.canceled||!picked.filePath)return null;if(nativeMaintenance&&productNative&&maintenanceSelection)admitNativeSaveParent(productNative,maintenanceSelection,picked.filePath,assertPrivateOperationAuthority,readOnlyMaintenanceDirectory);return picked.filePath;}});
      cleanups.push(() => sharedRuntime.close());
      ipcMain.handle("folio:shared",(event,input:unknown)=>privateLifecycle.run(() => withPrivatePersistence(privatePersistence, () => withNativeTransfer(nativeTransfer, async () => {
        const requestWindow=win;
        const generation = rendererGeneration;
        const authorized=()=>privateLifecycle.isUsable() && generation === rendererGeneration && !!requestWindow&&!requestWindow.isDestroyed()&&win===requestWindow&&event.sender===requestWindow.webContents&&event.senderFrame===requestWindow.webContents.mainFrame&&event.senderFrame.url===url;
        return withPrivateOperationAuthority(() => {requireCondition(authorized(), "unauthorized", 403);}, () => sharedRuntime.handle(input,authorized));
      }))));
      const privateRequestHandlers = createPrivateRequestHandlers<BrowserWindow>({
        lifecycle: privateLifecycle,
        syncGate,
        enterScope: (work) => withPrivatePersistence(privatePersistence, () => withNativeTransfer(nativeTransfer, work)),
        getRequestWindow: () => win,
        getRendererGeneration: () => rendererGeneration,
        getWorkspaceBinding: () => store,
        trustedUrl: url,
        dispatch: async (req, context) => {
        const requestWindow = context.requestWindow;
        const isAuthorized = context.isAuthorized;
        if (req.type === "recovery:list") return conflictRecovery.list(req.cursor);
        if (req.type === "recovery:status") return conflictRecovery.status(req.operationId);
        if (req.type === "recovery:export" || req.type === "recovery:restore") return syncGate.write(() => withPrivateOperationAuthority(() => {requireCondition(isAuthorized(), "unauthorized", 403);}, () => {
          if (!isAuthorized()) throw new Error("Unauthorized IPC sender");
          return conflictRecovery.run(req.target,req.type === "recovery:restore" ? "restore" : req.mode,async () => {
            const selected = await dialog.showOpenDialog(requestWindow,{title:"保全データの新規取り出し先",properties:["openDirectory","createDirectory"],defaultPath:maintenanceSelection?.outputParent});
            assertPrivateOperationAuthority();
            if (selected.canceled || !selected.filePaths[0]) return null;
            if (nativeMaintenance && productNative && maintenanceSelection)
              admitNativeSaveDirectory(productNative, maintenanceSelection, selected.filePaths[0], assertPrivateOperationAuthority, readOnlyMaintenanceDirectory);
            return selected.filePaths[0];
          },isAuthorized,req.operationId);
        }));
        if (req.type === "sync:status") return syncControl.status();
        if (req.type === "sync:connectionStatus") return management.status();
        if (req.type === "sync:retentionStatus") return management.retention();
        if (req.type === "sync:connectionConfigure") return management.configure(req.input);
        if (req.type === "sync:connectionDisable") return management.disable(req.requestId, req.expectedRevision);
        if (req.type === "sync:connectionResolve") return management.resolve(req.requestId);
        if (req.type === "sync:transferInventory") return management.inventory(req.cursor);
        if (req.type === "sync:transferPlan") return management.plan(req.entryId);
        if (req.type === "sync:transferRelease") return management.release(req.operationId);
        if (req.type === "sync:transferResolve") return management.resolveRelease(req.operationId);
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
          return withPrivateOperationAuthority(() => {requireCondition(isAuthorized(), "unauthorized", 403);}, () =>
            exportConflictAfterPicker({target, authorized: isAuthorized,
            candidate: (selected) => syncControl.conflictCandidate(selected),
            pick: async () => {
              const result = await dialog.showSaveDialog(requestWindow, {
                defaultPath: join(maintenanceSelection?.outputParent ?? app.getPath("downloads"), `folio-conflict-${req.side}.json`),
                filters: [{name: "Folio conflict checkpoint", extensions: ["json"]}],
              });
              assertPrivateOperationAuthority();
              return result.canceled ? null : result.filePath ?? null;
            },
            save: (path, candidate) => {
              assertPrivateOperationAuthority();
              if (nativeMaintenance && productNative && maintenanceSelection)
                admitNativeSaveParent(productNative, maintenanceSelection, path, assertPrivateOperationAuthority, readOnlyMaintenanceDirectory);
              return exportConflictCheckpoint(path, candidate, (out) => assertExternalOutput(dataDir, out), productNative?.privateFileV3Port ?? nativeExports?.privateFilePortV2);
            },
          }));
        }
        const handle = async () => {
        if (!isAuthorized()) throw new Error("Unauthorized IPC sender");
        const win = requestWindow;
        if (req.type === "startup:status") return startupStatus;
        if (readOnly) assertReadOnlyRequest(req);
        if (req.type === "desktop:capabilities")
          return createDesktopCapabilities({
            fileDialogs: dialog,
            attachmentStore: store,
            externalLinkOpener: shell,
            backupService: workspaceBackups,
            sharedCredentialProvider,
            privateCredentialVault: vault,
            nativeFileSystem: productNative?.privateFilesystem ?? null,
            hostLifecycle: app,
            readOnly,
            platform: process.platform,
          });
        const utility = storage.handleUtility(req, isAuthorized);
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
          const selected = await dialog.showOpenDialog(win, {title: "Folioの完全バックアップを選択", properties: ["openDirectory"], defaultPath: join(dataDir, "backups")});
          assertPrivateOperationAuthority();
          return selected.canceled ? null : workspaceBackups.choose(selected.filePaths[0]);
        }
        if (req.type === "workspaceBackup:restore") {
          return workspaceBackups.restoreAfterPicker(req.ticket, async () => {
            const selected = await dialog.showOpenDialog(win, {title: "復元先の親フォルダーを選択（新しいフォルダーを作成します）", properties: ["openDirectory", "createDirectory"], defaultPath: maintenanceSelection?.outputParent});
            assertPrivateOperationAuthority();
            return selected.canceled ? null : selected.filePaths[0];
          }, isAuthorized, () => {requireCondition(isAuthorized(), "unauthorized", 403); assertPrivateOperationAuthority();});
        }
        if (req.type === "workspaceBackup:open") {
          await context.openBackup(workspaceBackups, req.ticket, (directory, handoff, markStarted) =>
            launchRestoredWorkspace({
              directory, handoff, markStarted, spawn,
              parentEnv: process.env,
              executable: process.execPath,
              // When Electron starts dist/main.cjs directly, getAppPath() is
              // dist/, which has no package.json entry point. Relaunch this file.
              args: process.defaultApp ? [__filename] : [],
            }));
          return true;
        }
        if (req.type === "restoreVersion") {
          protectRichDocument(store.versions(req.id).find(v => v.id === req.versionId));
          if (!req.databasePageId && store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='record_memberships' AND type='table'").get() &&
              store.db.prepare("SELECT 1 FROM record_memberships WHERE page_id=?").get(req.id))
            throw new Error("履歴復元にはレコードの所属確認が必要です。");
        }
        if (req.type === "openExternal") {
          await shell.openExternal(req.url);
          return true;
        }
        if (isPrivateRecoveryRequest(req)) return handlePrivateRecoveryRequest(req, {
          readRecovery: () => context.readRecovery(crashRecovery!),
          writeRecovery: (expectedGeneration, snapshot) =>
            context.writeRecovery(crashRecovery!, expectedGeneration, snapshot),
          copyRecovery: (recoveryId, input) => createRecoveryCopy(store, recoveryId, input),
        });
        if (req.type === "pageOrder:preview" || req.type === "pageOrder:apply")
          return handlePageOrderRepair(store, req, () => storage.admitSnapshot());
        if (req.type === "property:preview") return previewPropertyOperation(store, req);
        if (req.type === "property:commit") return commitPropertyOperation(store, req.operation);
        if (req.type === "property:resolve") return resolvePropertyOperation(store, req.operation);
        if (req.type === "migration:preview") return previewLegacyMigration(store, req.databasePageId);
        if (req.type === "migration:commit") {
          if (productNative) {
            storage.admitSnapshot();
            for (const directory of [join(dataDir, "backups"), join(dataDir, "backups", "legacy-migration")]) {
              if (existsSync(directory)) productNative.privateFilesystem.inspectDirectory(directory);
              else productNative.privateFilesystem.createDirectory(directory);
            }
          }
          return commitLegacyMigration(store, req.operation, {
          ...privatePersistence,
          assetsPath: assets, snapshotRoot: join(dataDir, "backups", "legacy-migration"),
          beforeSnapshot: () => storage.admitSnapshot(),
        });
        }
        if (req.type === "migration:resolve") return resolveLegacyMigration(store, req.operation);
        if (req.type === "exportWorkspaceMarkdown") {
          const picked = await dialog.showOpenDialog(requestWindow, {title: "Markdown一括書き出し先", properties: ["openDirectory", "createDirectory"],
            defaultPath: maintenanceSelection?.outputParent});
          assertPrivateOperationAuthority();
          const parent = picked.filePaths[0];
          if (picked.canceled || !parent) return null;
          if (nativeMaintenance && productNative && maintenanceSelection)
            admitNativeSaveDirectory(productNative, maintenanceSelection, parent, assertPrivateOperationAuthority, readOnlyMaintenanceDirectory);
          const write = () => exportWorkspaceMarkdown(store, assets, parent);
          return nativeMaintenance ? nativeMaintenance.withScope({kind: "raw-rescue", parent}, assertPrivateOperationAuthority, write) : write();
        }
        if (req.type === "downloadAttachment") {
          const asset = resolveAsset(store.db, assets, req.url);
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(app.getPath("downloads"), basename(asset.name)),
          });
          assertPrivateOperationAuthority();
          if (result.canceled || !result.filePath) return null;
          assertExternalOutput(dataDir, result.filePath);
          copyFileSync(asset.path, result.filePath);
          return result.filePath;
        }
        if (req.type === "backup") {
          storage.admitSnapshot();
          return createOriginalWorkspaceCopy(store.db, dataDir, () => {
            assertPrivateOperationAuthority(); storage.admitSnapshot();
          }).directory;
        }
        if (req.type === "attachBytes")
          return attachBuffer(store.db, assets, req.name, req.mime, decodeAttachment(req.dataBase64),
            bytes => storage.admitAttachment(bytes), privatePersistence);
        if (req.type === "attach") {
          const result = await dialog.showOpenDialog(win, {
            properties: ["openFile"],
          });
          assertPrivateOperationAuthority();
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
          assertPrivateOperationAuthority();
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
            defaultPath: join(maintenanceSelection?.outputParent ?? app.getPath("downloads"), "folio-unsaved-changes.json"),
            filters: [{ name: "Folio unsaved changes", extensions: ["json"] }],
          });
          assertPrivateOperationAuthority();
          if (result.canceled || !result.filePath) return null;
          if (nativeMaintenance && productNative && maintenanceSelection)
            admitNativeSaveParent(productNative, maintenanceSelection, result.filePath, assertPrivateOperationAuthority, readOnlyMaintenanceDirectory);
          const saved = writePendingJournalFileV3(result.filePath, req.content, {
            ...(productNative ? {privateFilePortV3: productNative.privateFileV3Port} : {privateFilePortV2: nativeExports?.privateFilePortV2}),
            validate: parsePendingJournal,
            checkDestination: (path) => assertExternalOutput(dataDir, path),
          });
          return saved.path;
        }
        if (req.type === "exportRecovery") {
          parseRecovery(req.content);
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(maintenanceSelection?.outputParent ?? app.getPath("downloads"), "folio-unsaved-recovery.json"),
          });
          assertPrivateOperationAuthority();
          if (result.canceled || !result.filePath) return null;
          if (nativeMaintenance && productNative && maintenanceSelection) {
            admitNativeSaveParent(productNative, maintenanceSelection, result.filePath, assertPrivateOperationAuthority, readOnlyMaintenanceDirectory);
            // The raw32 recovery write reads the ambient persistence FS, so
            // the selected-parent capability must be installed for it.
            nativeMaintenance.withScope({kind: "raw-rescue", parent: dirname(result.filePath)}, assertPrivateOperationAuthority,
              () => writeRecoveryFile(result.filePath!, req.content, () => assertExternalOutput(dataDir, result.filePath!)));
          } else {
            writeRecoveryFile(result.filePath, req.content, () => assertExternalOutput(dataDir, result.filePath!));
          }
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
          assertPrivateOperationAuthority();
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
          assertPrivateOperationAuthority();
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
        return context.withStorageAction(req, handle);
        },
      });
      ipcMain.handle("folio:request", (event, input: unknown) => privateRequestHandlers.legacy(event, input));
      ipcMain.handle("folio:request:diagnostic-v1", (event, input: unknown) => privateRequestHandlers.diagnostic(event, input));
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
          if (details.isMainFrame && !details.isSameDocument) {rendererGeneration++; storage.resetTickets();}
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
      }));
    })
    .catch((e) => {
      if (restoredStartupHandoff && restoredStartupPending) {
        try {restoredStartupHandoff.retainFailure(e);} catch (retained) {e = retained;}
      }
      privateLifecycle.observe(e);
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
      closeStore: () => {privateLifecycle.assertUsable(); store?.close();},
    });
  });
}
