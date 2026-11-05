import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { estimateBackupBytes } from "../src/main/bulk-storage-budget";
import { durableFs } from "../src/persistence/durable-file";
import { Store } from "../src/persistence/store";
import { migrateWorkspace } from "../src/persistence/workspace";

const MARKER = "FOLIO-RECOVERY-INCOMPLETE";
const roots: string[] = [];
const databases: DatabaseSync[] = [];
const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeDigest(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, {
      withFileTypes: true,
    }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path, relative);
        continue;
      }
      files[relative] = sha256(path);
    }
  };
  walk(root, "");
  return files;
}

function legacyWorkspace(prefix: string) {
  const root = tempRoot(prefix);
  const source = join(root, "source");
  const assets = join(source, "assets");
  mkdirSync(assets, { recursive: true });
  const database = new DatabaseSync(join(source, "workspace.sqlite"));
  databases.push(database);
  database.exec(`
    CREATE TABLE pages(id TEXT PRIMARY KEY, data TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE versions(id INTEGER PRIMARY KEY AUTOINCREMENT, pageId TEXT NOT NULL, createdAt INTEGER NOT NULL, title TEXT NOT NULL, doc TEXT NOT NULL);
    PRAGMA user_version=1;
  `);
  database.prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)").run(
    "legacy-page",
    JSON.stringify({ title: "旧ページ", icon: null }),
    JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "旧本文" }] },
      ],
    }),
  );
  database
    .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
    .run("theme", "classic");
  database
    .prepare("INSERT INTO versions(pageId,createdAt,title,doc) VALUES(?,?,?,?)")
    .run("legacy-page", 1, "旧履歴", '{"type":"doc","content":[]}');
  writeFileSync(join(assets, "orphan.bin"), Buffer.alloc(700, 3));
  mkdirSync(join(assets, "nested"));
  writeFileSync(join(assets, "nested", "deep.dat"), Buffer.alloc(4096, 7));
  mkdirSync(join(assets, "empty"));
  return { root, source, assets, database };
}

function pageCount(database: DatabaseSync): number {
  return (database.prepare("PRAGMA page_count").get() as { page_count: number })
    .page_count;
}

function pageSize(database: DatabaseSync): number {
  return (database.prepare("PRAGMA page_size").get() as { page_size: number })
    .page_size;
}

