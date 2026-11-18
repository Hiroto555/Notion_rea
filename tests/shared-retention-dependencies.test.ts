import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  scopeKey,
  type Attempt,
  type AuthContext,
  type Cut,
  type DocumentState,
  type Intent,
  type Receipt,
  type RuntimeEvent,
} from "../src/collaboration/runtime/contract";
import { digest } from "../src/collaboration/runtime/digest";
import { DurableQueue } from "../src/collaboration/runtime/durable-queue";
import { rememberEditorVersions } from "../src/collaboration/runtime/editor-versions";
import {
  inspectRetentionDependencies,
  planRetentionReclamation,
  retentionNamespaceContract,
  retentionNamespaceContracts,
  RETENTION_AUTHORITY_STORE_ID,
  RETENTION_RELEASES_NAMESPACE,
  RETENTION_RECOVERY_NAMESPACE,
  type RetentionDependencyLimits,
} from "../src/collaboration/runtime/retention-dependencies";
import { assertRuntimeStateRoot } from "../src/collaboration/runtime/state-root";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import {
  sealDeleteWitness,
  storeDeleteWitness,
} from "../src/collaboration/runtime/undo-witness";

const scope = {
  orgId: "org", workspaceId: "workspace",
  documentId: "document", incarnationId: "incarnation",
};
const cut: Cut = { epoch: "epoch", seq: 1, hash: digest("head") };
const auth: AuthContext = {
  userId: "user", deviceId: "device", writerId: "writer", sessionId: "session",
};
const directories: string[] = [];
const stores: RuntimeStore[] = [];
const authorities: SharedAuthority[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "folio-retention-dependencies-"));
  directories.push(path);
  return path;
}

function newStore(withHead = true): RuntimeStore {
  const store = new RuntimeStore(directory());
  stores.push(store);
  if (withHead) store.transaction(() => store.set("meta", "head", cut));
  return store;
}

