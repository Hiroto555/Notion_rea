import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Store } from "../src/persistence/store";
import { attachFile } from "../src/persistence/assets";
import { WorkspaceLimitSettings } from "../src/persistence/workspace-limit-settings";
import { seedDemo } from "./r7-demo-seed";
import type {
  DatabaseOperation,
  DatabaseOperationResult,
} from "../src/shared/database-operation";
import type { SaveOperation, SaveResult } from "../src/shared/save-contract";
import type { ManagedGrowthLimits } from "../src/shared/storage-overview";
import type {
  DatabaseView,
  Doc,
  Page,
  Property,
} from "../src/shared/types";

export type MacTrialManifest = Readonly<{
  schema: "folio.mac-trial-fixture.v1";
  workspaceDirectory: string;
  databaseFile: string;
  activePage: string;
  database: Readonly<{
    id: string;
    title: string;
    settings: Page["database"];
    properties: Property[];
    views: Array<Pick<DatabaseView, "id" | "name" | "type">>;
  }>;
  pages: ReadonlyArray<
    Readonly<{
      id: string;
      title: string;
      parentId: string | null;
      doc: Doc;
    }>
  >;
  records: ReadonlyArray<
    Readonly<{
      id: string;
      title: string;
      values: Record<string, string | number | boolean>;
      doc: Doc;
    }>
  >;
  assets: ReadonlyArray<
    Readonly<{
      id: string;
      url: string;
      name: string;
      mime: string;
      bytes: number;
      sha256: string;
      storagePath: string;
    }>
  >;
  limits: Readonly<{
    kind: "trial";
    note: string;
    revision: string | null;
    configured: ManagedGrowthLimits;
    effective: ManagedGrowthLimits;
  }>;
  expected: Readonly<{
    totalPages: number;
    ordinaryPages: number;
    databases: number;
    records: number;
    assets: number;
    emptyParagraphs: number;
    internalLinks: number;
  }>;
  operations: ReadonlyArray<
    Readonly<{
      type: "database:commit" | "save:commit";
      operationId: string;
      seq: number;
      status: "applied";
    }>
  >;
}>;

const TRIAL_LIMITS: ManagedGrowthLimits = {
  maxDatabaseBytes: 268435456,
  maxAssetBytes: 268435456,
  maxBackupBytes: 1073741824,
  maxReceiptRows: 20000,
};

const LIMITS_NOTE =
  "Trial settings for the Folio Mac single-machine limited trial only. " +
  "These are per-workspace trial caps, not total/global limits and not " +
  "long-term guarantees.";

const SYNTHETIC_TEXT =
  "Folio Mac 単機トライアル用の合成テキスト添付です。\n" +
  "このファイルは UTF-8 で保存され、添付登録の検証に使われます。\n" +
  "ユーザーの実データは一切含まれていません。\n";

const text = (value: string, marks?: Doc["marks"]): Doc => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (id: string, ...content: Doc[]): Doc => ({
  type: "paragraph",
  attrs: { id },
  content,
});
const heading = (id: string, level: number, value: string): Doc => ({
  type: "heading",
  attrs: { id, level },
  content: [text(value)],
});
const pageLink = (pageId: string): Doc["marks"] => [
  { type: "link", attrs: { href: "folio-page://" + pageId } },
];
const doc = (...content: Doc[]): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content,
});

type ExtraRecord = {
  slug: string;
  title: string;
  values: Record<string, string | number | boolean>;
  body: string;
};