it("migrates a legacy database and unregistered nested assets while retaining the source and a usable backup", () => {
  const fixture = legacyWorkspace("folio-r5-import-legacy-");
  const destination = join(fixture.root, "imported");
  const sourceRootEntries = readdirSync(fixture.source).sort();
  const sourceDatabaseHash = sha256(join(fixture.source, "workspace.sqlite"));
  const sourceAssets = treeDigest(fixture.assets);
  fixture.database.close();

  const result = migrateWorkspace(fixture.source, destination);
  expect(result.destination).toBe(destination);
  expect(result.backup.startsWith(destination + ".backup-")).toBe(true);
  expect(sha256(join(fixture.source, "workspace.sqlite"))).toBe(
    sourceDatabaseHash,
  );
  expect(treeDigest(fixture.assets)).toEqual(sourceAssets);
  expect(readdirSync(fixture.source).sort()).toEqual(sourceRootEntries);

  for (const copy of [result.destination, result.backup]) {
    expect(existsSync(join(copy, MARKER))).toBe(false);
    expect(
      JSON.parse(readFileSync(join(copy, "manifest.json"), "utf8")),
    ).toMatchObject({ app: "Folio", format: 1 });
    expect(treeDigest(join(copy, "assets"))).toEqual(sourceAssets);
    expect(statSync(join(copy, "assets", "empty")).isDirectory()).toBe(true);
    const database = new DatabaseSync(join(copy, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      expect(
        (
          database.prepare("PRAGMA user_version").get() as {
            user_version: number;
          }
        ).user_version,
      ).toBe(1);
      expect(database.prepare("SELECT count(*) AS n FROM pages").get()?.n).toBe(
        1,
      );
      expect(
        database.prepare("SELECT value FROM settings WHERE key='theme'").get()
          ?.value,
      ).toBe("classic");
      expect(
        database.prepare("SELECT count(*) AS n FROM versions").get()?.n,
      ).toBe(1);
    } finally {
      database.close();
    }
  }
});

it("estimates both complete copies and calls beforeCopy before any output or parent creation", () => {
  const fixture = legacyWorkspace("folio-r5-import-budget-");
  const expected = estimateBackupBytes(fixture.database, fixture.source) * 2;
  const destination = join(fixture.root, "missing-parent", "imported");
  const sourceEntries = readdirSync(fixture.source).sort();
  const sourceAssets = treeDigest(fixture.assets);
  const sourceDatabaseHash = sha256(join(fixture.source, "workspace.sqlite"));

  const beforeCopy = vi.fn((parent: string, bytes: number) => {
    expect(parent).toBe(fixture.root);
    expect(bytes).toBe(expected);
    expect(bytes).toBeGreaterThan(0);
    expect(existsSync(join(fixture.root, "missing-parent"))).toBe(false);
    expect(existsSync(destination)).toBe(false);
    throw new Error("capacity-exceeded test");
  });
  expect(() =>
    migrateWorkspace(fixture.source, destination, { beforeCopy }),
  ).toThrow(/capacity-exceeded/);
  expect(beforeCopy).toHaveBeenCalledTimes(1);
  expect(existsSync(join(fixture.root, "missing-parent"))).toBe(false);
  expect(readdirSync(fixture.root).sort()).toEqual(["source"]);
  expect(readdirSync(fixture.source).sort()).toEqual(sourceEntries);
  expect(sha256(join(fixture.source, "workspace.sqlite"))).toBe(
    sourceDatabaseHash,
  );
  expect(treeDigest(fixture.assets)).toEqual(sourceAssets);
});

it("includes WAL-resident logical pages and unregistered assets in the two-copy budget", () => {
  const fixture = legacyWorkspace("folio-r5-import-wal-budget-");
  fixture.database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE warm(value BLOB);",
  );
  const insert = fixture.database.prepare("INSERT INTO warm(value) VALUES(?)");
  for (let index = 0; index < 80; index++)
    insert.run(Buffer.alloc(2048, index));
  expect(
    statSync(join(fixture.source, "workspace.sqlite-wal")).size,
  ).toBeGreaterThan(0);
  const logicalBytes = pageCount(fixture.database) * pageSize(fixture.database);
  expect(logicalBytes).toBeGreaterThan(
    statSync(join(fixture.source, "workspace.sqlite")).size,
  );
  const oneCopy = estimateBackupBytes(fixture.database, fixture.source);
  const assetBytes =
    statSync(join(fixture.assets, "orphan.bin")).size +
    statSync(join(fixture.assets, "nested", "deep.dat")).size;
  expect(oneCopy).toBeGreaterThan(logicalBytes + assetBytes);
  const walPath = join(fixture.source, "workspace.sqlite-wal");
  const walHash = sha256(walPath);
  const mainHash = sha256(join(fixture.source, "workspace.sqlite"));

  let observed = -1;
  expect(() =>
    migrateWorkspace(fixture.source, join(fixture.root, "imported"), {
      beforeCopy: (_parent, bytes) => {
        observed = bytes;
        throw new Error("capacity-exceeded test");
      },
    }),
  ).toThrow(/capacity-exceeded/);
  expect(observed).toBe(oneCopy * 2);
  expect(existsSync(join(fixture.root, "imported"))).toBe(false);
  expect(sha256(walPath)).toBe(walHash);
  expect(sha256(join(fixture.source, "workspace.sqlite"))).toBe(mainHash);
});

it("snapshots committed WAL content instead of copying only the main database file", () => {
  const fixture = legacyWorkspace("folio-r5-import-wal-snapshot-");
  fixture.database.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE warm(value BLOB);",
  );
  const insert = fixture.database.prepare("INSERT INTO warm(value) VALUES(?)");
  for (let index = 0; index < 40; index++)
    insert.run(Buffer.alloc(2048, index));
  const walPath = join(fixture.source, "workspace.sqlite-wal");
  expect(statSync(walPath).size).toBeGreaterThan(0);
  const walHash = sha256(walPath);
  const mainHash = sha256(join(fixture.source, "workspace.sqlite"));
  const assets = treeDigest(fixture.assets);

  const destination = join(fixture.root, "imported");
  const result = migrateWorkspace(fixture.source, destination);
  expect(sha256(join(fixture.source, "workspace.sqlite"))).toBe(mainHash);
  expect(sha256(walPath)).toBe(walHash);
  expect(treeDigest(fixture.assets)).toEqual(assets);
  for (const copy of [result.destination, result.backup]) {
    const database = new DatabaseSync(join(copy, "workspace.sqlite"), {
      readOnly: true,
    });
    try {
      expect(database.prepare("SELECT count(*) AS n FROM warm").get()?.n).toBe(
        40,
      );
      expect(database.prepare("SELECT count(*) AS n FROM pages").get()?.n).toBe(
        1,
      );
    } finally {
      database.close();
    }
  }
});

