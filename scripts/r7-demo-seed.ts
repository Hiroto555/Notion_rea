import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Store } from "../src/persistence/store";
import { attachFile } from "../src/persistence/assets";
import { legacySortValue } from "../src/database/model";
import type {
  DatabaseOperation,
  DatabaseOperationResult,
} from "../src/shared/database-operation";
import type { SaveOperation, SaveResult } from "../src/shared/save-contract";
import type {
  DatabaseSettings,
  DatabaseView,
  Doc,
  FilterGroup,
  Property,
} from "../src/shared/types";

export type R7DemoManifest = {
  format: "folio-r7-demo-manifest-v1";
  seedVersion: 1;
  marker: string;
  databaseFile: "workspace.sqlite";
  database: {
    id: string;
    title: string;
    activeViewId: string;
    properties: Property[];
    views: Array<Pick<DatabaseView, "id" | "name" | "type">>;
  };
  records: Array<{
    pageId: string;
    title: string;
    values: Record<string, string | number | boolean>;
    body: string;
  }>;
  pages: Array<{
    role: "home" | "nested" | "regular";
    id: string;
    title: string;
    parentId: string | null;
    internalLinkTargets: string[];
  }>;
  asset: {
    id: string;
    url: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    storagePath: string;
  };
  operations: Array<{
    type: "database:commit" | "save:commit";
    operationId: string;
    seq: number;
    status: "applied";
  }>;
  checks: {
    views: number;
    properties: number;
    records: number;
    nestedPages: number;
    internalLinks: number;
    assets: number;
  };
};

const SESSION_ID = "r7-demo-session";
const MARKER = "Folio R7 synthetic demo";
const DATABASE_TITLE = "R7 制作タスク";

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
const image = (id: string, src: string, alt: string): Doc => ({
  type: "image",
  attrs: { id, src, alt },
});
const pageLink = (pageId: string): Doc["marks"] => [
  { type: "link", attrs: { href: "folio-page://" + pageId } },
];
const doc = (...content: Doc[]): Doc => ({
  type: "doc",
  schemaVersion: 1,
  content,
});

const properties: Property[] = [
  { id: "note", name: "メモ", type: "text" },
  { id: "estimate", name: "見積", type: "number" },
  {
    id: "status",
    name: "ステータス",
    type: "select",
    options: ["未着手", "進行中", "完了"],
  },
  { id: "due", name: "期日", type: "date" },
  { id: "done", name: "完了", type: "checkbox" },
];

const emptyFilter = (id: string): FilterGroup => ({
  kind: "group",
  id,
  conjunction: "and",
  conditions: [],
});

const nestedStatusFilter: FilterGroup = {
  kind: "group",
  id: "r7-filter-status-any",
  conjunction: "or",
  conditions: [
    {
      kind: "condition",
      id: "r7-filter-status-doing",
      propertyId: "status",
      operator: "equals",
      value: "進行中",
    },
    {
      kind: "condition",
      id: "r7-filter-status-todo",
      propertyId: "status",
      operator: "equals",
      value: "未着手",
    },
  ],
};

const views: DatabaseView[] = [
  {
    id: "r7-view-all",
    name: "すべて",
    type: "table",
    filterText: "",
    filter: {
      kind: "group",
      id: "r7-filter-active",
      conjunction: "and",
      conditions: [
        nestedStatusFilter,
        {
          kind: "condition",
          id: "r7-filter-not-done",
          propertyId: "done",
          operator: "is_not_checked",
        },
      ],
    },
    sorts: [
      { id: "r7-sort-due", propertyId: "due", direction: "asc" },
      { id: "r7-sort-estimate", propertyId: "estimate", direction: "desc" },
    ],
    groupBy: null,
  },
  {
    id: "r7-view-board",
    name: "ステータス別",
    type: "board",
    filterText: "",
    filter: emptyFilter("r7-filter-board"),
    sorts: [{ id: "r7-sort-board-due", propertyId: "due", direction: "asc" }],
    groupBy: { propertyId: "status", direction: "asc" },
  },
  {
    id: "r7-view-calendar",
    name: "期日カレンダー",
    type: "calendar",
    filterText: "",
    filter: emptyFilter("r7-filter-calendar"),
    sorts: [],
    groupBy: { propertyId: "due", direction: "asc" },
  },
  {
    id: "r7-view-gallery",
    name: "完了ギャラリー",
    type: "gallery",
    filterText: "",
    filter: emptyFilter("r7-filter-gallery"),
    sorts: [{ id: "r7-sort-gallery-done", propertyId: "done", direction: "asc" }],
    groupBy: null,
  },
];

const settings: DatabaseSettings = {
  schemaVersion: 2,
  properties,
  views,
  activeViewId: "r7-view-all",
  view: "table",
  filter: "",
  sort: legacySortValue(views[0].sorts[0]),
};

type DemoRecord = {
  slug: string;
  title: string;
  values: Record<string, string | number | boolean>;
  body: string;
};

