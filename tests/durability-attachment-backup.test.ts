import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import {
  durableFs,
  writeNewFileDurably,
} from "../src/persistence/durable-file";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { Store } from "../src/persistence/store";

const roots: string[] = [];
const stores: Store[] = [];
const databases: DatabaseSync[] = [];
const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length) restores.pop()!();
  for (const database of databases.splice(0)) {
    try {
      database.close();
    } catch {}
  }
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  // Resolve the platform temp alias (for example /var -> /private/var) so the
  // backup creator's canonical destination has the same path the test records.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/**
 * A narrowly scoped seam over the production durability operations. It maps
 * descriptors back to paths so individual file or directory fsync failures can
 * be injected without replacing node:fs globally.
 */
function instrumentFs(
  failFsync?: (path: string, count: number) => boolean,
) {
  const originals = {
    openSync: durableFs.openSync,
    writeFileSync: durableFs.writeFileSync,
    fsyncSync: durableFs.fsyncSync,
    closeSync: durableFs.closeSync,
    unlinkSync: durableFs.unlinkSync,
    syncPath: durableFs.syncPath,
  };
  const descriptors = new Map<number, string>();
  const events: string[] = [];
  let count = 0;

  durableFs.openSync = ((...args: Parameters<typeof originals.openSync>) => {
    const descriptor = originals.openSync(...args);
    descriptors.set(descriptor, resolve(String(args[0])));
    return descriptor;
  }) as unknown as typeof durableFs.openSync;
  durableFs.closeSync = ((...args: Parameters<typeof originals.closeSync>) => {
    try {
      return originals.closeSync(...args);
    } finally {
      descriptors.delete(args[0]);
    }
  }) as unknown as typeof durableFs.closeSync;
  durableFs.fsyncSync = ((...args: Parameters<typeof originals.fsyncSync>) => {
    const path = descriptors.get(args[0]) ?? "<unknown>";
    count++;
    events.push("fsync:" + path);
    if (failFsync?.(path, count))
      throw new Error("simulated fsync failure: " + path);
    return originals.fsyncSync(...args);
  }) as unknown as typeof durableFs.fsyncSync;

  return {
    events,
    restore() {
      Object.assign(durableFs, originals);
    },
  };
}

function assetDatabase(root: string): DatabaseSync {
  const database = new DatabaseSync(join(root, "workspace.sqlite"));
  databases.push(database);
  database.exec(
    "CREATE TABLE assets(id TEXT PRIMARY KEY, metadata TEXT NOT NULL)",
  );
  return database;
}