it("refuses existing and stale targets, including empty directories and dangling links, without clobbering them", () => {
  const fixture = legacyWorkspace("folio-r5-import-stale-");
  fixture.database.close();
  const empty = join(fixture.root, "empty-target");
  mkdirSync(empty);
  expect(() => migrateWorkspace(fixture.source, empty)).toThrow(/移行先/);
  expect(readdirSync(empty)).toEqual([]);

  const occupied = join(fixture.root, "occupied-target");
  mkdirSync(occupied);
  writeFileSync(join(occupied, "keep.txt"), "keep");
  expect(() => migrateWorkspace(fixture.source, occupied)).toThrow(/移行先/);
  expect(readFileSync(join(occupied, "keep.txt"), "utf8")).toBe("keep");

  const dangling = join(fixture.root, "dangling-target");
  symlinkSync(join(fixture.root, "missing"), dangling);
  expect(() => migrateWorkspace(fixture.source, dangling)).toThrow(/移行先/);
  expect(() => readdirSync(dangling)).toThrow();

  const names = readdirSync(fixture.root);
  expect(names.some((name) => name.includes(".backup-"))).toBe(false);
  expect(names.some((name) => name.includes(".staging-"))).toBe(false);
});

it("rejects canonical source/destination aliases, including symlinked existing ancestors", () => {
  const fixture = legacyWorkspace("folio-r5-import-alias-");
  fixture.database.close();
  const sourceAssets = treeDigest(fixture.assets);

  expect(() =>
    migrateWorkspace(fixture.source, join(fixture.source, "child")),
  ).toThrow(/移行先|移行元/);
  expect(existsSync(join(fixture.source, "child"))).toBe(false);

  const alias = join(fixture.root, "source-alias");
  symlinkSync(fixture.source, alias);
  expect(() => migrateWorkspace(alias, join(alias, "child"))).toThrow(
    /移行先|移行元|シンボリック/,
  );
  expect(existsSync(join(fixture.source, "child"))).toBe(false);

  const parentAlias = join(fixture.root, "parent-alias");
  symlinkSync(fixture.root, parentAlias);
  const sourceThroughParentAlias = join(parentAlias, "source");
  expect(() =>
    migrateWorkspace(sourceThroughParentAlias, join(fixture.source, "child-2")),
  ).toThrow(/移行先|移行元/);
  expect(existsSync(join(fixture.source, "child-2"))).toBe(false);
  expect(treeDigest(fixture.assets)).toEqual(sourceAssets);
});

it("canonicalizes a disjoint symlinked destination parent for admission and writing", () => {
  const fixture = legacyWorkspace("folio-r5-import-parent-alias-");
  fixture.database.close();
  const realParent = join(fixture.root, "real-parent");
  mkdirSync(realParent);
  const alias = join(fixture.root, "target-alias");
  symlinkSync(realParent, alias);
  const destination = join(alias, "imported");
  let admittedParent = "";

  const result = migrateWorkspace(fixture.source, destination, {
    beforeCopy: (parent, bytes) => {
      admittedParent = parent;
      expect(bytes).toBeGreaterThan(0);
    },
  });
  expect(admittedParent).toBe(realParent);
  expect(result.destination).toBe(destination);
  expect(existsSync(destination)).toBe(true);
  expect(existsSync(join(realParent, "imported", "workspace.sqlite"))).toBe(
    true,
  );
  expect(existsSync(result.backup)).toBe(true);
  expect(existsSync(join(destination, MARKER))).toBe(false);
});

it("does not publish when the hook exposes an existing destination race", () => {
  const fixture = legacyWorkspace("folio-r5-import-hook-race-");
  fixture.database.close();
  const destination = join(fixture.root, "imported");
  expect(() =>
    migrateWorkspace(fixture.source, destination, {
      beforeCopy: () => {
        mkdirSync(destination);
        writeFileSync(join(destination, "keep.txt"), "keep");
      },
    }),
  ).toThrow(/移行先/);
  expect(readFileSync(join(destination, "keep.txt"), "utf8")).toBe("keep");
  const names = readdirSync(fixture.root);
  expect(names.some((name) => name.includes(".backup-"))).toBe(false);
  expect(names.some((name) => name.includes(".staging-"))).toBe(false);
});

