import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Fixed synthetic medium workspace for the R8 performance sample.
 *
 * The fixture is built only through Store operations and save/database
 * receipts. It never reads, migrates or overwrites a real workspace.
 */
export const R8_PERF_PAGE_COUNT = 300;
export const R8_PERF_RECORD_COUNT = 200;
export const R8_PERF_MARKER = "Folio R8 synthetic performance fixture";
export const R8_PERF_MARKER_FILE = "SYNTHETIC-R8-PERF";
export const R8_PERF_SESSION_ID = "r8-perf-session";
export const R8_PERF_DATABASE_TITLE = "R8 性能データベース";
export const R8_PERF_TITLE_TERM = "桜木タイトル";
export const R8_PERF_BODY_TERM = "桜木本文";
export const R8_PERF_PROPERTY_TERM = "桜木メモ";
export const R8_PERF_BROAD_QUERY = "性能ページ";

const LINK_SOURCE_COUNT = 10;
const DATABASE_OPERATION_ID = "r8-perf-op-database-create";
const FIXTURE_MAX_BYTES = 1_000_000;

type ManifestOperation = {
  type: "database:commit" | "save:commit";
  operationId: string;
  seq: number;
  status: "applied";
};

export type R8PerfPage = {
  id: string;
  title: string;
  parentId: string | null;
  internalLinkTargets: string[];
  hasAsset: boolean;
};

export type R8PerfRecord = {
  pageId: string;
  title: string;
  values: Record<string, string | number | boolean>;
  body: string;
};

export type R8PerfManifest = {
  format: "folio-r8-perf-manifest-v1";
  seedVersion: 1;
  marker: string;
  markerFile: string;
  databaseFile: "workspace.sqlite";
  database: {
    id: string;
    title: string;
    activeViewId: string;
    properties: Property[];
    views: Array<Pick<DatabaseView, "id" | "name" | "type">>;
  };
  records: R8PerfRecord[];
  pages: R8PerfPage[];
  asset: {
    id: string;
    url: string;
    name: string;
    mime: string;
    size: number;
    sha256: string;
    storagePath: string;
  };
  search: {
    queries: Array<{
      query: string;
      kind: "title" | "body" | "property" | "broad";
      expectedPageIds?: string[];
      expectedCount?: number;
    }>;
    titleHitPageId: string;
    bodyHitPageId: string;
    propertyHitRecordPageId: string;
    broadExpectedCount: number;
  };
  operations: ManifestOperation[];
  checks: {
    regularPages: number;
    records: number;
    databases: number;
    views: number;
    properties: number;
    assets: number;
    internalLinks: number;
    knownSearchHits: number;
  };
};

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

const pad = (value: number, width: number) => String(value).padStart(width, "0");

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

const views: DatabaseView[] = [
  {
    id: "r8-view-table",
    name: "テーブル",
    type: "table",
    filterText: "",
    filter: emptyFilter("r8-filter-table"),
    sorts: [{ id: "r8-sort-table-due", propertyId: "due", direction: "asc" }],
    groupBy: null,
  },
  {
    id: "r8-view-board",
    name: "ボード",
    type: "board",
    filterText: "",
    filter: emptyFilter("r8-filter-board"),
    sorts: [{ id: "r8-sort-board-due", propertyId: "due", direction: "asc" }],
    groupBy: { propertyId: "status", direction: "asc" },
  },
];

const settings: DatabaseSettings = {
  schemaVersion: 2,
  properties,
  views,
  activeViewId: "r8-view-table",
  view: "table",
  filter: "",
  sort: legacySortValue(views[0].sorts[0]),
};

const statuses = ["未着手", "進行中", "完了"] as const;

function recordTitle(index: number): string {
  return "性能レコード " + pad(index + 1, 4);
}

function recordBody(index: number): string {
  return (
    "合成レコード本文 " +
    pad(index + 1, 4) +
    "。" +
    "検索・表示・ボード切替の測定に使う日本語の本文です。" +
    "この文章はすべて合成データで、実際の利用者データは含みません。" +
    "同じ長さの段落を複数回含めて、中規模ワークスペースの読み取り量を再現します。"
  );
}

function recordValues(index: number): Record<string, string | number | boolean> {
  const status = statuses[index % statuses.length];
  return {
    note:
      index === 0
        ? R8_PERF_PROPERTY_TERM + " 合成プロパティ"
        : "合成メモ " + pad(index + 1, 4),
    estimate: (index % 13) + 1,
    status,
    due: "2026-12-" + pad(((index + 1) % 28) + 1, 2),
    done: status === "完了",
  };
}

function recordDoc(record: { title: string; body: string }): Doc {
  return doc(
    heading("r8-record-heading-" + record.title, 2, record.title),
    paragraph("r8-record-body-" + record.title, text(record.body)),
    paragraph(
      "r8-record-meta-" + record.title,
      text("合成レコードの測定用本文です。"),
    ),
  );
}

