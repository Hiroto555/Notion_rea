import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { seedDemo, type R7DemoManifest } from "../scripts/r7-demo-seed";
import { Store } from "../src/persistence/store";
import { createFullBackup } from "../src/persistence/full-backup-create";
import {
  inspectWorkspaceSnapshot,
  verifyFullBackup,
} from "../src/persistence/full-backup-verify";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import type { SaveOperation, SaveResult } from "../src/shared/save-contract";
import type { RecordProjection } from "../src/shared/types";
import type {
  WorkspaceBackupManifest,
  WorkspaceInventory,
  VerifiedWorkspaceBackup,
} from "../src/shared/workspace-backup";

const seedImage = resolve("tests/fixtures/image.png");
const roots: string[] = [];
const stores: Store[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "folio-r8-backup-qa-"));
  roots.push(root);
  return root;
}

function openStore(directory: string) {
  const store = new Store(join(directory, "workspace.sqlite"));
  stores.push(store);
  return store;
}

function closeStore(store: Store) {
  try {
    store.close();
  } catch {}
}

afterEach(() => {
  for (const store of stores.splice(0)) closeStore(store);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const hashFile = (path: string) => sha256(readFileSync(path));

type CapturedSqlite = {
  userVersion: number;
  tables: Record<string, Record<string, unknown>[]>;
  schema: Record<string, unknown>[];
};

const tableQueries: Record<string, string> = {
  pages: "SELECT id,data,body FROM pages ORDER BY id",
  settings: "SELECT key,value FROM settings ORDER BY key",
  versions:
    "SELECT id,pageId,createdAt,title,doc,database FROM versions ORDER BY id",
  save_receipts:
    "SELECT operation_id,fingerprint,result_json FROM save_receipts ORDER BY operation_id",
  assets: "SELECT id,metadata FROM assets ORDER BY id",
  record_databases:
    "SELECT database_page_id FROM record_databases ORDER BY database_page_id",
  record_memberships:
    "SELECT page_id,database_page_id,position,values_json FROM record_memberships ORDER BY database_page_id,position,page_id",
  record_value_versions:
    "SELECT version_id,values_json FROM record_value_versions ORDER BY version_id",
  folio_record_schema: "SELECT version FROM folio_record_schema",
  record_database_trash_batches:
    "SELECT database_page_id,deleted_revision,deleted_at FROM record_database_trash_batches ORDER BY database_page_id",
  record_database_trash_members:
    "SELECT database_page_id,page_id,deleted_revision FROM record_database_trash_members ORDER BY database_page_id,page_id",
  sqlite_sequence: "SELECT name,seq FROM sqlite_sequence ORDER BY name",
};

/** Read raw SQLite content, not a Store projection or verifier inventory. */
function captureSqlite(path: string): CapturedSqlite {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const userVersion = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const [name, query] of Object.entries(tableQueries)) {
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name)
      )
        tables[name] = db.prepare(query).all() as Record<string, unknown>[];
    }
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all() as Record<string, unknown>[];
    return { userVersion, tables, schema };
  } finally {
    db.close();
  }
}

function inventoryFrom(capture: CapturedSqlite): WorkspaceInventory {
  const count = (name: string) => capture.tables[name]?.length ?? 0;
  return {
    pages: count("pages"),
    recordDatabases: count("record_databases"),
    records: count("record_memberships"),
    versions: count("versions"),
    settings: count("settings"),
    saveReceipts: count("save_receipts"),
    registeredAssets: count("assets"),
  };
}

type CapturedAsset = { path: string; bytes: number; sha256: string };

function capturedAssets(directory: string): CapturedAsset[] {
  const root = join(directory, "assets");
  if (!existsSync(root)) return [];
  const assets: CapturedAsset[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink())
        throw new Error("Unexpected symbolic link in assets: " + absolute);
      if (entry.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        const bytes = readFileSync(absolute);
        assets.push({
          path: relative(directory, absolute).split(sep).join("/"),
          bytes: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  };
  walk(root);
  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

function relativeFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(absolute);
      else files.push(relative(directory, absolute).split(sep).join("/"));
    }
  };
  walk(directory);
  return files.sort();
}

const sidecar = /-(?:wal|shm|journal)$/;
const materialFiles = (directory: string) =>
  relativeFiles(directory).filter((path) => !sidecar.test(path));

const journalOrSession = (path: string) => {
  const parts = path.split("/");
  return (
    parts.includes("session") ||
    parts[parts.length - 1] === "crash-recovery.json"
  );
};

