import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachFile } from "../src/persistence/assets";
import { copyRecoveryAsset } from "../src/persistence/conflict-recovery-assets";
import {
  validateRecoveryManifest,
  verifyRecoveryBundle,
} from "../src/persistence/conflict-recovery-verify";
import { Store } from "../src/persistence/store";
import type { ArchiveTarget } from "../src/shared/conflict-recovery";
import {
  listConflictArchives,
  readConflictArchive,
} from "../src/sync/conflict-archive-catalog";
import {
  canonicalJson,
  hashCheckpoint,
  MAX_CHECKPOINT_BYTES,
  type Checkpoint,
} from "../src/sync/protocol";
import {
  buildWorkspaceCheckpoint,
  WORKSPACE_CONTENT_TABLES,
} from "../src/sync/workspace-checkpoint";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const db of databases.splice(0)) {
    if (db.isOpen) db.close();
  }
});

function root(): string {
  const directory = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "folio-m1-d10-")));
  roots.push(directory);
  return directory;
}

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const STATE_SCHEMA = `CREATE TABLE workspace_sync_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  server_epoch TEXT NOT NULL,
  generation INTEGER NOT NULL,
  clean_generation INTEGER NOT NULL,
  applied_revision INTEGER NOT NULL,
  received_cursor INTEGER NOT NULL,
  suppress_triggers INTEGER NOT NULL CHECK(suppress_triggers IN (0,1))
)`;

