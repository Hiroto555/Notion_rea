import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CheckpointRemote } from "../src/sync/client";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import {
  hashCheckpoint,
  SyncError,
  type Checkpoint,
  type Commit,
} from "../src/sync/protocol";
import { inspectFullServerBackup } from "../src/sync/server-full-inspection";
import {
  SERVER_FULL_MARKER,
  SERVER_FULL_MANIFEST,
  type ServerFullBackupManifest,
} from "../src/sync/server-full-types";

const WORKSPACE_ID = "workspace";
const OWNER_ID = "owner";
const CLIENT_ID = "client-a";
const OTHER_CLIENT_ID = "client-b";
const roots: string[] = [];
let suiteRoot = "";
let backupIndex = 0;
let source: {
  dbBytes: Buffer;
  blobBytes: Buffer;
  assetSha: string;
  manifest: ServerFullBackupManifest;
};

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");
const WORKSPACE_BLOB_DIR = sha256(WORKSPACE_ID);

function tempRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-server-full-")),
  );
  roots.push(root);
  return root;
}

function validateCheckpoint(value: Checkpoint): boolean {
  if (
    value.name !== "test-fixture" ||
    value.version !== 1 ||
    typeof value.payload.text !== "string"
  )
    throw new Error("fixture schema");
  return true;
}

function checkpoint(
  text: string,
  assets: Checkpoint["assets"] = [],
): Checkpoint {
  return {
    format: "folio-checkpoint/v1",
    name: "test-fixture",
    version: 1,
    payload: { text },
    assets,
  };
}

async function commit(
  remote: CheckpointRemote,
  baseRevision: number,
  text: string,
  operationId: string,
  assets: Checkpoint["assets"] = [],
): Promise<{ checkpointHash: string; status: string }> {
  const head = await remote.head();
  const value = checkpoint(text, assets);
  const operation: Commit = {
    protocol: 1,
    workspaceId: WORKSPACE_ID,
    clientId: CLIENT_ID,
    operationId,
    serverEpoch: head.serverEpoch,
    baseRevision,
    checkpointHash: hashCheckpoint(value),
    checkpoint: value,
  };
  const result = await remote.commit(operation);
  return { checkpointHash: operation.checkpointHash, status: result.status };
}

beforeAll(async () => {
  suiteRoot = tempRoot();
  const staging = join(suiteRoot, "staging");
  mkdirSync(staging, { mode: 0o700 });
  const databasePath = join(staging, "server.sqlite");
  const token = randomBytes(32).toString("base64url");
  const otherToken = randomBytes(32).toString("base64url");
  const server = await startCheckpointServer({
    databasePath,
    capabilities: [],
    workspaces: [{ workspaceId: WORKSPACE_ID, ownerId: OWNER_ID }],
    validateCheckpoint,
    blobs: { has: () => true, handle: async () => {} },
  });
  try {
    server.registerDevice({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      clientId: CLIENT_ID,
      token,
    });
    server.registerDevice({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      clientId: OTHER_CLIENT_ID,
      token: otherToken,
    });
    server.revokeDevice(WORKSPACE_ID, OTHER_CLIENT_ID);

    const remote = new CheckpointRemote({
      baseUrl: server.url,
      workspaceId: WORKSPACE_ID,
      token,
    });
    await commit(remote, 0, "one", "op-1");
    const second = await commit(remote, 1, "two", "op-2");
    const blobBytes = Buffer.from("historical blob bytes");
    const assetSha = sha256(blobBytes);
    const loser = await commit(remote, 0, "loser", "op-loser", [
      { id: randomUUID(), sha256: assetSha, bytes: blobBytes.length },
    ]);
    expect(loser.status).toBe("conflict");
    const serverEpoch = server.serverEpoch;
    await server.close();
    const dbBytes = readFileSync(databasePath);
    source = {
      dbBytes,
      blobBytes,
      assetSha,
      manifest: {
        format: "folio-server-full/v1",
        createdAt: "2026-01-01T00:00:00.000Z",
        serverEpoch,
        database: {
          path: "server.sqlite",
          bytes: dbBytes.length,
          sha256: sha256(dbBytes),
        },
        assets: [
          {
            workspaceId: WORKSPACE_ID,
            sha256: assetSha,
            bytes: blobBytes.length,
            path: `blobs/${WORKSPACE_BLOB_DIR}/${assetSha}`,
          },
        ],
        workspaces: [
          {
            workspaceId: WORKSPACE_ID,
            ownerId: OWNER_ID,
            revision: 2,
            checkpointHash: second.checkpointHash,
          },
        ],
        counts: {
          changes: 2,
          operations: 3,
          devices: 2,
          activeDevices: 1,
          revokedDevices: 1,
        },
      },
    };
  } finally {
    try {
      await server.close();
    } catch {}
  }
});

