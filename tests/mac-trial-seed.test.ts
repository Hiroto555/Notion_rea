import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/persistence/store";
import { resolveAsset } from "../src/persistence/assets";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { WorkspaceLimitSettings } from "../src/persistence/workspace-limit-settings";
import { seedMacTrial } from "../scripts/mac-trial-seed";
import type { Doc } from "../src/shared/types";

const fixture = resolve("tests/fixtures/image.png");
const ownedDirs: string[] = [];

function tempDir(prefix: string): string {
  mkdirSync(resolve("output"), { recursive: true });
  const dir = mkdtempSync(resolve(prefix));
  ownedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of ownedDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const JAPANESE = /[぀-ヿ㐀-䶿一-鿿]/;

type DocLike = {
  type?: string;
  content?: DocLike[];
  marks?: Array<{ type?: string; attrs?: { href?: unknown } }>;
};

function* walkDoc(docValue: Doc): Generator<DocLike> {
  const stack = [...((docValue as DocLike).content ?? [])];
  while (stack.length) {
    const node = stack.shift()!;
    yield node;
    stack.push(...(node.content ?? []));
  }
}

const emptyParagraphCount = (docValue: Doc): number =>
  [...walkDoc(docValue)].filter(
    (node) =>
      node.type === "paragraph" &&
      (!node.content || node.content.length === 0),
  ).length;

const internalLinkHrefs = (docValue: Doc): string[] =>
  [...walkDoc(docValue)].flatMap((node) =>
    (node.marks ?? [])
      .map((mark) => mark.attrs?.href)
      .filter(
        (href): href is string =>
          typeof href === "string" && href.startsWith("folio-page://"),
      ),
  );

function expectWorkspaceMatchesManifest(
  store: Store,
  manifest: ReturnType<typeof seedMacTrial>,
) {
  const snapshot = store.load();
  expect(snapshot.recordDatabaseIds).toEqual([manifest.database.id]);
  expect(snapshot.records ?? []).toHaveLength(20);
  const projections = new Map(
    (snapshot.records ?? []).map((record) => [record.pageId, record]),
  );
  for (const record of manifest.records) {
    const projection = projections.get(record.id);
    expect(projection, record.id).toBeTruthy();
    expect(projection!.title).toBe(record.title);
    expect({ ...projection!.values }).toEqual(record.values);
    expect(store.get(record.id).doc).toEqual(record.doc);
  }
  for (const page of manifest.pages) {
    const actual = store.get(page.id);
    expect(actual.title).toBe(page.title);
    expect(actual.parentId).toBe(page.parentId);
    expect(actual.doc).toEqual(page.doc);
  }
  const owner = store.get(manifest.database.id);
  expect(owner.title).toBe(manifest.database.title);
  expect(owner.database).toEqual(manifest.database.settings);
  expect(snapshot.settings.activePage).toBe(manifest.activePage);
  const limits = new WorkspaceLimitSettings(store.db, {}).read();
  expect(limits.revision).toBe(manifest.limits.revision);
  expect(limits.configured).toEqual(manifest.limits.configured);
  const reopenedEmpties =
    manifest.pages.reduce(
      (total, page) => total + emptyParagraphCount(store.get(page.id).doc),
      0,
    ) +
    manifest.records.reduce(
      (total, record) => total + emptyParagraphCount(store.get(record.id).doc),
      0,
    );
  expect(reopenedEmpties).toBe(5);
}

it("creates the exact fixture shape: 10 ordinary pages, 1 database with 20 records, 2 attachments", () => {
  const base = tempDir("output/mac-trial-shape-");
  const root = join(base, "workspace");
  const manifest = seedMacTrial(root, fixture);

  expect(Object.isFrozen(manifest)).toBe(true);
  expect(manifest.schema).toBe("folio.mac-trial-fixture.v1");
  expect(manifest.workspaceDirectory).toBe(resolve(root));
  expect(manifest.databaseFile).toBe(
    join(resolve(root), "workspace.sqlite"),
  );
  expect(manifest.pages).toHaveLength(10);
  expect(manifest.records).toHaveLength(20);
  expect(manifest.assets).toHaveLength(2);
  expect(manifest.expected).toMatchObject({
    totalPages: 31,
    ordinaryPages: 10,
    databases: 1,
    records: 20,
    assets: 2,
    emptyParagraphs: 5,
  });

  const pageIds = new Set(manifest.pages.map((page) => page.id));
  const recordIds = new Set(manifest.records.map((record) => record.id));
  expect(pageIds.has(manifest.database.id)).toBe(false);
  expect(recordIds.has(manifest.database.id)).toBe(false);
  for (const id of pageIds) expect(recordIds.has(id)).toBe(false);

  expect(
    [...new Set(manifest.database.properties.map((p) => p.type))].sort(),
  ).toEqual(["checkbox", "date", "number", "select", "text"]);
  expect(
    [...new Set(manifest.database.views.map((v) => v.type))].sort(),
  ).toEqual(["board", "calendar", "gallery", "table"]);

  for (const record of manifest.records) {
    expect(typeof record.values.note).toBe("string");
    expect(typeof record.values.estimate).toBe("number");
    expect(typeof record.values.status).toBe("string");
    expect(typeof record.values.due).toBe("string");
    expect(typeof record.values.done).toBe("boolean");
  }
  const statuses = new Set(
    manifest.records.map((record) => record.values.status),
  );
  expect(statuses.has("未着手")).toBe(true);
  expect(statuses.has("進行中")).toBe(true);
  expect(statuses.has("完了")).toBe(true);

  expect(manifest.limits.kind).toBe("trial");
  expect(manifest.limits.note).toMatch(/trial/i);
  expect(manifest.limits.configured).toEqual({
    maxDatabaseBytes: 268435456,
    maxAssetBytes: 268435456,
    maxBackupBytes: 1073741824,
    maxReceiptRows: 20000,
  });

  expect(manifest.pages.some((page) => JAPANESE.test(page.title))).toBe(true);
  expect(manifest.records.every((r) => JAPANESE.test(r.title))).toBe(true);
  const bodyTexts = manifest.records.flatMap((record) =>
    [...walkDoc(record.doc)]
      .filter((node) => node.type === "text")
      .map((node) => (node as { text?: string }).text ?? ""),
  );
  expect(bodyTexts.some((value) => JAPANESE.test(value))).toBe(true);

  const byId = new Map(manifest.pages.map((page) => [page.id, page]));
  const children = manifest.pages.filter(
    (page) => page.parentId !== null && byId.has(page.parentId),
  );
  expect(children.length).toBeGreaterThanOrEqual(3);
  expect(
    children.some((child) => {
      const parent = byId.get(child.parentId!);
      return !!parent?.parentId && byId.has(parent.parentId);
    }),
  ).toBe(true);

  const allDocs = [
    ...manifest.pages.map((page) => page.doc),
    ...manifest.records.map((record) => record.doc),
  ];
  const hrefs = allDocs.flatMap(internalLinkHrefs);
  expect(hrefs.length).toBe(manifest.expected.internalLinks);
  expect(hrefs.length).toBeGreaterThanOrEqual(5);
  const allIds = new Set([...pageIds, ...recordIds, manifest.database.id]);
  for (const href of hrefs)
    expect(allIds.has(href.slice("folio-page://".length))).toBe(true);

  expect(
    allDocs.reduce((total, value) => total + emptyParagraphCount(value), 0),
  ).toBe(5);

  const seqs = manifest.operations.map((operation) => operation.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  expect(
    new Set(manifest.operations.map((operation) => operation.operationId))
      .size,
  ).toBe(manifest.operations.length);
  expect(
    manifest.operations.every((operation) => operation.status === "applied"),
  ).toBe(true);
});

it("keeps record values, documents, and settings across a real close and reopen", () => {
  const base = tempDir("output/mac-trial-reopen-");
  const manifest = seedMacTrial(join(base, "workspace"), fixture);

  const store = new Store(manifest.databaseFile);
  try {
    expectWorkspaceMatchesManifest(store, manifest);
    const storedDatabase = JSON.stringify(
      store.get(manifest.database.id).database,
    );
    for (const type of ["text", "number", "select", "date", "checkbox"])
      expect(storedDatabase).toContain(`"type":"${type}"`);
    for (const type of ["table", "board", "calendar", "gallery"])
      expect(storedDatabase).toContain(`"type":"${type}"`);
  } finally {
    store.close();
  }

  const db = new DatabaseSync(manifest.databaseFile, { readOnly: true });
  try {
    const count = (sql: string) =>
      Number((db.prepare(sql).get() as { n: number }).n);
    expect(count("SELECT count(*) AS n FROM pages")).toBe(31);
    expect(count("SELECT count(*) AS n FROM record_databases")).toBe(1);
    expect(count("SELECT count(*) AS n FROM record_memberships")).toBe(20);
    expect(count("SELECT count(*) AS n FROM assets")).toBe(2);
  } finally {
    db.close();
  }
});

it("registers both attachments with durable bytes and hashes", () => {
  const base = tempDir("output/mac-trial-assets-");
  const manifest = seedMacTrial(join(base, "workspace"), fixture);
  const assetsDir = join(manifest.workspaceDirectory, "assets");

  const db = new DatabaseSync(manifest.databaseFile, { readOnly: true });
  try {
    for (const asset of manifest.assets) {
      const storedPath = join(manifest.workspaceDirectory, asset.storagePath);
      const bytes = readFileSync(storedPath);
      expect(bytes.length).toBe(asset.bytes);
      expect(sha256(bytes)).toBe(asset.sha256);
      const row = db
        .prepare("SELECT metadata FROM assets WHERE id=?")
        .get(asset.id) as { metadata: string } | undefined;
      expect(row, asset.id).toBeTruthy();
      const metadata = JSON.parse(row!.metadata);
      expect(metadata.size).toBe(asset.bytes);
      expect(metadata.sha256).toBe(asset.sha256);
      const resolvedAsset = resolveAsset(db, assetsDir, asset.url);
      expect(resolvedAsset.path).toBe(storedPath);
      expect(resolvedAsset.mime).toBe(asset.mime);
    }
  } finally {
    db.close();
  }

  const png = manifest.assets.find((asset) => asset.mime === "image/png");
  expect(png).toBeTruthy();
  expect(
    readFileSync(join(manifest.workspaceDirectory, png!.storagePath)),
  ).toEqual(readFileSync(fixture));
  const text = manifest.assets.find((asset) => asset.id !== png!.id);
  expect(text).toBeTruthy();
  expect(
    readFileSync(
      join(manifest.workspaceDirectory, text!.storagePath),
      "utf8",
    ),
  ).toContain("Folio Mac 単機トライアル用の合成テキスト添付です。");
});

it("refuses any existing root and preserves directory, file, and database bytes", () => {
  const base = tempDir("output/mac-trial-refuse-");
  const hashTree = (dir: string) =>
    Object.fromEntries(
      readdirSync(dir)
        .sort()
        .map((name) => [name, sha256(readFileSync(join(dir, name)))]),
    );

  const occupied = join(base, "occupied");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "keep.txt"), "keep these bytes\n", "utf8");
  const existing = new DatabaseSync(join(occupied, "workspace.sqlite"));
  existing.exec("CREATE TABLE t(x INTEGER)");
  existing.exec("INSERT INTO t VALUES(42)");
  existing.close();
  const before = hashTree(occupied);
  expect(() => seedMacTrial(occupied, fixture)).toThrow(/absent/);
  expect(hashTree(occupied)).toEqual(before);

  const emptyDir = join(base, "empty");
  mkdirSync(emptyDir);
  expect(() => seedMacTrial(emptyDir, fixture)).toThrow(/absent/);
  expect(readdirSync(emptyDir)).toEqual([]);

  const filePath = join(base, "afile");
  writeFileSync(filePath, "existing file bytes", "utf8");
  expect(() => seedMacTrial(filePath, fixture)).toThrow(/absent/);
  expect(readFileSync(filePath, "utf8")).toBe("existing file bytes");

  const target = join(base, "target");
  mkdirSync(target);
  const link = join(base, "link");
  symlinkSync(target, link);
  expect(() => seedMacTrial(link, fixture)).toThrow(/absent/);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readdirSync(target)).toEqual([]);

  const dangling = join(base, "dangling");
  symlinkSync(join(base, "missing-target"), dangling);
  expect(() => seedMacTrial(dangling, fixture)).toThrow(/absent/);
  expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
});

