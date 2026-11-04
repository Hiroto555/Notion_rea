import {
  expect,
  test,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../../src/persistence/store";
import { RecordRepository } from "../../../src/persistence/record-repository";
import { markRecordStoreVersion } from "../../../src/persistence/record-version";
import {
  emptyDatabase,
  type Doc,
  type Snapshot,
} from "../../../src/shared/types";

/**
 * W3 acceptance fixtures are entirely synthetic and always live below
 * output/r9-acceptance-*. No real workspace is read or written.
 *
 * The acceptance outcomes intentionally remain skipped until the integration
 * branch contains the frozen W3 files and a built Electron entry point.
 */
const W3_FROZEN_FILES = [
  "src/editor/callout.ts",
  "src/editor/simple-table.ts",
  "src/document-io/rich-block-html.ts",
] as const;

export function w3IntegratedBuildReady(): boolean {
  return (
    W3_FROZEN_FILES.every((file) => existsSync(resolve(file))) &&
    existsSync(resolve("dist/main.cjs"))
  );
}

/** Register the not-run gate for every W3 acceptance spec. */
export function requireIntegratedBuild(): void {
  test.beforeEach(() => {
    expect(
      w3IntegratedBuildReady(),
      "Build the integrated W3 candidate before acceptance",
    ).toBe(true);
  });
}

export const r9SimpleDoc = (text: string): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const textNode = (
  text: string,
  marks?: { type: string; attrs?: Record<string, unknown> }[],
): Doc => ({ type: "text", text, ...(marks ? { marks } : {}) });

const paragraph = (id: string, content: Doc[]): Doc => ({
  type: "paragraph",
  attrs: { id },
  content,
});

const listItem = (id: string, content: Doc[]): Doc => ({
  type: "listItem",
  attrs: { id },
  content,
});

const bulletList = (id: string, content: Doc[]): Doc => ({
  type: "bulletList",
  attrs: { id },
  content,
});

const tableRow = (id: string, content: Doc[]): Doc => ({
  type: "tableRow",
  attrs: { id },
  content,
});

const tableCell = (
  type: "tableCell" | "tableHeader",
  id: string,
  content: Doc[],
): Doc => ({
  type,
  attrs: { id, colspan: 1, rowspan: 1, colwidth: null },
  content,
});

/**
 * Rich semantic fixture: warning callout with a nested list, a 2x2 table with
 * multiline marked cells and Japanese text. It is stored verbatim as a v2
 * document so the acceptance test does not depend on editor creation paths.
 */
export function r9RichDoc(): Doc {
  return {
    type: "doc",
    schemaVersion: 2,
    content: [
      {
        type: "callout",
        attrs: { id: "rich-callout", tone: "warning" },
        content: [
          paragraph("rich-callout-p", [
            textNode("警告: 日本語の本文"),
            { type: "hardBreak" },
            textNode("太字の続き", [{ type: "bold" }]),
          ]),
          bulletList("rich-list-outer", [
            listItem("rich-li-1", [
              paragraph("rich-li-1-p", [textNode("外側項目")]),
              bulletList("rich-list-inner", [
                listItem("rich-li-1-1", [
                  paragraph("rich-li-1-1-p", [
                    textNode("入れ子項目", [{ type: "italic" }]),
                  ]),
                ]),
              ]),
            ]),
            listItem("rich-li-2", [
              paragraph("rich-li-2-p", [
                textNode("二番目の項目", [{ type: "bold" }]),
              ]),
            ]),
          ]),
        ],
      },
      {
        type: "table",
        attrs: { id: "rich-table" },
        content: [
          tableRow("rich-row-h", [
            tableCell("tableHeader", "rich-h1", [
              paragraph("rich-h1-p", [textNode("見出し甲")]),
            ]),
            tableCell("tableHeader", "rich-h2", [
              paragraph("rich-h2-p", [textNode("見出し乙")]),
            ]),
          ]),
          tableRow("rich-row-1", [
            tableCell("tableCell", "rich-c1", [
              paragraph("rich-c1-p1", [
                textNode("複数行セル", [{ type: "bold" }]),
              ]),
              paragraph("rich-c1-p2", [
                textNode("二行目の日本語", [{ type: "italic" }]),
              ]),
            ]),
            tableCell("tableCell", "rich-c2", [
              paragraph("rich-c2-p", [textNode("右セル")]),
            ]),
          ]),
        ],
      },
      paragraph("rich-tail", [textNode("末尾の日本語")]),
    ],
  };
}

/** A multi-cell table used for the HTML clipboard identity check. */
export function r9TableDoc(): Doc {
  return {
    type: "doc",
    schemaVersion: 2,
    content: [
      {
        type: "table",
        attrs: { id: "clip-table" },
        content: [
          tableRow("clip-row-h", [
            tableCell("tableHeader", "clip-h1", [
              paragraph("clip-h1-p", [textNode("見出し一")]),
            ]),
            tableCell("tableHeader", "clip-h2", [
              paragraph("clip-h2-p", [textNode("見出し二")]),
            ]),
          ]),
          tableRow("clip-row-1", [
            tableCell("tableCell", "clip-a", [
              paragraph("clip-a-p", [textNode("セルA1")]),
            ]),
            tableCell("tableCell", "clip-b", [
              paragraph("clip-b-p", [textNode("セルB1")]),
            ]),
          ]),
          tableRow("clip-row-2", [
            tableCell("tableCell", "clip-c", [
              paragraph("clip-c-p", [textNode("セルA2")]),
            ]),
            tableCell("tableCell", "clip-d", [
              paragraph("clip-d-p", [textNode("セルB2")]),
            ]),
          ]),
        ],
      },
      paragraph("clip-tail", [textNode("表コピー末尾")]),
    ],
  };
}

/** A deliberately unknown future document: root v3 plus an unknown node type. */
export function r9FutureDoc(): Doc {
  return {
    type: "doc",
    schemaVersion: 3,
    content: [
      {
        type: "futureBlock",
        attrs: { id: "future-block", payload: "未来のデータ" },
        content: [paragraph("future-p", [textNode("未知の未来ブロック")])],
      },
    ],
  };
}

const emptyFilter = (id: string) => ({
  kind: "group" as const,
  id,
  conjunction: "and" as const,
  conditions: [],
});

function rawPage(store: Store, id: string): Record<string, unknown> {
  const row = store.db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
    { data: string } | undefined;
  if (!row) throw new Error("R9 fixture page not found: " + id);
  return JSON.parse(row.data);
}

/** Plant an exact JSON shape without asking the current validator to accept it. */
function plantPage(store: Store, id: string, patch: Record<string, unknown>) {
  const page = rawPage(store, id);
  store.db
    .prepare("UPDATE pages SET data=? WHERE id=?")
    .run(JSON.stringify({ ...page, ...patch }), id);
}

export function r9Data(includeFuture = false) {
  mkdirSync(resolve("output"), { recursive: true });
  const root = mkdtempSync(resolve("output/r9-acceptance-"));
  const dataDir = join(root, "workspace");
  const filesDir = join(root, "files");
  mkdirSync(dataDir);
  mkdirSync(filesDir);
  const store = new Store(join(dataDir, "workspace.sqlite"));

  const home = store.create(null, "page", "R9 受入ホーム");
  store.update(home.id, home.revision, {
    doc: r9SimpleDoc("R9 home body"),
  });

  const rich = store.create(null, "page", "R9 マークダウン統合 日本語");
  store.update(rich.id, rich.revision, {
    doc: r9SimpleDoc("rich placeholder"),
  });
  plantPage(store, rich.id, { doc: r9RichDoc() });

  const table = store.create(null, "page", "R9 表コピー");
  store.update(table.id, table.revision, {
    doc: r9SimpleDoc("table placeholder"),
  });
  plantPage(store, table.id, { doc: r9TableDoc() });

  const future = store.create(null, "page", "R9 未来文書");
  store.update(future.id, future.revision, {
    doc: r9SimpleDoc("future placeholder"),
  });
  if (includeFuture)
    plantPage(store, future.id, {
      schemaVersion: 3,
      doc: r9FutureDoc(),
    });

  let owner = store.create(null, "database", "R9 受入データベース");
  const database = emptyDatabase();
  database.properties = [{ id: "note", name: "メモ", type: "text" }];
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
  const record = repository.create(owner.id, "R9 記録", {
    note: "受入レコード",
  });
  store.updateRecordPage(record.pageId, owner.id, record.revision, {
    doc: r9SimpleDoc("record placeholder"),
  });
  plantPage(store, record.pageId, { doc: r9RichDoc(), width: "standard" });

  store.handle({ type: "setting", key: "activePage", value: home.id });
  store.close();

  return {
    root,
    dataDir,
    filesDir,
    home,
    rich,
    table,
    future,
    owner,
    record,
    titles: {
      home: home.title,
      rich: rich.title,
      table: table.title,
      future: future.title,
      database: owner.title,
      record: record.title,
    },
  };
}
export type R9Data = ReturnType<typeof r9Data>;

export async function launchR9(data: R9Data) {
  const app = await electron.launch({
    args: [resolve("dist/main.cjs")],
    env: { ...process.env, FOLIO_DATA_DIR: data.dataDir },
  });
  const window = await app.firstWindow();
  await expect(window.locator(".page-title")).toBeVisible();
  // Let Editor setup, recovery checkpoints and launch normalization settle.
  await window.evaluate(
    () =>
      new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      ),
  );
  await r9Saved(window);
  return { app, window };
}