const records: DemoRecord[] = [
  {
    slug: "requirements",
    title: "R7 要件を整理する",
    values: {
      note: "合成デモ用の要件メモ",
      estimate: 5,
      status: "進行中",
      due: "2026-11-10",
      done: false,
    },
    body:
      "要件を一枚にまとめ、確認待ちの項目を整理します。この本文は合成データです。",
  },
  {
    slug: "screens",
    title: "R7 画面を確認する",
    values: {
      note: "主要画面の表示を確認",
      estimate: 3,
      status: "未着手",
      due: "2026-11-12",
      done: false,
    },
    body:
      "サイドピークと全画面の両方で、本文と選択範囲が保たれることを確認します。",
  },
  {
    slug: "review",
    title: "R7 初回レビュー",
    values: {
      note: "完了済みの合成レビュー",
      estimate: 8,
      status: "完了",
      due: "2026-11-01",
      done: true,
    },
    body:
      "初回レビューの記録です。完了済みの行は「すべて」ビューの条件から外れます。",
  },
  {
    slug: "spacing",
    title: "R7 余白を調整する",
    values: {
      note: "狭い幅でも崩れない余白",
      estimate: 2,
      status: "進行中",
      due: "2026-11-20",
      done: false,
    },
    body:
      "狭い画面でも本文が読みやすいように余白を調整します。保存と再起動の確認用です。",
  },
];

const recordDoc = (record: DemoRecord): Doc =>
  doc(
    heading("r7-record-" + record.slug + "-heading", 2, record.title),
    paragraph(
      "r7-record-" + record.slug + "-body",
      text(record.body),
    ),
    paragraph(
      "r7-record-" + record.slug + "-meta",
      text("期日: " + String(record.values.due) + " / 見積: " + String(record.values.estimate)),
    ),
  );

function commitDatabase(
  store: Store,
  operation: DatabaseOperation,
): DatabaseOperationResult {
  const result = store.handle({
    type: "database:commit",
    operation,
  }) as DatabaseOperationResult;
  if (result.status !== "applied")
    throw new Error(
      "R7 demo database operation failed: " +
        (result.message ?? result.status),
    );
  return result;
}

function commitSave(store: Store, operation: SaveOperation): SaveResult {
  const result = store.handle({
    type: "save:commit",
    operation,
  }) as SaveResult;
  if (result.status !== "applied")
    throw new Error(
      "R7 demo save operation failed: " + (result.message ?? result.status),
    );
  return result;
}

/**
 * Build a fixed, synthetic R7 workspace through the real Store operation
 * contracts. The caller owns the directory and must pass an empty database
 * path; this function never opens or writes a user workspace.
 */