type Fixture = {
  root: string;
  source: string;
  database: string;
  r7: R7DemoManifest;
  extras: {
    savedPageId: string;
    saveOperationId: string;
    trashedPageId: string;
    trashedRecordId: string;
    expandedSetting: string;
  };
};

/** Start from the real Store v4 fixture, then add version/receipt, trash,
 * record-trash and settings rows so those tables are non-trivial too. */
function createFixture(): Fixture {
  const root = tempRoot();
  const source = join(root, "source");
  const database = join(source, "workspace.sqlite");
  const r7 = seedDemo(database, undefined, seedImage);
  const store = new Store(database);
  try {
    const saved = store.create(null, "page", "R8 QA saved history");
    const operation: SaveOperation = {
      operationId: "r8-qa-extra-save",
      sessionId: "r8-qa-session",
      seq: 1,
      pageId: saved.id,
      databasePageId: null,
      revision: saved.revision,
      patch: { title: "R8 QA saved history (edited)" },
    };
    const result = store.handle({ type: "save:commit", operation }) as SaveResult;
    expect(result.status).toBe("applied");

    const trashed = store.create(null, "page", "R8 QA trashed page");
    store.handle({ type: "trash", id: trashed.id });

    const record = store.handle({
      type: "record:get",
      pageId: r7.records[0].pageId,
    }) as RecordProjection;
    store.handle({ type: "trash", id: record.pageId });

    const expandedSetting = [saved.id, r7.pages[0].id].join(",");
    store.handle({ type: "setting", key: "theme", value: "dark" });
    store.handle({ type: "setting", key: "sidebar", value: "wide" });
    store.handle({ type: "setting", key: "expanded", value: expandedSetting });

    mkdirSync(join(source, "session"), { recursive: true });
    writeFileSync(join(source, "session", "Cookies"), "session-marker");
    writeFileSync(
      join(source, "crash-recovery.json"),
      JSON.stringify({ format: "folio-crash-recovery-v1", marker: "do not copy" }),
    );

    return {
      root,
      source,
      database,
      r7,
      extras: {
        savedPageId: saved.id,
        saveOperationId: operation.operationId,
        trashedPageId: trashed.id,
        trashedRecordId: record.pageId,
        expandedSetting,
      },
    };
  } finally {
    closeStore(store);
  }
}

function createBackup(
  fixture: Fixture,
  name = "backup",
): VerifiedWorkspaceBackup {
  const destination = join(fixture.root, name);
  const store = openStore(fixture.source);
  try {
    return createFullBackup(store.db, fixture.source, destination);
  } finally {
    closeStore(store);
  }
}

function cloneBackup(
  backup: VerifiedWorkspaceBackup,
  destination: string,
): string {
  cpSync(backup.directory, destination, { recursive: true });
  return destination;
}

function findManifest(directory: string): string {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (value?.format === "folio-workspace-backup") return path;
    } catch {}
  }
  throw new Error("Workspace backup manifest not found in " + directory);
}

function readManifest(directory: string): WorkspaceBackupManifest {
  return JSON.parse(readFileSync(findManifest(directory), "utf8"));
}

function writeManifest(directory: string, manifest: unknown) {
  writeFileSync(findManifest(directory), JSON.stringify(manifest, null, 2));
}

function assertSafeBackupFile(directory: string, file: { path: string; bytes: number; sha256: string }) {
  expect(typeof file.path).toBe("string");
  expect(file.path.length).toBeGreaterThan(0);
  expect(isAbsolute(file.path)).toBe(false);
  expect(file.path.split(/[\\/]/)).not.toContain("..");
  const absolute = resolve(directory, file.path);
  expect(absolute.startsWith(resolve(directory) + sep)).toBe(true);
  expect(statSync(absolute).size).toBe(file.bytes);
  expect(hashFile(absolute)).toBe(file.sha256);
}

function expectRejectedBeforePublication(
  directory: string,
  root: string,
  label: string,
) {
  const destination = join(root, `destination-${label}`);
  expect(() => verifyFullBackup(directory)).toThrow();
  expect(() => restoreFullBackup(directory, destination)).toThrow();
  expect(existsSync(destination)).toBe(false);
}

