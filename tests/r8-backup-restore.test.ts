import { afterEach, expect, it, vi } from "vitest";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { attachFile, resolveAsset } from "../src/persistence/assets";
import { restoreFullBackup } from "../src/persistence/full-backup-restore";
import { verifyFullBackup } from "../src/persistence/full-backup-verify";
import type { WorkspaceBackupManifest } from "../src/shared/workspace-backup";

// Worker V owns the real verifier. This focused test harness stands in for the
// frozen verifyFullBackup contract so restore's copy/marker/fingerprint rules
// can be exercised before verifier integration. It is not an integration claim.
const verifierMock = vi.hoisted(() => ({
  calls: [] as { directory: string; allowIncomplete: boolean }[],
  beforeCall: undefined as
    | { index: number; run: () => void }
    | undefined,
  afterCall: undefined as { index: number; run: () => void } | undefined,
}));

vi.mock("../src/persistence/full-backup-verify", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const crypto = await import("node:crypto");
  const MARKER = "FOLIO-RECOVERY-INCOMPLETE";

  function inside(root: string, target: string): boolean {
    const rel = path.relative(root, target);
    return (
      rel === "" ||
      (rel !== ".." &&
        !rel.startsWith(".." + path.sep) &&
        !path.isAbsolute(rel))
    );
  }
  function digest(bytes: Buffer): string {
    return crypto.createHash("sha256").update(bytes).digest("hex");
  }
  function checkFile(
    directory: string,
    entry: { path: string; bytes: number; sha256: string },
  ): Buffer {
    const root = fs.realpathSync(directory);
    const target = path.resolve(root, entry.path);
    if (!inside(root, target) || target === root)
      throw new Error("unsafe backup path");
    let cursor = root;
    for (const part of path.relative(root, target).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new Error("backup symlink");
    }
    const bytes = fs.readFileSync(target);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256)
      throw new Error("backup file changed");
    return bytes;
  }
  function verifyFullBackup(
    directory: string,
    options: { allowIncomplete?: boolean } = {},
  ) {
    const resolved = path.resolve(directory);
    const callIndex = verifierMock.calls.length + 1;
    if (verifierMock.beforeCall?.index === callIndex) {
      const run = verifierMock.beforeCall.run;
      verifierMock.beforeCall = undefined;
      run();
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(resolved, "manifest.json"), "utf8"),
    );
    if (
      manifest?.format !== "folio-workspace-backup" ||
      manifest?.version !== 1
    )
      throw new Error("malformed manifest");
    if (
      manifest.database?.path !== "workspace.sqlite" ||
      !Array.isArray(manifest.assets)
    )
      throw new Error("malformed manifest");
    if (
      fs.existsSync(path.join(resolved, MARKER)) &&
      !options.allowIncomplete
    )
      throw new Error("incomplete workspace");
    const database = checkFile(resolved, manifest.database);
    for (const asset of manifest.assets) {
      if (typeof asset?.path !== "string" || !asset.path.startsWith("assets/"))
        throw new Error("malformed asset path");
      checkFile(resolved, asset);
    }
    if (manifest.logicalSha256 !== digest(database))
      throw new Error("logical hash changed");
    const fingerprint = digest(
      Buffer.from(JSON.stringify(manifest), "utf8"),
    );
    verifierMock.calls.push({
      directory: resolved,
      allowIncomplete: !!options.allowIncomplete,
    });
    if (verifierMock.afterCall?.index === callIndex) {
      const run = verifierMock.afterCall.run;
      verifierMock.afterCall = undefined;
      run();
    }
    return { directory: resolved, manifest, fingerprint };
  }

  return { verifyFullBackup, inspectWorkspaceSnapshot: () => {
    throw new Error("test inspectWorkspaceSnapshot is not implemented");
  } };
});

const roots: string[] = [];
const stores: Store[] = [];
const MARKER = "FOLIO-RECOVERY-INCOMPLETE";

