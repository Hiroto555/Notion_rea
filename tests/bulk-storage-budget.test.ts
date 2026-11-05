import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { Store } from "../src/persistence/store";
import {
  estimateBackupBytes,
  estimateRestoreBytes,
} from "../src/main/bulk-storage-budget";
import { WorkspaceBackupService } from "../src/main/workspace-backup-service";

const roots: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
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

function workspace(prefix: string) {
  const root = tempRoot(prefix);
  const directory = join(root, "workspace");
  mkdirSync(directory);
  const assets = join(directory, "assets");
  mkdirSync(assets);
  const store = new Store(join(directory, "workspace.sqlite"));
  stores.push(store);
  return { root, directory, assets, store };
}

function treeBytes(root: string): { bytes: number; files: number } {
  const summary = { bytes: 0, files: 0 };
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) pending.push(path);
      else if (info.isFile()) {
        summary.bytes += info.size;
        summary.files++;
      }
    }
  }
  return summary;
}

function assetCount(store: Store): number {
  return (
    store.db.prepare("SELECT count(*) AS n FROM assets").get() as { n: number }
  ).n;
}

it("estimates live backups from allocated SQLite pages and every asset file, including unregistered nested files", () => {
  const f = workspace("folio-bulk-estimate-");
  f.store.create(null, "page", "budget");
  const input = join(f.root, "registered.txt");
  writeFileSync(input, Buffer.alloc(1234, 7));
  attachFile(f.store.db, f.assets, input);
  writeFileSync(join(f.assets, "unregistered.bin"), Buffer.alloc(2345, 1));
  mkdirSync(join(f.assets, "nested"));
  writeFileSync(join(f.assets, "nested", "deep.bin"), Buffer.alloc(3456, 2));

  // Keep the logical pages in the WAL so page_count, not the small main file,
  // proves that WAL-resident content is included.
  f.store.db.exec("PRAGMA wal_autocheckpoint=0");
  f.store.db.exec("CREATE TABLE budget_extra(value BLOB)");
  const insert = f.store.db.prepare(
    "INSERT INTO budget_extra(value) VALUES(?)",
  );
  for (let index = 0; index < 80; index++)
    insert.run(Buffer.alloc(1024, index));

  const pageCount = (
    f.store.db.prepare("PRAGMA page_count").get() as { page_count: number }
  ).page_count;
  const pageSize = (
    f.store.db.prepare("PRAGMA page_size").get() as { page_size: number }
  ).page_size;
  const mainBytes = statSync(join(f.directory, "workspace.sqlite")).size;
  expect(statSync(join(f.directory, "workspace.sqlite-wal")).size).toBeGreaterThan(0);
  expect(pageCount * pageSize).toBeGreaterThan(mainBytes);

  const estimate = estimateBackupBytes(f.store.db, f.directory);
  const minimum =
    Math.max(pageCount * pageSize, mainBytes) + 1234 + 2345 + 3456;
  expect(estimate).toBeGreaterThan(minimum);
});

it("restores unregistered top-level assets and estimates extra files that a stale verification does not list", () => {
  const f = workspace("folio-bulk-restore-");
  f.store.create(null, "page", "restore budget");
  const input = join(f.root, "registered.txt");
  writeFileSync(input, Buffer.alloc(3456, 3));
  const registered = attachFile(f.store.db, f.assets, input);
  const orphanBytes = Buffer.alloc(4096, 4);
  writeFileSync(join(f.assets, "unregistered.bin"), orphanBytes);

  const backupDirectory = join(f.root, "backup");
  createFullBackup(f.store.db, f.directory, backupDirectory);
  const verified = verifyFullBackup(backupDirectory);
  expect(verified.manifest.assets.map((file) => file.path)).toContain(
    "assets/unregistered.bin",
  );

  const estimate = estimateRestoreBytes(verified);
  expect(estimate).toBeGreaterThanOrEqual(treeBytes(backupDirectory).bytes);
  expect(estimateBackupBytes(f.store.db, f.directory)).toBeGreaterThanOrEqual(
    treeBytes(backupDirectory).bytes,
  );

  const restoredDirectory = join(f.root, "restored");
  restoreFullBackup(backupDirectory, restoredDirectory);
  expect(
    readFileSync(join(restoredDirectory, "assets", "unregistered.bin")),
  ).toEqual(orphanBytes);
  expect(
    readFileSync(
      join(restoredDirectory, "assets", registered.storageName),
    ).length,
  ).toBe(3456);
  expect(estimate).toBeGreaterThanOrEqual(treeBytes(restoredDirectory).bytes);

  // A later restore tree walk must budget files that the verified manifest
  // does not list. Both an extra top-level file and an unregistered nested
  // tree are measured, even though this stale object is not re-verified.
  const before = estimateRestoreBytes(verified);
  writeFileSync(
    join(backupDirectory, "assets", "late-orphan.bin"),
    Buffer.alloc(5000, 5),
  );
  mkdirSync(join(backupDirectory, "assets", "late-tree"));
  writeFileSync(
    join(backupDirectory, "assets", "late-tree", "deep.bin"),
    Buffer.alloc(6000, 6),
  );
  const after = estimateRestoreBytes(verified);
  expect(after - before).toBeGreaterThanOrEqual(11_000);
});