it("fails closed for incomplete, linked and corrupt sources before creating a destination", () => {
  const incomplete = legacyWorkspace("folio-r5-import-incomplete-");
  writeFileSync(join(incomplete.source, MARKER), "incomplete");
  expect(() =>
    migrateWorkspace(incomplete.source, join(incomplete.root, "imported")),
  ).toThrow(/未完了/);
  expect(existsSync(join(incomplete.root, "imported"))).toBe(false);

  const linkedAssets = legacyWorkspace("folio-r5-import-linked-assets-");
  const realAssets = join(linkedAssets.root, "real-assets");
  mkdirSync(realAssets);
  writeFileSync(join(realAssets, "file.bin"), "attachment");
  rmSync(linkedAssets.assets, { recursive: true });
  symlinkSync(realAssets, linkedAssets.assets);
  expect(() =>
    migrateWorkspace(linkedAssets.source, join(linkedAssets.root, "imported")),
  ).toThrow(/シンボリック/);
  expect(existsSync(join(linkedAssets.root, "imported"))).toBe(false);
  expect(readFileSync(join(realAssets, "file.bin"), "utf8")).toBe("attachment");

  const linkedDatabase = legacyWorkspace("folio-r5-import-linked-db-");
  linkedDatabase.database.close();
  const actualDatabase = join(linkedDatabase.root, "actual.sqlite");
  renameSync(join(linkedDatabase.source, "workspace.sqlite"), actualDatabase);
  symlinkSync(actualDatabase, join(linkedDatabase.source, "workspace.sqlite"));
  expect(() =>
    migrateWorkspace(
      linkedDatabase.source,
      join(linkedDatabase.root, "imported"),
    ),
  ).toThrow(/シンボリック/);
  expect(existsSync(join(linkedDatabase.root, "imported"))).toBe(false);

  const linkedRoot = legacyWorkspace("folio-r5-import-linked-root-");
  linkedRoot.database.close();
  const rootAlias = join(linkedRoot.root, "source-alias");
  symlinkSync(linkedRoot.source, rootAlias);
  expect(() =>
    migrateWorkspace(rootAlias, join(linkedRoot.root, "imported")),
  ).toThrow(/シンボリック/);
  expect(existsSync(join(linkedRoot.root, "imported"))).toBe(false);

  const corrupt = tempRoot("folio-r5-import-corrupt-");
  const corruptSource = join(corrupt, "source");
  mkdirSync(join(corruptSource, "assets"), { recursive: true });
  writeFileSync(join(corruptSource, "workspace.sqlite"), "not sqlite");
  expect(() =>
    migrateWorkspace(corruptSource, join(corrupt, "imported")),
  ).toThrow();
  expect(existsSync(join(corrupt, "imported"))).toBe(false);
  expect(readFileSync(join(corruptSource, "workspace.sqlite"), "utf8")).toBe(
    "not sqlite",
  );
});

function instrumentFsync(fail: (path: string) => boolean) {
  const originals = {
    openSync: durableFs.openSync,
    fsyncSync: durableFs.fsyncSync,
    closeSync: durableFs.closeSync,
  };
  const paths = new Map<number, string>();
  durableFs.openSync = ((...args: Parameters<typeof originals.openSync>) => {
    const descriptor = originals.openSync(...args);
    if (typeof args[0] === "string") paths.set(descriptor, resolve(args[0]));
    return descriptor;
  }) as unknown as typeof durableFs.openSync;
  durableFs.closeSync = ((...args: Parameters<typeof originals.closeSync>) => {
    try {
      return originals.closeSync(...args);
    } finally {
      paths.delete(args[0]);
    }
  }) as unknown as typeof durableFs.closeSync;
  durableFs.fsyncSync = ((...args: Parameters<typeof originals.fsyncSync>) => {
    const path = paths.get(args[0]) ?? "";
    if (fail(path)) throw new Error("simulated fsync failure: " + path);
    return originals.fsyncSync(...args);
  }) as unknown as typeof durableFs.fsyncSync;
  restores.push(() => Object.assign(durableFs, originals));
}

