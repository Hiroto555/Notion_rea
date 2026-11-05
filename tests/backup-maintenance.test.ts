import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveBackup, planBackupArchive } from "../src/main/backup-maintenance";
import { attachFile } from "../src/persistence/assets";
import { durableFs } from "../src/persistence/durable-file";
import { createFullBackup } from "../src/persistence/full-backup-create";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import { Store } from "../src/persistence/store";
import type { VerifiedWorkspaceBackup } from "../src/shared/workspace-backup";

const OLD = "2025-01-01T00:00:00.000Z";
const TIE = "2025-01-02T00:00:00.000Z";
const NEW = "2025-01-05T00:00:00.000Z";

type Fixture = {
  root: string;
  workspace: string;
  backups: string;
  store: Store;
  pageId: string;
  assetName: string;
  addBackup(name: string, createdAt?: string): VerifiedWorkspaceBackup;
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {}
  }
});

function backupName(): string {
  return `workspace-${Date.now()}-${randomUUID()}`;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(resolve("output/backup-maintenance-"));
  const workspace = join(root, "workspace");
  const backups = join(workspace, "backups");
  const assets = join(workspace, "assets");
  fs.mkdirSync(backups, { recursive: true });
  fs.mkdirSync(assets, { recursive: true });
  const store = new Store(join(workspace, "workspace.sqlite"));
  const page = store.create(null, "page", "Original");
  const input = join(root, "attachment.txt");
  fs.writeFileSync(input, "attachment bytes\n");
  const attachment = attachFile(store.db, assets, input);

  const value: Fixture = {
    root,
    workspace,
    backups,
    store,
    pageId: page.id,
    assetName: attachment.storageName,
    addBackup(name, createdAt) {
      const directory = join(backups, name);
      const verified = createFullBackup(store.db, workspace, directory);
      if (!createdAt) return verified;
      const manifestPath = join(directory, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.createdAt = createdAt;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      return verifyFullBackup(directory);
    },
  };
  cleanups.push(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return value;
}

function treeSnapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const path = join(current, name);
      const info = fs.lstatSync(path);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (info.isSymbolicLink()) throw new Error("unexpected symlink");
      if (info.isDirectory()) walk(path, relative);
      else if (info.isFile())
        result[relative] = createHash("sha256")
          .update(fs.readFileSync(path))
          .digest("hex");
      else throw new Error("unexpected filesystem entry");
    }
  };
  walk(directory, "");
  return result;
}

function expectedBytes(backup: VerifiedWorkspaceBackup): number {
  return (
    backup.manifest.database.bytes +
    backup.manifest.assets.reduce((total, asset) => total + asset.bytes, 0)
  );
}

describe("planBackupArchive", () => {
  it("plans a verified generated generation without changing its bytes", () => {
    const f = fixture();
    const older = f.addBackup(backupName(), OLD);
    const newer = f.addBackup(backupName(), NEW);
    const before = treeSnapshot(older.directory);

    const plan = planBackupArchive(f.workspace, older.directory, () => false);

    expect(plan).toEqual({
      fingerprint: older.fingerprint,
      name: basename(older.directory),
      bytes: expectedBytes(older),
    });
    expect(treeSnapshot(older.directory)).toEqual(before);
    expect(verifyFullBackup(older.directory).fingerprint).toBe(plan.fingerprint);
    expect(fs.existsSync(newer.directory)).toBe(true);
  });

  it("protects the newest valid backup, timestamp ties, and the final valid backup", () => {
    const f = fixture();
    const older = f.addBackup(backupName(), OLD);
    const tieA = f.addBackup(backupName(), TIE);
    const tieB = f.addBackup(backupName(), TIE);

    expect(() =>
      planBackupArchive(f.workspace, tieA.directory, () => false),
    ).toThrow(/最新/);
    expect(() =>
      planBackupArchive(f.workspace, tieB.directory, () => false),
    ).toThrow(/最新/);
    expect(
      planBackupArchive(f.workspace, older.directory, () => false).name,
    ).toBe(basename(older.directory));

    const single = fixture();
    const only = single.addBackup(backupName(), NEW);
    expect(() =>
      planBackupArchive(single.workspace, only.directory, () => false),
    ).toThrow(/最後/);
  });

  it("denies active pins using the canonical source path", () => {
    const f = fixture();
    const source = f.addBackup(backupName(), OLD);
    f.addBackup(backupName(), NEW);
    const seen: string[] = [];

    expect(() =>
      planBackupArchive(f.workspace, source.directory, (canonical) => {
        seen.push(canonical);
        return true;
      }),
    ).toThrow(/使用中/);
    expect(seen).toEqual([source.directory]);
    expect(fs.existsSync(source.directory)).toBe(true);
  });
});

