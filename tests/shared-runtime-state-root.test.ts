import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";
import {
  assertRuntimeGenesis,
  assertRuntimeStateRoot,
  authorityStateRoot,
  createRuntimeGenesis,
} from "../src/collaboration/runtime/state-root";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()!();
    } catch {
      continue;
    }
  }
});

function tempStore(): RuntimeStore {
  const directory = mkdtempSync(join(tmpdir(), "folio-state-root-"));
  const store = new RuntimeStore(directory);
  cleanups.push(() => {
    try {
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return store;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function seed(store: RuntimeStore): void {
  store.transaction(() => {
    store.set("documents", "org1:ws1:doc1:inc1", {
      document: { type: "doc", content: [] },
      tables: [],
      tombstones: [],
    });
    store.set("doclifecycles", "org1:ws1:doc1", {
      activeIncarnation: "inc1",
      deleted: false,
      cut: { epoch: "epoch1", seq: 7, hash: "a".repeat(64) },
    });
    store.set("organization", "org1", {
      orgId: "org1",
      memberIds: ["user1"],
      ownerIds: ["user1"],
      version: 1,
    });
    store.set("workspace.roles", "org1:ws1:user1", {
      orgId: "org1",
      workspaceId: "ws1",
      userId: "user1",
      role: "owner",
    });
    store.set("meta", "role", "authority");
    store.set("meta", "primary-org", "org1");
    store.set("meta", "head", {
      epoch: "epoch1",
      seq: 7,
      hash: "b".repeat(64),
    });
    store.set("authority.prefix", "epoch1:7", {
      epoch: "epoch1",
      seq: 7,
      hash: "b".repeat(64),
    });
    store.set("history", "ignored", { value: "ignored" });
    store.set("authority.events", "ignored", { value: "ignored" });
    store.set("organization.audit", "ignored", { value: "ignored" });
    store.set("operations.log", "ignored", { value: "ignored" });
    store.set("client.queue", "ignored", { value: "ignored" });
    store.set("asset.staging", "org1:ws1:upload1", {
      hash: "c".repeat(64),
      bytes: 1,
      published: false,
    });
    store.set("asset.holds", "org1:ws1:" + "c".repeat(64) + ":hold1", {
      hash: "c".repeat(64),
      holdId: "hold1",
    });
  });
}

function clearHead(store: RuntimeStore): void {
  store.transaction(() => {
    store.set("meta", "head", null);
    store.set("authority.prefix", "epoch1:7", null);
  });
}

function withDocument(store: RuntimeStore, value: unknown): StoragePort {
  return {
    db: store.db,
    transaction: <T>(work: () => T) => store.transaction(work),
    get: (namespace, key) => store.get(namespace, key),
    set: (namespace, key, next) => store.set(namespace, key, next),
    all: (namespace) =>
      namespace === "documents"
        ? [{ key: "org1:ws1:doc1:inc1", value }]
        : store.all(namespace),
    blobGet: (scope, hash) => store.blobGet(scope, hash),
    blobPut: (scope, hash, bytes) => store.blobPut(scope, hash, bytes),
    blobDelete: (scope, hash) => store.blobDelete(scope, hash),
    close: () => store.close(),
  };
}

describe("authority state root", () => {
  it("is deterministic and excludes non-authoritative namespaces and meta", () => {
    const store = tempStore();
    seed(store);
    const root = authorityStateRoot(store);
    expect(root).toMatch(/^[a-f0-9]{64}$/);
    expect(authorityStateRoot(store)).toBe(root);

    store.transaction(() => {
      store.set("history", "changed", { value: "changed" });
      store.set("authority.events", "changed", { value: "changed" });
      store.set("organization.audit", "changed", { value: "changed" });
      store.set("operations.queue", "changed", { value: "changed" });
      store.set("client.queue", "changed", { value: "changed" });
      store.set("asset.staging", "org1:ws1:upload2", {
        hash: "d".repeat(64),
        bytes: 2,
        published: false,
      });
      store.set("asset.holds", "org1:ws1:" + "d".repeat(64) + ":hold2", {
        hash: "d".repeat(64),
        holdId: "hold2",
      });
      store.set("meta", "head", {
        epoch: "epoch1",
        seq: 7,
        hash: "d".repeat(64),
      });
      store.set("meta", "state-root", root);
      store.set("meta", "genesis", {
        format: "folio.shared.genesis/2",
        epoch: "epoch1",
        sourceHash: null,
        authorityStateHash: root,
      });
    });

    expect(authorityStateRoot(store)).toBe(root);
  });

  it("normalizes exact cut shapes while retaining epoch and seq", () => {
    const store = tempStore();
    seed(store);
    const root = authorityStateRoot(store);

    store.transaction(() => {
      store.set("doclifecycles", "org1:ws1:doc1", {
        activeIncarnation: "inc1",
        deleted: false,
        cut: { epoch: "epoch1", seq: 7, hash: "e".repeat(64) },
      });
    });
    expect(authorityStateRoot(store)).toBe(root);

    store.transaction(() => {
      store.set("doclifecycles", "org1:ws1:doc1", {
        activeIncarnation: "inc1",
        deleted: false,
        cut: { epoch: "epoch1", seq: 8, hash: "e".repeat(64) },
      });
    });
    expect(authorityStateRoot(store)).not.toBe(root);
  });

  it("detects canonical value corruption in documents and records", () => {
    const store = tempStore();
    seed(store);
    const root = authorityStateRoot(store);

    store.transaction(() => {
      store.set("documents", "org1:ws1:doc1:inc1", {
        document: { type: "doc", content: [{ type: "paragraph" }] },
        tables: [],
        tombstones: [],
      });
    });
    const documentRoot = authorityStateRoot(store);
    expect(documentRoot).not.toBe(root);

    store.transaction(() => {
      store.set("records", "org1:ws1:doc1:inc1:row1", {
        recordId: "row1",
        value: "changed",
      });
    });
    expect(authorityStateRoot(store)).not.toBe(documentRoot);
  });

  it("rejects getters and unsafe integers before normalization", () => {
    const store = tempStore();
    seed(store);
    const getter = Object.defineProperty({ type: "doc" }, "content", {
      enumerable: true,
      get() {
        return [];
      },
    });
    expect(() => authorityStateRoot(withDocument(store, getter))).toThrow(
      "INVALID_ACCESSOR",
    );
    expect(() =>
      authorityStateRoot(
        withDocument(store, {
          type: "doc",
          value: Number.MAX_SAFE_INTEGER + 1,
        }),
      ),
    ).toThrow("UNSAFE_NUMBER");
  });

  it("indexes published blobs and rejects missing or length-mismatched blobs", () => {
    const store = tempStore();
    const bytes = new TextEncoder().encode("payload");
    const hash = hashBytes(bytes);
    store.transaction(() => {
      store.set("asset", `org1:ws1:${hash}`, {
        hash,
        bytes: bytes.byteLength,
        uploads: ["upload1"],
      });
      store.blobPut("org1:ws1", hash, bytes);
    });
    const root = authorityStateRoot(store);
    store.transaction(() => store.set("meta", "state-root", root));
    expect(() => assertRuntimeStateRoot(store)).not.toThrow();
    expect(() => assertRuntimeStateRoot(store, root)).not.toThrow();

    store.transaction(() => {
      store.set("asset", `org1:ws1:${hash}`, {
        hash,
        bytes: bytes.byteLength + 1,
        uploads: ["upload1"],
      });
    });
    expect(() => authorityStateRoot(store)).toThrow("ASSET_TAMPERED");
  });

  it("rejects published metadata with no blob row", () => {
    const store = tempStore();
    const hash = "f".repeat(64);
    store.transaction(() => {
      store.set("asset", `org1:ws1:${hash}`, {
        hash,
        bytes: 3,
        uploads: ["upload1"],
      });
    });
    expect(() => authorityStateRoot(store)).toThrow("ASSET_MISSING");
  });

  it("verifies same-length blob bit flips through blobGet", () => {
    const store = tempStore();
    const bytes = new TextEncoder().encode("payload");
    const hash = hashBytes(bytes);
    store.transaction(() => {
      store.set("asset", `org1:ws1:${hash}`, {
        hash,
        bytes: bytes.byteLength,
        uploads: ["upload1"],
      });
      store.blobPut("org1:ws1", hash, bytes);
    });
    const root = authorityStateRoot(store);
    store.transaction(() => store.set("meta", "state-root", root));

    const corrupted = bytes.slice();
    corrupted[0] = corrupted[0]! ^ 0xff;
    store.db
      .prepare("UPDATE runtime_blobs SET bytes=? WHERE scope=? AND hash=?")
      .run(corrupted, "org1:ws1", hash);

    expect(authorityStateRoot(store)).toBe(root);
    expect(() => assertRuntimeStateRoot(store)).toThrow();
  });
});

describe("runtime genesis", () => {
  it("requires an explicit transaction", () => {
    const store = tempStore();
    expect(() => createRuntimeGenesis(store, "epoch1", null)).toThrow(
      "TRANSACTION_REQUIRED",
    );
  });

  it("creates a strict genesis and binds head, prefix, and state root", () => {
    const store = tempStore();
    seed(store);
    clearHead(store);
    const cut = store.transaction(() =>
      createRuntimeGenesis(store, "epoch2", null),
    );
    expect(cut.epoch).toBe("epoch2");
    expect(cut.seq).toBe(0);
    expect(cut.hash).toMatch(/^[a-f0-9]{64}$/);

    const genesis = store.get("meta", "genesis") as Record<string, unknown>;
    expect(genesis.format).toBe("folio.shared.genesis/2");
    expect(genesis.epoch).toBe("epoch2");
    expect(genesis.sourceHash).toBeNull();
    expect(genesis.authorityStateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(store.get("meta", "state-root")).toBe(genesis.authorityStateHash);
    expect(assertRuntimeGenesis(store)).toEqual(cut);
    expect(() => assertRuntimeStateRoot(store)).not.toThrow();

    const source = "a".repeat(64);
    const sourcedStore = tempStore();
    const sourced = sourcedStore.transaction(() =>
      createRuntimeGenesis(sourcedStore, "epoch2", source),
    );
    expect(
      (sourcedStore.get("meta", "genesis") as Record<string, unknown>)
        .sourceHash,
    ).toBe(source);
    expect(assertRuntimeGenesis(sourcedStore)).toEqual(sourced);
  });

  it("rejects a non-genesis head without matching restore metadata", () => {
    const store = tempStore();
    seed(store);
    expect(() =>
      store.transaction(() => createRuntimeGenesis(store, "epoch2", null)),
    ).toThrow("GENESIS_CONFLICT");

    const second = tempStore();
    second.transaction(() =>
      second.set("meta", "head", {
        epoch: "epoch2",
        seq: 0,
        hash: "a".repeat(64),
      }),
    );
    expect(() =>
      second.transaction(() => createRuntimeGenesis(second, "epoch2", null)),
    ).toThrow("GENESIS_CONFLICT");
  });

  it("accepts a matching restore epoch and rejects invalid source hashes", () => {
    const store = tempStore();
    store.transaction(() => {
      store.set("meta", "head", {
        epoch: "restored",
        seq: 0,
        hash: "a".repeat(64),
      });
      store.set("meta", "restore", {
        originalCut: { epoch: "old", seq: 4, hash: "b".repeat(64) },
        epoch: "restored",
        backupHash: "c".repeat(64),
        requiresReauthorization: true,
      });
    });
    const cut = store.transaction(() =>
      createRuntimeGenesis(store, "restored", null),
    );
    expect(cut.epoch).toBe("restored");
    expect(assertRuntimeGenesis(store)).toEqual(cut);

    expect(() =>
      store.transaction(() =>
        createRuntimeGenesis(store, "restored", "not-a-hash"),
      ),
    ).toThrow("INVALID_SOURCE_HASH");
  });

  it("detects a tampered genesis record", () => {
    const store = tempStore();
    const cut = store.transaction(() =>
      createRuntimeGenesis(store, "epoch3", null),
    );
    expect(assertRuntimeGenesis(store)).toEqual(cut);
    const genesis = store.get("meta", "genesis") as Record<string, unknown>;
    store.transaction(() =>
      store.set("meta", "genesis", {
        ...genesis,
        sourceHash: "d".repeat(64),
      }),
    );
    expect(() => assertRuntimeGenesis(store)).toThrow("GENESIS_HASH_MISMATCH");
  });

  it("compares the current root against stored or supplied state roots", () => {
    const store = tempStore();
    seed(store);
    clearHead(store);
    store.transaction(() => createRuntimeGenesis(store, "epoch4", null));
    expect(() => assertRuntimeStateRoot(store)).not.toThrow();
    expect(() => assertRuntimeStateRoot(store, "e".repeat(64))).toThrow(
      "STATE_ROOT_MISMATCH",
    );

    store.transaction(() =>
      store.set("documents", "org1:ws1:doc1:inc1", {
        document: { type: "doc", content: [{ type: "paragraph" }] },
        tables: [],
        tombstones: [],
      }),
    );
    expect(() => assertRuntimeStateRoot(store)).toThrow("STATE_ROOT_MISMATCH");
  });

  it("reports a missing stored state root when no expected hash is supplied", () => {
    const store = tempStore();
    seed(store);
    expect(() => assertRuntimeStateRoot(store)).toThrow("STATE_ROOT_MISSING");
  });
});