function tempRoot(): string {
  const root = mkdtempSync(resolve("output/r8-backup-restore-"));
  roots.push(root);
  return root;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeSnapshot(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (lstatSync(path).isSymbolicLink())
        throw new Error("unexpected symlink in test tree");
      if (entry.isDirectory()) walk(path);
      else result.set(relative(root, path), hashFile(path));
    }
  };
  walk(root);
  return result;
}

function tableCount(store: Store, table: string): number {
  if (
    !store.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
      )
      .get(table)
  )
    return 0;
  return (
    store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

function inventory(store: Store) {
  return {
    pages: tableCount(store, "pages"),
    recordDatabases: tableCount(store, "record_databases"),
    records: tableCount(store, "record_memberships"),
    versions: tableCount(store, "versions"),
    settings: tableCount(store, "settings"),
    saveReceipts: tableCount(store, "save_receipts"),
    registeredAssets: tableCount(store, "assets"),
  };
}

function buildBackup(
  workspace: string,
  backup: string,
  counts: ReturnType<typeof inventory>,
): WorkspaceBackupManifest {
  mkdirSync(backup, { recursive: true });
  copyFileSync(
    join(workspace, "workspace.sqlite"),
    join(backup, "workspace.sqlite"),
  );
  const sourceAssets = join(workspace, "assets");
  if (existsSync(sourceAssets))
    cpSync(sourceAssets, join(backup, "assets"), { recursive: true });
  const databaseBytes = readFileSync(join(backup, "workspace.sqlite"));
  const assetFiles = (existsSync(join(backup, "assets"))
    ? readdirSync(join(backup, "assets"), { withFileTypes: true })
    : []
  )
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const bytes = readFileSync(join(backup, "assets", entry.name));
      return {
        path: `assets/${entry.name}`,
        bytes: bytes.length,
        sha256: hashBytes(bytes),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest: WorkspaceBackupManifest = {
    format: "folio-workspace-backup",
    version: 1,
    createdAt: "2026-11-04T00:00:00.000Z",
    storeVersion: 4,
    inventory: counts,
    logicalSha256: hashBytes(databaseBytes),
    database: {
      path: "workspace.sqlite",
      bytes: databaseBytes.length,
      sha256: hashBytes(databaseBytes),
    },
    assets: assetFiles,
  };
  writeFileSync(
    join(backup, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

function minimalBackup(root: string) {
  const workspace = join(root, "source");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "assets"));
  const store = new Store(join(workspace, "workspace.sqlite"));
  stores.push(store);
  const page = store.create(null, "page", "Original page");
  store.handle({ type: "setting", key: "theme", value: "dark" });
  const upload = join(root, "upload.bin");
  writeFileSync(upload, Buffer.from([0, 1, 2, 255, 10, 13]));
  const attachment = attachFile(store.db, join(workspace, "assets"), upload);
  const pageBefore = store.get(page.id);
  const counts = inventory(store);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();
  const backup = join(root, "backup");
  const manifest = buildBackup(workspace, backup, counts);
  return { workspace, backup, manifest, pageId: page.id, pageBefore, attachment };
}

afterEach(() => {
  verifierMock.calls.length = 0;
  verifierMock.beforeCall = undefined;
  verifierMock.afterCall = undefined;
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it("restores IDs, page/row values, settings, history, receipts and assets byte-for-byte", () => {
  const root = tempRoot();
  const workspace = join(root, "source");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "assets"));
  const store = new Store(join(workspace, "workspace.sqlite"));
  stores.push(store);

  const page = store.create(null, "page", "Original page");
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "preserved body", marks: [{ type: "bold" }] },
        ],
      },
    ],
  };
  store.update(page.id, page.revision, { title: "Saved page", doc });
  store.handle({ type: "setting", key: "theme", value: "system" });
  store.handle({ type: "setting", key: "expanded", value: "a,b" });

  let owner = store.create(null, "database", "Tasks");
  owner = store.update(owner.id, owner.revision, {
    database: {
      ...owner.database!,
      properties: [
        { id: "note", name: "Note", type: "text" },
        { id: "count", name: "Count", type: "number" },
        { id: "done", name: "Done", type: "checkbox" },
      ],
    },
  });
  const repository = new RecordRepository(store);
  store.transaction(() => {
    repository.createSchema();
    repository.registerDatabase(owner.id);
  });
  const record = repository.create(owner.id, "Task", {
    note: "before",
    count: 1,
    done: false,
  });
  const recordSave = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    seq: 1,
    pageId: record.pageId,
    databasePageId: owner.id,
    revision: record.revision,
    patch: { title: "Edited task" },
    values: { note: "after", count: 7, done: true },
  };
  const recordResult = store.commitSave(recordSave);
  const pageSave = {
    operationId: randomUUID(),
    sessionId: randomUUID(),
    seq: 2,
    pageId: page.id,
    databasePageId: null,
    revision: store.get(page.id).revision,
    patch: { title: "Receipt page" },
  };
  const pageResult = store.commitSave(pageSave);

  const upload = join(root, "attachment.bin");
  const attachmentBytes = Buffer.from([0, 255, 13, 10, 1, 2, 3, 4]);
  writeFileSync(upload, attachmentBytes);
  const attachment = attachFile(
    store.db,
    join(workspace, "assets"),
    upload,
  );

  const expectedPages = store.pages();
  const expectedVersions = new Map(
    expectedPages.map((expected) => [expected.id, store.versions(expected.id)]),
  );
  const expectedSettings = store.load().settings;
  const expectedRecord = new RecordRepository(store).projection(record.pageId);
  const expectedReceipts = store.db
    .prepare(
      "SELECT operation_id, fingerprint, result_json FROM save_receipts ORDER BY operation_id",
    )
    .all();
  const counts = inventory(store);

  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  store.close();

  const backup = join(root, "backup");
  const manifest = buildBackup(workspace, backup, counts);
  // Files outside the manifest must never be copied into a restored workspace.
  writeFileSync(join(backup, "session.json"), "not part of the backup");
  writeFileSync(join(backup, "workspace.sqlite-wal"), "not part of the backup");
  writeFileSync(
    join(backup, "FOLIO-CRASH-RECOVERY"),
    "not part of the backup",
  );
  const backupBefore = treeSnapshot(backup);
  const expectedFingerprint = verifyFullBackup(backup).fingerprint;
  const destination = join(root, "restored");

  const restoredInfo = restoreFullBackup(
    backup,
    destination,
    expectedFingerprint,
  );
  expect(restoredInfo.directory).toBe(resolve(destination));
  expect(restoredInfo.sourceFingerprint).toBe(expectedFingerprint);
  expect(restoredInfo.manifest).toEqual(manifest);
  expect(existsSync(join(destination, MARKER))).toBe(false);
  expect(hashFile(join(destination, "workspace.sqlite"))).toBe(
    hashFile(join(backup, "workspace.sqlite")),
  );
  expect(treeSnapshot(backup)).toEqual(backupBefore);
  for (const omitted of [
    "session.json",
    "workspace.sqlite-wal",
    "FOLIO-CRASH-RECOVERY",
  ])
    expect(existsSync(join(destination, omitted))).toBe(false);

  const restored = new Store(join(destination, "workspace.sqlite"));
  stores.push(restored);
  expect(restored.pages()).toEqual(expectedPages);
  for (const expected of expectedPages)
    expect(restored.versions(expected.id)).toEqual(
      expectedVersions.get(expected.id),
    );
  expect(restored.load().settings).toEqual(expectedSettings);
  expect(new RecordRepository(restored).projection(record.pageId)).toEqual(
    expectedRecord,
  );
  expect(
    restored.db
      .prepare(
        "SELECT operation_id, fingerprint, result_json FROM save_receipts ORDER BY operation_id",
      )
      .all(),
  ).toEqual(expectedReceipts);
  expect(restored.resolveSave(recordSave)).toEqual(recordResult);
  expect(restored.resolveSave(pageSave)).toEqual(pageResult);
  expect(
    readFileSync(
      resolveAsset(
        restored.db,
        join(destination, "assets"),
        attachment.url,
      ).path,
    ),
  ).toEqual(attachmentBytes);
});