const EXTRA_RECORDS: ExtraRecord[] = [
  {
    slug: "startup",
    title: "起動と初期表示を確認する",
    values: {
      note: "初回起動時の描画と一覧を確認",
      estimate: 2,
      status: "進行中",
      due: "2026-11-16",
      done: false,
    },
    body: "起動直後のページ一覧と本文表示を確認するための合成記録です。",
  },
  {
    slug: "page-create",
    title: "ページ作成と保存を試す",
    values: {
      note: "新規ページの保存を確認",
      estimate: 1,
      status: "完了",
      due: "2026-11-15",
      done: true,
    },
    body: "通常ページを作成し、保存後の再読み込みを確認します。",
  },
  {
    slug: "hierarchy",
    title: "入れ子構造を確認する",
    values: {
      note: "三階層の親子関係",
      estimate: 2,
      status: "進行中",
      due: "2026-11-18",
      done: false,
    },
    body: "親ページの下に子ページを作り、階層表示を確かめます。",
  },
  {
    slug: "links",
    title: "内部リンクをたどる",
    values: {
      note: "folio-page リンクの遷移",
      estimate: 1,
      status: "未着手",
      due: "2026-11-19",
      done: false,
    },
    body: "本文中の内部リンクから対象ページへ移動できるかを見ます。",
  },
  {
    slug: "record-values",
    title: "レコード値の型を確認する",
    values: {
      note: "五種類のプロパティ",
      estimate: 3,
      status: "進行中",
      due: "2026-11-20",
      done: false,
    },
    body: "文字・数値・選択・日付・チェックの各値が保存されるかを確認します。",
  },
  {
    slug: "views",
    title: "四つのビューを切り替える",
    values: {
      note: "表・ボード・カレンダー・ギャラリー",
      estimate: 2,
      status: "未着手",
      due: "2026-11-21",
      done: false,
    },
    body: "登録済みの四ビューがそれぞれ開けることを確認します。",
  },
  {
    slug: "attach-image",
    title: "画像添付を確認する",
    values: {
      note: "PNG の登録と表示",
      estimate: 1,
      status: "完了",
      due: "2026-11-14",
      done: true,
    },
    body: "fixture 画像が assets に登録され本文から参照できることを見ます。",
  },
  {
    slug: "attach-text",
    title: "テキスト添付を確認する",
    values: {
      note: "UTF-8 テキストの登録",
      estimate: 1,
      status: "完了",
      due: "2026-11-14",
      done: true,
    },
    body: "合成テキストファイルの登録とハッシュ一致を確認します。",
  },
  {
    slug: "reopen",
    title: "再起動後の内容を確認する",
    values: {
      note: "クローズと再オープン",
      estimate: 2,
      status: "進行中",
      due: "2026-11-22",
      done: false,
    },
    body: "ワークスペースを閉じて再度開いたとき本文と値が残るかを見ます。",
  },
  {
    slug: "backup",
    title: "フルバックアップを取る",
    values: {
      note: "完全バックアップの作成",
      estimate: 3,
      status: "未着手",
      due: "2026-11-23",
      done: false,
    },
    body: "完全なバックアップを作成する手順の記録です。",
  },
  {
    slug: "restore",
    title: "バックアップから復元する",
    values: {
      note: "別ディレクトリへの復元",
      estimate: 3,
      status: "未着手",
      due: "2026-11-24",
      done: false,
    },
    body: "バックアップを新しい場所へ復元し、内容を照合します。",
  },
  {
    slug: "limits",
    title: "試用上限の設定を読む",
    values: {
      note: "トライアル用の上限値",
      estimate: 1,
      status: "進行中",
      due: "2026-11-25",
      done: false,
    },
    body: "保存した試用上限を読み出して設定内容を確認します。",
  },
  {
    slug: "empty-paragraphs",
    title: "空の段落を保持する",
    values: {
      note: "五つの空段落",
      estimate: 1,
      status: "未着手",
      due: "2026-11-26",
      done: false,
    },
    body: "空の段落が保存後も消えないことを確認するための記録です。",
  },
  {
    slug: "japanese",
    title: "日本語の本文を保持する",
    values: {
      note: "マルチバイト文字列",
      estimate: 2,
      status: "進行中",
      due: "2026-11-27",
      done: false,
    },
    body: "日本語のタイトルと本文が文字化けせず保存されるかを見ます。",
  },
  {
    slug: "active-page",
    title: "最後に開いたページを復元する",
    values: {
      note: "activePage の保持",
      estimate: 1,
      status: "未着手",
      due: "2026-11-28",
      done: false,
    },
    body: "最後に開いていたページの設定が再起動後も保持されるかを確認します。",
  },
  {
    slug: "receipts",
    title: "操作レシートを残す",
    values: {
      note: "適用済み操作の記録",
      estimate: 2,
      status: "未着手",
      due: "2026-11-29",
      done: false,
    },
    body: "すべての操作が適用済みのレシートを残すことを確認します。",
  },
];

