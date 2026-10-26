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
} from "node:fs";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Store } from "../persistence/store";
import { seed } from "../persistence/seed";
import { requestSchema } from "../shared/types";
const dataDir = resolve(
  process.env.FOLIO_DATA_DIR ||
    (app.isPackaged
      ? join(dirname(process.execPath), "../../../..", ".folio-data")
      : join(app.getAppPath(), ".folio-data")),
);
mkdirSync(dataDir, { recursive: true });
app.setPath("userData", dataDir);
app.setPath("sessionData", join(dataDir, "session"));
app.setName("Folio");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "folio-asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
if (!app.requestSingleInstanceLock()) {
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
    .then(() => {
      store = new Store(join(dataDir, "workspace.sqlite"));
      seed(store);
      const assets = join(dataDir, "assets");
      mkdirSync(assets, { recursive: true });
      protocol.handle("folio-asset", (req) => {
        const u = new URL(req.url);
        const id = u.hostname;
        if (!/^[a-f0-9-]{36}\.(png|jpg|jpeg|gif|webp)$/.test(id))
          return new Response("Not found", { status: 404 });
        return net.fetch(pathToFileURL(join(assets, id)).toString());
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
          const id = new URL(req.url).hostname;
          const result = await dialog.showSaveDialog(win, {
            defaultPath: join(dataDir, id),
          });
          if (result.canceled || !result.filePath) return null;
          copyFileSync(join(assets, id), result.filePath);
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
          if (statSync(file).size > 20_000_000)
            throw new Error("添付の上限は20MBです");
          const extension = extname(file).toLowerCase(),
            id = randomUUID() + extension;
          copyFileSync(file, join(assets, id));
          return {
            name: basename(file),
            url: "folio-asset://" + id,
            image: [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(
              extension,
            ),
          };
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