it("refuses a changed expected fingerprint, existing targets, backup-inside paths and aliases", () => {
  const root = tempRoot();
  const f = minimalBackup(root);
  const before = treeSnapshot(f.backup);

  expect(() =>
    restoreFullBackup(f.backup, join(root, "fingerprint"), "0".repeat(64)),
  ).toThrow(/変更/);
  expect(existsSync(join(root, "fingerprint"))).toBe(false);

  const existing = join(root, "existing");
  mkdirSync(existing);
  writeFileSync(join(existing, "sentinel"), "keep");
  expect(() => restoreFullBackup(f.backup, existing)).toThrow(/存在しない/);
  expect(readFileSync(join(existing, "sentinel"), "utf8")).toBe("keep");

  const existingFile = join(root, "existing-file");
  writeFileSync(existingFile, "keep file");
  expect(() => restoreFullBackup(f.backup, existingFile)).toThrow();
  expect(readFileSync(existingFile, "utf8")).toBe("keep file");

  const inside = join(f.backup, "nested");
  expect(() => restoreFullBackup(f.backup, inside)).toThrow(/中や同じ場所/);
  expect(existsSync(inside)).toBe(false);

  symlinkSync(f.backup, join(root, "alias"), "dir");
  const aliasDestination = join(root, "alias", "nested");
  expect(() => restoreFullBackup(f.backup, aliasDestination)).toThrow(
    /中や同じ場所/,
  );
  expect(existsSync(join(f.backup, "nested"))).toBe(false);

  // A symlink in an ancestor of the selected backup path is canonicalized for
  // reading, but the destination itself may not alias the backup.
  symlinkSync(root, join(root, "root-alias"), "dir");
  const viaAlias = join(root, "root-alias", "backup");
  const fromAlias = join(root, "from-alias");
  expect(restoreFullBackup(viaAlias, fromAlias).directory).toBe(
    resolve(fromAlias),
  );
  expect(existsSync(join(fromAlias, "workspace.sqlite"))).toBe(true);
  expect(existsSync(join(fromAlias, MARKER))).toBe(false);
  expect(treeSnapshot(f.backup)).toEqual(before);
});