export async function r9Saved(window: Page) {
  await expect(window.locator(".save-state")).toHaveText("保存済み");
}

export async function r9Snapshot(window: Page): Promise<Snapshot> {
  return window.evaluate(() =>
    globalThis.window.folio.request<Snapshot>({ type: "load" }),
  );
}

export async function r9Page(window: Page, pageId: string) {
  const snapshot = await r9Snapshot(window);
  return snapshot.pages.find((candidate) => candidate.id === pageId);
}

export async function ensureSidebar(window: Page) {
  const toggle = window.getByRole("button", {
    name: "サイドバーを切り替え",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-pressed")) !== "true")
    await toggle.click();
}

export async function openPage(window: Page, title: string) {
  await ensureSidebar(window);
  const link = window.getByTitle(title, { exact: true }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(
    window.getByLabel("ページタイトル", { exact: true }),
  ).toHaveValue(title);
}

export async function openDatabase(window: Page, title: string) {
  await ensureSidebar(window);
  await window.getByTitle(title, { exact: true }).first().click();
  await expect(
    window.getByRole("region", { name: "レコード一覧", exact: true }),
  ).toBeVisible();
}

export async function openRecord(window: Page, title: string) {
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

/** Native file dialogs are replaced only inside the test-owned process. */
export async function installNativeDialogStub(app: ElectronApplication) {
  await app.evaluate(({ dialog }) => {
    const state = ((globalThis as any).__r9NativePaths = {
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
    Object.assign((globalThis as any).__r9NativePaths, {
      save: next.save ?? null,
      open: next.open ?? null,
    });
  }, paths);
}

/** Insert a slash-command block by its frozen visible name. */
export async function insertSlashBlock(window: Page, name: string) {
  const editor = window.locator(".folio-editor");
  await editor.click();
  await window.keyboard.press("End");
  await window.keyboard.press("Enter");
  await window.keyboard.type("/");
  const menu = window.getByRole("listbox", {
    name: "ブロックコマンド",
    exact: true,
  });
  await expect(menu).toBeVisible();
  const option = menu.getByRole("option").filter({ hasText: name }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(menu).toHaveCount(0);
}

type ControlSpec = string | RegExp;

/**
 * The frozen RichBlockControls contract supplies accessible buttons. Japanese
 * labels are primary here; English fallbacks keep the assertions readable if
 * the integration exposes the same contract with localized alternates.
 */
export const TONE_LABELS = {
  note: [/メモ/, /ノート/, /note/i],
  tip: [/ヒント/, /tip/i],
  warning: ["注意", /警告/, /warning/i],
} satisfies Record<"note" | "tip" | "warning", ControlSpec[]>;

export const TABLE_CONTROLS = {
  addRow: [/行を追加/, /add row/i],
  deleteRow: [/行を削除/, /delete row/i],
  addColumn: [/列を追加/, /add column/i],
  deleteColumn: [/列を削除/, /delete column/i],
  toggleHeader: [
    "見出し行",
    /ヘッダー.*(切|トグル)/,
    /先頭行.*ヘッダー/,
    /ヘッダー行/,
    /toggle.*header/i,
  ],
  deleteTable: [/表を削除/, /delete table/i],
} satisfies Record<string, ControlSpec[]>;

export async function richControl(
  window: Page,
  specs: ControlSpec[],
): Promise<Locator> {
  for (const spec of specs) {
    const candidate =
      typeof spec === "string"
        ? window.getByRole("button", { name: spec, exact: true })
        : window.getByRole("button", { name: spec });
    const visible = candidate.filter({ visible: true }).first();
    try {
      await expect(visible).toBeVisible({ timeout: 3000 });
      return visible;
    } catch {
      // Try the next frozen-label alternative.
    }
  }
  throw new Error(
    "Rich block control not found: " + specs.map(String).join(", "),
  );
}

export async function chooseCalloutTone(
  window: Page,
  tone: "note" | "tip" | "warning",
) {
  const button = await richControl(window, TONE_LABELS[tone]);
  await button.click();
}

export function nodesOfType(node: unknown, type: string): any[] {
  const found: any[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.type === type) found.push(value);
    for (const child of value.content ?? []) visit(child);
  };
  visit(node);
  return found;
}

export function collectIds(node: unknown): string[] {
  const ids: string[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.attrs?.id === "string" && value.attrs.id)
      ids.push(value.attrs.id);
    for (const child of value.content ?? []) visit(child);
  };
  visit(node);
  return ids;
}

export function collectMarkTypes(node: unknown): string[] {
  const marks = new Set<string>();
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    for (const mark of value.marks ?? [])
      if (typeof mark?.type === "string") marks.add(mark.type);
    for (const child of value.content ?? []) visit(child);
  };
  visit(node);
  return [...marks];
}

export function readRawPage(dataDir: string, pageId: string): string | null {
  const db = new DatabaseSync(join(dataDir, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db.prepare("SELECT data FROM pages WHERE id=?").get(pageId) as
      { data: string } | undefined;
    return row?.data ?? null;
  } finally {
    db.close();
  }
}

export function readExportedMarkdown(path: string): string {
  return readFileSync(path, "utf8");
}

export async function disposeR9(data: R9Data, app?: ElectronApplication) {
  const child = app?.process();
  if (child && child.exitCode === null && child.signalCode === null)
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGKILL");
    });
  rmSync(data.root, { recursive: true, force: true });
}