it("keeps an incomplete backup and starts no staging when a backup asset flush fails", () => {
  const fixture = legacyWorkspace("folio-r5-import-backup-fault-");
  fixture.database.close();
  const sourceDatabaseHash = sha256(join(fixture.source, "workspace.sqlite"));
  const sourceAssets = treeDigest(fixture.assets);
  let injected = false;
  instrumentFsync((path) => {
    if (!injected && path.includes(".backup-") && path.endsWith("/deep.dat")) {
      injected = true;
      return true;
    }
    return false;
  });

  const destination = join(fixture.root, "imported");
  expect(() => migrateWorkspace(fixture.source, destination)).toThrow(
    /simulated fsync failure/,
  );
  expect(injected).toBe(true);
  expect(existsSync(destination)).toBe(false);
  const names = readdirSync(fixture.root);
  const backupName = names.find((name) => name.includes(".backup-"));
  expect(backupName).toBeDefined();
  expect(existsSync(join(fixture.root, backupName!, MARKER))).toBe(true);
  expect(names.some((name) => name.includes(".staging-"))).toBe(false);
  expect(sha256(join(fixture.source, "workspace.sqlite"))).toBe(
    sourceDatabaseHash,
  );
  expect(treeDigest(fixture.assets)).toEqual(sourceAssets);
});

it("keeps the staging marker and complete backup when a staged asset flush fails", () => {
  const fixture = legacyWorkspace("folio-r5-import-stage-fault-");
  fixture.database.close();
  const sourceDatabaseHash = sha256(join(fixture.source, "workspace.sqlite"));
  const sourceAssets = treeDigest(fixture.assets);
  let injected = false;
  instrumentFsync((path) => {
    if (!injected && path.includes(".staging-") && path.endsWith("/deep.dat")) {
      injected = true;
      return true;
    }
    return false;
  });

  const destination = join(fixture.root, "imported");
  expect(() => migrateWorkspace(fixture.source, destination)).toThrow(
    /simulated fsync failure/,
  );
  expect(injected).toBe(true);
  expect(existsSync(destination)).toBe(false);
  const names = readdirSync(fixture.root);
  const backupName = names.find((name) => name.includes(".backup-"));
  const stagingName = names.find((name) => name.includes(".staging-"));
  expect(backupName).toBeDefined();
  expect(stagingName).toBeDefined();
  expect(existsSync(join(fixture.root, backupName!, MARKER))).toBe(false);
  expect(existsSync(join(fixture.root, stagingName!, MARKER))).toBe(true);
  expect(sha256(join(fixture.source, "workspace.sqlite"))).toBe(
    sourceDatabaseHash,
  );
  expect(treeDigest(fixture.assets)).toEqual(sourceAssets);
});

it("leaves an incomplete guard when the parent flush after publish fails", () => {
  const fixture = legacyWorkspace("folio-r5-import-publish-parent-fault-");
  fixture.database.close();
  const destination = join(fixture.root, "imported");
  const originalSyncPath = durableFs.syncPath;
  durableFs.syncPath = (path: string) => {
    if (
      resolve(path) === fixture.root &&
      existsSync(destination) &&
      existsSync(join(destination, MARKER))
    )
      throw new Error("simulated parent fsync failure");
    return originalSyncPath(path);
  };
  restores.push(() => {
    durableFs.syncPath = originalSyncPath;
  });

  expect(() => migrateWorkspace(fixture.source, destination)).toThrow(
    /simulated parent fsync failure/,
  );
  expect(existsSync(destination)).toBe(true);
  expect(existsSync(join(destination, MARKER))).toBe(true);
  expect(() => new Store(join(destination, "workspace.sqlite"))).toThrow(
    /復旧/,
  );
  const backupName = readdirSync(fixture.root).find((name) =>
    name.includes(".backup-"),
  );
  expect(backupName).toBeDefined();
  expect(existsSync(join(fixture.root, backupName!, MARKER))).toBe(false);
});

it("restores the incomplete guard when the final destination flush fails", () => {
  const fixture = legacyWorkspace("folio-r5-import-publish-final-fault-");
  fixture.database.close();
  const destination = join(fixture.root, "imported");
  const originalSyncPath = durableFs.syncPath;
  durableFs.syncPath = (path: string) => {
    if (
      resolve(path) === destination &&
      !existsSync(join(destination, MARKER)) &&
      existsSync(join(destination, "workspace.sqlite"))
    )
      throw new Error("simulated final fsync failure");
    return originalSyncPath(path);
  };
  restores.push(() => {
    durableFs.syncPath = originalSyncPath;
  });

  expect(() => migrateWorkspace(fixture.source, destination)).toThrow(
    /simulated final fsync failure/,
  );
  expect(existsSync(destination)).toBe(true);
  expect(existsSync(join(destination, MARKER))).toBe(true);
  expect(() => new Store(join(destination, "workspace.sqlite"))).toThrow(
    /復旧/,
  );
  const backupName = readdirSync(fixture.root).find((name) =>
    name.includes(".backup-"),
  );
  expect(backupName).toBeDefined();
  expect(existsSync(join(fixture.root, backupName!, MARKER))).toBe(false);
});