it("refuses a malformed source before reserving the destination", () => {
  const root = tempRoot();
  const f = minimalBackup(root);
  const manifestPath = join(f.backup, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.database.sha256 = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const destination = join(root, "malformed");
  expect(() => restoreFullBackup(f.backup, destination)).toThrow();
  expect(existsSync(destination)).toBe(false);
});

it("detects source changes between verification and destination verification", () => {
  const root = tempRoot();
  const f = minimalBackup(root);
  const databasePath = join(f.backup, "workspace.sqlite");
  const manifestPath = join(f.backup, "manifest.json");
  const changed = Buffer.concat([
    readFileSync(databasePath),
    Buffer.from("source changed during copy"),
  ]);
  verifierMock.beforeCall = {
    index: 2,
    run: () => {
      writeFileSync(databasePath, changed);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.database.bytes = changed.length;
      manifest.database.sha256 = hashBytes(changed);
      manifest.logicalSha256 = hashBytes(changed);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    },
  };

  const destination = join(root, "changed-source");
  expect(() => restoreFullBackup(f.backup, destination)).toThrow(/コピー中/);
  expect(existsSync(join(destination, MARKER))).toBe(true);
  expect(existsSync(destination)).toBe(true);
});

it("leaves a marked partial copy and Store refuses it after a copy failure", () => {
  const root = tempRoot();
  const f = minimalBackup(root);
  const assetName = readdirSync(join(f.backup, "assets"))[0];
  verifierMock.afterCall = {
    index: 1,
    run: () => unlinkSync(join(f.backup, "assets", assetName)),
  };

  const destination = join(root, "partial");
  expect(() => restoreFullBackup(f.backup, destination)).toThrow();
  expect(existsSync(destination)).toBe(true);
  expect(readFileSync(join(destination, MARKER), "utf8")).toBe(
    "Recovery incomplete; do not open this workspace.\n",
  );
  expect(existsSync(join(destination, "workspace.sqlite"))).toBe(true);
  expect(() =>
    new Store(join(destination, "workspace.sqlite")),
  ).toThrow(/復旧が完了していない/);
});