function pageTitle(index: number): string {
  return index === 0
    ? "性能ページ " + pad(index + 1, 4) + " " + R8_PERF_TITLE_TERM
    : "性能ページ " + pad(index + 1, 4);
}

function pageBody(
  index: number,
  linkTargetId: string,
  assetUrl?: string,
): Doc {
  const body =
    index === 1
      ? R8_PERF_BODY_TERM +
        "。検索本文の既知ヒットを作るための合成ページです。" +
        "日本語の本文、内部リンク、画像を中規模ワークスペースに配置します。" +
        "この内容はすべて合成データです。"
      : "性能本文 " +
        pad(index + 1, 4) +
        "。表示と検索の応答を確認するための合成ページです。" +
        "日本語の本文を複数行にわたり保持し、通常ページの読み取り量を再現します。" +
        "この内容はすべて合成データです。";
  const content: Doc[] = [
    heading("r8-page-heading-" + pad(index + 1, 4), 2, pageTitle(index)),
    paragraph("r8-page-body-" + pad(index + 1, 4), text(body)),
  ];
  if (index < LINK_SOURCE_COUNT) {
    content.push(
      paragraph(
        "r8-page-link-" + pad(index + 1, 4),
        text("リンク先の合成ページを開く", pageLink(linkTargetId)),
      ),
    );
  }
  if (assetUrl) content.push(image("r8-page-asset-image", assetUrl, "合成測定画像"));
  return doc(...content);
}

function assertNewDataDirectory(path: string, dataDir: string): void {
  if (existsSync(path))
    throw new Error(
      "R8 performance seed refuses to overwrite an existing database: " + path,
    );
  if (existsSync(dataDir)) {
    const stat = lstatSync(dataDir);
    if (stat.isSymbolicLink())
      throw new Error("R8 performance data directory must not be a symlink");
    if (!stat.isDirectory())
      throw new Error(
        "R8 performance data path is not a directory: " + dataDir,
      );
    if (readdirSync(dataDir).length > 0)
      throw new Error(
        "R8 performance seed requires a new empty data directory; refusing to overwrite: " +
          dataDir,
      );
  } else {
    mkdirSync(dataDir, { recursive: true });
  }
}

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
      "R8 performance database operation failed: " +
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
      "R8 performance save operation failed: " +
        (result.message ?? result.status),
    );
  return result;
}

/**
 * Build the fixed R8 synthetic medium workspace. The caller owns a new empty
 * data directory; an existing database, marker or other file makes the seed
 * refuse instead of overwriting anything.
 */
