import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { hashCheckpoint, type Checkpoint } from "../src/sync/protocol";
import {
  CHECKPOINT_SERVER_BACKUP_DATABASE,
  CHECKPOINT_SERVER_BACKUP_FORMAT,
  CHECKPOINT_SERVER_BACKUP_MANIFEST,
  CHECKPOINT_SERVER_BACKUP_MARKER,
  CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES,
  type CheckpointServerBackupManifest,
} from "../src/sync/server-backup";
import {
  inspectCheckpointServerBackup,
} from "../src/sync/server-backup-inspection";

const WORKSPACE_ID = "workspace";
const EPOCH = "epoch-1";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-backup-inspection-")),
  );
  roots.push(root);
  return root;
}

function checkpoint(text: string): Checkpoint {
  return {
    format: "folio-checkpoint/v1",
    name: "test-fixture",
    version: 1,
    payload: { text },
    assets: [],
  };
}

type Fixture = {
  root: string;
  directory: string;
  manifestPath: string;
  databasePath: string;
  manifest: CheckpointServerBackupManifest;
  epoch: string;
};

function makeFixture(): Fixture {
  const root = tempRoot();
  const directory = join(root, "backup");
  mkdirSync(directory, { mode: 0o700 });
  const databasePath = join(directory, CHECKPOINT_SERVER_BACKUP_DATABASE);
  const manifestPath = join(directory, CHECKPOINT_SERVER_BACKUP_MANIFEST);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      CREATE TABLE checkpoint_server_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, epoch TEXT NOT NULL);
      CREATE TABLE checkpoint_heads(workspace_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision INTEGER NOT NULL, checkpoint_hash TEXT, checkpoint_json TEXT);
      CREATE TABLE checkpoint_operations(workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, commit_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(workspace_id,client_id,operation_id));
      CREATE TABLE checkpoint_changes(workspace_id TEXT NOT NULL, revision INTEGER NOT NULL, change_json TEXT NOT NULL, PRIMARY KEY(workspace_id,revision));
      CREATE TABLE checkpoint_devices(workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, owner_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), PRIMARY KEY(workspace_id,client_id));
    `);
    db.prepare("INSERT INTO checkpoint_server_identity VALUES(1,1,?)").run(
      EPOCH,
    );
    const value = checkpoint("two");
    const checkpointHash = hashCheckpoint(value);
    db.prepare("INSERT INTO checkpoint_heads VALUES(?,?,?,?,?)").run(
      WORKSPACE_ID,
      "owner",
      2,
      checkpointHash,
      JSON.stringify(value),
    );
    for (let revision = 1; revision <= 2; revision++) {
      db.prepare("INSERT INTO checkpoint_changes VALUES(?,?,?)").run(
        WORKSPACE_ID,
        revision,
        "{}",
      );
      db.prepare("INSERT INTO checkpoint_operations VALUES(?,?,?,?,?,?)").run(
        WORKSPACE_ID,
        "client",
        `op-${revision}`,
        "fingerprint",
        "{}",
        "{}",
      );
    }
    db.prepare("INSERT INTO checkpoint_devices VALUES(?,?,?,?,0)").run(
      WORKSPACE_ID,
      "client",
      "owner",
      "token-hash",
    );
  } finally {
    db.close();
  }

  const bytes = readFileSync(databasePath);
  const manifest: CheckpointServerBackupManifest = {
    format: CHECKPOINT_SERVER_BACKUP_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    serverEpoch: EPOCH,
    scope: "catalog",
    database: {
      path: CHECKPOINT_SERVER_BACKUP_DATABASE,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    counts: {
      workspaces: 1,
      changes: 2,
      operations: 2,
      devices: 1,
      activeDevices: 1,
      revokedDevices: 0,
    },
    workspaces: [
      {
        workspaceId: WORKSPACE_ID,
        revision: 2,
        checkpointHash: hashCheckpoint(checkpoint("two")),
      },
    ],
    attachments: { included: false, headAssetReferences: 0 },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  return {
    root,
    directory,
    manifestPath,
    databasePath,
    manifest,
    epoch: EPOCH,
  };
}

function rewriteManifest(
  fixture: Fixture,
  mutate: (manifest: CheckpointServerBackupManifest) => void,
): void {
  const manifest = JSON.parse(
    readFileSync(fixture.manifestPath, "utf8"),
  ) as CheckpointServerBackupManifest;
  mutate(manifest);
  writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
}

it("verifies a standalone catalog backup and reports excluded attachment bytes", () => {
  const fixture = makeFixture();
  const result = inspectCheckpointServerBackup(fixture.directory);
  expect(result.directory).toBe(realpathSync(fixture.directory));
  expect(result.manifest).toEqual(fixture.manifest);
  expect(result.database).toEqual(fixture.manifest.database);
  expect(result.serverEpoch).toBe(fixture.epoch);
  expect(result.counts).toEqual(fixture.manifest.counts);
  expect(result.workspaces).toEqual(fixture.manifest.workspaces);
  expect(result.attachments).toEqual({
    included: false,
    bytes: "excluded",
    headAssetReferences: 0,
    message: "Attachment bytes are excluded from this catalog backup.",
  });
  expect(inspectCheckpointServerBackup(fixture.directory).serverEpoch).toBe(
    fixture.epoch,
  );
});

it("rejects the incomplete marker even when the catalog is otherwise valid", () => {
  const fixture = makeFixture();
  writeFileSync(
    join(fixture.directory, CHECKPOINT_SERVER_BACKUP_MARKER),
    "incomplete",
  );
  expect(() => inspectCheckpointServerBackup(fixture.directory)).toThrow(
    "server-backup-incomplete",
  );
});

it("rejects symlinked and hardlinked database or manifest files", () => {
  const symlinked = makeFixture();
  const realDatabase = join(symlinked.root, "real.sqlite");
  renameSync(symlinked.databasePath, realDatabase);
  symlinkSync(realDatabase, symlinked.databasePath);
  expect(() => inspectCheckpointServerBackup(symlinked.directory)).toThrow(
    "server-backup-unsafe-file",
  );

  const hardlinked = makeFixture();
  const outsideDatabase = join(hardlinked.root, "outside.sqlite");
  linkSync(hardlinked.databasePath, outsideDatabase);
  expect(() => inspectCheckpointServerBackup(hardlinked.directory)).toThrow(
    "server-backup-unsafe-file",
  );
  unlinkSync(outsideDatabase);

  const manifestLinked = makeFixture();
  const outsideManifest = join(manifestLinked.root, "outside-manifest.json");
  linkSync(manifestLinked.manifestPath, outsideManifest);
  expect(() => inspectCheckpointServerBackup(manifestLinked.directory)).toThrow(
    "server-backup-unsafe-file",
  );
  unlinkSync(outsideManifest);
});

it("rejects malformed, oversized and unsupported manifests", () => {
  const malformed = makeFixture();
  writeFileSync(malformed.manifestPath, "{");
  expect(() => inspectCheckpointServerBackup(malformed.directory)).toThrow(
    "server-backup-verification-failed",
  );

  const oversized = makeFixture();
  writeFileSync(
    oversized.manifestPath,
    "x".repeat(CHECKPOINT_SERVER_BACKUP_MAX_MANIFEST_BYTES + 1),
  );
  expect(() => inspectCheckpointServerBackup(oversized.directory)).toThrow(
    "server-backup-manifest-too-large",
  );

  const unsupported = makeFixture();
  rewriteManifest(unsupported, (manifest) => {
    (manifest as unknown as { format: string }).format = "other-format";
  });
  expect(() => inspectCheckpointServerBackup(unsupported.directory)).toThrow(
    "server-backup-unsupported-format",
  );

  const futureVersion = makeFixture();
  rewriteManifest(futureVersion, (manifest) => {
    (manifest as unknown as { version: number }).version = 2;
  });
  expect(
    () => inspectCheckpointServerBackup(futureVersion.directory),
  ).toThrow("server-backup-unsupported-format");
});

it("rejects an incorrect database length or sha256", () => {
  const wrongLength = makeFixture();
  rewriteManifest(wrongLength, (manifest) => {
    manifest.database.bytes += 1;
  });
  expect(() => inspectCheckpointServerBackup(wrongLength.directory)).toThrow(
    "server-backup-verification-failed",
  );

  const wrongHash = makeFixture();
  rewriteManifest(wrongHash, (manifest) => {
    manifest.database.sha256 = "b".repeat(64);
  });
  expect(() => inspectCheckpointServerBackup(wrongHash.directory)).toThrow(
    "server-backup-verification-failed",
  );
});

it("rejects catalog, count and attachment-reference mismatches", () => {
  const wrongCount = makeFixture();
  rewriteManifest(wrongCount, (manifest) => {
    manifest.counts.changes += 1;
  });
  expect(() => inspectCheckpointServerBackup(wrongCount.directory)).toThrow(
    "server-backup-verification-failed",
  );

  const wrongWorkspace = makeFixture();
  rewriteManifest(wrongWorkspace, (manifest) => {
    manifest.workspaces[0].revision = 1;
  });
  expect(() => inspectCheckpointServerBackup(wrongWorkspace.directory)).toThrow(
    "server-backup-verification-failed",
  );

  const wrongAssets = makeFixture();
  rewriteManifest(wrongAssets, (manifest) => {
    manifest.attachments.headAssetReferences = 1;
  });
  expect(() => inspectCheckpointServerBackup(wrongAssets.directory)).toThrow(
    "server-backup-verification-failed",
  );
});

it("rejects an epoch mismatch against the database or the expected epoch", () => {
  const manifestEpoch = makeFixture();
  rewriteManifest(manifestEpoch, (manifest) => {
    manifest.serverEpoch = "epoch-2";
  });
  expect(() => inspectCheckpointServerBackup(manifestEpoch.directory)).toThrow(
    "server-backup-epoch-mismatch",
  );

  const expectedEpoch = makeFixture();
  expect(() =>
    inspectCheckpointServerBackup(expectedEpoch.directory, {
      expectedEpoch: "epoch-2",
    }),
  ).toThrow("server-backup-epoch-mismatch");
});

it("rejects a corrupted database even when the manifest is updated to match", () => {
  const fixture = makeFixture();
  const original = readFileSync(fixture.databasePath);
  const corrupted = Buffer.from(
    original.subarray(0, Math.max(100, Math.floor(original.length / 2))),
  );
  writeFileSync(fixture.databasePath, corrupted);
  rewriteManifest(fixture, (manifest) => {
    manifest.database.bytes = corrupted.length;
    manifest.database.sha256 = createHash("sha256")
      .update(corrupted)
      .digest("hex");
  });
  expect(() => inspectCheckpointServerBackup(fixture.directory)).toThrow(
    "server-backup-verification-failed",
  );
});

it("fails closed on sidecars and unexpected directory entries", () => {
  const sidecar = makeFixture();
  writeFileSync(sidecar.databasePath + "-wal", "");
  expect(() => inspectCheckpointServerBackup(sidecar.directory)).toThrow(
    "server-backup-verification-failed",
  );

  const unexpected = makeFixture();
  writeFileSync(join(unexpected.directory, "notes.txt"), "keep");
  expect(() => inspectCheckpointServerBackup(unexpected.directory)).toThrow(
    "server-backup-unsafe-file",
  );
});