it("round-trips the real v4 fixture table-for-table and byte-for-byte without trusting verification", () => {
  const fixture = createFixture();
  const backupDirectory = join(fixture.root, "backup");
  const restoredDirectory = join(fixture.root, "restored");
  const store = openStore(fixture.source);
  let backup: VerifiedWorkspaceBackup;
  let sourceLogical: ReturnType<Store["load"]>;
  let sourceTables: CapturedSqlite;
  let sourceAssets: CapturedAsset[];
  let sourceDbHash: string;
  let sourceFiles: string[];
  try {
    sourceLogical = store.load();
    sourceTables = captureSqlite(fixture.database);
    sourceAssets = capturedAssets(fixture.source);
    sourceDbHash = hashFile(fixture.database);
    sourceFiles = materialFiles(fixture.source);

    backup = createFullBackup(store.db, fixture.source, backupDirectory);
  } finally {
    closeStore(store);
  }

  // createFullBackup must not modify the source workspace.
  expect(hashFile(fixture.database)).toBe(sourceDbHash);
  expect(captureSqlite(fixture.database)).toEqual(sourceTables);
  expect(capturedAssets(fixture.source)).toEqual(sourceAssets);
  expect(materialFiles(fixture.source)).toEqual(sourceFiles);
  expect(readFileSync(join(fixture.source, "crash-recovery.json"), "utf8")).toContain(
    "do not copy",
  );

  expect(realpathSync(backup.directory)).toBe(realpathSync(backupDirectory));
  const inspected = inspectWorkspaceSnapshot(backup.directory);
  const verified = verifyFullBackup(backup.directory);
  expect(verified.manifest).toEqual(backup.manifest);
  expect(verified.fingerprint).toBe(backup.fingerprint);
  expect(typeof verified.fingerprint).toBe("string");
  expect(verified.fingerprint.length).toBeGreaterThan(0);

  const expectedInventory = inventoryFrom(sourceTables);
  expect(inspected.storeVersion).toBe(sourceTables.userVersion);
  expect(inspected.inventory).toEqual(expectedInventory);
  expect(inspected.logicalSha256).toBe(backup.manifest.logicalSha256);
  expect(inspected.assets).toEqual(backup.manifest.assets);
  expect(backup.manifest.format).toBe("folio-workspace-backup");
  expect(backup.manifest.version).toBe(1);
  expect(backup.manifest.storeVersion).toBe(4);
  expect(backup.manifest.inventory).toEqual(expectedInventory);
  expect(backup.manifest.database.path).toBeTruthy();
  assertSafeBackupFile(backup.directory, backup.manifest.database);
  for (const file of backup.manifest.assets)
    assertSafeBackupFile(backup.directory, file);

  // Independent comparison of the snapshot's raw database and attachment bytes.
  expect(captureSqlite(join(backup.directory, "workspace.sqlite"))).toEqual(
    sourceTables,
  );
  expect(capturedAssets(backup.directory)).toEqual(sourceAssets);
  expect(backup.manifest.assets).toHaveLength(sourceAssets.length);
  expect(
    relativeFiles(backup.directory).some(journalOrSession),
  ).toBe(false);

  const restored = restoreFullBackup(
    backup.directory,
    restoredDirectory,
    verified.fingerprint,
  );
  expect(resolve(restored.directory)).toBe(resolve(restoredDirectory));
  expect(restored.sourceFingerprint).toBe(verified.fingerprint);
  expect(restored.manifest).toEqual(verified.manifest);
  expect(
    existsSync(join(restoredDirectory, "FOLIO-RECOVERY-INCOMPLETE")),
  ).toBe(false);
  expect(relativeFiles(restoredDirectory).some(journalOrSession)).toBe(false);

  const restoredTables = captureSqlite(
    join(restoredDirectory, "workspace.sqlite"),
  );
  expect(restoredTables).toEqual(sourceTables);
  expect(capturedAssets(restoredDirectory)).toEqual(sourceAssets);

  const reopened = openStore(restoredDirectory);
  const restoredLogical = reopened.load();
  expect(restoredLogical).toEqual(sourceLogical);

  for (const page of sourceLogical.pages) {
    const restoredPage = reopened.get(page.id);
    expect(restoredPage.revision).toBe(page.revision);
    expect(restoredPage.deletedAt).toBe(page.deletedAt);
  }
  expect(reopened.get(fixture.extras.trashedPageId).deletedAt).toEqual(
    expect.any(Number),
  );
  expect(reopened.get(fixture.extras.trashedRecordId).deletedAt).toEqual(
    expect.any(Number),
  );

  const owner = reopened.get(fixture.r7.database.id);
  const sourceOwner = sourceLogical.pages.find(
    (page) => page.id === fixture.r7.database.id,
  )!;
  expect(owner.revision).toBe(sourceOwner.revision);
  expect(owner.database?.properties).toEqual(fixture.r7.database.properties);
  expect(
    owner.database?.views.map(({ id, name, type }) => ({ id, name, type })),
  ).toEqual(fixture.r7.database.views);
  expect(owner.database?.activeViewId).toBe(fixture.r7.database.activeViewId);

  const home = sourceLogical.pages.find(
    (page) => page.id === fixture.r7.pages.find((page) => page.role === "home")!.id,
  )!;
  const nested = reopened.get(
    fixture.r7.pages.find((page) => page.role === "nested")!.id,
  );
  expect(nested.parentId).toBe(home.id);
  expect(JSON.stringify(nested.doc)).toContain(fixture.r7.asset.url);
  expect(JSON.stringify(nested.doc)).toContain('"type":"image"');
  for (const record of fixture.r7.records) {
    expect(JSON.stringify(reopened.get(record.pageId).doc)).toContain(
      record.body,
    );
    const projection = restoredLogical.records?.find(
      (item) => item.pageId === record.pageId,
    );
    expect(projection?.values).toEqual(record.values);
  }

  const versionPageIds = (
    restoredTables.tables.versions as { pageId: string }[]
  ).map((row) => row.pageId);
  for (const record of fixture.r7.records)
    expect(versionPageIds).toContain(record.pageId);
  expect(versionPageIds).toContain(fixture.extras.savedPageId);
  expect(reopened.versions(fixture.extras.savedPageId).length).toBeGreaterThan(
    0,
  );

  const receiptIds = (
    restoredTables.tables.save_receipts as { operation_id: string }[]
  ).map((row) => row.operation_id);
  for (const operation of fixture.r7.operations)
    expect(receiptIds).toContain(operation.operationId);
  expect(receiptIds).toContain(fixture.extras.saveOperationId);

  const settings = Object.fromEntries(
    (restoredTables.tables.settings as { key: string; value: string }[]).map(
      (row) => [row.key, row.value],
    ),
  );
  expect(settings).toEqual(
    Object.fromEntries(
      (sourceTables.tables.settings as { key: string; value: string }[]).map(
        (row) => [row.key, row.value],
      ),
    ),
  );
  expect(settings.activePage).toBe(
    fixture.r7.pages.find((page) => page.role === "home")!.id,
  );
  expect(settings.theme).toBe("dark");
  expect(settings.sidebar).toBe("wide");
  expect(settings.expanded).toBe(fixture.extras.expandedSetting);

  expect(hashFile(join(restoredDirectory, fixture.r7.asset.storagePath))).toBe(
    fixture.r7.asset.sha256,
  );
  expect(
    readFileSync(join(restoredDirectory, fixture.r7.asset.storagePath)),
  ).toEqual(readFileSync(join(fixture.source, fixture.r7.asset.storagePath)));

  // Restore itself must leave both the source workspace and the snapshot alone.
  expect(captureSqlite(fixture.database)).toEqual(sourceTables);
  expect(capturedAssets(fixture.source)).toEqual(sourceAssets);
  expect(materialFiles(fixture.source)).toEqual(sourceFiles);
});