export function seedMediumWorkspace(
  path: string,
  manifestPath?: string,
  fixtureImage = join(process.cwd(), "tests/fixtures/image.png"),
): R8PerfManifest {
  if (!existsSync(fixtureImage))
    throw new Error("R8 performance fixture image is missing: " + fixtureImage);
  const fixtureSize = statSync(fixtureImage).size;
  if (fixtureSize <= 0 || fixtureSize > FIXTURE_MAX_BYTES)
    throw new Error(
      "R8 performance fixture image must be a small non-empty file: " +
        fixtureImage,
    );

  const dataDir = dirname(path);
  assertNewDataDirectory(path, dataDir);

  const store = new Store(path);
  const operations: ManifestOperation[] = [];
  let seq = 0;
  const nextSeq = () => ++seq;

  try {
    if (store.pages().length)
      throw new Error(
        "R8 performance seed requires an empty synthetic workspace",
      );

    const databaseSeq = nextSeq();
    const created = commitDatabase(store, {
      operationId: DATABASE_OPERATION_ID,
      sessionId: R8_PERF_SESSION_ID,
      seq: databaseSeq,
      command: {
        kind: "createDatabase",
        parentId: null,
        title: R8_PERF_DATABASE_TITLE,
        settings,
      },
    });
    operations.push({
      type: "database:commit",
      operationId: DATABASE_OPERATION_ID,
      seq: databaseSeq,
      status: "applied",
    });
    const owner = created.page;
    if (!owner) throw new Error("R8 performance database was not created");

    const records: Array<{
      index: number;
      pageId: string;
      revision: number;
      title: string;
      values: Record<string, string | number | boolean>;
      body: string;
    }> = [];

    for (let index = 0; index < R8_PERF_RECORD_COUNT; index++) {
      const title = recordTitle(index);
      const values = recordValues(index);
      const operationId = "r8-perf-op-record-create-" + pad(index + 1, 4);
      const operationSeq = nextSeq();
      const result = commitDatabase(store, {
        operationId,
        sessionId: R8_PERF_SESSION_ID,
        seq: operationSeq,
        command: {
          kind: "createRecord",
          databasePageId: owner.id,
          revision: owner.revision,
          title,
          values,
        },
      });
      if (!result.record)
        throw new Error("R8 performance record was not created: " + title);
      operations.push({
        type: "database:commit",
        operationId,
        seq: operationSeq,
        status: "applied",
      });
      records.push({
        index,
        pageId: result.record.pageId,
        revision: result.record.revision,
        title,
        values,
        body: recordBody(index),
      });
    }

    for (const record of records) {
      const operationId =
        "r8-perf-op-record-body-" + pad(record.index + 1, 4);
      const operationSeq = nextSeq();
      commitSave(store, {
        operationId,
        sessionId: R8_PERF_SESSION_ID,
        seq: operationSeq,
        pageId: record.pageId,
        databasePageId: owner.id,
        revision: record.revision,
        patch: { doc: recordDoc(record) },
      });
      operations.push({
        type: "save:commit",
        operationId,
        seq: operationSeq,
        status: "applied",
      });
    }

    const pages = Array.from({ length: R8_PERF_PAGE_COUNT }, (_, index) =>
      store.create(null, "page", pageTitle(index)),
    );
    const linkTarget = pages[pages.length - 1];

    const assetsDir = join(dataDir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    const asset = attachFile(store.db, assetsDir, fixtureImage);

    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      const operationId = "r8-perf-op-page-" + pad(index + 1, 4);
      const operationSeq = nextSeq();
      commitSave(store, {
        operationId,
        sessionId: R8_PERF_SESSION_ID,
        seq: operationSeq,
        pageId: page.id,
        databasePageId: null,
        revision: page.revision,
        patch: {
          doc: pageBody(
            index,
            linkTarget.id,
            index === pages.length - 1 ? asset.url : undefined,
          ),
        },
      });
      operations.push({
        type: "save:commit",
        operationId,
        seq: operationSeq,
        status: "applied",
      });
    }

    store.handle({ type: "setting", key: "activePage", value: pages[0].id });

    const titleHitPageId = pages[0].id;
    const bodyHitPageId = pages[1].id;
    const propertyHitRecordPageId = records[0].pageId;

    const manifest: R8PerfManifest = {
      format: "folio-r8-perf-manifest-v1",
      seedVersion: 1,
      marker: R8_PERF_MARKER,
      markerFile: R8_PERF_MARKER_FILE,
      databaseFile: "workspace.sqlite",
      database: {
        id: owner.id,
        title: owner.title,
        activeViewId: settings.activeViewId,
        properties,
        views: views.map(({ id, name, type }) => ({ id, name, type })),
      },
      records: records.map((record) => ({
        pageId: record.pageId,
        title: record.title,
        values: record.values,
        body: record.body,
      })),
      pages: pages.map((page, index) => ({
        id: page.id,
        title: page.title,
        parentId: page.parentId,
        internalLinkTargets:
          index < LINK_SOURCE_COUNT ? [linkTarget.id] : [],
        hasAsset: index === pages.length - 1,
      })),
      asset: {
        id: asset.id,
        url: asset.url,
        name: asset.name,
        mime: asset.mime,
        size: asset.size,
        sha256: asset.sha256,
        storagePath: `assets/${asset.id}`,
      },
      search: {
        queries: [
          {
            query: R8_PERF_TITLE_TERM,
            kind: "title",
            expectedPageIds: [titleHitPageId],
          },
          {
            query: R8_PERF_BODY_TERM,
            kind: "body",
            expectedPageIds: [bodyHitPageId],
          },
          {
            query: R8_PERF_PROPERTY_TERM,
            kind: "property",
            expectedPageIds: [propertyHitRecordPageId],
          },
          {
            query: R8_PERF_BROAD_QUERY,
            kind: "broad",
            expectedCount: R8_PERF_PAGE_COUNT,
          },
        ],
        titleHitPageId,
        bodyHitPageId,
        propertyHitRecordPageId,
        broadExpectedCount: R8_PERF_PAGE_COUNT,
      },
      operations,
      checks: {
        regularPages: pages.length,
        records: records.length,
        databases: 1,
        views: views.length,
        properties: properties.length,
        assets: 1,
        internalLinks: LINK_SOURCE_COUNT,
        knownSearchHits: 3,
      },
    };

    // Leave one self-contained database file for the runner's per-launch clones.
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    if (manifestPath) {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(
        manifestPath,
        JSON.stringify(manifest, null, 2) + "\n",
        { encoding: "utf8", flag: "wx" },
      );
    }
    writeFileSync(
      join(dataDir, R8_PERF_MARKER_FILE),
      R8_PERF_MARKER + "\n",
      { encoding: "utf8", flag: "wx" },
    );
    return manifest;
  } finally {
    store.close();
  }
}
