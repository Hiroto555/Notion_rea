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
} from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "../persistence/store";
import { seed } from "../persistence/seed";
import { attachFile, resolveAsset } from "../persistence/assets";
import { workspacePath, migrateWorkspace } from "../persistence/workspace";
import { requestSchema } from "../shared/types";
app.setName("Folio");
const userData = join(app.getPath("appData"), "Folio");
const dataDir = workspacePath(userData, process.env.FOLIO_DATA_DIR);
let startupError: unknown;
try {
  const profile = process.env.FOLIO_DATA_DIR ? dataDir : userData;
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
    store: Store;
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
          if (choice.response === 0) migrateWorkspace(legacy, dataDir);
          if (choice.response === 1) {
            const selected = await dialog.showOpenDialog({
              properties: ["openDirectory"],
            });
            if (selected.canceled) {
              app.quit();
              return;
            }
            migrateWorkspace(selected.filePaths[0], dataDir);
          }
        }
      }
      mkdirSync(dataDir, { recursive: true });
      store = new Store(join(dataDir, "workspace.sqlite"));
      seed(store);
      const assets = join(dataDir, "assets");
      mkdirSync(assets, { recursive: true });
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
        const req = requestSchema.parse(input);
        if (Buffer.byteLength(JSON.stringify(req)) > 32_000_000)
          throw new Error("リクエストが大きすぎます");
        if (req.type === "openExternal") {
          await shell.openExternal(req.url);
          return true;
        }
        if (req.type === "downloadAttachment") {
          const asset = resolveAsset(store.db, assets, req.url);
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(dataDir, basename(asset.name)),
          });
          if (result.canceled || !result.filePath) return null;
          copyFileSync(asset.path, result.filePath);
          return result.filePath;
        }
        if (req.type === "backup") {
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
          return attachFile(store.db, assets, file);
        }
        if (req.type === "recover") {
          const selected = await dialog.showOpenDialog(win, {
            properties: ["openFile"],
            filters: [{ name: "Folio recovery", extensions: ["json"] }],
          });
          if (selected.canceled) return null;
          const path = selected.filePaths[0];
          if (statSync(path).size > 30_000_000)
            throw new Error("復旧ファイルが大きすぎます");
          return store.recover(JSON.parse(readFileSync(path, "utf8")));
        }
        if (req.type === "export") {
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(
              dataDir,
              req.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") +
                "." +
                req.format,
            ),
          });
          if (result.canceled || !result.filePath) return null;
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
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-navigate", (e) => e.preventDefault());
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
      createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((e) => {
      dialog.showErrorBox("Folioを起動できません", String(e));
      app.quit();
    });
  app.on("window-all-closed", () => app.quit());
  app.on("will-quit", () => store?.close());
}