function countAssets(database: DatabaseSync): number {
  return (
    database.prepare("SELECT count(*) AS n FROM assets").get() as { n: number }
  ).n;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

it("never replaces or deletes an existing file when exclusive creation fails", () => {
  const root = tempRoot("folio-durability-exclusive-");
  const target = join(root, "existing.bin");
  writeFileSync(target, Buffer.from("keep"));

  expect(() => writeNewFileDurably(target, Buffer.from("new"))).toThrow(
    /EEXIST/,
  );
  expect(readFileSync(target)).toEqual(Buffer.from("keep"));
});

it("fsyncs a new attachment body and its directory before inserting metadata", () => {
  const root = tempRoot("folio-durability-attach-order-");
  const assets = join(root, "assets");
  mkdirSync(assets);
  const input = join(root, "input.txt");
  writeFileSync(input, Buffer.from("attachment body"));
  const database = assetDatabase(root);
  const h = instrumentFs();
  restores.push(h.restore);

  const statement = database.prepare.bind(database);
  const wrapped = {
    prepare(sql: string) {
      const prepared = statement(sql);
      if (/^\s*INSERT\s+INTO\s+assets/i.test(sql))
        return {
          run(...args: unknown[]) {
            h.events.push("insert");
            return prepared.run(...(args as any[]));
          },
        };
      return prepared;
    },
  } as unknown as DatabaseSync;

  const attachment = attachFile(wrapped, assets, input) as {
    storageName: string;
  };
  expect(h.events).toEqual([
    "fsync:" + resolve(join(assets, attachment.storageName)),
    "fsync:" + resolve(assets),
    "insert",
  ]);
  expect(readFileSync(join(assets, attachment.storageName))).toEqual(
    Buffer.from("attachment body"),
  );
  expect(countAssets(database)).toBe(1);
});

it("does not register or leave a new file when the attachment body fsync fails", () => {
  const root = tempRoot("folio-durability-attach-file-fsync-");
  const assets = join(root, "assets");
  mkdirSync(assets);
  const input = join(root, "input.txt");
  writeFileSync(input, Buffer.from("new bytes"));
  const existing = join(assets, "existing.bin");
  writeFileSync(existing, Buffer.from("keep"));
  const database = assetDatabase(root);
  database
    .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
    .run("existing", "{}");
  const h = instrumentFs((_path, count) => count === 1);
  restores.push(h.restore);

  expect(() => attachFile(database, assets, input)).toThrow(
    /simulated fsync failure/,
  );
  expect(readdirSync(assets).sort()).toEqual(["existing.bin"]);
  expect(readFileSync(existing)).toEqual(Buffer.from("keep"));
  expect(countAssets(database)).toBe(1);
});

it("does not register or leave a new file when the assets directory fsync fails", () => {
  const root = tempRoot("folio-durability-attach-dir-fsync-");
  const assets = join(root, "assets");
  mkdirSync(assets);
  const input = join(root, "input.txt");
  writeFileSync(input, Buffer.from("new bytes"));
  const existing = join(assets, "existing.bin");
  writeFileSync(existing, Buffer.from("keep"));
  const database = assetDatabase(root);
  database
    .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
    .run("existing", "{}");
  const h = instrumentFs((path) => path === resolve(assets));
  restores.push(h.restore);

  expect(() => attachFile(database, assets, input)).toThrow(
    /simulated fsync failure/,
  );
  expect(readdirSync(assets).sort()).toEqual(["existing.bin"]);
  expect(readFileSync(existing)).toEqual(Buffer.from("keep"));
  expect(countAssets(database)).toBe(1);
});

it("keeps existing asset data and leaves the new body when INSERT is aborted", () => {
  const root = tempRoot("folio-durability-attach-insert-");
  const assets = join(root, "assets");
  mkdirSync(assets);
  const input = join(root, "input.txt");
  writeFileSync(input, Buffer.from("new bytes"));
  const existing = join(assets, "existing.bin");
  writeFileSync(existing, Buffer.from("keep"));
  const database = assetDatabase(root);
  database
    .prepare("INSERT INTO assets(id,metadata) VALUES(?,?)")
    .run("existing", '{"id":"existing"}');
  database.exec(
    "CREATE TRIGGER fail_asset_insert AFTER INSERT ON assets BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END",
  );
  const before = readdirSync(assets).sort();

  expect(() => attachFile(database, assets, input)).toThrow(
    /simulated insert failure/,
  );
  expect(countAssets(database)).toBe(1);
  expect(
    (
      database.prepare("SELECT metadata FROM assets WHERE id='existing'").get() as {
        metadata: string;
      }
    ).metadata,
  ).toBe('{"id":"existing"}');
  expect(readFileSync(existing)).toEqual(Buffer.from("keep"));
  const added = readdirSync(assets)
    .sort()
    .filter((name) => !before.includes(name));
  // The generic error path cannot assume whether a commit occurred. Even in
  // this definite rollback case it conservatively retains the orphan body.
  expect(added).toHaveLength(1);
  expect(readFileSync(join(assets, added[0]))).toEqual(Buffer.from("new bytes"));
});

it("keeps a registered body when INSERT commits but the caller receives an error", () => {
  const root = tempRoot("folio-durability-attach-lost-ack-");
  const assets = join(root, "assets");
  mkdirSync(assets);
  const input = join(root, "input.txt");
  writeFileSync(input, Buffer.from("committed body"));
  const database = assetDatabase(root);
  const wrapped = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      if (/^\s*INSERT\s+INTO\s+assets/i.test(sql)) return {
        run(...args: any[]) {
          statement.run(...args);
          throw new Error("simulated lost acknowledgement");
        },
      };
      return statement;
    },
  } as unknown as DatabaseSync;
  expect(() => attachFile(wrapped, assets, input)).toThrow(/lost acknowledgement/);
  expect(countAssets(database)).toBe(1);
  const row = database.prepare("SELECT metadata FROM assets").get() as { metadata: string };
  const metadata = JSON.parse(row.metadata);
  expect(readFileSync(join(assets, metadata.storageName))).toEqual(Buffer.from("committed body"));
});

it("preserves the original fsync failure when descriptor cleanup also fails", () => {
  const root = tempRoot("folio-durability-close-error-");
  const originalSync = durableFs.fsyncSync;
  const originalClose = durableFs.closeSync;
  restores.push(() => { durableFs.fsyncSync = originalSync; durableFs.closeSync = originalClose; });
  durableFs.fsyncSync = () => { throw new Error("primary fsync failure"); };
  durableFs.closeSync = (fd) => { originalClose(fd); throw new Error("secondary close failure"); };
  expect(() => durableFs.syncPath(root)).toThrow("primary fsync failure");
});

function backupFixture() {
  const root = tempRoot("folio-durability-backup-");
  const source = join(root, "source");
  mkdirSync(source);
  const store = new Store(join(source, "workspace.sqlite"));
  stores.push(store);
  store.create(null, "page", "Page");
  const assets = join(source, "assets");
  mkdirSync(assets);
  const rootFile = join(assets, "root.bin");
  writeFileSync(rootFile, Buffer.from("root bytes"));
  return { root, source, store, assets, rootFile };
}

function nestedBackupFixture() {
  const fixture = backupFixture();
  const nested = join(fixture.assets, "nested");
  mkdirSync(nested);
  const nestedFile = join(nested, "deep.bin");
  writeFileSync(nestedFile, Buffer.from("nested bytes"));
  return { ...fixture, nestedFile };
}

