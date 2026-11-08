import {
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixtureRoot } from "../fixture-isolation";
import { killFixture, launchFixture } from "../recovery-ci-runtime";
import { Store } from "../../../src/persistence/store";
import { RecordRepository } from "../../../src/persistence/record-repository";
import { markRecordStoreVersion } from "../../../src/persistence/record-version";
import { attachFile } from "../../../src/persistence/assets";
import {
  emptyDatabase,
  type DatabaseProjection,
  type Doc,
  type Snapshot,
} from "../../../src/shared/types";

/**
 * Round 8 acceptance data is purely synthetic and always lives in a fresh
 * directory below output/. No helper reads or writes a real workspace.
 */
export const r8Paragraph = (text: string): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const r8Link = (text: string, targetId: string) => ({
  type: "text",
  text,
  marks: [{ type: "link", attrs: { href: "folio-page://" + targetId } }],
});

/** A short excerpt around a Folio page link, so backlink context is exact. */
export const r8ContextDoc = (
  before: string,
  linkText: string,
  after: string,
  targetId: string,
): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: before },
        r8Link(linkText, targetId),
        { type: "text", text: after },
      ],
    },
  ],
});

const emptyFilter = (id: string) => ({
  kind: "group" as const,
  id,
  conjunction: "and" as const,
  conditions: [],
});

/** Page.width is optional in W2; raw storage keeps this fixture independent of
 * the parent-owned TypeScript field while still seeding the real contract. */
function seedWidth(store: Store, id: string, width: "standard" | "wide") {
  const row = store.db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
    { data: string } | undefined;
  if (!row) throw new Error("R8 fixture page not found: " + id);
  const page = JSON.parse(row.data);
  store.db
    .prepare("UPDATE pages SET data=? WHERE id=?")
    .run(JSON.stringify({ ...page, width }), id);
}

/** Platform-aware primary modifier for the real Electron keyboard. */
export const r8Mod = process.platform === "darwin" ? "Meta" : "Control";

export function r8Data() {
  const root = fixtureRoot("r8-acceptance-");
  const dataDir = join(root, "workspace");
  mkdirSync(dataDir);
  const assetsDir = join(dataDir, "assets");
  mkdirSync(assetsDir);
  const inputsDir = join(root, "inputs");
  mkdirSync(inputsDir);
  const store = new Store(join(dataDir, "workspace.sqlite"));

  const home = store.create(null, "page", "R8 Home");
  store.update(home.id, home.revision, {
    doc: r8Paragraph("R8 home body"),
  });

  const target = store.create(null, "page", "R8 Backlink Target");
  store.update(target.id, target.revision, {
    doc: r8Paragraph("R8 target body"),
  });

  const alpha = store.create(null, "page", "R8 Backlink Alpha");
  store.update(alpha.id, alpha.revision, {
    doc: r8ContextDoc(
      "Alpha文脈：",
      "共有リンク甲",
      " Alpha周辺",
      target.id,
    ),
  });
  const beta = store.create(null, "page", "R8 Backlink Beta");
  store.update(beta.id, beta.revision, {
    doc: r8ContextDoc("Beta文脈：", "共有リンク乙", " Beta周辺", target.id),
  });
  const gamma = store.create(null, "page", "R8 Backlink Gamma");
  store.update(gamma.id, gamma.revision, {
    doc: r8ContextDoc("Gamma文脈：", "共有リンク丙", " Gamma周辺", target.id),
  });

  let owner = store.create(null, "database", "R8 Tasks");
  const database = emptyDatabase();
  database.properties = [
    { id: "note", name: "メモ", type: "text" },
    { id: "estimate", name: "見積", type: "number" },
  ];
  database.views = [
    {
      id: "view-table",
      name: "テーブル",
      type: "table",
      filterText: "",
      filter: emptyFilter("filter-table"),
      sorts: [],
      groupBy: null,
    },
  ];
  database.activeViewId = "view-table";
  database.view = "table";
  database.filter = "";
  database.sort = "";
  owner = store.update(owner.id, owner.revision, { database });

  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
    markRecordStoreVersion(store.db);
  });
  const alphaRecord = repository.create(owner.id, "R8 Alpha Record", {
    note: "alpha record note",
    estimate: 7,
  });
  store.updateRecordPage(alphaRecord.pageId, owner.id, alphaRecord.revision, {
    doc: r8Paragraph("R8 Alpha record body"),
  });
  const betaRecord = repository.create(owner.id, "R8 Beta Record", {
    note: "beta record note",
    estimate: 2,
  });
  store.updateRecordPage(betaRecord.pageId, owner.id, betaRecord.revision, {
    doc: r8Paragraph("R8 Beta record body"),
  });

  // Ordinary pages default to standard; a database defaults to wide. Store the
  // explicit choices so restart checks prove the field survives rather than a
  // default happening to look right.
  seedWidth(store, home.id, "standard");
  seedWidth(store, owner.id, "wide");

  const assetSource = join(inputsDir, "r8-asset.txt");
  writeFileSync(assetSource, "R8 attachment bytes that must survive backup\n");
  const asset = attachFile(store.db, assetsDir, assetSource);
  const currentHome = store.get(home.id);
  store.update(home.id, currentHome.revision, {
    doc: {
      type: "doc",
      schemaVersion: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "R8 home body" }],
        },
        { type: "image", attrs: { src: asset.url, alt: "R8 asset" } },
      ],
    },
  });

  store.handle({ type: "setting", key: "activePage", value: home.id });
  store.close();

  return {
    root,
    dataDir,
    assetsDir,
    inputsDir,
    backupTarget: join(root, "backup-archive"),
    restoreTarget: join(root, "restored-workspace"),
    home,
    target,
    sources: { alpha, beta, gamma },
    owner,
    records: { alpha: alphaRecord, beta: betaRecord },
    asset,
  };
}
export type R8Data = ReturnType<typeof r8Data>;