afterEach(() => {
  for (const authority of authorities.splice(0)) authority.close();
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function state(text = "hello"): DocumentState {
  return {
    document: {
      type: "doc", schemaVersion: 2,
      content: [{
        type: "paragraph", attrs: { id: "paragraph" },
        content: [{ type: "text", text }],
      }],
    },
    tables: [], tombstones: [],
  };
}

function publish(store: RuntimeStore, label = "asset") {
  const bytes = new TextEncoder().encode(label);
  const hash = createHash("sha256").update(bytes).digest("hex");
  store.transaction(() => {
    store.blobPut("org:workspace", hash, bytes);
    store.set("asset", "org:workspace:" + hash, {
      hash, bytes: bytes.byteLength, uploads: [],
    });
  });
  return { hash, bytes, uri: "folio-asset://" + hash };
}

function intent(payload: string | null = null): Intent {
  return {
    v: 1, intentId: "intent", writerId: "writer", scope, base: cut,
    command: { kind: "resource", action: "test", payload },
  };
}

function attempt(input = intent()): Attempt {
  return { v: 1, attemptId: "attempt", intent: input, base: cut };
}

function receipt(input: Attempt, resultHash: string): Receipt {
  return {
    v: 1, status: "REJECTED", intentId: input.intent.intentId,
    intentHash: digest(input.intent), attemptId: input.attemptId,
    attemptHash: digest(input), writerId: input.intent.writerId,
    scope, cut, resultHash, code: "TEST_REJECTED",
  };
}

function persisted(store: RuntimeStore) {
  return {
    records: store.db.prepare("SELECT namespace,key,raw FROM runtime_records ORDER BY namespace,key").all(),
    blobs: store.db.prepare("SELECT scope,hash,bytes FROM runtime_blobs ORDER BY scope,hash").all(),
  };
}

describe.skipIf(process.platform === "win32")("read-only retention dependency contract", () => {
  it("offers unreferenced asset/state candidates, but never a deletion or safety proof", () => {
    const store = newStore(), asset = publish(store), orphan = state("orphan");
    store.transaction(() => store.set("editor.states", digest(orphan), orphan));
    const before = persisted(store);
    const inventory = inspectRetentionDependencies(store, cut);
    const plan = planRetentionReclamation(store, cut);
    expect(plan.candidates.map((target) => target.kind)).toEqual(["asset", "editor-state"]);
    expect(plan.execution).toBe("UNSUPPORTED");
    expect(plan.mode).toBe("PLAN_ONLY");
    expect(plan.deletions).toEqual([]);
    expect(plan.requiredConditions).toContain("COMPLETE_LIVE_HISTORY_AND_EXTERNAL_ROOTS");
    expect(plan.requiredConditions).toContain("VERIFIED_BACKUP_FOR_EXACT_SNAPSHOT");
    expect(inventory.coverage).toEqual({
      persistedRecords: "enumerated", blobContents: "NOT_VERIFIED",
      liveHistory: "UNAVAILABLE", otherStores: "NOT_ENUMERATED",
    });
    expect(inventory.blobBytes).toBe(asset.bytes.byteLength);
    expect(plan.fingerprint).toBe(inventory.fingerprint);
    expect(inspectRetentionDependencies(store, cut)).toEqual(inventory);
    expect(persisted(store)).toEqual(before);
  });

  it("protects every indexed historical version, not only the latest state", () => {
    const store = newStore(), old = state("old"), current = state("current");
    store.transaction(() => {
      store.set("documents", scopeKey(scope), old);
      rememberEditorVersions(store, { ...cut, seq: 0 });
      store.set("documents", scopeKey(scope), current);
      rememberEditorVersions(store, cut);
    });
    const before = persisted(store);
    const inventory = inspectRetentionDependencies(store, cut);
    const plan = planRetentionReclamation(store, cut);
    expect(plan.candidates).toEqual([]);
    expect(plan.protected.map((entry) => entry.target.hash).sort()).toEqual(
      [digest(old), digest(current)].sort(),
    );
    expect(inventory.references.filter((ref) => ref.kind === "editor-version")).toHaveLength(2);
    expect(persisted(store)).toEqual(before);
  });

  it.each(["PREPARED", "UNKNOWN"] as const)(
    "preserves a real durable queue's %s attempt and immutable raw",
    (status) => {
      const store = newStore(), asset = publish(store);
      const queue = new DurableQueue(store, { scope, writerId: "writer" });
      const input = intent(asset.uri), prepared = attempt(input);
      queue.enqueue(input);
      queue.attempt(prepared);
      if (status === "UNKNOWN") queue.markUnknown(input.intentId, prepared.attemptId);
      const before = persisted(store);
      const inventory = inspectRetentionDependencies(store, cut);
      expect(inventory.unresolved).toEqual([{
        namespace: "client.queue", key: scopeKey(scope) + ":writer:intent",
        attemptId: prepared.attemptId, state: status, base: cut,
      }]);
      expect(inventory.references.some((ref) => ref.kind === "raw")).toBe(true);
      expect(planRetentionReclamation(store, cut).candidates).toEqual([]);
      expect(queue.read(input.intentId)?.raw).toBe(canonical(input));
      expect(persisted(store)).toEqual(before);
    },
  );

  it("protects receipt hashes after a real durable queue confirms rejection", () => {
    const store = newStore(), asset = publish(store);
    const queue = new DurableQueue(store, { scope, writerId: "writer" });
    const prepared = attempt();
    queue.enqueue(prepared.intent);
    queue.attempt(prepared);
    queue.markUnknown(prepared.intent.intentId, prepared.attemptId);
    const proof = receipt(prepared, asset.hash);
    queue.confirm(proof);
    const before = persisted(store);
    const inventory = inspectRetentionDependencies(store, cut);
    expect(inventory.unresolved).toEqual([]);
    expect(inventory.references.some((ref) => ref.kind === "receipt")).toBe(true);
    expect(planRetentionReclamation(store, cut).candidates).toEqual([]);
    expect(queue.read(prepared.intent.intentId)?.attempts[0].receipt).toEqual(proof);
    expect(persisted(store)).toEqual(before);
  });

  it.each(["client.archived", "resource-client.archive"])(
    "keeps raw and receipt references from the real archive entry shape in %s",
    (namespace) => {
      const store = newStore(), asset = publish(store);
      const queue = new DurableQueue(store, { scope, writerId: "writer" });
      const prepared = attempt(intent(asset.uri));
      queue.enqueue(prepared.intent);
      queue.attempt(prepared);
      queue.confirm(receipt(prepared, digest("result")));
      const entry = queue.read(prepared.intent.intentId)!;
      store.transaction(() => store.set(
        namespace, scopeKey(scope) + ":writer:intent", { raw: entry.raw, entry },
      ));
      const before = persisted(store);
      const inventory = inspectRetentionDependencies(store, cut);
      expect(inventory.references.some(
        (ref) => ref.namespace === namespace && ref.kind === "raw",
      )).toBe(true);
      expect(inventory.references.some(
        (ref) => ref.namespace === namespace && ref.kind === "asset" && ref.target === asset.hash,
      )).toBe(true);
      expect(planRetentionReclamation(store, cut).deletions).toEqual([]);
      expect(persisted(store)).toEqual(before);
    },
  );

  it("retains an asset referenced only by a historical table Undo witness", () => {
    const store = newStore(), asset = publish(store);
    const deletion: Attempt = {
      ...attempt(),
      intent: {
        ...intent(),
        command: { kind: "table.row.delete", tableId: "table", rowId: "row" },
      },
    };
    store.transaction(() => {
      storeDeleteWitness(store, deletion, auth, {
        kind: "table.row.restore", tableId: "table", beforeId: null,
        columnIds: ["column"],
        sourceRow: {
          type: "tableRow", attrs: { id: "row" },
          content: [{
            type: "tableCell", attrs: { id: "cell" },
            content: [{ type: "image", attrs: { id: "image", src: asset.uri } }],
          }],
        },
      });
      sealDeleteWitness(store, deletion, { ...cut, seq: 0 });
    });
    const before = persisted(store);
    const inventory = inspectRetentionDependencies(store, cut);
    expect(inventory.references.some(
      (ref) => ref.namespace === "authority.undo" && ref.kind === "asset" && ref.target === asset.hash,
    )).toBe(true);
    expect(planRetentionReclamation(store, cut).candidates).toEqual([]);
    expect(persisted(store)).toEqual(before);
  });

  it("protects archived event appliedBefore even when current state no longer references it", () => {
    const store = newStore(), asset = publish(store), prepared = attempt();
    const old = state();
    old.document.content = [{ type: "image", attrs: { src: asset.uri } }];
    const event: RuntimeEvent = {
      seq: 0, epoch: cut.epoch, previousHash: digest("previous"),
      hash: digest("historical-event"), scope, intentId: prepared.intent.intentId,
      attemptId: prepared.attemptId, writerId: "writer",
      command: prepared.intent.command, appliedText: null,
      state: state("current"), appliedBefore: old,
      receipt: receipt(prepared, digest("result")),
    };
    store.transaction(() => {
      store.set("documents", scopeKey(scope), state("current"));
      store.set("authority.archive.events", cut.epoch + ":0000000000000000", event);
    });
    const inventory = inspectRetentionDependencies(store, cut);
    expect(inventory.references.some(
      (ref) => ref.namespace === "authority.archive.events" && ref.kind === "event",
    )).toBe(true);
    expect(planRetentionReclamation(store, cut).candidates).toEqual([]);
  });

  it.each(["client.editing", "history", "asset.holds", "asset.staging", "future.namespace"])(
    "conservatively protects persisted references in %s without a namespace allowlist",
    (namespace) => {
      const store = newStore(), asset = publish(store);
      const values: Record<string, unknown> = {
        "client.editing": { raw: canonical({ src: asset.uri + "/" }), cut: null },
        "history": { scope, cut: { ...cut, seq: 0 }, state: state(asset.uri) },
        "asset.holds": { hash: asset.hash, holdId: "hold" },
        "asset.staging": { hash: asset.hash, bytes: asset.bytes.byteLength, published: false },
        "future.namespace": { nested: [{ [asset.hash]: "opaque reference key" }] },
      };
      const key = namespace === "asset.holds" ? "org:workspace:" + asset.hash + ":hold"
        : namespace === "asset.staging" ? "org:workspace:upload" : "retained";
      store.transaction(() => store.set(namespace, key, values[namespace]));
      expect(planRetentionReclamation(store, cut).candidates).toEqual([]);
    },
  );

  it("enumerates a real rooted authority without changing its root or historical evidence", () => {
    const authority = new SharedAuthority(directory());
    authorities.push(authority);
    authority.bootstrap({
      orgId: "org", userId: "user", deviceId: "device",
      workspaceId: "workspace", documentId: "document", document: state().document,
    });
    const head = authority.head(), before = persisted(authority.store);
    assertRuntimeStateRoot(authority.store);
    const inventory = inspectRetentionDependencies(authority.store, head);
    const plan = planRetentionReclamation(authority.store, head);
    for (const namespace of [
      "authority.attempts", "authority.intents", "authority.events",
      "editor.versions", "editor.states", "history",
    ]) expect(inventory.records.some((row) => row.namespace === namespace)).toBe(true);
    expect(inventory.references.some((ref) => ref.kind === "receipt")).toBe(true);
    expect(plan.candidates).toEqual([]);
    expect(plan.deletions).toEqual([]);
    assertRuntimeStateRoot(authority.store);
    expect(persisted(authority.store)).toEqual(before);
  });

  it("rejects stale epoch, sequence and hash rather than planning another cut", () => {
    const store = newStore();
    for (const stale of [
      { ...cut, epoch: "other" }, { ...cut, seq: 0 }, { ...cut, hash: digest("other") },
    ]) expect(() => planRetentionReclamation(store, stale)).toThrow("RETENTION_PLAN_STALE");
  });

  it("inventories a headless client explicitly, but cannot manufacture an authority-cut plan", () => {
    const store = newStore(false);
    const queue = new DurableQueue(store, { scope, writerId: "writer" });
    queue.enqueue(intent());
    const before = persisted(store);
    const inventory = inspectRetentionDependencies(store, null);
    expect(inventory.cut).toBeNull();
    expect(inventory.references.some((ref) => ref.kind === "raw")).toBe(true);
    expect(() => planRetentionReclamation(store, cut)).toThrow("RETENTION_HEAD_UNAVAILABLE");
    expect(persisted(store)).toEqual(before);
  });

  it("changes fingerprint when raw, holds, or blob metadata changes without a head advance", () => {
    const store = newStore(), asset = publish(store);
    const first = planRetentionReclamation(store, cut);
    store.transaction(() => store.set("client.editing", "draft", { raw: "unsaved", cut: null }));
    const second = planRetentionReclamation(store, cut);
    expect(second.cut).toEqual(first.cut);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    store.transaction(() => store.set("asset.holds", "org:workspace:" + asset.hash + ":hold", {
      hash: asset.hash, holdId: "hold",
    }));
    const third = planRetentionReclamation(store, cut);
    expect(third.fingerprint).not.toBe(second.fingerprint);
    expect(third.candidates).toEqual([]);
    publish(store, "another");
    expect(planRetentionReclamation(store, cut).fingerprint).not.toBe(third.fingerprint);
  });
});

describe.skipIf(process.platform === "win32")("retention inventory bounds and uncertainty", () => {
  it("accepts exact row/byte/reference bounds and refuses truncation at a smaller bound", () => {
    const store = newStore();
    publish(store);
    const inventory = inspectRetentionDependencies(store, cut);
    const exact: RetentionDependencyLimits = {
      maxRows: inventory.records.length + inventory.blobs.length,
      maxRecordBytes: inventory.recordBytes,
      maxReferences: inventory.references.length,
    };
    expect(inspectRetentionDependencies(store, cut, exact)).toEqual(inventory);
    const before = persisted(store);
    for (const smaller of [
      { ...exact, maxRows: exact.maxRows! - 1 },
      { ...exact, maxRecordBytes: exact.maxRecordBytes! - 1 },
      { ...exact, maxReferences: exact.maxReferences! - 1 },
      { maxScanNodes: 1 },
    ]) expect(() => inspectRetentionDependencies(store, cut, smaller)).toThrow("RETENTION_INVENTORY_LIMIT");
    expect(persisted(store)).toEqual(before);
  });

  it("rejects oversized inventory before decoding even the head record", () => {
    const store = newStore();
    const get = vi.spyOn(store, "get");
    try {
      expect(() => inspectRetentionDependencies(store, cut, { maxRecordBytes: 1 }))
        .toThrow("RETENTION_INVENTORY_LIMIT");
      expect(get).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
    }
  });

  it.each([
    { maxRows: 0 }, { maxRows: -1 }, { maxRows: 1.5 }, { maxRows: 100_001 },
    { maxRows: null }, { maxRecordBytes: 64 * 1024 * 1024 + 1 },
    { maxReferences: 100_001 }, { maxScanNodes: 1_000_001 },
    { unknownOption: 1 }, [],
  ])("rejects malformed/unsupported limits: %j", (input) => {
    const store = newStore();
    expect(() => inspectRetentionDependencies(
      store, cut, input as unknown as RetentionDependencyLimits,
    )).toThrow();
  });

  it("fails closed on an ambiguous raw asset reference and preserves the original", () => {
    const store = newStore();
    const raw = "unparsed original folio-asset://not-a-hash";
    store.transaction(() => store.set("client.editing", "editing", { raw, cut: null }));
    const before = persisted(store);
    expect(() => planRetentionReclamation(store, cut)).toThrow("RETENTION_UNKNOWN_REFERENCE");
    expect(persisted(store)).toEqual(before);
    expect(store.get("client.editing", "editing")).toEqual({ raw, cut: null });
  });

  it("refuses dangling historical version indexes and tampered content-addressed states", () => {
    const store = newStore(), old = state("old"), oldHash = digest(old);
    store.transaction(() => store.set(
      "editor.versions", scopeKey(scope) + ":epoch:0000000000000000", oldHash,
    ));
    const before = persisted(store);
    expect(() => planRetentionReclamation(store, cut)).toThrow("EDITOR_VERSION_CORRUPT");
    expect(persisted(store)).toEqual(before);
    store.transaction(() => store.set("editor.states", oldHash, state("tampered")));
    const tampered = persisted(store);
    expect(() => planRetentionReclamation(store, cut)).toThrow("EDITOR_VERSION_CORRUPT");
    expect(persisted(store)).toEqual(tampered);
  });

  it("uses the actual durable queue decoder rather than trusting forged raw/intent evidence", () => {
    const store = newStore();
    const queue = new DurableQueue(store, { scope, writerId: "writer" });
    queue.enqueue(intent());
    const key = scopeKey(scope) + ":writer:intent";
    store.transaction(() => {
      const stored = store.get("client.queue", key) as Record<string, unknown>;
      store.set("client.queue", key, { ...stored, raw: "different immutable original" });
    });
    const before = persisted(store);
    expect(() => planRetentionReclamation(store, cut)).toThrow("CORRUPT_QUEUE");
    expect(persisted(store)).toEqual(before);
  });

  it("refuses published metadata without the matching blob", () => {
    const store = newStore(), asset = publish(store);
    store.transaction(() => store.blobDelete("org:workspace", asset.hash));
    const before = persisted(store);
    expect(() => planRetentionReclamation(store, cut)).toThrow("RETENTION_DEPENDENCY_DRIFT");
    expect(persisted(store)).toEqual(before);
  });

  it("inventories unknown blob scopes but never makes them deletion candidates", () => {
    const store = newStore(), bytes = new TextEncoder().encode("unclassified evidence");
    const hash = createHash("sha256").update(bytes).digest("hex");
    store.transaction(() => store.blobPut("future:scope", hash, bytes));
    expect(inspectRetentionDependencies(store, cut).blobs).toEqual([{
      scope: "future:scope", hash, bytes: bytes.byteLength,
    }]);
    expect(planRetentionReclamation(store, cut).candidates).toEqual([]);
    expect(store.blobGet("future:scope", hash)).toEqual(bytes);
  });

  it("handles inherited-object namespace names as opaque persisted evidence", () => {
    const store = newStore();
    store.transaction(() => store.set("constructor", "record", "original"));
    expect(inspectRetentionDependencies(store, cut).records.find(
      (row) => row.namespace === "constructor",
    )?.kinds).toEqual(["other"]);
  });
});

describe.skipIf(process.platform === "win32")("retention namespace contract catalog", () => {
  it("classifies every persisted namespace this test store produces", () => {
    const authority = new SharedAuthority(directory());
    authorities.push(authority);
    authority.bootstrap({
      orgId: "org", userId: "user", deviceId: "device",
      workspaceId: "workspace", documentId: "document", document: state().document,
    });
    const namespaces = new Set(
      authority.store.db.prepare(
        "SELECT DISTINCT namespace FROM runtime_records",
      ).all().map((row) => String((row as { namespace: unknown }).namespace)),
    );
    expect(namespaces.size).toBeGreaterThan(0);
    for (const namespace of namespaces)
      expect(
        retentionNamespaceContract(namespace),
        namespace + " must be classified",
      ).not.toBeNull();
    // Unclassified namespaces fail closed rather than being scoped in.
    expect(retentionNamespaceContract("future.namespace")).toBeNull();
    expect(retentionNamespaceContract("constructor")).toBeNull();
  });

  it("assigns stable obligations and owner/caller metadata", () => {
    expect(RETENTION_AUTHORITY_STORE_ID).toBe("authority");
    expect(RETENTION_RELEASES_NAMESPACE).toBe("retention.releases");
    expect(RETENTION_RECOVERY_NAMESPACE).toBe("retention.recovery");
    expect(retentionNamespaceContract("asset.holds")).toMatchObject({
      owner: "assets",
      obligation: "EXPLICIT_HOLD",
    });
    expect(retentionNamespaceContract("retention.releases")).toMatchObject({
      owner: "retention",
      obligation: "RECOVERY_EVIDENCE",
    });
    expect(retentionNamespaceContract("retention.recovery")).toMatchObject({
      owner: "retention",
      obligation: "RECOVERY_EVIDENCE",
    });
    for (const namespace of [
      "authority.attempts",
      "authority.intents",
      "authority.undo",
      "authority.events",
      "client.queue",
      "client.drafts",
      "history",
    ])
      expect(retentionNamespaceContract(namespace)?.obligation).toBe(
        "IMMUTABLE_EVIDENCE",
      );
    for (const namespace of [
      "documents",
      "editor.states",
      "editor.versions",
      "asset",
    ])
      expect(retentionNamespaceContract(namespace)?.obligation).toBe(
        "ROOTED_STATE",
      );
    const catalog = retentionNamespaceContracts();
    expect(catalog.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const entry of catalog) {
      expect(seen.has(entry.namespace)).toBe(false);
      seen.add(entry.namespace);
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.caller.length).toBeGreaterThan(0);
      expect([
        "IMMUTABLE_EVIDENCE",
        "ROOTED_STATE",
        "UNROOTED_OPERATIONAL",
        "EXPLICIT_HOLD",
        "RECOVERY_EVIDENCE",
      ]).toContain(entry.obligation);
    }
    // The catalog classifies exactly the namespaces the inventory marks "other".
    const contractNamespaces = new Set(
      catalog.map((entry) => entry.namespace),
    );
    for (const namespace of [
      "meta",
      "asset.holds",
      "asset.staging",
      "asset.staging.owners",
      "backup.verifications",
      "copy.staging",
      "restoreSeeds",
      "retention.releases",
      "retention.recovery",
    ]) expect(contractNamespaces.has(namespace)).toBe(true);
  });
});