describe("archiveBackup", () => {
  it("moves only the chosen generation into a fresh private wrapper with data intact", () => {
    const f = fixture();
    const older = f.addBackup(backupName(), OLD);
    const newer = f.addBackup(backupName(), NEW);
    const external = join(f.root, "external");
    fs.mkdirSync(external);
    const olderBefore = treeSnapshot(older.directory);
    const newerBefore = treeSnapshot(newer.directory);
    const pageBefore = f.store
      .load()
      .pages.find((page) => page.id === f.pageId);
    const plan = planBackupArchive(f.workspace, older.directory, () => false);

    const result = archiveBackup(
      f.workspace,
      older.directory,
      external,
      plan.fingerprint,
      () => false,
    );

    expect(result.destination.startsWith(external + sep)).toBe(true);
    expect(basename(result.destination)).toMatch(/^folio-backup-archive-/);
    expect(fs.statSync(result.destination).mode & 0o077).toBe(0);
    expect(fs.existsSync(older.directory)).toBe(false);
    expect(fs.readdirSync(result.destination)).toEqual([
      basename(older.directory),
    ]);
    const moved = join(result.destination, basename(older.directory));
    expect(treeSnapshot(moved)).toEqual(olderBefore);
    expect(verifyFullBackup(moved).fingerprint).toBe(plan.fingerprint);
    expect(treeSnapshot(newer.directory)).toEqual(newerBefore);
    expect(fs.existsSync(join(f.workspace, "assets", f.assetName))).toBe(true);
    expect(
      f.store.load().pages.find((page) => page.id === f.pageId),
    ).toEqual(pageBefore);
  });

  it("rejects a changed fingerprint before creating a destination", () => {
    const f = fixture();
    const source = f.addBackup(backupName(), OLD);
    f.addBackup(backupName(), NEW);
    const external = join(f.root, "external");
    fs.mkdirSync(external);
    const plan = planBackupArchive(f.workspace, source.directory, () => false);

    const manifestPath = join(source.directory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.createdAt = "2025-01-03T00:00:00.000Z";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const changed = verifyFullBackup(source.directory);
    expect(changed.fingerprint).not.toBe(plan.fingerprint);

    expect(() =>
      archiveBackup(
        f.workspace,
        source.directory,
        external,
        plan.fingerprint,
        () => false,
      ),
    ).toThrow(/変更/);
    expect(fs.existsSync(source.directory)).toBe(true);
    expect(fs.readdirSync(external)).toEqual([]);
    expect(verifyFullBackup(source.directory).fingerprint).toBe(
      changed.fingerprint,
    );
  });

  it("rechecks pins before the rename and removes the empty wrapper", () => {
    const f = fixture();
    const source = f.addBackup(backupName(), OLD);
    f.addBackup(backupName(), NEW);
    const external = join(f.root, "external");
    fs.mkdirSync(external);
    const plan = planBackupArchive(f.workspace, source.directory, () => false);
    let calls = 0;

    expect(() =>
      archiveBackup(
        f.workspace,
        source.directory,
        external,
        plan.fingerprint,
        () => {
          calls++;
          return calls > 1;
        },
      ),
    ).toThrow(/使用中/);
    expect(calls).toBe(2);
    expect(fs.existsSync(source.directory)).toBe(true);
    expect(fs.readdirSync(external)).toEqual([]);
  });

  it("rechecks retention after wrapper creation and removes the empty wrapper", () => {
    const f = fixture();
    const source = f.addBackup(backupName(), OLD);
    const newer = f.addBackup(backupName(), NEW);
    const external = join(f.root, "external");
    fs.mkdirSync(external);
    const plan = planBackupArchive(f.workspace, source.directory, () => false);
    const movedAside = join(f.root, "newer-away");
    const original = durableFs.syncPath;
    let moved = false;
    const sync = vi
      .spyOn(durableFs, "syncPath")
      .mockImplementation((path: string) => {
        if (!moved && path === external) {
          moved = true;
          fs.renameSync(newer.directory, movedAside);
        }
        original(path);
      });

    let thrown: unknown;
    try {
      archiveBackup(
        f.workspace,
        source.directory,
        external,
        plan.fingerprint,
        () => false,
      );
    } catch (error) {
      thrown = error;
    } finally {
      sync.mockRestore();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/最後|最新/);
    expect(moved).toBe(true);
    expect(fs.existsSync(source.directory)).toBe(true);
    expect(fs.readdirSync(external)).toEqual([]);
    expect(fs.existsSync(movedAside)).toBe(true);
  });

  it("rechecks source bytes after wrapper creation and keeps the original", () => {
    const f = fixture();
    const source = f.addBackup(backupName(), OLD);
    f.addBackup(backupName(), NEW);
    const external = join(f.root, "external");
    fs.mkdirSync(external);
    const plan = planBackupArchive(f.workspace, source.directory, () => false);
    const original = durableFs.syncPath;
    let changed = false;
    const sync = vi
      .spyOn(durableFs, "syncPath")
      .mockImplementation((path: string) => {
        if (!changed && path === external) {
          changed = true;
          const manifestPath = join(source.directory, "manifest.json");
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          manifest.createdAt = "2025-01-03T00:00:00.000Z";
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        }
        original(path);
      });

    let thrown: unknown;
    try {
      archiveBackup(
        f.workspace,
        source.directory,
        external,
        plan.fingerprint,
        () => false,
      );
    } catch (error) {
      thrown = error;
    } finally {
      sync.mockRestore();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/変更/);
    expect(changed).toBe(true);
    expect(fs.existsSync(source.directory)).toBe(true);
    expect(fs.readdirSync(external)).toEqual([]);
    expect(verifyFullBackup(source.directory).fingerprint).not.toBe(
      plan.fingerprint,
    );
  });

  it("refuses nested or aliased destinations and allows similarly named siblings", () => {
    const f = fixture();
    const olderA = f.addBackup(backupName(), OLD);
    const olderB = f.addBackup(backupName(), OLD);
    f.addBackup(backupName(), NEW);
    const planA = planBackupArchive(f.workspace, olderA.directory, () => false);
    const planB = planBackupArchive(f.workspace, olderB.directory, () => false);
    const insideName = join(f.workspace, "backups-archive");
    fs.mkdirSync(insideName);
    const workspaceAlias = join(f.root, "workspace-alias");
    fs.symlinkSync(f.workspace, workspaceAlias, "dir");

    for (const destination of [insideName, f.workspace, workspaceAlias]) {
      expect(() =>
        archiveBackup(
          f.workspace,
          olderA.directory,
          destination,
          planA.fingerprint,
          () => false,
        ),
      ).toThrow(/外側|指して/);
      expect(fs.existsSync(olderA.directory)).toBe(true);
    }

    const sibling = join(f.root, "workspace-archive");
    fs.mkdirSync(sibling);
    const first = archiveBackup(
      f.workspace,
      olderA.directory,
      sibling,
      planA.fingerprint,
      () => false,
    );
    expect(first.destination.startsWith(sibling + sep)).toBe(true);

    const target = join(f.root, "outside-target");
    fs.mkdirSync(target);
    const targetLink = join(f.root, "outside-link");
    fs.symlinkSync(target, targetLink, "dir");
    const second = archiveBackup(
      f.workspace,
      olderB.directory,
      targetLink,
      planB.fingerprint,
      () => false,
    );
    expect(second.destination.startsWith(target + sep)).toBe(true);
    expect(
      fs.existsSync(join(second.destination, basename(olderB.directory))),
    ).toBe(true);
  });

  it("rejects symlinks, nested paths, generated-name mismatches, and unverified backups", () => {
    const f = fixture();
    const source = f.addBackup(backupName(), OLD);
    f.addBackup(backupName(), NEW);
    const external = join(f.root, "external");
    fs.mkdirSync(external);

    const copy = (name: string): string => {
      const destination = join(f.backups, name);
      fs.cpSync(source.directory, destination, { recursive: true });
      return destination;
    };
    const manual = copy("manual-copy");
    expect(() =>
      planBackupArchive(f.workspace, manual, () => false),
    ).toThrow(/生成/);
    const legacyName = copy("workspace-1700000000000");
    expect(() =>
      planBackupArchive(f.workspace, legacyName, () => false),
    ).toThrow(/生成/);

    const nested = join(source.directory, "nested");
    fs.mkdirSync(nested);
    expect(() =>
      planBackupArchive(f.workspace, nested, () => false),
    ).toThrow(/直下/);

    const linked = join(f.backups, `workspace-1700000000001-${randomUUID()}`);
    fs.symlinkSync(source.directory, linked, "dir");
    expect(() =>
      planBackupArchive(f.workspace, linked, () => false),
    ).toThrow(/安全/);

    const file = join(f.backups, `workspace-1700000000002-${randomUUID()}`);
    fs.writeFileSync(file, "not a backup");
    expect(() =>
      planBackupArchive(f.workspace, file, () => false),
    ).toThrow(/安全/);

    const incomplete = copy(`workspace-1700000000003-${randomUUID()}`);
    fs.writeFileSync(
      join(incomplete, "FOLIO-RECOVERY-INCOMPLETE"),
      "incomplete\n",
    );
    expect(() =>
      planBackupArchive(f.workspace, incomplete, () => false),
    ).toThrow(/完全バックアップ/);

    const legacy = copy(`workspace-1700000000004-${randomUUID()}`);
    fs.writeFileSync(
      join(legacy, "manifest.json"),
      JSON.stringify(
        { app: "Folio", schema: 1, createdAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    expect(() =>
      planBackupArchive(f.workspace, legacy, () => false),
    ).toThrow(/完全バックアップ/);

    const outside = join(f.root, "outside-backup");
    fs.cpSync(source.directory, outside, { recursive: true });
    expect(() =>
      planBackupArchive(f.workspace, outside, () => false),
    ).toThrow(/直下/);

    const fakeWorkspace = join(f.root, "fake-workspace");
    fs.mkdirSync(fakeWorkspace);
    fs.symlinkSync(f.backups, join(fakeWorkspace, "backups"), "dir");
    expect(() =>
      planBackupArchive(fakeWorkspace, source.directory, () => false),
    ).toThrow(/バックアップフォルダー/);

    const workspaceLink = join(f.root, "workspace-link");
    fs.symlinkSync(f.workspace, workspaceLink, "dir");
    expect(() =>
      planBackupArchive(
        workspaceLink,
        join(workspaceLink, "backups", basename(source.directory)),
        () => false,
      ),
    ).toThrow(/ワークスペース/);

    expect(fs.existsSync(source.directory)).toBe(true);
    expect(fs.readdirSync(external)).toEqual([]);
  });

  it("retains the original and removes the empty wrapper on EXDEV", () => {
    const f = fixture();
    const source = f.addBackup(backupName(), OLD);
    f.addBackup(backupName(), NEW);
    const external = join(f.root, "external");
    fs.mkdirSync(external);
    const plan = planBackupArchive(f.workspace, source.directory, () => false);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), {
        code: "EXDEV",
      });
    });

    let thrown: unknown;
    try {
      archiveBackup(
        f.workspace,
        source.directory,
        external,
        plan.fingerprint,
        () => false,
      );
    } catch (error) {
      thrown = error;
    } finally {
      rename.mockRestore();
    }

    expect((thrown as NodeJS.ErrnoException).code).toBe("EXDEV");
    expect((thrown as Error).message).toMatch(/同じファイルシステム/);
    expect(fs.existsSync(source.directory)).toBe(true);
    expect(fs.readdirSync(external)).toEqual([]);
    expect(verifyFullBackup(source.directory).fingerprint).toBe(
      plan.fingerprint,
    );
  });

  it("reports a moved state if a directory fsync fails after the rename", () => {
    const f = fixture();
    const source = f.addBackup(backupName(), OLD);
    f.addBackup(backupName(), NEW);
    const external = join(f.root, "external");
    fs.mkdirSync(external);
    const plan = planBackupArchive(f.workspace, source.directory, () => false);
    const original = durableFs.syncPath;
    const sync = vi
      .spyOn(durableFs, "syncPath")
      .mockImplementation((path: string) => {
        if (path === f.backups) throw new Error("injected fsync failure");
        original(path);
      });

    let thrown: unknown;
    try {
      archiveBackup(
        f.workspace,
        source.directory,
        external,
        plan.fingerprint,
        () => false,
      );
    } catch (error) {
      thrown = error;
    } finally {
      sync.mockRestore();
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/移動済み/);
    expect(fs.existsSync(source.directory)).toBe(false);
    const wrappers = fs.readdirSync(external);
    expect(wrappers).toHaveLength(1);
    const moved = join(external, wrappers[0], basename(source.directory));
    expect(fs.existsSync(moved)).toBe(true);
    expect(verifyFullBackup(moved).fingerprint).toBe(plan.fingerprint);
  });
});