export async function launchR8(data: R8Data) {
  const app = await launchFixture(data.dataDir);
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".page-title")).toBeVisible();
    // Let Editor setup, recovery checkpoints and any launch-time normalization
    // settle before capturing a baseline or injecting test hooks.
    await window.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await r8Saved(window);
    return { app, window };
  } catch (error) {
    await killFixture(app);
    throw error;
  }
}

export async function r8Saved(window: Page) {
  await expect(window.locator(".save-state")).toHaveText("保存済み");
}

export async function r8Snapshot(window: Page): Promise<Snapshot> {
  return window.evaluate(() =>
    globalThis.window.folio.request<Snapshot>({ type: "load" }),
  );
}

export async function r8PageWidth(window: Page, pageId: string) {
  const snapshot = await r8Snapshot(window);
  const page = snapshot.pages.find((candidate) => candidate.id === pageId);
  return (page as (typeof snapshot.pages)[number] & { width?: string })
    ?.width;
}

export async function r8Database(
  window: Page,
  databasePageId: string,
): Promise<DatabaseProjection> {
  return window.evaluate(
    (id) =>
      globalThis.window.folio.request<DatabaseProjection>({
        type: "database:load",
        databasePageId: id,
      }),
    databasePageId,
  );
}

async function ensureSidebar(window: Page) {
  const toggle = window.getByRole("button", {
    name: "サイドバーを切り替え",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-pressed")) !== "true")
    await toggle.click();
}

export async function openR8Page(window: Page, title: string) {
  await ensureSidebar(window);
  await window.getByTitle(title, { exact: true }).first().click();
  await expect(window.getByLabel("ページタイトル", { exact: true })).toHaveValue(
    title,
  );
}

export async function openR8Database(window: Page, title = "R8 Tasks") {
  await ensureSidebar(window);
  await window.getByTitle(title, { exact: true }).first().click();
  await expect(
    window.getByRole("region", { name: "レコード一覧", exact: true }),
  ).toBeVisible();
}

export async function openR8Record(window: Page, title = "R8 Alpha Record") {
  await window
    .getByRole("button", { name: `開く ${title}`, exact: true })
    .click();
  await expect(
    window.getByLabel("レコードのタイトル", { exact: true }),
  ).toHaveValue(title);
  await expect(window.locator(".r3-record-page .folio-editor")).toBeVisible();
}

export async function openPageMenu(window: Page) {
  const trigger = window.getByRole("button", {
    name: "ページメニュー",
    exact: true,
  });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

export async function openBackupSurface(window: Page) {
  await openPageMenu(window);
  await window
    .getByRole("button", { name: "バックアップと復元", exact: true })
    .click();
}

/** The modal may still be rendering the result of its real IPC operation. */
export async function backupAction(window: Page, name: string) {
  const action = window.getByRole("button", { name, exact: true });
  const dialog = window.getByRole("dialog", {name: "バックアップと復元", exact: true});
  if (!(await dialog.isVisible()))
    await openBackupSurface(window);
  await expect(action).toBeVisible();
  return action;
}

/** The inspector is the existing contextual backlink surface. */
export const r8Inspector = (window: Page) =>
  window.getByRole("complementary", {
    name: "ページの情報",
    exact: true,
  });

export async function openR8Inspector(window: Page) {
  const toggle = window.getByRole("button", {
    name: "ページ情報",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-pressed")) !== "true")
    await toggle.click();
  const inspector = r8Inspector(window);
  await expect(inspector).toBeVisible();
  return inspector;
}

export function backlinkEntry(inspector: Locator, title: string) {
  return inspector.locator("button, a").filter({ hasText: title }).first();
}

/** Hide non-document chrome so standard/wide measurements are unambiguous. */
export async function maximizeDocumentArea(window: Page) {
  const sidebar = window.getByRole("button", {
    name: "サイドバーを切り替え",
    exact: true,
  });
  if ((await sidebar.getAttribute("aria-pressed")) === "true")
    await sidebar.click();
  const inspector = window.getByRole("button", {
    name: "ページ情報",
    exact: true,
  });
  if ((await inspector.getAttribute("aria-pressed")) === "true")
    await inspector.click();
}

export async function contentWidth(window: Page) {
  return window
    .locator(".document-content")
    .first()
    .evaluate((element) => element.getBoundingClientRect().width);
}

const visible = async (locator: Locator) =>
  (await locator.filter({ visible: true }).count()) > 0;

async function ensureWidthControl(window: Page) {
  const label = window.getByText("ページの幅", { exact: true });
  const select = window.getByLabel("ページの幅", { exact: true });
  if ((await visible(label)) || (await visible(select))) return;
  await openPageMenu(window);
  if ((await visible(label)) || (await visible(select))) return;
  await openR8Inspector(window);
}

export async function setPageWidth(
  window: Page,
  width: "標準" | "ワイド",
) {
  await ensureWidthControl(window);
  const select = window
    .getByLabel("ページの幅", { exact: true })
    .filter({ visible: true })
    .first();
  if (await select.count()) {
    if ((await select.evaluate((element) => element.tagName)) === "SELECT") {
      await select.selectOption({ label: width });
      return;
    }
  }

  const group = window
    .getByRole("group", { name: "ページの幅", exact: true })
    .filter({ visible: true })
    .first();
  if (await group.count()) {
    const radio = group
      .getByRole("radio", { name: width, exact: true })
      .filter({ visible: true })
      .first();
    if (await radio.count()) {
      await radio.check();
      return;
    }
    const button = group
      .getByRole("button", { name: width, exact: true })
      .filter({ visible: true })
      .first();
    if (await button.count()) {
      await button.click();
      return;
    }
  }

  const radio = window
    .getByRole("radio", { name: width, exact: true })
    .filter({ visible: true })
    .first();
  if (await radio.count()) {
    await radio.check();
    return;
  }
  const button = window
    .getByRole("button", { name: width, exact: true })
    .filter({ visible: true })
    .first();
  if (await button.count()) {
    await button.click();
    return;
  }
  const option = window
    .getByRole("option", { name: width, exact: true })
    .filter({ visible: true })
    .first();
  if (await option.count()) {
    await option.click();
    return;
  }
  throw new Error("ページの幅 control did not expose 標準/ワイド");
}

export async function pageWidthState(window: Page) {
  await ensureWidthControl(window);
  const select = window
    .getByLabel("ページの幅", { exact: true })
    .filter({ visible: true })
    .first();
  if (await select.count()) {
    if ((await select.evaluate((element) => element.tagName)) === "SELECT")
      return select.evaluate((element) => {
        const option = (element as HTMLSelectElement).selectedOptions[0];
        return option?.textContent?.trim() || option?.value || null;
      });
  }
  for (const width of ["標準", "ワイド"] as const) {
    const radio = window
      .getByRole("radio", { name: width, exact: true })
      .filter({ visible: true })
      .first();
    if ((await radio.count()) && (await radio.isChecked())) return width;
    const button = window
      .getByRole("button", { name: width, exact: true })
      .filter({ visible: true })
      .first();
    if (await button.count()) {
      const pressed = await button.getAttribute("aria-pressed");
      const checked = await button.getAttribute("aria-checked");
      if (pressed === "true" || checked === "true") return width;
    }
  }
  return null;
}

/** Native file/folder dialogs are replaced only inside the test-owned process. */
export async function installNativeDialogStub(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    const state = ((globalThis as any).__r8NativePaths = {
      save: null as string | null,
      open: null as string | null,
    });
    dialog.showSaveDialog = (async () => ({
      canceled: state.save === null,
      filePath: state.save ?? undefined,
    })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({
      canceled: state.open === null,
      filePaths: state.open ? [state.open] : [],
    })) as typeof dialog.showOpenDialog;
  });
}

export async function setNativePaths(
  app: ElectronApplication,
  paths: { save?: string | null; open?: string | null },
) {
  await app.evaluate((_electron, next) => {
    Object.assign((globalThis as any).__r8NativePaths, {
      save: next.save ?? null,
      open: next.open ?? null,
    });
  }, paths);
}

type BackupCall = {
  type: string;
  request: any;
  result?: any;
  error?: string;
};

/** Records the real W2 request results without replacing the handler. */
export async function installBackupRecorder(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as any;
    const original = ipc._invokeHandlers.get("folio:request");
    const calls: BackupCall[] = ((globalThis as any).__r8BackupCalls = []);
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, request: any) => {
      const backupRequest =
        typeof request?.type === "string" && /backup/i.test(request.type);
      const copy = (value: unknown) => {
        try {
          return structuredClone(value);
        } catch {
          return value;
        }
      };
      try {
        const result = await original(event, request);
        if (backupRequest)
          calls.push({
            type: request.type,
            request: copy(request),
            result: copy(result),
          });
        return result;
      } catch (error) {
        if (backupRequest)
          calls.push({
            type: request.type,
            request: copy(request),
            error: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    });
  });
}

export async function readBackupCalls(app: ElectronApplication) {
  return app.evaluate(
    () => ((globalThis as any).__r8BackupCalls ?? []) as BackupCall[],
  );
}

export async function findLatestBackupCall(
  app: ElectronApplication,
  action: string,
): Promise<BackupCall | undefined> {
  const calls = await readBackupCalls(app);
  const pattern = new RegExp(`(?:^|[:/])${action}$`, "i");
  return [...calls].reverse().find((call) => pattern.test(call.type));
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function walkFiles(
  directory: string,
  accept: (path: string) => boolean = () => true,
): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path, accept));
    else if (entry.isFile() && accept(path)) files.push(path);
  }
  return files;
}