it("round-trips every page, record, and attachment through a full backup and restore", () => {
  const base = tempDir("output/mac-trial-backup-");
  const manifest = seedMacTrial(join(base, "workspace"), fixture);

  const backupDir = join(base, "backup");
  const store = new Store(manifest.databaseFile);
  let fingerprint: string | undefined;
  try {
    const backup = createFullBackup(
      store.db,
      manifest.workspaceDirectory,
      backupDir,
    ) as { fingerprint?: string };
    fingerprint = backup.fingerprint;
  } finally {
    store.close();
  }
  expect(existsSync(backupDir)).toBe(true);

  const restoreDir = join(base, "restored");
  const restored = restoreFullBackup(backupDir, restoreDir, fingerprint) as
    | { directory?: string; path?: string }
    | string;
  const restoredRoot =
    typeof restored === "string"
      ? restored
      : restored.directory ?? restored.path ?? restoreDir;

  const restoredStore = new Store(join(restoredRoot, "workspace.sqlite"));
  try {
    expectWorkspaceMatchesManifest(restoredStore, manifest);
  } finally {
    restoredStore.close();
  }

  const restoredDb = new DatabaseSync(
    join(restoredRoot, "workspace.sqlite"),
    { readOnly: true },
  );
  try {
    const restoredAssetsDir = join(restoredRoot, "assets");
    for (const asset of manifest.assets) {
      const storedPath = join(restoredRoot, asset.storagePath);
      const bytes = readFileSync(storedPath);
      expect(bytes.length).toBe(asset.bytes);
      expect(sha256(bytes)).toBe(asset.sha256);
      const row = restoredDb
        .prepare("SELECT metadata FROM assets WHERE id=?")
        .get(asset.id) as { metadata: string } | undefined;
      expect(row, asset.id).toBeTruthy();
      const metadata = JSON.parse(row!.metadata);
      expect(metadata.size).toBe(asset.bytes);
      expect(metadata.sha256).toBe(asset.sha256);
      const resolvedAsset = resolveAsset(
        restoredDb,
        restoredAssetsDir,
        asset.url,
      );
      expect(resolvedAsset.path).toBe(storedPath);
      expect(resolvedAsset.mime).toBe(asset.mime);
    }
  } finally {
    restoredDb.close();
  }
});
