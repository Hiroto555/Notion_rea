import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConflictRecoveryService } from "../src/main/conflict-recovery-service";
import { attachFile } from "../src/persistence/assets";
import { restoreRecoveryBundle } from "../src/persistence/conflict-recovery-import";
import { verifyRecoveryBundle } from "../src/persistence/conflict-recovery-verify";
import { inspectRecoveredContent } from "../src/persistence/recovered-content";
import {
  assertRecoverySyncAllowed,
  readRecoveryOrigin,
} from "../src/persistence/recovery-origin";
import { Store } from "../src/persistence/store";
import {
  RECOVERY_ORIGIN_KEY,
  type ArchiveTarget,
  type RecoveryActionResult,
} from "../src/shared/conflict-recovery";
import { listConflictArchives } from "../src/sync/conflict-archive-catalog";
import {
  canonicalJson,
  hashCheckpoint,
  type Checkpoint,
} from "../src/sync/protocol";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { WorkspaceSync } from "../src/sync/workspace-sync";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-d11-acceptance-")));
  roots.push(root);
  return root;
}

function japaneseDoc(text: string) {
  return {
    type: "doc" as const,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

type WorkspaceFixture = {
  root: string;
  directory: string;
  storePath: string;
  checkpoint: Checkpoint;
  pageId: string;
  databasePageId: string;
  assetId: string;
  assetBytes: Buffer;
  versions: number;
};

function createWorkspaceFixture(): WorkspaceFixture {
  const root = temporaryRoot();
  const directory = join(root, "source");
  const assetsDirectory = join(directory, "assets");
  mkdirSync(assetsDirectory, { recursive: true });
  const storePath = join(directory, "workspace.sqlite");
  const store = new Store(storePath);
  let checkpoint: Checkpoint | undefined;
  let pageId = "";
  let databasePageId = "";
  let assetId = "";
  let assetBytes = Buffer.alloc(0);
  let versions = 0;
  try {
    const page = store.create(null, "page", "日本語のページ");
    pageId = page.id;
    store.update(pageId, 0, { doc: japaneseDoc("こんにちは世界") });
    store.update(pageId, 1, { doc: japaneseDoc("更新された日本語本文") });
    versions = store.versions(pageId).length;

    const database = store.create(null, "database", "データベース");
    databasePageId = database.id;

    const attachment = join(directory, "添付-日本語.txt");
    writeFileSync(attachment, "添付の日本語本文");
    const attached = attachFile(store.db, assetsDirectory, attachment);
    assetId = attached.id;
    assetBytes = readFileSync(join(assetsDirectory, assetId));

    store.db
      .prepare("INSERT INTO settings(key,value) VALUES(?,?)")
      .run("secret", "token-should-not-be-copied");
    store.db.exec(`CREATE TABLE workspace_sync_state (
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
    )`);
    store.db
      .prepare(
        "INSERT INTO workspace_sync_state VALUES(1,1,?,?,?,?,0,0,0,0,0)",
      )
      .run("workspace-a", "client-a", "binding-a", "epoch-a");
    store.db.exec("CREATE TABLE workspace_sync_outbox (id INTEGER PRIMARY KEY, payload TEXT)");
    store.db
      .prepare("INSERT INTO workspace_sync_outbox(payload) VALUES(?)")
      .run("secret-outbox");

    checkpoint = buildWorkspaceCheckpoint(store.db);
  } finally {
    store.close();
  }
  if (!checkpoint) throw new Error("checkpoint was not built");
  return { root, directory, storePath, checkpoint, pageId, databasePageId, assetId, assetBytes, versions };
}

function makeBundle(fixture: WorkspaceFixture) {
  const bundle = join(fixture.root, "bundle");
  mkdirSync(join(bundle, "assets"), { recursive: true });
  const checkpointJson = canonicalJson(fixture.checkpoint);
  const checkpointHash = hashCheckpoint(fixture.checkpoint);
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
    assets: fixture.checkpoint.assets.map((asset) => ({
      ...asset,
      file: `assets/${asset.id}`,
    })),
  };
  writeFileSync(join(bundle, "checkpoint.json"), checkpointJson);
  for (const asset of fixture.checkpoint.assets) {
    writeFileSync(
      join(bundle, "assets", asset.id),
      readFileSync(join(fixture.directory, "assets", asset.id)),
    );
  }
  writeFileSync(join(bundle, "manifest.json"), canonicalJson(manifest));
  return { bundle, manifest, checkpointHash };
}

function restoreFixture() {
  const fixture = createWorkspaceFixture();
  const { bundle, checkpointHash } = makeBundle(fixture);
  const verified = verifyRecoveryBundle(bundle);
  const restored = restoreRecoveryBundle(verified, join(fixture.root, "restored"), {
    admitBytes: () => {},
  });
  return { fixture, bundle, checkpointHash, restored };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function treeHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hashes[relative(root, path)] = sha256File(path);
    }
  };
  walk(root);
  return hashes;
}