it("rejects corrupt, future-version, missing-asset, symlinked and traversing snapshots before publication", () => {
  const fixture = createFixture();
  const backup = createBackup(fixture);

  const corrupt = cloneBackup(backup, join(fixture.root, "corrupt-database"));
  writeFileSync(join(corrupt, "workspace.sqlite"), "not a SQLite database");
  expectRejectedBeforePublication(corrupt, fixture.root, "corrupt");

  const corruptManifest = cloneBackup(
    backup,
    join(fixture.root, "corrupt-manifest"),
  );
  writeFileSync(findManifest(corruptManifest), "{not json");
  expectRejectedBeforePublication(
    corruptManifest,
    fixture.root,
    "corrupt-manifest",
  );

  const future = cloneBackup(backup, join(fixture.root, "future-version"));
  const futureDb = new DatabaseSync(join(future, "workspace.sqlite"));
  try {
    futureDb.exec("PRAGMA user_version=5");
  } finally {
    futureDb.close();
  }
  expectRejectedBeforePublication(future, fixture.root, "future-version");

  const missing = cloneBackup(backup, join(fixture.root, "missing-asset"));
  const assetName = readdirSync(join(missing, "assets"))[0];
  expect(assetName).toBeTruthy();
  unlinkSync(join(missing, "assets", assetName));
  expectRejectedBeforePublication(missing, fixture.root, "missing-asset");

  const symlinked = cloneBackup(backup, join(fixture.root, "symlinked-asset"));
  const symlinkName = readdirSync(join(symlinked, "assets"))[0];
  const outsideAsset = join(fixture.root, "outside-asset.bin");
  writeFileSync(outsideAsset, "outside attachment");
  unlinkSync(join(symlinked, "assets", symlinkName));
  symlinkSync(outsideAsset, join(symlinked, "assets", symlinkName));
  expectRejectedBeforePublication(symlinked, fixture.root, "symlink");

  const traversing = cloneBackup(backup, join(fixture.root, "traversing-asset"));
  const traversingManifest = readManifest(traversing);
  const outsideVisibleAsset = join(fixture.root, "outside-visible.bin");
  writeFileSync(outsideVisibleAsset, "visible only through traversal");
  expect(traversingManifest.assets.length).toBeGreaterThan(0);
  traversingManifest.assets[0].path = "../outside-visible.bin";
  writeManifest(traversing, traversingManifest);
  expectRejectedBeforePublication(traversing, fixture.root, "traversal-asset");

  const traversingDatabase = cloneBackup(
    backup,
    join(fixture.root, "traversing-database"),
  );
  const databaseOut = join(fixture.root, "outside-workspace.sqlite");
  cpSync(join(traversingDatabase, "workspace.sqlite"), databaseOut);
  const databaseManifest = readManifest(traversingDatabase);
  databaseManifest.database.path = "../outside-workspace.sqlite";
  writeManifest(traversingDatabase, databaseManifest);
  expectRejectedBeforePublication(
    traversingDatabase,
    fixture.root,
    "traversal-database",
  );
});