function walkDirectories(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const result = [directory];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      result.push(...walkDirectories(join(directory, entry.name)));
  }
  return result;
}

export function assetHashes(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of walkFiles(directory)) {
    const key = relative(directory, file).split(sep).join("/");
    result[key] = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
  }
  return result;
}

type BackupManifest = {
  format?: string;
  version?: number;
  inventory?: { pages?: number; assets?: number };
  database?: { path?: string };
  assets?: unknown[];
};

export type FoundBackup = {
  root: string;
  manifestPath: string;
  manifest: BackupManifest;
  databasePath: string;
};

function readBackupManifest(root: string): FoundBackup | null {
  for (const file of walkFiles(root, (path) => path.endsWith(".json"))) {
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (
      manifest?.format !== "folio-workspace-backup" ||
      manifest.version !== 1
    )
      continue;
    const backupRoot = dirname(file);
    const databasePath = manifest.database?.path
      ? resolve(backupRoot, manifest.database.path)
      : join(backupRoot, "workspace.sqlite");
    if (!existsSync(databasePath)) continue;
    return {
      root: backupRoot,
      manifestPath: file,
      manifest,
      databasePath,
    };
  }
  return null;
}

export function findBackupManifests(root: string): FoundBackup[] {
  const manifests: FoundBackup[] = [];
  for (const directory of walkDirectories(root)) {
    const found = readBackupManifest(directory);
    if (found) manifests.push(found);
  }
  return manifests;
}

