import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { RecordRepository } from "../src/persistence/record-repository";
import { markRecordStoreVersion } from "../src/persistence/record-version";
import { Store } from "../src/persistence/store";
import {
  inspectWorkspaceSnapshot,
  verifyFullBackup,
} from "../src/persistence/full-backup-verify";
import type { WorkspaceBackupManifest } from "../src/shared/workspace-backup";

type Fixture = ReturnType<typeof fixture>;

function fixture(v4 = false) {
  const root = mkdtempSync(resolve("output/r8-backup-verify-"));
  const source = join(root, "source");
  const assets = join(source, "assets");
  mkdirSync(source);
  mkdirSync(assets);
  const store = new Store(join(source, "workspace.sqlite"));
  if (v4)
    store.transaction(() => {
      new RecordRepository(store).createSchema();
      markRecordStoreVersion(store.db);
    });
  return {
    root,
    source,
    assets,
    store,
    dispose() {
      try {
        store.close();
      } catch {}
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function removeSidecars(databasePath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (existsSync(databasePath + suffix)) unlinkSync(databasePath + suffix);
}

function editDatabase(
  backup: string,
  edit: (db: DatabaseSync) => void,
): void {
  const path = join(backup, "workspace.sqlite");
  const db = new DatabaseSync(path);
  try {
    edit(db);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
  } finally {
    db.close();
    removeSidecars(path);
  }
}

function createBackup(
  root: string,
  source: string,
  name = "backup",
): { backup: string; manifest: WorkspaceBackupManifest } {
  const backup = join(root, name);
  mkdirSync(backup);
  const sourceDb = join(source, "workspace.sqlite");
  const reader = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    reader.prepare("VACUUM INTO ?").run(join(backup, "workspace.sqlite"));
  } finally {
    reader.close();
  }
  const sourceAssets = join(source, "assets");
  if (existsSync(sourceAssets))
    cpSync(sourceAssets, join(backup, "assets"), { recursive: true });
  const inspection = inspectWorkspaceSnapshot(backup);
  const dbBytes = readFileSync(join(backup, "workspace.sqlite"));
  const manifest: WorkspaceBackupManifest = {
    ...inspection,
    format: "folio-workspace-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    database: {
      path: "workspace.sqlite",
      bytes: dbBytes.length,
      sha256: sha256(dbBytes),
    },
  };
  writeManifest(backup, manifest);
  return { backup, manifest };
}

function writeManifest(
  backup: string,
  manifest: WorkspaceBackupManifest,
): void {
  writeFileSync(
    join(backup, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

function addAttachment(f: Fixture, name: string, bytes: Buffer): string {
  const input = join(f.root, name);
  writeFileSync(input, bytes);
  const asset = attachFile(f.store.db, f.assets, input) as { id: string };
  return asset.id;
}

describe("workspace snapshot inspection", () => {
  it("inspects v3 history, receipts, settings, raw page JSON and every asset without mutation", () => {
    const f = fixture(false);
    try {
      const page = f.store.create(null, "page", "Original");
      const saved = f.store.commitSave({
        operationId: randomUUID(),
        sessionId: randomUUID(),
        seq: 1,
        pageId: page.id,
        databasePageId: null,
        revision: 0,
        patch: { title: "After" },
      });
      expect(saved.status).toBe("applied");
      f.store.db
        .prepare("INSERT INTO settings(key,value) VALUES('theme','dark')")
        .run();
      const assetId = addAttachment(f, "input.bin", Buffer.from("asset bytes"));
      writeFileSync(join(f.assets, "orphan.bin"), Buffer.from("orphan bytes"));

      // Unknown document nodes and unknown Page fields must survive verbatim.
      const original = JSON.parse(
        f.store.db.prepare("SELECT data FROM pages WHERE id=?").get(page.id)!
          .data as string,
      );
      original.doc = {
        type: "doc",
        content: [{ type: "futureNode", attrs: { value: "keep" } }],
      };
      original.futureField = { preserved: true };
      const raw = JSON.stringify(original);
      f.store.db
        .prepare("UPDATE pages SET data=? WHERE id=?")
        .run(raw, page.id);
      f.store.close();

      const sourceInspection = inspectWorkspaceSnapshot(f.source);
      const { backup, manifest } = createBackup(f.root, f.source);
      const inspection = inspectWorkspaceSnapshot(backup);
      expect(inspection.storeVersion).toBe(3);
      expect(inspection.storeVersion).toBe(sourceInspection.storeVersion);
      expect(inspection.inventory).toEqual(sourceInspection.inventory);
      expect(inspection.logicalSha256).toBe(sourceInspection.logicalSha256);
      expect(inspection.assets).toEqual(sourceInspection.assets);
      expect(inspection.inventory).toEqual({
        pages: 1,
        recordDatabases: 0,
        records: 0,
        versions: 1,
        settings: 1,
        saveReceipts: 1,
        registeredAssets: 1,
      });
      expect(inspection.assets.map((file) => file.path)).toEqual(
        ["assets/" + assetId, "assets/orphan.bin"].sort(),
      );
      expect(inspection.logicalSha256).toMatch(/^[a-f0-9]{64}$/);

      const backupDb = new DatabaseSync(join(backup, "workspace.sqlite"), {
        readOnly: true,
      });
      try {
        expect(
          backupDb.prepare("SELECT data FROM pages WHERE id=?").get(page.id)!
            .data,
        ).toBe(raw);
      } finally {
        backupDb.close();
      }

      const dbPath = join(backup, "workspace.sqlite");
      const before = readFileSync(dbPath);
      expect(inspectWorkspaceSnapshot(backup)).toEqual(inspection);
      expect(readFileSync(dbPath)).toEqual(before);

      const verified = verifyFullBackup(backup);
      expect(verified.directory).toBe(backup);
      expect(verified.manifest).toEqual(manifest);
      expect(verified.fingerprint).toBe(
        sha256(readFileSync(join(backup, "manifest.json"))),
      );
    } finally {
      f.dispose();
    }
  });

  it("inspects and verifies v4 record ownership, values and history", () => {
    const f = fixture(true);
    try {
      const owner = f.store.create(null, "database", "Tasks");
      const repo = new RecordRepository(f.store);
      const record = repo.create(owner.id, "Row", { status: "未着手" });
      repo.patch(record.pageId, owner.id, 0, {
        title: "Edited",
        values: { status: "進行中" },
      });
      f.store.close();

      const { backup } = createBackup(f.root, f.source);
      const inspection = inspectWorkspaceSnapshot(backup);
      expect(inspection.storeVersion).toBe(4);
      expect(inspection.inventory).toMatchObject({
        pages: 2,
        recordDatabases: 1,
        records: 1,
        versions: 1,
      });
      expect(() => verifyFullBackup(backup)).not.toThrow();

      const wrongOwner = createBackup(f.root, f.source, "wrong-owner");
      editDatabase(wrongOwner.backup, (db) => {
        db.exec("PRAGMA foreign_keys=OFF");
        db.prepare(
          "UPDATE record_memberships SET database_page_id='missing'",
        ).run();
      });
      expect(() => inspectWorkspaceSnapshot(wrongOwner.backup)).toThrow(
        /owner|registered/i,
      );

      const badValues = createBackup(f.root, f.source, "bad-values");
      editDatabase(badValues.backup, (db) =>
        db
          .prepare("UPDATE record_memberships SET values_json='not json'")
          .run(),
      );
      expect(() => inspectWorkspaceSnapshot(badValues.backup)).toThrow(
        /record values/i,
      );
    } finally {
      f.dispose();
    }
  });

  it("detects missing and cyclic page parent references", () => {
    const f = fixture(false);
    try {
      const parent = f.store.create(null, "page", "Parent");
      const child = f.store.create(parent.id, "page", "Child");
      f.store.close();
      const { backup } = createBackup(f.root, f.source);

      const missing = createBackup(f.root, f.source, "missing-parent");
      editDatabase(missing.backup, (db) =>
        db
          .prepare("UPDATE pages SET data=? WHERE id=?")
          .run(
            JSON.stringify({ ...child, parentId: "missing-parent-id" }),
            child.id,
          ),
      );
      expect(() => inspectWorkspaceSnapshot(missing.backup)).toThrow(
        /parent reference is missing/i,
      );

      const cyclic = createBackup(f.root, f.source, "cyclic-parent");
      editDatabase(cyclic.backup, (db) =>
        db
          .prepare("UPDATE pages SET data=? WHERE id=?")
          .run(JSON.stringify({ ...parent, parentId: parent.id }), parent.id),
      );
      expect(() => inspectWorkspaceSnapshot(cyclic.backup)).toThrow(
        /cycle/i,
      );
      expect(() => inspectWorkspaceSnapshot(backup)).not.toThrow();
    } finally {
      f.dispose();
    }
  });
});

describe("full backup verification", () => {
  it("rejects database and asset corruption, missing registered assets and metadata mismatches", () => {
    const f = fixture(false);
    try {
      addAttachment(f, "input.bin", Buffer.from("original asset"));
      f.store.close();
      const { backup } = createBackup(f.root, f.source);
      expect(() => verifyFullBackup(backup)).not.toThrow();

      const dbPath = join(backup, "workspace.sqlite");
      const dbBytes = readFileSync(dbPath);
      const corruptDb = Buffer.from(dbBytes);
      corruptDb[corruptDb.length - 1] ^= 0xff;
      writeFileSync(dbPath, corruptDb);
      expect(() => verifyFullBackup(backup)).toThrow(/database bytes or hash/i);
      writeFileSync(dbPath, dbBytes);
      expect(() => verifyFullBackup(backup)).not.toThrow();

      const assetPath = join(backup, "assets", readdirNames(backup)[0]);
      const assetBytes = readFileSync(assetPath);
      writeFileSync(assetPath, Buffer.from("corrupt asset"));
      expect(() => verifyFullBackup(backup)).toThrow(/asset/i);
      writeFileSync(assetPath, assetBytes);
      expect(() => verifyFullBackup(backup)).not.toThrow();

      const missing = createBackup(f.root, f.source, "missing-asset");
      for (const name of readdirNames(missing.backup))
        unlinkSync(join(missing.backup, "assets", name));
      expect(() => verifyFullBackup(missing.backup)).toThrow(/asset/i);

      const metadata = createBackup(f.root, f.source, "metadata-mismatch");
      editDatabase(metadata.backup, (db) => {
        const row = db.prepare("SELECT id,metadata FROM assets").get() as {
          id: string;
          metadata: string;
        };
        const value = JSON.parse(row.metadata);
        value.storageName = "different";
        db.prepare("UPDATE assets SET metadata=? WHERE id=?").run(
          JSON.stringify(value),
          row.id,
        );
      });
      expect(() => inspectWorkspaceSnapshot(metadata.backup)).toThrow(
        /asset metadata/i,
      );
    } finally {
      f.dispose();
    }
  });

  it("requires every actual asset, including orphan files, and nothing extra", () => {
    const f = fixture(false);
    try {
      addAttachment(f, "input.bin", Buffer.from("registered"));
      writeFileSync(join(f.assets, "orphan.bin"), Buffer.from("orphan"));
      f.store.close();
      const { backup, manifest } = createBackup(f.root, f.source);
      expect(manifest.assets.map((file) => file.path)).toContain(
        "assets/orphan.bin",
      );
      expect(() => verifyFullBackup(backup)).not.toThrow();

      const missingOrphan = structuredClone(manifest);
      missingOrphan.assets = missingOrphan.assets.filter(
        (file) => file.path !== "assets/orphan.bin",
      );
      writeManifest(backup, missingOrphan);
      expect(() => verifyFullBackup(backup)).toThrow(/asset list/i);

      writeManifest(backup, manifest);
      writeFileSync(join(backup, "assets", "new-orphan.bin"), Buffer.from("x"));
      expect(() => verifyFullBackup(backup)).toThrow(/asset list/i);
      unlinkSync(join(backup, "assets", "new-orphan.bin"));

      writeManifest(backup, manifest);
      unlinkSync(join(backup, "assets", "orphan.bin"));
      expect(() => verifyFullBackup(backup)).toThrow(/asset list/i);
    } finally {
      f.dispose();
    }
  });

  it("rejects root and descendant symlinks but allows symlinked ancestor aliases", () => {
    const f = fixture(false);
    try {
      addAttachment(f, "input.bin", Buffer.from("asset"));
      f.store.close();
      const { backup } = createBackup(f.root, f.source);
      expect(() => verifyFullBackup(backup)).not.toThrow();

      const rootLink = join(f.root, "root-link");
      symlinkSync(backup, rootLink, "dir");
      expect(() => verifyFullBackup(rootLink)).toThrow(/symbolic link|director/i);

      const assetLink = join(backup, "assets", "linked-asset");
      symlinkSync(join(backup, "workspace.sqlite"), assetLink);
      expect(() => verifyFullBackup(backup)).toThrow(/symbolic|regular file/i);
      unlinkSync(assetLink);

      const ancestorLink = join(f.root, "ancestor-link");
      symlinkSync(f.root, ancestorLink, "dir");
      expect(() =>
        verifyFullBackup(join(ancestorLink, basename(backup))),
      ).not.toThrow();
    } finally {
      f.dispose();
    }
  });

  it("rejects extra root entries, WAL sidecars, traversal, duplicates and malformed manifests", () => {
    const f = fixture(false);
    try {
      addAttachment(f, "input.bin", Buffer.from("asset"));
      f.store.close();
      const { backup, manifest } = createBackup(f.root, f.source);
      expect(() => verifyFullBackup(backup)).not.toThrow();

      writeFileSync(join(backup, "extra.txt"), "extra");
      expect(() => verifyFullBackup(backup)).toThrow(/unexpected backup entry/i);
      unlinkSync(join(backup, "extra.txt"));

      writeFileSync(join(backup, "workspace.sqlite-wal"), "wal");
      expect(() => verifyFullBackup(backup)).toThrow(/unexpected backup entry/i);
      unlinkSync(join(backup, "workspace.sqlite-wal"));

      const traversal = structuredClone(manifest);
      traversal.assets[0].path = "assets/../workspace.sqlite";
      writeManifest(backup, traversal);
      expect(() => verifyFullBackup(backup)).toThrow(/asset.*path|unsafe/i);

      const duplicate = structuredClone(manifest);
      duplicate.assets.push({ ...duplicate.assets[0] });
      writeManifest(backup, duplicate);
      expect(() => verifyFullBackup(backup)).toThrow(/duplicate/i);

      const extraField = {
        ...structuredClone(manifest),
        extra: true,
      } as unknown as WorkspaceBackupManifest;
      writeManifest(backup, extraField);
      expect(() => verifyFullBackup(backup)).toThrow(/fields/i);

      writeFileSync(join(backup, "manifest.json"), "{");
      expect(() => verifyFullBackup(backup)).toThrow(/malformed/i);

      writeFileSync(
        join(backup, "manifest.json"),
        " ".repeat(8 * 1024 * 1024 + 1),
      );
      expect(() => verifyFullBackup(backup)).toThrow(/size limit/i);

      writeManifest(backup, manifest);
      expect(() => verifyFullBackup(backup)).not.toThrow();
    } finally {
      f.dispose();
    }
  });

  it("rejects the incomplete marker by default, accepts it when allowed, and rejects future schemas", () => {
    const f = fixture(false);
    try {
      const page = f.store.create(null, "page", "Page");
      f.store.close();
      const { backup, manifest } = createBackup(f.root, f.source);
      writeFileSync(join(backup, "FOLIO-RECOVERY-INCOMPLETE"), "pending");
      expect(() => verifyFullBackup(backup)).toThrow(
        /FOLIO-RECOVERY-INCOMPLETE/,
      );
      const allowed = verifyFullBackup(backup, { allowIncomplete: true });
      expect(allowed.manifest).toEqual(manifest);

      writeFileSync(join(backup, "workspace.sqlite-wal"), "wal");
      expect(() =>
        verifyFullBackup(backup, { allowIncomplete: true }),
      ).toThrow(/unexpected backup entry/i);
      unlinkSync(join(backup, "workspace.sqlite-wal"));

      const futureManifest = structuredClone(manifest);
      futureManifest.storeVersion = 6;
      writeManifest(backup, futureManifest);
      expect(() => verifyFullBackup(backup, { allowIncomplete: true })).toThrow(
        /unsupported workspace/i,
      );

      writeManifest(backup, manifest);
      editDatabase(backup, (db) => db.exec("PRAGMA user_version=6"));
      expect(() => inspectWorkspaceSnapshot(backup)).toThrow(
        /unsupported workspace database version/i,
      );

      // Guard against the fixture itself being considered invalid by accident.
      expect(page.id).toBeTruthy();
    } finally {
      f.dispose();
    }
  });

  it("fingerprints the exact manifest bytes and covers every table including sqlite_sequence", () => {
    const f = fixture(false);
    try {
      const page = f.store.create(null, "page", "Page");
      f.store.commitSave({
        operationId: randomUUID(),
        sessionId: randomUUID(),
        seq: 1,
        pageId: page.id,
        databasePageId: null,
        revision: 0,
        patch: { title: "After" },
      });
      f.store.db.exec(
        "CREATE TABLE extra_records(k TEXT PRIMARY KEY, v TEXT NOT NULL)",
      );
      f.store.db
        .prepare("INSERT INTO extra_records(k,v) VALUES('b','second')")
        .run();
      f.store.db
        .prepare("INSERT INTO extra_records(k,v) VALUES('a','first')")
        .run();
      f.store.close();
      const { backup, manifest } = createBackup(f.root, f.source);

      const first = verifyFullBackup(backup);
      expect(first.fingerprint).toBe(
        sha256(readFileSync(join(backup, "manifest.json"))),
      );
      const pretty = JSON.stringify(manifest, null, 4) + "\n";
      writeFileSync(join(backup, "manifest.json"), pretty);
      const second = verifyFullBackup(backup);
      expect(second.fingerprint).toBe(sha256(Buffer.from(pretty)));
      expect(second.fingerprint).not.toBe(first.fingerprint);

      // Rebuilding the same logical rows in the opposite insertion order must
      // not change the canonical digest.
      const digestBefore = inspectWorkspaceSnapshot(backup).logicalSha256;
      editDatabase(backup, (db) => {
        db.exec("DROP TABLE extra_records");
        db.exec("CREATE TABLE extra_records(k TEXT PRIMARY KEY, v TEXT NOT NULL)");
        db.prepare("INSERT INTO extra_records(k,v) VALUES('a','first')").run();
        db.prepare("INSERT INTO extra_records(k,v) VALUES('b','second')").run();
      });
      expect(inspectWorkspaceSnapshot(backup).logicalSha256).toBe(digestBefore);

      const mutation = createBackup(f.root, f.source, "digest-mutation");
      editDatabase(mutation.backup, (db) =>
        db.prepare("INSERT INTO extra_records(k,v) VALUES('c','third')").run(),
      );
      expect(inspectWorkspaceSnapshot(mutation.backup).logicalSha256).not.toBe(
        digestBefore,
      );

      const sequence = createBackup(f.root, f.source, "sequence-mutation");
      const sequenceBefore = inspectWorkspaceSnapshot(sequence.backup);
      editDatabase(sequence.backup, (db) =>
        db.prepare("UPDATE sqlite_sequence SET seq=seq+10 WHERE name='versions'").run(),
      );
      const sequenceAfter = inspectWorkspaceSnapshot(sequence.backup);
      expect(sequenceAfter.inventory).toEqual(sequenceBefore.inventory);
      expect(sequenceAfter.logicalSha256).not.toBe(sequenceBefore.logicalSha256);
    } finally {
      f.dispose();
    }
  });
});

function readdirNames(backup: string): string[] {
  return readdirSync(join(backup, "assets")).sort();
}