it("rejects a stale preview fingerprint and an existing restore destination without publishing", () => {
  const fixture = createFixture();
  const first = createBackup(fixture);
  const firstVerified = verifyFullBackup(first.directory);

  const mutator = openStore(fixture.source);
  try {
    mutator.create(null, "page", "Changed after the first preview");
  } finally {
    closeStore(mutator);
  }

  const second = createBackup(fixture, "backup-after-change");
  const secondVerified = verifyFullBackup(second.directory);
  expect(secondVerified.fingerprint).not.toBe(firstVerified.fingerprint);

  const staleDestination = join(fixture.root, "stale-destination");
  expect(() =>
    restoreFullBackup(
      second.directory,
      staleDestination,
      firstVerified.fingerprint,
    ),
  ).toThrow();
  expect(existsSync(staleDestination)).toBe(false);

  const occupiedStale = join(fixture.root, "occupied-stale-destination");
  mkdirSync(occupiedStale);
  writeFileSync(join(occupiedStale, "sentinel.txt"), "keep");
  expect(() =>
    restoreFullBackup(
      second.directory,
      occupiedStale,
      firstVerified.fingerprint,
    ),
  ).toThrow();
  expect(readdirSync(occupiedStale)).toEqual(["sentinel.txt"]);
  expect(readFileSync(join(occupiedStale, "sentinel.txt"), "utf8")).toBe(
    "keep",
  );

  const occupied = join(fixture.root, "occupied-destination");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "sentinel.txt"), "keep");
  expect(() =>
    restoreFullBackup(second.directory, occupied, secondVerified.fingerprint),
  ).toThrow();
  expect(readdirSync(occupied)).toEqual(["sentinel.txt"]);
  expect(readFileSync(join(occupied, "sentinel.txt"), "utf8")).toBe("keep");
});

it("never overwrites an existing backup destination", () => {
  const fixture = createFixture();
  const destination = join(fixture.root, "occupied-backup");
  mkdirSync(destination);
  writeFileSync(join(destination, "workspace.sqlite"), "existing database");
  writeFileSync(join(destination, "sentinel.txt"), "keep");

  const store = openStore(fixture.source);
  try {
    expect(() =>
      createFullBackup(store.db, fixture.source, destination),
    ).toThrow();
  } finally {
    closeStore(store);
  }
  expect(readFileSync(join(destination, "workspace.sqlite"), "utf8")).toBe(
    "existing database",
  );
  expect(readFileSync(join(destination, "sentinel.txt"), "utf8")).toBe("keep");
});

it("blocks a normal Store from opening a FOLIO-RECOVERY-INCOMPLETE workspace", () => {
  const root = tempRoot();
  const directory = join(root, "incomplete-workspace");
  const store = openStore(directory);
  store.create(null, "page", "Preserve me");
  closeStore(store);

  const marker = join(directory, "FOLIO-RECOVERY-INCOMPLETE");
  writeFileSync(marker, "recovery was interrupted");
  expect(() => new Store(join(directory, "workspace.sqlite"))).toThrow(
    /復旧/,
  );
  expect(readFileSync(marker, "utf8")).toBe("recovery was interrupted");
});