const recordDoc = (entry: ExtraRecord): Doc =>
  doc(
    heading("mac-trial-record-" + entry.slug + "-heading", 2, entry.title),
    paragraph("mac-trial-record-" + entry.slug + "-body", text(entry.body)),
    paragraph(
      "mac-trial-record-" + entry.slug + "-meta",
      text(
        "期日: " +
          String(entry.values.due) +
          " / 見積: " +
          String(entry.values.estimate),
      ),
    ),
  );

type PageSpec = {
  slug: string;
  title: string;
  parent: string | null;
  doc: (ref: (slug: string) => string) => Doc;
};

const PAGE_SPECS: PageSpec[] = [
  {
    slug: "guide",
    title: "Mac 単機トライアル ガイド",
    parent: null,
    doc: (ref) =>
      doc(
        heading("mac-trial-guide-heading", 2, "Mac 単機トライアル ガイド"),
        paragraph(
          "mac-trial-guide-intro",
          text(
            "このワークスペースは Folio Mac 単機限定トライアル向けの合成フィクスチャです。実データは含みません。",
          ),
        ),
        paragraph(
          "mac-trial-guide-links",
          text("検証メモを開く", pageLink(ref("notes"))),
          text(" / "),
          text("リンク集へ", pageLink(ref("links"))),
        ),
        paragraph("mac-trial-guide-blank"),
      ),
  },
  {
    slug: "setup",
    title: "セットアップ確認",
    parent: "guide",
    doc: (ref) =>
      doc(
        heading("mac-trial-setup-heading", 2, "セットアップ確認"),
        paragraph(
          "mac-trial-setup-body",
          text("起動・保存・添付・バックアップの確認手順をまとめた子ページです。"),
        ),
        paragraph(
          "mac-trial-setup-link",
          text("ガイドに戻る", pageLink(ref("guide"))),
        ),
      ),
  },
  {
    slug: "detail",
    title: "詳細メモ",
    parent: "setup",
    doc: (ref) =>
      doc(
        heading("mac-trial-detail-heading", 2, "詳細メモ"),
        paragraph(
          "mac-trial-detail-body",
          text("孫ページとして階層の深さを検証します。"),
        ),
        paragraph(
          "mac-trial-detail-link",
          text("トップのガイドへ", pageLink(ref("guide"))),
        ),
      ),
  },
  {
    slug: "checklist",
    title: "確認チェックリスト",
    parent: "guide",
    doc: () =>
      doc(
        heading("mac-trial-checklist-heading", 2, "確認チェックリスト"),
        paragraph(
          "mac-trial-checklist-body",
          text("以下の項目を順に確認します。"),
        ),
        paragraph("mac-trial-checklist-blank-1"),
        paragraph("mac-trial-checklist-blank-2"),
        paragraph(
          "mac-trial-checklist-end",
          text("以上で基本的な確認は完了です。"),
        ),
      ),
  },
  {
    slug: "notes",
    title: "検証メモ",
    parent: null,
    doc: (ref) =>
      doc(
        heading("mac-trial-notes-heading", 2, "検証メモ"),
        paragraph(
          "mac-trial-notes-body",
          text("本文の保持・再起動後の内容・添付の整合を確認するためのメモです。"),
        ),
        paragraph("mac-trial-notes-blank"),
        paragraph(
          "mac-trial-notes-link",
          text("リンク集へ進む", pageLink(ref("links"))),
        ),
      ),
  },
  {
    slug: "links",
    title: "リンク集",
    parent: null,
    doc: (ref) =>
      doc(
        heading("mac-trial-links-heading", 2, "リンク集"),
        paragraph(
          "mac-trial-links-body",
          text("内部リンクは folio-page:// で対象ページを指します。"),
        ),
        paragraph(
          "mac-trial-links-links",
          text("ガイド", pageLink(ref("guide"))),
          text(" / "),
          text("入れ子ページ", pageLink(ref("demo-nested"))),
          text(" / "),
          text("チェックリスト", pageLink(ref("checklist"))),
        ),
      ),
  },
  {
    slug: "emptylog",
    title: "空行の確認",
    parent: null,
    doc: () =>
      doc(
        heading("mac-trial-emptylog-heading", 2, "空行の確認"),
        paragraph(
          "mac-trial-emptylog-body",
          text("このページには保存対象の空の段落が含まれます。"),
        ),
        paragraph("mac-trial-emptylog-blank"),
        paragraph("mac-trial-emptylog-end", text("末尾の段落です。")),
      ),
  },
];