afterAll(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function makeBackup(
  mutate?: (manifest: ServerFullBackupManifest, root: string) => void,
): { root: string; manifest: ServerFullBackupManifest; assetPath: string } {
  const root = join(suiteRoot, `backup-${backupIndex++}`);
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root, "blobs", WORKSPACE_BLOB_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "server.sqlite"), source.dbBytes, { mode: 0o600 });
  const assetPath = join(root, source.manifest.assets[0].path);
  writeFileSync(assetPath, source.blobBytes, { mode: 0o600 });
  const manifest = structuredClone(source.manifest);
  mutate?.(manifest, root);
  writeFileSync(
    join(root, SERVER_FULL_MANIFEST),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 },
  );
  return { root, manifest, assetPath };
}

function expectFailure(
  action: () => unknown,
  code: string,
  status: number,
): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe(code);
    expect((error as SyncError).status).toBe(status);
    return;
  }
  throw new Error("expected inspection to fail");
}

it("returns the frozen manifest and never modifies the snapshot", () => {
  const { root, manifest } = makeBackup();
  const files = [
    join(root, "server.sqlite"),
    join(root, "blobs", WORKSPACE_BLOB_DIR, source.assetSha),
    join(root, SERVER_FULL_MANIFEST),
  ];
  const before = files.map((path) => readFileSync(path));
  const beforeListing = readdirSync(root).sort();

  expect(inspectFullServerBackup(root)).toEqual(manifest);

  files.forEach((path, index) => expect(readFileSync(path)).toEqual(before[index]));
  expect(readdirSync(root).sort()).toEqual(beforeListing);
  expect(beforeListing).toEqual(["blobs", SERVER_FULL_MANIFEST, "server.sqlite"]);
});

it("always blocks when the incomplete marker is present", () => {
  const { root } = makeBackup();
  writeFileSync(join(root, SERVER_FULL_MARKER), "", { mode: 0o600 });
  rmSync(join(root, SERVER_FULL_MANIFEST));
  expectFailure(() => inspectFullServerBackup(root), "server-full-incomplete", 409);
});

it("rejects a missing historical blob as incomplete", () => {
  const { root, assetPath } = makeBackup();
  rmSync(assetPath);
  expectFailure(() => inspectFullServerBackup(root), "server-full-incomplete", 409);
});

it("rejects a corrupt historical blob", () => {
  const { root, assetPath } = makeBackup();
  writeFileSync(assetPath, Buffer.alloc(source.blobBytes.length, 0x41), {
    mode: 0o600,
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects an extra blob path", () => {
  const { root } = makeBackup();
  writeFileSync(join(root, "blobs", WORKSPACE_BLOB_DIR, "extra"), "unexpected", {
    mode: 0o600,
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects a traversal asset path", () => {
  const { root } = makeBackup((manifest) => {
    manifest.assets[0].path = `blobs/${WORKSPACE_BLOB_DIR}/../../server.sqlite`;
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects an asset replaced by a symlink", () => {
  const { root, assetPath } = makeBackup();
  rmSync(assetPath);
  symlinkSync(join(root, "server.sqlite"), assetPath);
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects a hardlinked asset", () => {
  const { root, assetPath } = makeBackup();
  linkSync(assetPath, join(root, "asset-hardlink"));
  expect(lstatSync(assetPath).nlink).toBe(2);
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects a wrong database hash", () => {
  const { root } = makeBackup((manifest) => {
    manifest.database.sha256 = "0".repeat(64);
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects a mismatched server epoch", () => {
  const { root } = makeBackup((manifest) => {
    manifest.serverEpoch = "different-epoch";
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects a manifest that omits a losing receipt asset", () => {
  const { root } = makeBackup((manifest) => {
    manifest.assets = [];
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects mismatched counts", () => {
  const { root } = makeBackup((manifest) => {
    manifest.counts.changes = 1;
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects a non-canonical timestamp", () => {
  const { root } = makeBackup((manifest) => {
    manifest.createdAt = "2026-01-01";
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-invalid", 422);
});

it("rejects more than the asset ceiling", () => {
  const { root } = makeBackup((manifest) => {
    manifest.assets = Array.from({ length: 4097 }, (_, index) => ({
      workspaceId: WORKSPACE_ID,
      sha256: index.toString(16).padStart(64, "0"),
      bytes: 1,
      path: `blobs/${WORKSPACE_BLOB_DIR}/${index.toString(16).padStart(64, "0")}`,
    }));
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-limit", 409);
});

it("rejects a total asset byte overflow", () => {
  const { root } = makeBackup((manifest) => {
    manifest.assets = Array.from({ length: 14 }, (_, index) => {
      const digest = index.toString(16).padStart(64, "0");
      return {
        workspaceId: WORKSPACE_ID,
        sha256: digest,
        bytes: 20_000_000,
        path: `blobs/${WORKSPACE_BLOB_DIR}/${digest}`,
      };
    });
  });
  expectFailure(() => inspectFullServerBackup(root), "server-full-limit", 409);
});

it("rejects an oversized manifest", () => {
  const { root } = makeBackup();
  writeFileSync(
    join(root, SERVER_FULL_MANIFEST),
    " ".repeat(4 * 1024 * 1024) + JSON.stringify(source.manifest),
    { mode: 0o600 },
  );
  expectFailure(() => inspectFullServerBackup(root), "server-full-limit", 409);
});