function copyTree(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

function readSettings(store: Store): { key: string; value: string }[] {
  return store.db.prepare("SELECT key,value FROM settings").all() as {
    key: string;
    value: string;
  }[];
}

async function withNoFetch(
  store: Store,
  work: (baseUrl: string, hits: () => number) => Promise<void>,
): Promise<void> {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.statusCode = 503;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as { port: number };
  try {
    await work(`http://127.0.0.1:${address.port}`, () => hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}

function syncOptions(store: Store, baseUrl: string, mode: "publish" | "join" | "recover") {
  return {
    store,
    baseUrl,
    token: "test-token",
    workspaceId: "workspace-a",
    clientId: "client-a",
    bindingId: "binding-a",
    mode,
    canApply: () => true,
    timeoutMs: 200,
  };
}

describe("independent copy restore acceptance", () => {
  it("restores Japanese content, a database, history and attachments into a fresh v4 workspace", () => {
    const { fixture, checkpointHash, restored } = restoreFixture();

    expect(restored.directory).toBe(join(fixture.root, "restored"));
    expect(restored.checkpointHash).toBe(checkpointHash);
    expect(restored.recoveryId).toMatch(UUID);
    expect(restored.recoveryId).not.toBe(fixture.pageId);
    expect(restored.recoveryId).not.toBe(fixture.databasePageId);
    expect(inspectRecoveredContent(restored.directory, checkpointHash)).toBe(restored.recoveryId);

    const store = new Store(join(restored.directory, "workspace.sqlite"), { readOnly: true });
    try {
      expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
      expect(JSON.stringify(store.get(fixture.pageId).doc)).toContain("更新された日本語本文");
      expect(store.get(fixture.pageId).title).toBe("日本語のページ");
      expect(store.versions(fixture.pageId)).toHaveLength(fixture.versions);
      expect(store.get(fixture.databasePageId).kind).toBe("database");
      expect(store.get(fixture.databasePageId).database?.rows).toEqual([]);

      const settings = readSettings(store);
      expect(settings.map((row) => row.key).sort()).toEqual(
        [RECOVERY_ORIGIN_KEY, "folio.recovery.workspaceId"].sort(),
      );
      expect(settings.some((row) => row.key === "secret")).toBe(false);
      const marker = JSON.parse(
        settings.find((row) => row.key === RECOVERY_ORIGIN_KEY)!.value,
      ) as { recoveryId: string; checkpointHash: string; sync: string };
      expect(marker.recoveryId).toBe(restored.recoveryId);
      expect(marker.checkpointHash).toBe(checkpointHash);
      expect(marker.sync).toBe("held");
      expect(
        settings.find((row) => row.key === "folio.recovery.workspaceId")!.value,
      ).toBe(restored.recoveryId);
      expect(readRecoveryOrigin(store.db)).toBe("recovered");

      const tables = store.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      expect(tables.some((row) => row.name.startsWith("workspace_sync_"))).toBe(false);
      expect(
        store.db.prepare("SELECT count(*) AS n FROM save_receipts").get()?.n,
      ).toBe(0);
    } finally {
      store.close();
    }

    expect(readFileSync(join(restored.directory, "assets", fixture.assetId))).toEqual(
      fixture.assetBytes,
    );
  });

  it("reopens the restored workspace with the same checkpoint hash", () => {
    const { fixture, checkpointHash, restored } = restoreFixture();
    const path = join(restored.directory, "workspace.sqlite");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const store = new Store(path, { readOnly: true });
      try {
        expect(hashCheckpoint(buildWorkspaceCheckpoint(store.db))).toBe(checkpointHash);
        expect(store.db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
      } finally {
        store.close();
      }
    }
    expect(existsSync(join(fixture.directory, "workspace.sqlite"))).toBe(true);
  });

  it("allows normal saves and new history only on a verification copy", () => {
    const { fixture, restored } = restoreFixture();
    const copy = join(fixture.root, "verification-copy");
    copyTree(restored.directory, copy);

    const store = new Store(join(copy, "workspace.sqlite"));
    try {
      const before = store.versions(fixture.pageId).length;
      const page = store.get(fixture.pageId);
      store.update(fixture.pageId, page.revision, { title: "更新後のタイトル" });
      expect(store.versions(fixture.pageId).length).toBe(before + 1);
      expect(store.get(fixture.pageId).title).toBe("更新後のタイトル");
    } finally {
      store.close();
    }

    const reopened = new Store(join(copy, "workspace.sqlite"));
    try {
      expect(reopened.get(fixture.pageId).title).toBe("更新後のタイトル");
    } finally {
      reopened.close();
    }
  });

  it("leaves the source bundle byte-for-byte unchanged", () => {
    const fixture = createWorkspaceFixture();
    const { bundle, checkpointHash } = makeBundle(fixture);
    const before = treeHashes(bundle);

    const restored = restoreRecoveryBundle(verifyRecoveryBundle(bundle), join(fixture.root, "restored"), {
      admitBytes: () => {},
    });

    expect(restored.checkpointHash).toBe(checkpointHash);
    expect(treeHashes(bundle)).toEqual(before);
  });

  it("rejects a missing attachment and a corrupted attachment after verification", () => {
    const missingFixture = createWorkspaceFixture();
    const missingBundle = makeBundle(missingFixture).bundle;
    const missingVerified = verifyRecoveryBundle(missingBundle);
    unlinkSync(join(missingBundle, "assets", missingFixture.assetId));
    const missingDestination = join(missingFixture.root, "missing-restore");
    expect(() =>
      restoreRecoveryBundle(missingVerified, missingDestination, { admitBytes: () => {} }),
    ).toThrow();
    expect(existsSync(missingDestination)).toBe(false);

    const corruptFixture = createWorkspaceFixture();
    const corruptBundle = makeBundle(corruptFixture).bundle;
    const corruptVerified = verifyRecoveryBundle(corruptBundle);
    writeFileSync(join(corruptBundle, "assets", corruptFixture.assetId), "破損した添付");
    const corruptDestination = join(corruptFixture.root, "corrupt-restore");
    expect(() =>
      restoreRecoveryBundle(corruptVerified, corruptDestination, { admitBytes: () => {} }),
    ).toThrow();
    expect(existsSync(corruptDestination)).toBe(false);
  });

  it("rejects an existing destination and a destination inside the bundle", () => {
    const fixture = createWorkspaceFixture();
    const { bundle } = makeBundle(fixture);
    const verified = verifyRecoveryBundle(bundle);

    const existing = join(fixture.root, "existing");
    mkdirSync(existing);
    expect(() =>
      restoreRecoveryBundle(verified, existing, { admitBytes: () => {} }),
    ).toThrow();
    expect(existsSync(join(existing, "workspace.sqlite"))).toBe(false);

    const inside = join(bundle, "nested");
    expect(() =>
      restoreRecoveryBundle(verified, inside, { admitBytes: () => {} }),
    ).toThrow();
    expect(existsSync(inside)).toBe(false);

    expect(() =>
      restoreRecoveryBundle(verified, bundle, { admitBytes: () => {} }),
    ).toThrow();
  });

  it("keeps a restored workspace sync-held for publish, join and recover before any fetch", async () => {
    const { fixture, restored } = restoreFixture();
    const store = new Store(join(restored.directory, "workspace.sqlite"));
    await withNoFetch(store, async (baseUrl, hits) => {
      for (const mode of ["publish", "join", "recover"] as const) {
        await expect(
          WorkspaceSync.open(syncOptions(store, baseUrl, mode)),
        ).rejects.toThrow(/recovered-workspace-sync-held/);
      }
      expect(hits()).toBe(0);
    });
    expect(existsSync(join(fixture.directory, "workspace.sqlite"))).toBe(true);
  });

  it("keeps sync held when the recovery origin is corrupted", async () => {
    const { fixture, restored } = restoreFixture();
    const copy = join(fixture.root, "corrupt-origin");
    mkdirSync(copy);
    copyFileSync(
      join(restored.directory, "workspace.sqlite"),
      join(copy, "workspace.sqlite"),
    );

    const store = new Store(join(copy, "workspace.sqlite"));
    store.db
      .prepare("UPDATE settings SET value=? WHERE key=?")
      .run("{not-json", RECOVERY_ORIGIN_KEY);
    expect(readRecoveryOrigin(store.db)).toBe("blocked");
    expect(() => assertRecoverySyncAllowed(store.db)).toThrow(
      /recovered-workspace-sync-held/,
    );

    await withNoFetch(store, async (baseUrl, hits) => {
      await expect(
        WorkspaceSync.open(syncOptions(store, baseUrl, "publish")),
      ).rejects.toThrow(/recovered-workspace-sync-held/);
      expect(hits()).toBe(0);
    });
  });

  it("refuses to upgrade an unknown restore while an attachment is wrong", async () => {
    const fixture = createWorkspaceFixture();
    makeBundle(fixture);
    const store = new Store(fixture.storePath);
    const service = new ConflictRecoveryService(store, fixture.directory);
    const target = insertArchive(store, fixture.checkpoint);
    const output = join(fixture.root, "output");
    mkdirSync(output);

    let calls = 0;
    const authorized = () => {
      calls += 1;
      return calls < 4;
    };

    let result: RecoveryActionResult;
    try {
      result = await service.run(target, "restore", async () => output, authorized);
      expect(result.kind).toBe("outcome-unknown");
      if (result.kind !== "outcome-unknown") throw new Error("expected an unknown outcome");
      expect(result.directory.startsWith(output)).toBe(true);

      writeFileSync(join(result.directory, "assets", fixture.assetId), "破損した添付");
      expect(service.status()?.kind).toBe("outcome-unknown");

      writeFileSync(join(result.directory, "assets", fixture.assetId), fixture.assetBytes);
      expect(service.status()?.kind).toBe("restored");
    } finally {
      store.close();
    }
  });

  it("restores an archive through ConflictRecoveryService without touching the source", async () => {
    const fixture = createWorkspaceFixture();
    makeBundle(fixture);
    const sourceBefore = treeHashes(join(fixture.directory, "assets"));
    const store = new Store(fixture.storePath);
    const service = new ConflictRecoveryService(store, fixture.directory);
    const target = insertArchive(store, fixture.checkpoint);
    const output = join(fixture.root, "output");
    mkdirSync(output);
    const operationId = randomUUID();
    try {
      const result = await service.run(
        target,
        "restore",
        async () => output,
        () => true,
        operationId,
      );
      expect(result.kind).toBe("restored");
      expect(service.status(operationId)?.kind).toBe("restored");
      if (result.kind !== "restored") throw new Error("expected a restored result");
      expect(result.checkpointHash).toBe(target.checkpointHash);
      expect(result.directory.startsWith(output)).toBe(true);
      expect(inspectRecoveredContent(result.directory, target.checkpointHash)).toMatch(UUID);
      expect(hashCheckpoint(buildWorkspaceCheckpoint(store.db))).toBe(
        hashCheckpoint(fixture.checkpoint),
      );
    } finally {
      store.close();
    }
    expect(treeHashes(join(fixture.directory, "assets"))).toEqual(sourceBefore);
  });
});

function insertArchive(store: Store, checkpoint: Checkpoint): ArchiveTarget {
  store.db.exec(
    "CREATE TABLE workspace_sync_archives (id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, kind TEXT NOT NULL, checkpoint_json TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  store.db
    .prepare(
      "INSERT INTO workspace_sync_archives(operation_id,kind,checkpoint_json,created_at) VALUES(?,?,?,?)",
    )
    .run("operation-1", "conflict-local", canonicalJson(checkpoint), 1);
  const page = listConflictArchives(store.db);
  const target = page.items[0]?.target;
  if (!target) throw new Error("archive target was not listed");
  return target;
}