const ORDINARY_ORDER = [
  "demo-home",
  "demo-nested",
  "demo-regular",
  ...PAGE_SPECS.map((spec) => spec.slug),
];

type DocLike = {
  type?: string;
  content?: DocLike[];
  marks?: Array<{ type?: string; attrs?: { href?: unknown } }>;
};

function walkDoc(docValue: Doc, visit: (node: DocLike) => void): void {
  const visitNode = (node: DocLike): void => {
    visit(node);
    for (const child of node.content ?? []) visitNode(child);
  };
  for (const node of (docValue as DocLike).content ?? []) visitNode(node);
}

function countEmptyParagraphs(docValue: Doc): number {
  let count = 0;
  walkDoc(docValue, (node) => {
    if (
      node.type === "paragraph" &&
      (!node.content || node.content.length === 0)
    )
      count++;
  });
  return count;
}

function countInternalLinks(docValue: Doc): number {
  let count = 0;
  walkDoc(docValue, (node) => {
    for (const mark of node.marks ?? [])
      if (
        mark.type === "link" &&
        typeof mark.attrs?.href === "string" &&
        mark.attrs.href.startsWith("folio-page://")
      )
        count++;
  });
  return count;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Build the Mac single-machine limited trial fixture inside a brand-new
 * directory. `root` must be entirely absent: any existing entry (directory,
 * file, or symlink, including a dangling one) is refused before the Store or
 * the directory is touched. The directory is created with a non-recursive
 * mkdir so a concurrent creator loses the race instead of being reused.
 * On a partial failure the directory is left in place for inspection.
 */
export function seedMacTrial(
  root: string,
  fixtureImage = join(process.cwd(), "tests/fixtures/image.png"),
): MacTrialManifest {
  const workspaceDirectory = resolve(root);
  let exists = true;
  try {
    lstatSync(workspaceDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists)
    throw new Error(
      "Mac trial seed requires an absent root path: " + workspaceDirectory,
    );
  if (!existsSync(fixtureImage))
    throw new Error("Mac trial fixture image is missing: " + fixtureImage);

  mkdirSync(workspaceDirectory);

  const databaseFile = join(workspaceDirectory, "workspace.sqlite");
  const demo = seedDemo(databaseFile, undefined, fixtureImage);

  const store = new Store(databaseFile);
  try {
    const sessionId = "mac-trial-seed-" + randomUUID();
    const operations: Array<{
      type: "database:commit" | "save:commit";
      operationId: string;
      seq: number;
      status: "applied";
    }> = [];
    let seq = 0;
    const nextSeq = () => ++seq;

    const commitDatabase = (
      operation: DatabaseOperation,
    ): DatabaseOperationResult => {
      const result = store.handle({
        type: "database:commit",
        operation,
      }) as DatabaseOperationResult;
      if (result.status !== "applied")
        throw new Error(
          "Mac trial database operation failed: " +
            (result.message ?? result.status),
        );
      return result;
    };
    const commitSave = (operation: SaveOperation): SaveResult => {
      const result = store.handle({
        type: "save:commit",
        operation,
      }) as SaveResult;
      if (result.status !== "applied")
        throw new Error(
          "Mac trial save operation failed: " +
            (result.message ?? result.status),
        );
      return result;
    };
    const requireAdvancedRevision = (pageId: string, previous: number) => {
      const after = store.get(pageId);
      if (typeof after.revision !== "number" || after.revision <= previous)
        throw new Error(
          "Mac trial mutation did not advance the revision for " + pageId,
        );
      return after;
    };

    const recordIds = demo.records.map((record) => record.pageId);
    for (const [index, entry] of EXTRA_RECORDS.entries()) {
      const number = index + demo.records.length + 1;
      const owner = store.get(demo.database.id);
      const operationId = `mac-trial-op-record-${String(number).padStart(2, "0")}-${entry.slug}`;
      const operationSeq = nextSeq();
      const created = commitDatabase({
        operationId,
        sessionId,
        seq: operationSeq,
        command: {
          kind: "createRecord",
          databasePageId: owner.id,
          revision: owner.revision,
          title: entry.title,
          values: entry.values,
        },
      });
      const record = created.record;
      if (!record || typeof record.revision !== "number")
        throw new Error(
          "Mac trial record create returned no applied record: " + entry.slug,
        );
      operations.push({
        type: "database:commit",
        operationId,
        seq: operationSeq,
        status: "applied",
      });

      const saveOperationId = `mac-trial-op-record-doc-${String(number).padStart(2, "0")}-${entry.slug}`;
      const saveSeq = nextSeq();
      commitSave({
        operationId: saveOperationId,
        sessionId,
        seq: saveSeq,
        pageId: record.pageId,
        databasePageId: owner.id,
        revision: record.revision,
        patch: { doc: recordDoc(entry) },
      });
      operations.push({
        type: "save:commit",
        operationId: saveOperationId,
        seq: saveSeq,
        status: "applied",
      });
      requireAdvancedRevision(record.pageId, record.revision);
      recordIds.push(record.pageId);
    }

    const pageIds = new Map<string, string>();
    for (const page of demo.pages)
      pageIds.set("demo-" + page.role, page.id);
    const pageRef = (slug: string): string => {
      const id = pageIds.get(slug);
      if (!id) throw new Error("Mac trial seed is missing page id: " + slug);
      return id;
    };

    const createdPages: Array<{ spec: PageSpec; page: Page }> = [];
    for (const spec of PAGE_SPECS) {
      const page = store.create(
        spec.parent ? pageRef(spec.parent) : null,
        "page",
        spec.title,
      );
      if (typeof page.revision !== "number")
        throw new Error("Mac trial page create returned no revision");
      pageIds.set(spec.slug, page.id);
      createdPages.push({ spec, page });
    }
    for (const { spec, page } of createdPages) {
      const operationId = `mac-trial-op-page-${spec.slug}`;
      const operationSeq = nextSeq();
      commitSave({
        operationId,
        sessionId,
        seq: operationSeq,
        pageId: page.id,
        databasePageId: null,
        revision: page.revision,
        patch: { doc: spec.doc(pageRef) },
      });
      operations.push({
        type: "save:commit",
        operationId,
        seq: operationSeq,
        status: "applied",
      });
      requireAdvancedRevision(page.id, page.revision);
    }

    const seedInput = join(workspaceDirectory, "mac-trial-seed-input.txt");
    writeFileSync(seedInput, SYNTHETIC_TEXT, "utf8");
    const textAsset = attachFile(
      store.db,
      join(workspaceDirectory, "assets"),
      seedInput,
    );
    unlinkSync(seedInput);

    const limitSettings = new WorkspaceLimitSettings(store.db, {});
    const limitView = limitSettings.apply(null, TRIAL_LIMITS);
    if (limitView.revision === null)
      throw new Error("Mac trial limits were not persisted");
    for (const key of Object.keys(TRIAL_LIMITS) as Array<
      keyof ManagedGrowthLimits
    >)
      if (limitView.configured[key] !== TRIAL_LIMITS[key])
        throw new Error(
          "Mac trial limits did not persist the configured value for " + key,
        );

    const activePage = pageRef("guide");
    const settingResult = store.handle({
      type: "setting",
      key: "activePage",
      value: activePage,
    }) as { status?: string } | undefined;
    if (
      settingResult !== null &&
      typeof settingResult === "object" &&
      "status" in settingResult &&
      settingResult.status !== "applied"
    )
      throw new Error(
        "Mac trial activePage setting was not applied: " +
          String(settingResult.status),
      );

    const snapshot = store.load();
    if (snapshot.settings.activePage !== activePage)
      throw new Error("Mac trial activePage was not persisted");
    const storedRecords = snapshot.records ?? [];
    if (storedRecords.length !== 20)
      throw new Error(
        "Mac trial seed produced " + storedRecords.length + " records, expected 20",
      );
    if (
      !snapshot.recordDatabaseIds ||
      snapshot.recordDatabaseIds.length !== 1 ||
      snapshot.recordDatabaseIds[0] !== demo.database.id
    )
      throw new Error("Mac trial seed produced an unexpected database set");
    const totalPages = Number(
      (
        store.db.prepare("SELECT count(*) AS n FROM pages").get() as {
          n: number;
        }
      ).n,
    );
    if (totalPages !== 31)
      throw new Error(
        "Mac trial seed produced " + totalPages + " pages, expected 31",
      );

    const projections = new Map(
      storedRecords.map((record) => [record.pageId, record]),
    );
    const ownerPage = store.get(demo.database.id);
    const pages = ORDINARY_ORDER.map((slug) => {
      const page = store.get(pageRef(slug));
      return {
        id: page.id,
        title: page.title,
        parentId: page.parentId,
        doc: page.doc,
      };
    });
    const records = recordIds.map((id) => {
      const projection = projections.get(id);
      if (!projection)
        throw new Error("Mac trial record projection is missing: " + id);
      const page = store.get(id);
      return {
        id,
        title: projection.title,
        values: { ...projection.values },
        doc: page.doc,
      };
    });
    const docs = [...pages.map((page) => page.doc), ...records.map((record) => record.doc)];
    const emptyParagraphs = docs.reduce(
      (total, value) => total + countEmptyParagraphs(value),
      0,
    );
    if (emptyParagraphs !== 5)
      throw new Error(
        "Mac trial seed built " + emptyParagraphs + " empty paragraphs, expected 5",
      );
    const internalLinks = docs.reduce(
      (total, value) => total + countInternalLinks(value),
      0,
    );

    return deepFreeze<MacTrialManifest>({
      schema: "folio.mac-trial-fixture.v1",
      workspaceDirectory,
      databaseFile: resolve(databaseFile),
      activePage,
      database: {
        id: ownerPage.id,
        title: ownerPage.title,
        settings: ownerPage.database ?? null,
        properties: demo.database.properties,
        views: demo.database.views,
      },
      pages,
      records,
      assets: [
        {
          id: demo.asset.id,
          url: demo.asset.url,
          name: demo.asset.name,
          mime: demo.asset.mime,
          bytes: demo.asset.size,
          sha256: demo.asset.sha256,
          storagePath: demo.asset.storagePath,
        },
        {
          id: textAsset.id,
          url: textAsset.url,
          name: textAsset.name,
          mime: textAsset.mime,
          bytes: textAsset.size,
          sha256: textAsset.sha256,
          storagePath: `assets/${textAsset.id}`,
        },
      ],
      limits: {
        kind: "trial",
        note: LIMITS_NOTE,
        revision: limitView.revision,
        configured: { ...limitView.configured },
        effective: { ...limitView.effective },
      },
      expected: {
        totalPages: 31,
        ordinaryPages: 10,
        databases: 1,
        records: 20,
        assets: 2,
        emptyParagraphs: 5,
        internalLinks,
      },
      operations,
    });
  } finally {
    store.close();
  }
}