export function seedDemo(
  path: string,
  manifestPath?: string,
  fixtureImage = join(process.cwd(), "tests/fixtures/image.png"),
): R7DemoManifest {
  if (!existsSync(fixtureImage))
    throw new Error("R7 demo fixture image is missing: " + fixtureImage);
  const store = new Store(path);
  const operations: R7DemoManifest["operations"] = [];
  let seq = 0;
  const nextSeq = () => ++seq;
  try {
    if (store.pages().length)
      throw new Error("R7 demo seed requires an empty synthetic workspace");

    const databaseOperationId = "r7-demo-op-01-create-database";
    const databaseSeq = nextSeq();
    const created = commitDatabase(store, {
      operationId: databaseOperationId,
      sessionId: SESSION_ID,
      seq: databaseSeq,
      command: {
        kind: "createDatabase",
        parentId: null,
        title: DATABASE_TITLE,
        settings,
      },
    });
    operations.push({
      type: "database:commit",
      operationId: databaseOperationId,
      seq: databaseSeq,
      status: "applied",
    });
    const owner = created.page!;

    const createdRecords: Array<{
      record: DemoRecord;
      pageId: string;
      revision: number;
    }> = [];
    for (const [index, record] of records.entries()) {
      const operationId = `r7-demo-op-record-${String(index + 1).padStart(2, "0")}-${record.slug}`;
      const operationSeq = nextSeq();
      const result = commitDatabase(store, {
        operationId,
        sessionId: SESSION_ID,
        seq: operationSeq,
        command: {
          kind: "createRecord",
          databasePageId: owner.id,
          revision: owner.revision,
          title: record.title,
          values: record.values,
        },
      });
      operations.push({
        type: "database:commit",
        operationId,
        seq: operationSeq,
        status: "applied",
      });
      createdRecords.push({
        record,
        pageId: result.record!.pageId,
        revision: result.record!.revision,
      });
    }

    for (const [index, entry] of createdRecords.entries()) {
      const operationId = `r7-demo-op-record-body-${String(index + 1).padStart(2, "0")}`;
      const operationSeq = nextSeq();
      commitSave(store, {
        operationId,
        sessionId: SESSION_ID,
        seq: operationSeq,
        pageId: entry.pageId,
        databasePageId: owner.id,
        revision: entry.revision,
        patch: { doc: recordDoc(entry.record) },
      });
      operations.push({
        type: "save:commit",
        operationId,
        seq: operationSeq,
        status: "applied",
      });
    }

    const home = store.create(null, "page", "R7 合成デモの使い方");
    const nested = store.create(home.id, "page", "R7 入れ子ページ");
    const regular = store.create(null, "page", "R7 画像サンプル");
    const assets = join(dirname(path), "assets");
    mkdirSync(assets, { recursive: true });
    const asset = attachFile(store.db, assets, fixtureImage);

    const homeSave = "r7-demo-op-page-home";
    const homeSeq = nextSeq();
    commitSave(store, {
      operationId: homeSave,
      sessionId: SESSION_ID,
      seq: homeSeq,
      pageId: home.id,
      databasePageId: null,
      revision: home.revision,
      patch: {
        doc: doc(
          heading("r7-home-heading", 2, "R7 合成デモの使い方"),
          paragraph(
            "r7-home-intro",
            text(
              "このワークスペースはすべて合成データです。実際のユーザーデータは含みません。",
            ),
          ),
          paragraph(
            "r7-home-nested-link",
            text("入れ子ページを開く", pageLink(nested.id)),
            text(" / "),
            text("画像サンプルを開く", pageLink(regular.id)),
          ),
          paragraph(
            "r7-home-views",
            text(
              "データベースにはテーブル・ボード・カレンダー・ギャラリーの4つのビューがあります。",
            ),
          ),
        ),
      },
    });
    operations.push({
      type: "save:commit",
      operationId: homeSave,
      seq: homeSeq,
      status: "applied",
    });

    const nestedSave = "r7-demo-op-page-nested";
    const nestedSeq = nextSeq();
    commitSave(store, {
      operationId: nestedSave,
      sessionId: SESSION_ID,
      seq: nestedSeq,
      pageId: nested.id,
      databasePageId: null,
      revision: nested.revision,
      patch: {
        doc: doc(
          heading("r7-nested-heading", 2, "R7 入れ子ページ"),
          paragraph(
            "r7-nested-body",
            text("親ページの下にある入れ子ページです。ローカルの合成画像を表示します。"),
          ),
          image("r7-nested-image", asset.url, "合成デモ画像"),
          paragraph(
            "r7-nested-link",
            text("画像サンプルへ戻る", pageLink(regular.id)),
          ),
        ),
      },
    });
    operations.push({
      type: "save:commit",
      operationId: nestedSave,
      seq: nestedSeq,
      status: "applied",
    });

    const regularSave = "r7-demo-op-page-regular";
    const regularSeq = nextSeq();
    commitSave(store, {
      operationId: regularSave,
      sessionId: SESSION_ID,
      seq: regularSeq,
      pageId: regular.id,
      databasePageId: null,
      revision: regular.revision,
      patch: {
        doc: doc(
          heading("r7-regular-heading", 2, "R7 画像サンプル"),
          paragraph(
            "r7-regular-body",
            text(
              "通常ページの本文です。ローカルの fixture 画像を添付し、内部リンクの遷移先にもなります。",
            ),
          ),
          image("r7-regular-image", asset.url, "合成デモ画像"),
        ),
      },
    });
    operations.push({
      type: "save:commit",
      operationId: regularSave,
      seq: regularSeq,
      status: "applied",
    });

    store.handle({ type: "setting", key: "activePage", value: home.id });

    const manifest: R7DemoManifest = {
      format: "folio-r7-demo-manifest-v1",
      seedVersion: 1,
      marker: MARKER,
      databaseFile: "workspace.sqlite",
      database: {
        id: owner.id,
        title: owner.title,
        activeViewId: settings.activeViewId,
        properties,
        views: views.map(({ id, name, type }) => ({ id, name, type })),
      },
      records: createdRecords.map(({ record, pageId }) => ({
        pageId,
        title: record.title,
        values: record.values,
        body: record.body,
      })),
      pages: [
        {
          role: "home",
          id: home.id,
          title: home.title,
          parentId: null,
          internalLinkTargets: [nested.id, regular.id],
        },
        {
          role: "nested",
          id: nested.id,
          title: nested.title,
          parentId: home.id,
          internalLinkTargets: [regular.id],
        },
        {
          role: "regular",
          id: regular.id,
          title: regular.title,
          parentId: null,
          internalLinkTargets: [],
        },
      ],
      asset: {
        id: asset.id,
        url: asset.url,
        name: asset.name,
        mime: asset.mime,
        size: asset.size,
        sha256: asset.sha256,
        storagePath: `assets/${asset.id}`,
      },
      operations,
      checks: {
        views: views.length,
        properties: properties.length,
        records: createdRecords.length,
        nestedPages: 1,
        internalLinks: 3,
        assets: 1,
      },
    };

    if (manifestPath) {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(
        manifestPath,
        JSON.stringify(manifest, null, 2) + "\n",
        "utf8",
      );
    }
    return manifest;
  } finally {
    store.close();
  }
}