it("flushes a copied attachment body before its directory and the completed destination", () => {
  const fixture = backupFixture();
  const h = instrumentFs();
  restores.push(h.restore);
  const destination = join(fixture.root, "backup");

  const result = createFullBackup(
    fixture.store.db,
    fixture.source,
    destination,
  );
  expect(result.directory).toBe(destination);
  expect(existsSync(join(destination, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(
    false,
  );

  const fileEvent = "fsync:" + resolve(join(destination, "assets", "root.bin"));
  const assetsDirectoryEvent =
    "fsync:" + resolve(join(destination, "assets"));
  const targetEvent = "fsync:" + resolve(destination);
  const fileIndex = h.events.indexOf(fileEvent);
  const assetsIndex = h.events.indexOf(assetsDirectoryEvent);
  expect(fileIndex).toBeGreaterThanOrEqual(0);
  expect(assetsIndex).toBeGreaterThan(fileIndex);
  expect(h.events.lastIndexOf(targetEvent)).toBeGreaterThan(assetsIndex);
  expect(h.events).toContain("fsync:" + fixture.root);
});

it("flushes nested copies bottom-up but preserves the verifier's flat-assets contract", () => {
  const fixture = nestedBackupFixture();
  const destination = join(fixture.root, "backup");
  const h = instrumentFs();
  restores.push(h.restore);
  // The existing backup format accepts flat assets only. Copy traversal may
  // encounter nested source entries, but must not publish an invalid manifest.
  expect(() => createFullBackup(fixture.store.db, fixture.source, destination)).toThrow(/not a regular file/);
  const nestedFileIndex = h.events.indexOf("fsync:" + join(destination, "assets", "nested", "deep.bin"));
  const nestedDirectoryIndex = h.events.indexOf("fsync:" + join(destination, "assets", "nested"));
  const assetsIndex = h.events.indexOf("fsync:" + join(destination, "assets"));
  expect(nestedFileIndex).toBeGreaterThanOrEqual(0);
  expect(nestedDirectoryIndex).toBeGreaterThan(nestedFileIndex);
  expect(assetsIndex).toBeGreaterThan(nestedDirectoryIndex);
  expect(existsSync(join(destination, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(true);
  expect(existsSync(join(destination, "manifest.json"))).toBe(false);
  expect(readFileSync(fixture.nestedFile)).toEqual(Buffer.from("nested bytes"));
});

it("does not publish a backup when persisting its parent directory fails", () => {
  const fixture = backupFixture();
  const destination = join(fixture.root, "backup");
  const h = instrumentFs((path) => path === fixture.root);
  restores.push(h.restore);
  expect(() => createFullBackup(fixture.store.db, fixture.source, destination)).toThrow(/simulated fsync failure/);
  expect(existsSync(join(destination, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(true);
  expect(existsSync(join(destination, "manifest.json"))).toBe(false);
  expect(readFileSync(fixture.rootFile)).toEqual(Buffer.from("root bytes"));
});

it("restores the incomplete guard if the final directory fsync fails after verification", () => {
  const fixture = backupFixture();
  const destination = join(fixture.root, "backup");
  const marker = join(destination, "FOLIO-RECOVERY-INCOMPLETE");
  const h = instrumentFs((path) => path === destination && !existsSync(marker));
  restores.push(h.restore);
  expect(() => createFullBackup(fixture.store.db, fixture.source, destination)).toThrow(/simulated fsync failure/);
  expect(existsSync(join(destination, "manifest.json"))).toBe(true);
  expect(readFileSync(marker, "utf8")).toContain("Backup incomplete");
  expect(readFileSync(fixture.rootFile)).toEqual(Buffer.from("root bytes"));
});

it("keeps the incomplete marker and source data when a nested backup file fsync fails", () => {
  const fixture = nestedBackupFixture();
  const destination = join(fixture.root, "backup");
  const nestedCopy = join(destination, "assets", "nested", "deep.bin");
  const h = instrumentFs((path) => path === resolve(nestedCopy));
  restores.push(h.restore);
  const sourceDatabaseHash = sha256(join(fixture.source, "workspace.sqlite"));
  const sourceNested = readFileSync(fixture.nestedFile);
  const sourceRoot = readFileSync(fixture.rootFile);

  expect(() =>
    createFullBackup(fixture.store.db, fixture.source, destination),
  ).toThrow(/simulated fsync failure/);

  expect(existsSync(join(destination, "FOLIO-RECOVERY-INCOMPLETE"))).toBe(
    true,
  );
  expect(existsSync(join(destination, "manifest.json"))).toBe(false);
  expect(sha256(join(fixture.source, "workspace.sqlite"))).toBe(
    sourceDatabaseHash,
  );
  expect(readFileSync(fixture.nestedFile)).toEqual(sourceNested);
  expect(readFileSync(fixture.rootFile)).toEqual(sourceRoot);
});