const ARCHIVE_SCHEMA = `CREATE TABLE workspace_sync_archives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

function catalogCheckpoint(name = "folio-workspace"): Checkpoint {
  const tables = Object.fromEntries(WORKSPACE_CONTENT_TABLES.map((table) => [table, []]));
  return {
    format: "folio-checkpoint/v1",
    name,
    version: 1,
    payload: { tables },
    assets: [],
  } as Checkpoint;
}

function insertState(
  db: DatabaseSync,
  identity = {
    workspaceId: "workspace-a",
    clientId: "client-a",
    bindingId: "binding-a",
    serverEpoch: "epoch-a",
  },
): void {
  db.prepare(
    `INSERT INTO workspace_sync_state(
      singleton,schema_version,workspace_id,client_id,binding_id,server_epoch,
      generation,clean_generation,applied_revision,received_cursor,suppress_triggers
    ) VALUES(1,1,?,?,?,?,0,0,0,0,0)`,
  ).run(identity.workspaceId, identity.clientId, identity.bindingId, identity.serverEpoch);
}

function insertArchive(
  db: DatabaseSync,
  value: Checkpoint | string,
  options: { operationId?: string; kind?: string; createdAt?: number } = {},
): number {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const result = db
    .prepare(
      "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
    )
    .run(
      options.operationId ?? "operation-" + randomUUID(),
      options.kind ?? "conflict-local",
      json,
      options.createdAt ?? 1,
    );
  return Number(result.lastInsertRowid);
}

function archiveDatabase(): DatabaseSync {
  const db = database();
  db.exec(STATE_SCHEMA);
  db.exec(ARCHIVE_SCHEMA);
  insertState(db);
  return db;
}

function targetOf(db: DatabaseSync, limit = 1): ArchiveTarget {
  const target = listConflictArchives(db, { limit }).items[0]?.target;
  if (!target) throw new Error("expected a valid archive target");
  return target;
}

describe("D03 catalog adversarial reads", () => {
  it("isolates corrupt and oversized checkpoint JSON and still reports limits", () => {
    const empty = database();
    expect(listConflictArchives(empty)).toEqual({ items: [], next: null, total: 0 });

    const blocked = database();
    blocked.exec(STATE_SCHEMA);
    insertState(blocked, {
      workspaceId: "",
      clientId: "client-a",
      bindingId: "binding-a",
      serverEpoch: "epoch-a",
    });
    expect(() => listConflictArchives(blocked)).toThrow(/invalid-sync-state/);

    const db = archiveDatabase();
    const validId = insertArchive(db, catalogCheckpoint(), { operationId: "valid" });
    const brokenId = insertArchive(db, "{", { operationId: "broken" });
    const huge = "x".repeat(MAX_CHECKPOINT_BYTES + 1);
    const hugeId = insertArchive(db, huge, { operationId: "huge" });

    const page = listConflictArchives(db, { limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([hugeId, brokenId, validId]);
    expect(page.total).toBe(3);

    const byId = new Map(page.items.map((item) => [item.id, item]));
    const expectedHash = digest(canonicalJson(catalogCheckpoint()));
    expect(expectedHash).toBe(hashCheckpoint(catalogCheckpoint()));
    expect(byId.get(validId)).toMatchObject({
      valid: true,
      bytes: Buffer.byteLength(JSON.stringify(catalogCheckpoint())),
      pages: 0,
      assets: 0,
      attachmentStatus: "not-checked",
      target: { operationId: "valid", checkpointHash: expectedHash },
    });
    expect(byId.get(brokenId)).toMatchObject({
      valid: false,
      target: null,
      reason: "invalid-archive-checkpoint",
    });
    expect(byId.get(hugeId)).toMatchObject({
      valid: false,
      target: null,
      reason: "checkpoint-too-large",
      bytes: MAX_CHECKPOINT_BYTES + 1,
    });
  });

  it("keeps the pagination anchor fixed when newer archives arrive", () => {
    const db = archiveDatabase();
    for (let index = 1; index <= 5; index += 1) {
      insertArchive(db, catalogCheckpoint(), {
        operationId: "operation-" + index,
        createdAt: index,
      });
    }

    const first = listConflictArchives(db, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([5, 4]);
    expect(first.next).toEqual({ anchor: 5, before: 4 });
    expect(first.total).toBe(5);

    insertArchive(db, catalogCheckpoint(), { operationId: "newer", createdAt: 6 });
    const second = listConflictArchives(db, { limit: 2, cursor: first.next! });
    expect(second.items.map((item) => item.id)).toEqual([3, 2]);
    expect(second.next).toEqual({ anchor: 5, before: 2 });
    expect(second.total).toBe(6);

    const third = listConflictArchives(db, { limit: 2, cursor: second.next! });
    expect(third.items.map((item) => item.id)).toEqual([1]);
    expect(third.next).toBeNull();
  });

  it("rejects target tuple changes and source scope changes", () => {
    const db = archiveDatabase();
    const id = insertArchive(db, catalogCheckpoint(), {
      operationId: "operation-read",
      kind: "conflict-local",
      createdAt: 10,
    });
    const target = targetOf(db);
    expect(target.source).toBe(digest(canonicalJson([
      "workspace-a",
      "client-a",
      "binding-a",
      "epoch-a",
    ])));
    expect(readConflictArchive(db, target).checkpoint).toEqual(catalogCheckpoint());

    db.prepare("UPDATE workspace_sync_archives SET kind=? WHERE id=?").run("changed-kind", id);
    expect(() => readConflictArchive(db, target)).toThrow(/archive-target-mismatch/);

    db.prepare("UPDATE workspace_sync_archives SET kind=? WHERE id=?").run("conflict-local", id);
    db.prepare("UPDATE workspace_sync_state SET server_epoch=? WHERE singleton=1").run("epoch-b");
    expect(() => readConflictArchive(db, target)).toThrow(/archive-source-mismatch/);

    const refreshed = targetOf(db);
    expect(refreshed.source).not.toBe(target.source);
    expect(readConflictArchive(db, refreshed).checkpoint).toEqual(catalogCheckpoint());
  });
});

function makeBundle(attachmentBytes?: Buffer) {
  const directory = root();
  const store = new Store(join(directory, "workspace.sqlite"));
  const sourceAssets = join(directory, "workspace-assets");
  mkdirSync(sourceAssets);
  const written: { id: string; bytes: Buffer }[] = [];
  let checkpoint: ReturnType<typeof buildWorkspaceCheckpoint> | undefined;
  try {
    if (attachmentBytes) {
      const source = join(directory, "attachment.bin");
      writeFileSync(source, attachmentBytes);
      const attached = attachFile(store.db, sourceAssets, source);
      written.push({ id: attached.id, bytes: readFileSync(source) });
    }
    checkpoint = buildWorkspaceCheckpoint(store.db);
  } finally {
    store.close();
  }
  if (!checkpoint) throw new Error("checkpoint was not built");

  const checkpointJson = canonicalJson(checkpoint);
  const checkpointHash = hashCheckpoint(checkpoint);
  const manifest = {
    format: "folio-conflict-recovery" as const,
    version: 1 as const,
    archive: {
      source: "a".repeat(64),
      id: 1,
      operationId: "operation-1",
      kind: "conflict-remote",
      createdAt: 1,
      checkpointHash,
    },
    checkpoint: {
      file: "checkpoint.json" as const,
      bytes: Buffer.byteLength(checkpointJson),
      sha256: checkpointHash,
    },
    assets: checkpoint.assets.map((asset) => ({ ...asset, file: `assets/${asset.id}` })),
  };
  const bundle = join(directory, "bundle");
  mkdirSync(bundle);
  mkdirSync(join(bundle, "assets"));
  writeFileSync(join(bundle, "checkpoint.json"), checkpointJson);
  for (const asset of written) writeFileSync(join(bundle, "assets", asset.id), asset.bytes);
  writeFileSync(join(bundle, "manifest.json"), canonicalJson(manifest));
  return { directory, bundle, checkpoint, checkpointJson, manifest, written };
}

function writeManifest(bundle: string, manifest: unknown): void {
  writeFileSync(join(bundle, "manifest.json"), canonicalJson(manifest));
}

describe("D04 bundle adversarial verification", () => {
  it("accepts a valid bundle and derives hashes with node:crypto", () => {
    const fixture = makeBundle();
    expect(fixture.manifest.checkpoint.sha256)
      .toBe(digest(canonicalJson(fixture.checkpoint)));

    const verified = verifyRecoveryBundle(fixture.bundle);
    expect(verified.checkpoint).toEqual(fixture.checkpoint);
    expect(verified.fingerprint).toBe(digest(canonicalJson(fixture.manifest)));
  });

  it("rejects a manifest replacement with a wrong checkpoint hash or bytes", () => {
    const fixture = makeBundle();
    writeManifest(fixture.bundle, {
      ...fixture.manifest,
      archive: { ...fixture.manifest.archive, checkpointHash: "e".repeat(64) },
      checkpoint: { ...fixture.manifest.checkpoint, sha256: "e".repeat(64) },
    });
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-checkpoint-hash/);

    writeManifest(fixture.bundle, fixture.manifest);
    writeFileSync(join(fixture.bundle, "checkpoint.json"), fixture.checkpointJson + " ");
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-checkpoint-bytes/);
  });

  it("rejects extra root entries and unexpected asset files", () => {
    const fixture = makeBundle();
    writeFileSync(join(fixture.bundle, "token.txt"), "secret-token");
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/unexpected-recovery-entry/);

    unlinkSync(join(fixture.bundle, "token.txt"));
    writeFileSync(join(fixture.bundle, "assets", "unexpected.bin"), "extra");
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-assets-mismatch/);
  });

  it("rejects the incomplete marker unless the caller explicitly allows it", () => {
    const fixture = makeBundle();
    writeFileSync(join(fixture.bundle, "FOLIO-RECOVERY-INCOMPLETE"), "pending");
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-incomplete/);

    const allowed = verifyRecoveryBundle(fixture.bundle, { allowIncomplete: true });
    expect(allowed.fingerprint).toBe(digest(canonicalJson(fixture.manifest)));
  });

  it("rejects archive hash swaps and non-exact manifest shapes", () => {
    const fixture = makeBundle();
    expect(() => validateRecoveryManifest({
      ...fixture.manifest,
      archive: { ...fixture.manifest.archive, checkpointHash: "f".repeat(64) },
    })).toThrow(/recovery-archive-hash-mismatch/);

    expect(() => validateRecoveryManifest({ ...fixture.manifest, token: "secret" }))
      .toThrow(/invalid-recovery-manifest/);

    const traversal = {
      id: "escape",
      sha256: "d".repeat(64),
      bytes: 1,
      file: "assets/../escape",
    };
    expect(() => validateRecoveryManifest({ ...fixture.manifest, assets: [traversal] }))
      .toThrow(/invalid-recovery-asset-file/);

    const duplicate = {
      id: "duplicate",
      sha256: "d".repeat(64),
      bytes: 1,
      file: "assets/duplicate",
    };
    expect(() => validateRecoveryManifest({
      ...fixture.manifest,
      assets: [duplicate, duplicate],
    })).toThrow(/duplicate-recovery-asset-id/);

    const oversized = Array.from({ length: 6 }, (_, index) => ({
      id: `asset-${index}`,
      sha256: "d".repeat(64),
      bytes: 20_000_000,
      file: `assets/asset-${index}`,
    }));
    expect(() => validateRecoveryManifest({ ...fixture.manifest, assets: oversized }))
      .toThrow(/recovery-asset-total-too-large/);
  });

  it("rejects a tampered or missing bundled asset", () => {
    const bytes = Buffer.from("adversarial attachment payload");
    const fixture = makeBundle(bytes);
    const asset = fixture.written[0];
    const output = join(fixture.bundle, "assets", asset.id);
    expect(readFileSync(output).equals(bytes)).toBe(true);

    writeFileSync(output, Buffer.from("tampered"));
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-asset-mismatch/);

    unlinkSync(output);
    expect(() => verifyRecoveryBundle(fixture.bundle)).toThrow(/recovery-assets-mismatch/);
  });
});

function assetFixture() {
  const directory = root();
  const source = join(directory, "source");
  const destination = join(directory, "destination");
  mkdirSync(source);
  mkdirSync(destination);
  mkdirSync(join(source, "assets"));
  mkdirSync(join(destination, "assets"));
  return { directory, source, destination };
}

function assetManifest(bytes: Buffer, id = `${randomUUID()}.bin`) {
  return { id, sha256: digest(bytes), bytes: bytes.length };
}

function putAsset(
  rootPath: string,
  asset: { id: string },
  bytes: Buffer,
  prefix = "assets",
): void {
  writeFileSync(join(rootPath, prefix, asset.id), bytes);
}

describe("D05 asset adversarial copying", () => {
  it("copies a normal Unicode asset into an independent file", () => {
    const { source, destination } = assetFixture();
    const bytes = Buffer.from("unicode attachment payload");
    const asset = assetManifest(bytes, "添付-日本語-α.bin");
    putAsset(source, asset, bytes);

    copyRecoveryAsset(source, destination, asset);
    const output = join(destination, "assets", asset.id);
    const copied = readFileSync(output);
    expect(copied.equals(bytes)).toBe(true);
    expect(digest(copied)).toBe(asset.sha256);
    expect(statSync(output).ino).not.toBe(statSync(join(source, "assets", asset.id)).ino);
  });

  it("rejects symlinked and hardlinked sources without creating output", () => {
    const { directory, source, destination } = assetFixture();
    const bytes = Buffer.from("linked source payload");
    const real = join(directory, "real.bin");
    writeFileSync(real, bytes);

    const symlinkAsset = assetManifest(bytes, "symlink.bin");
    symlinkSync(real, join(source, "assets", symlinkAsset.id));
    expect(() => copyRecoveryAsset(source, destination, symlinkAsset)).toThrow();
    expect(existsSync(join(destination, "assets", symlinkAsset.id))).toBe(false);

    const hardlinkAsset = assetManifest(bytes, "hardlink.bin");
    linkSync(real, join(source, "assets", hardlinkAsset.id));
    expect(() => copyRecoveryAsset(source, destination, hardlinkAsset)).toThrow();
    expect(existsSync(join(destination, "assets", hardlinkAsset.id))).toBe(false);
  });

  it("rejects path traversal and unsafe asset identifiers", () => {
    const { source, destination } = assetFixture();
    for (const id of ["", ".", "..", "../escape", "a/b", "a\\b", "a\0b", "/absolute"]) {
      const asset = { id, sha256: "0".repeat(64), bytes: 0 };
      expect(() => copyRecoveryAsset(source, destination, asset))
        .toThrow(/unsafe-recovery-asset-id/);
    }
    expect(existsSync(join(destination, "assets", "escape"))).toBe(false);
  });

  it("retains the output when a fault interrupts before or after directory sync", () => {
    const { source, destination } = assetFixture();
    const bytes = Buffer.from("fault retention payload");
    for (const stage of ["after-file-sync", "before-directory-sync"]) {
      const asset = assetManifest(bytes, `${stage}.bin`);
      putAsset(source, asset, bytes);
      expect(() => copyRecoveryAsset(source, destination, asset, {
        fault: (current) => {
          if (current === stage) throw new Error(`fault-${stage}`);
        },
      })).toThrow(`fault-${stage}`);

      const output = join(destination, "assets", asset.id);
      expect(existsSync(output)).toBe(true);
      const kept = readFileSync(output);
      expect(kept.equals(bytes)).toBe(true);
      expect(digest(kept)).toBe(asset.sha256);
    }
  });

  it("rejects non-canonical roots and pre-existing destination symlinks", () => {
    const { directory, source, destination } = assetFixture();
    const bytes = Buffer.from("destination guard payload");
    const asset = assetManifest(bytes);
    putAsset(source, asset, bytes);

    symlinkSync(destination, join(directory, "destination-link"));
    expect(() => copyRecoveryAsset(source, join(directory, "destination-link"), asset))
      .toThrow(/unsafe-recovery-directory/);
    expect(existsSync(join(destination, "assets", asset.id))).toBe(false);

    const outside = join(directory, "outside.bin");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(destination, "assets", asset.id));
    expect(() => copyRecoveryAsset(source, destination, asset)).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });
});