export async function waitForNewBackup(
  root: string,
  existing: Set<string>,
  timeout = 20000,
): Promise<FoundBackup> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const fresh = findBackupManifests(root).find(
      (candidate) => !existing.has(candidate.root),
    );
    if (fresh) return fresh;
    await sleep(100);
  }
  throw new Error("verified workspace backup folder did not appear");
}

function isWithin(path: string, parent: string) {
  const child = resolve(path);
  const base = resolve(parent);
  return child === base || child.startsWith(base + sep);
}

export function findWorkspaceRoots(root: string): string[] {
  return walkDirectories(root).filter((directory) =>
    existsSync(join(directory, "workspace.sqlite")),
  );
}

function findRestoredWorkspace(path: string) {
  if (!existsSync(path)) return null;
  if (existsSync(join(path, "workspace.sqlite"))) return path;
  return (
    walkDirectories(path).find((directory) =>
      existsSync(join(directory, "workspace.sqlite")),
    ) ?? null
  );
}

export type WorkspaceState = {
  pages: Record<string, unknown>;
  settings: Record<string, string>;
  assets: Record<string, string>;
};

export function workspaceState(directory: string): WorkspaceState {
  const db = new DatabaseSync(join(directory, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    const pages = Object.fromEntries(
      (
        db.prepare("SELECT id,data FROM pages ORDER BY id").all() as {
          id: string;
          data: string;
        }[]
      ).map((row) => [row.id, JSON.parse(row.data)]),
    );
    const settings = Object.fromEntries(
      (
        db.prepare("SELECT key,value FROM settings ORDER BY key").all() as {
          key: string;
          value: string;
        }[]
      ).map((row) => [row.key, row.value]),
    );
    return { pages, settings, assets: assetHashes(join(directory, "assets")) };
  } finally {
    db.close();
  }
}

export async function waitForRestoredWorkspace(
  app: ElectronApplication,
  options: {
    root: string;
    sourceDir: string;
    backupDir: string;
    target: string;
    before: Set<string>;
    timeout?: number;
  },
) {
  const deadline = Date.now() + (options.timeout ?? 20000);
  while (Date.now() < deadline) {
    const call = await findLatestBackupCall(app, "restore");
    const resultDirectory = call?.result?.directory;
    if (typeof resultDirectory === "string") {
      const found = findRestoredWorkspace(resultDirectory);
      if (found) return found;
    }
    const declaredTarget = findRestoredWorkspace(options.target);
    if (declaredTarget) return declaredTarget;
    const fresh = findWorkspaceRoots(options.root).find(
      (candidate) =>
        !options.before.has(candidate) &&
        !isWithin(candidate, options.sourceDir) &&
        !isWithin(candidate, options.backupDir),
    );
    if (fresh) return fresh;
    await sleep(100);
  }
  throw new Error("restored workspace did not appear");
}

/** Intercept only the real child-process spawn boundary in this test-owned
 * main process. No production-only global hook or original-app quit. */
export async function installRestoredLaunchHook(app: ElectronApplication) {
  await app.evaluate(async () => {
    const childProcess = process.getBuiltinModule("child_process");
    const {EventEmitter} = process.getBuiltinModule("events");
    const state: unknown[] = ((globalThis as any).__r8LaunchCalls = []);
    childProcess.spawn = ((executable: string, args: string[], options: any) => {
      state.push({directory: options.env.FOLIO_DATA_DIR, executable, args});
      const child: any = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => child.emit("spawn")); return child;
    }) as typeof childProcess.spawn;
  });
}

export async function readRestoredLaunchCalls(app: ElectronApplication) {
  return app.evaluate(
    () => ((globalThis as any).__r8LaunchCalls ?? []) as unknown[],
  );
}

export function launchTarget(call: unknown): string | null {
  if (typeof call === "string") return call;
  if (!call || typeof call !== "object") return null;
  const value = call as Record<string, any>;
  for (const key of ["directory", "target", "path", "openPath"])
    if (typeof value[key] === "string") return value[key];
  const relaunch = value.relaunch;
  if (relaunch && typeof relaunch === "object") {
    for (const key of ["args", "execPath"])
      if (typeof relaunch[key] === "string") return relaunch[key];
    if (Array.isArray(relaunch.args)) {
      const path = [...relaunch.args]
        .reverse()
        .find((argument) => typeof argument === "string");
      if (path) return path;
    }
  }
  return null;
}

export async function disposeR8(
  data: R8Data,
  app?: ElectronApplication,
) {
  await killFixture(app);
  rmSync(data.root, { recursive: true, force: true });
}