it("passes the backup estimate to beforeCreate and refuses before creating any destination", () => {
  const f = workspace("folio-bulk-create-admission-");
  f.store.create(null, "page", "create admission");
  const expected = estimateBackupBytes(f.store.db, f.directory);
  const beforeCreate = vi.fn((bytes: number) => {
    expect(bytes).toBe(expected);
    throw new Error("capacity-exceeded test");
  });
  const service = new WorkspaceBackupService(f.store.db, f.directory, {
    beforeCreate,
  });
  const before = readdirSync(f.directory).sort();
  expect(() => service.create()).toThrow(/capacity-exceeded/);
  expect(beforeCreate).toHaveBeenCalledTimes(1);
  expect(readdirSync(f.directory).sort()).toEqual(before);
  expect(existsSync(join(f.directory, "backups"))).toBe(false);

  // A legacy zero-argument callback keeps working and receives no required
  // parameters from its perspective.
  let legacyCalls = 0;
  const legacy = new WorkspaceBackupService(f.store.db, f.directory, {
    beforeCreate: () => {
      legacyCalls++;
    },
  });
  const preview = legacy.create();
  expect(legacyCalls).toBe(1);
  expect(existsSync(join(f.directory, "backups"))).toBe(true);
  expect(preview.bytes).toBeGreaterThan(0);
});

it("passes the restore estimate to beforeRestore and refuses before destination writes", () => {
  const f = workspace("folio-bulk-restore-admission-");
  f.store.create(null, "page", "restore admission");
  const input = join(f.root, "attachment.txt");
  writeFileSync(input, Buffer.alloc(2222, 8));
  attachFile(f.store.db, f.assets, input);
  const backup = new WorkspaceBackupService(
    f.store.db,
    f.directory,
  ).create();
  const verified = verifyFullBackup(backup.directory);
  const expected = estimateRestoreBytes(verified);

  const beforeRestore = vi.fn((parent: string, bytes: number) => {
    expect(parent).toBe(f.root);
    expect(bytes).toBe(expected);
    throw new Error("capacity-exceeded test");
  });
  const service = new WorkspaceBackupService(f.store.db, f.directory, {
    beforeRestore,
  });
  const selected = service.choose(backup.directory);
  const before = readdirSync(f.root).sort();
  expect(() => service.restore(selected.ticket, f.root)).toThrow(
    /capacity-exceeded/,
  );
  expect(beforeRestore).toHaveBeenCalledTimes(1);
  expect(readdirSync(f.root).sort()).toEqual(before);
  expect(
    readdirSync(f.root).some((name) => name.startsWith("Folio-restored-")),
  ).toBe(false);

  let restoredParent = "";
  const legacy = new WorkspaceBackupService(f.store.db, f.directory, {
    beforeRestore: (parent) => {
      restoredParent = parent;
    },
  });
  const ticket = legacy.choose(backup.directory);
  const restored = legacy.restore(ticket.ticket, f.root);
  expect(restoredParent).toBe(f.root);
  expect(existsSync(join(restored.directory, "workspace.sqlite"))).toBe(true);
});

it("invokes attachFile admission on actual bytes before writing the asset or metadata", () => {
  const f = workspace("folio-bulk-attach-");
  f.store.create(null, "page", "attachment admission");
  const input = join(f.root, "input.bin");
  const payload = Buffer.alloc(12_345, 9);
  writeFileSync(input, payload);
  const beforeFiles = readdirSync(f.assets);

  const beforeWrite = vi.fn((bytes: number) => {
    expect(bytes).toBe(payload.length);
    expect(readdirSync(f.assets)).toEqual(beforeFiles);
    expect(assetCount(f.store)).toBe(0);
    throw new Error("capacity-exceeded test");
  });
  expect(() =>
    attachFile(f.store.db, f.assets, input, beforeWrite),
  ).toThrow(/capacity-exceeded/);
  expect(beforeWrite).toHaveBeenCalledTimes(1);
  expect(readdirSync(f.assets)).toEqual(beforeFiles);
  expect(assetCount(f.store)).toBe(0);

  const seen: number[] = [];
  const asset = attachFile(f.store.db, f.assets, input, (bytes) => {
    seen.push(bytes);
    expect(readdirSync(f.assets)).toEqual(beforeFiles);
    expect(assetCount(f.store)).toBe(0);
  });
  expect(seen).toEqual([payload.length]);
  expect(asset.size).toBe(payload.length);
  expect(assetCount(f.store)).toBe(1);
  expect(readdirSync(f.assets)).toEqual([asset.storageName]);

  // Existing three-argument callers keep working.
  const legacy = attachFile(f.store.db, f.assets, input);
  expect(legacy.size).toBe(payload.length);
  expect(assetCount(f.store)).toBe(2);
});

it("refuses symlinked asset trees and arithmetic overflow instead of following or wrapping them", () => {
  const f = workspace("folio-bulk-refusal-");
  f.store.create(null, "page", "refusal");
  const outside = join(f.root, "outside.bin");
  writeFileSync(outside, Buffer.from("outside"));
  const link = join(f.assets, "linked.bin");
  symlinkSync(outside, link);
  expect(() => estimateBackupBytes(f.store.db, f.directory)).toThrow(
    /symbolic link/,
  );
  rmSync(link);

  const backupDirectory = join(f.root, "backup");
  createFullBackup(f.store.db, f.directory, backupDirectory);
  const verified = verifyFullBackup(backupDirectory);
  symlinkSync(outside, join(backupDirectory, "assets", "linked.bin"));
  expect(() => estimateRestoreBytes(verified)).toThrow(/symbolic link/);

  const overflowing = {
    prepare: () => ({
      get: () => ({
        page_count: Number.MAX_SAFE_INTEGER,
        page_size: 4096,
      }),
    }),
  } as unknown as DatabaseSync;
  expect(() => estimateBackupBytes(overflowing, f.directory)).toThrow(
    /supported size range/,
  );
});
