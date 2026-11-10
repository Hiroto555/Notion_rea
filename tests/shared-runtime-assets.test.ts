import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAssets } from "../src/collaboration/runtime/assets";
import {
  CollaborationError,
  scopeKey,
  type Cut,
  type DocumentState,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import type { Doc } from "../src/shared/types";

const CUT: Cut = { epoch: "epoch-1", seq: 1, hash: "a".repeat(64) };
const MIB = 1024 * 1024;

type Harness = { store: RuntimeStore; directory: string };

const stores: Harness[] = [];

function makeStore(): RuntimeStore {
  const directory = mkdtempSync(join(tmpdir(), "folio-runtime-assets-"));
  const store = new RuntimeStore(directory);
  stores.push({ store, directory });
  return store;
}

afterEach(() => {
  while (stores.length) {
    const { store, directory } = stores.pop()!;
    try {
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function scope(
  orgId = "org1",
  workspaceId = "ws1",
  documentId = "doc1",
  incarnationId = "inc1",
): Scope {
  return { orgId, workspaceId, documentId, incarnationId };
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function setHead(store: RuntimeStore, cut: Cut | null): void {
  store.transaction(() => store.set("meta", "head", cut));
}

function seedCut(store: RuntimeStore, cut: Cut = CUT): void {
  setHead(store, cut);
}

function state(document: Doc): DocumentState {
  return { document, tables: [], tombstones: [] };
}

function putState(store: RuntimeStore, target: Scope, document: Doc): void {
  store.transaction(() =>
    store.set("documents", scopeKey(target), state(document)),
  );
}

function putRawState(store: RuntimeStore, target: Scope, value: unknown): void {
  store.transaction(() => store.set("documents", scopeKey(target), value));
}

function imageDocument(src: string): Doc {
  return {
    type: "doc",
    content: [{ type: "image", attrs: { id: "img-1", src } }],
  };
}

function publish(
  assets: SharedAssets,
  target: Scope,
  uploadId: string,
  bytes: Uint8Array,
): { hash: string; bytes: number } {
  const staged = assets.stage(target, uploadId, bytes);
  return assets.publish(target, uploadId, staged.hash);
}

function expectCode(work: () => unknown, code: string): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("SharedAssets", () => {
  it("round-trips published bytes and keeps staged bytes private", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252]);

    const staged = assets.stage(target, "upload-1", bytes);
    expect(staged).toEqual({ hash: hashOf(bytes), bytes: bytes.length });
    expectCode(() => assets.read(target, staged.hash), "ASSET_NOT_FOUND");

    const published = assets.publish(target, "upload-1", staged.hash);
    expect(published).toEqual(staged);
    expect([...assets.read(target, published.hash)]).toEqual([...bytes]);
    expect(store.get("asset.staging", "org1:ws1:upload-1")).toEqual({
      hash: staged.hash,
      bytes: bytes.length,
      published: true,
    });
  });

  it("copies stage input and read output so callers cannot mutate storage", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const input = Uint8Array.from([4, 5, 6]);
    const staged = assets.stage(target, "upload-copy", input);
    input.fill(9);

    const published = assets.publish(target, "upload-copy", staged.hash);
    const firstRead = assets.read(target, published.hash);
    expect([...firstRead]).toEqual([4, 5, 6]);

    firstRead.fill(0);
    expect([...assets.read(target, published.hash)]).toEqual([4, 5, 6]);
  });

  it("is idempotent per upload and hash and refuses mismatches without publishing", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const bytes = Uint8Array.from([7, 7, 7]);
    const staged = assets.stage(target, "upload-same", bytes);

    expect(assets.publish(target, "upload-same", staged.hash)).toEqual(staged);
    expect(assets.publish(target, "upload-same", staged.hash)).toEqual(staged);

    expectCode(
      () => assets.stage(target, "upload-same", Uint8Array.from([8, 8, 8])),
      "UPLOAD_CONFLICT",
    );
    const otherHash = hashOf(Uint8Array.from([8, 8, 8]));
    expectCode(
      () => assets.publish(target, "upload-same", otherHash),
      "UPLOAD_HASH_MISMATCH",
    );
    expect([...assets.read(target, staged.hash)]).toEqual([7, 7, 7]);
    expectCode(
      () => assets.publish(target, "upload-missing", staged.hash),
      "UPLOAD_NOT_FOUND",
    );
  });

  it("detects tampered staged and published blobs through the real store", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const key = "org1:ws1";
    const bytes = Uint8Array.from([1, 3, 3, 7]);
    const staged = assets.stage(target, "upload-tamper", bytes);
    const tamper = (blobScope: string, replacement: Uint8Array) =>
      store.db
        .prepare("UPDATE runtime_blobs SET bytes=? WHERE scope=? AND hash=?")
        .run(replacement, blobScope, staged.hash);

    tamper(`stage:${key}`, Uint8Array.from([1, 3, 3, 8]));
    expect(() =>
      assets.publish(target, "upload-tamper", staged.hash),
    ).toThrow();

    tamper(`stage:${key}`, bytes);
    const published = assets.publish(target, "upload-tamper", staged.hash);
    tamper(key, Uint8Array.from([0, 0, 0, 0]));
    expect(() => assets.read(target, published.hash)).toThrow();
  });

  it("persists through a new helper instance", () => {
    const store = makeStore();
    const target = scope();
    const bytes = Uint8Array.from([10, 20, 30]);
    const published = publish(
      new SharedAssets(store),
      target,
      "upload-reopen",
      bytes,
    );

    const reopened = new SharedAssets(store);
    expect([...reopened.read(target, published.hash)]).toEqual([10, 20, 30]);
  });

  it("isolates equal content by org and workspace", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const left = scope("org1", "ws1");
    const right = scope("org1", "ws2");
    const bytes = Uint8Array.from([42, 42]);
    const leftAsset = publish(assets, left, "upload-left", bytes);
    const rightAsset = publish(assets, right, "upload-right", bytes);
    expect(leftAsset.hash).toBe(rightAsset.hash);

    seedCut(store);
    const result = assets.collect(left, [], CUT);
    expect(result.removed).toEqual([leftAsset.hash]);
    expectCode(() => assets.read(left, leftAsset.hash), "ASSET_NOT_FOUND");
    expect([...assets.read(right, rightAsset.hash)]).toEqual([42, 42]);
  });

  it("rolls back a quota refusal without staging bytes or metadata", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const existing = "b".repeat(64);
    store.transaction(() =>
      store.set("asset", `org1:ws1:${existing}`, {
        hash: existing,
        bytes: 100 * MIB,
        uploads: [],
      }),
    );

    expectCode(
      () => assets.stage(target, "upload-quota", Uint8Array.of(1)),
      "QUOTA_EXCEEDED",
    );
    expect(store.all("asset.staging")).toEqual([]);
    expect(
      store.blobGet("stage:org1:ws1", hashOf(Uint8Array.of(1))),
    ).toBeNull();
  });

  it("rejects assets larger than twenty mebibytes before staging", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    expectCode(
      () => assets.stage(target, "upload-huge", new Uint8Array(20 * MIB + 1)),
      "ASSET_TOO_LARGE",
    );
    expect(store.all("asset.staging")).toEqual([]);
  });

  it("refuses stale, missing or corrupt global head cuts and leaves assets intact", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const published = publish(assets, target, "upload-cut", Uint8Array.of(5));
    seedCut(store);

    const staleSeq: Cut = { ...CUT, seq: 2 };
    expectCode(() => assets.collect(target, [], staleSeq), "STALE_CUT");
    const staleEpoch: Cut = { ...CUT, epoch: "epoch-2" };
    expectCode(() => assets.collect(target, [], staleEpoch), "STALE_CUT");
    expect([...assets.read(target, published.hash)]).toEqual([5]);

    setHead(store, staleSeq);
    expectCode(() => assets.collect(target, [], CUT), "STALE_CUT");
    setHead(store, null);
    expectCode(() => assets.collect(target, [], CUT), "STALE_CUT");
    store.transaction(() =>
      store.set("meta", "head", { epoch: "epoch-1", seq: 1, hash: "bad" }),
    );
    expectCode(() => assets.collect(target, [], CUT), "CORRUPT_HEAD");
    expect([...assets.read(target, published.hash)]).toEqual([5]);
  });

  it("retains held assets until every hold is released", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const held = publish(assets, target, "upload-held", Uint8Array.of(1));
    const free = publish(assets, target, "upload-free", Uint8Array.of(2));
    seedCut(store);
    assets.hold(target, held.hash, "backup-1");
    assets.hold(target, held.hash, "UNKNOWN");

    expect(assets.collect(target, [], CUT)).toEqual({
      removed: [free.hash],
      bytes: 1,
    });
    expect([...assets.read(target, held.hash)]).toEqual([1]);

    assets.releaseHold(target, held.hash, "backup-1");
    assets.releaseHold(target, held.hash, "backup-1");
    expect(assets.collect(target, [], CUT).removed).toEqual([]);
    assets.releaseHold(target, held.hash, "UNKNOWN");
    expect(assets.collect(target, [], CUT).removed).toEqual([held.hash]);
  });

  it("retains an asset whose pending backup hold was recorded before publish", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const bytes = Uint8Array.of(11, 12, 13);
    const hash = hashOf(bytes);
    assets.hold(target, hash, "backup-pending");
    const published = publish(assets, target, "upload-pending-hold", bytes);
    seedCut(store);

    expect(assets.collect(target, [], CUT).removed).toEqual([]);
    expect([...assets.read(target, published.hash)]).toEqual([11, 12, 13]);
    assets.releaseHold(target, hash, "backup-pending");
    expect(assets.collect(target, [], CUT).removed).toEqual([hash]);
  });

  it("unions caller references with document image references at scopeKey rows", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const callerRef = publish(
      assets,
      target,
      "upload-caller",
      Uint8Array.of(3),
    );
    const imageRef = publish(assets, target, "upload-image", Uint8Array.of(4));
    const removable = publish(assets, target, "upload-gone", Uint8Array.of(5));
    seedCut(store);
    putState(store, target, imageDocument(`folio-asset://${imageRef.hash}`));

    expect(assets.collect(target, [callerRef.hash], CUT)).toEqual({
      removed: [removable.hash],
      bytes: 1,
    });
    expect([...assets.read(target, callerRef.hash)]).toEqual([3]);
    expect([...assets.read(target, imageRef.hash)]).toEqual([4]);
  });

  it("does not let another workspace document protect a target asset", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope("org1", "ws1");
    const other = scope("org1", "ws2");
    const targetAsset = publish(
      assets,
      target,
      "upload-target",
      Uint8Array.of(6),
    );
    seedCut(store);
    putState(store, other, imageDocument(`folio-asset://${targetAsset.hash}`));

    expect(assets.collect(target, [], CUT).removed).toEqual([targetAsset.hash]);
  });

  it("fails closed on malformed document state, references and holds", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const published = publish(
      assets,
      target,
      "upload-unknown",
      Uint8Array.of(9),
    );
    seedCut(store);

    putState(store, target, imageDocument("folio-asset://not-a-hash"));
    expectCode(() => assets.collect(target, [], CUT), "UNKNOWN_REFERENCE");
    expect([...assets.read(target, published.hash)]).toEqual([9]);

    putRawState(store, target, {
      document: { type: "doc", content: [{ type: "unknownBlock" }] },
      tables: [],
      tombstones: [],
    });
    expectCode(() => assets.collect(target, [], CUT), "CORRUPT_DOCUMENT");
    expect([...assets.read(target, published.hash)]).toEqual([9]);

    putRawState(store, target, { document: {}, tables: [], tombstones: [] });
    expectCode(() => assets.collect(target, [], CUT), "CORRUPT_DOCUMENT");
    expect([...assets.read(target, published.hash)]).toEqual([9]);

    store.transaction(() => store.set("documents", scopeKey(target), null));
    store.transaction(() =>
      store.set("asset.holds", `org1:ws1:${published.hash}:corrupt`, {
        hash: published.hash,
        holdId: "different",
      }),
    );
    expectCode(() => assets.collect(target, [], CUT), "UNKNOWN_HOLD");
    expect([...assets.read(target, published.hash)]).toEqual([9]);
  });

  it("retains unpublished staging through collection", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const old = publish(assets, target, "upload-old", Uint8Array.of(1));
    const staged = assets.stage(target, "upload-pending", Uint8Array.of(2));
    seedCut(store);

    expect(assets.collect(target, [], CUT).removed).toEqual([old.hash]);
    expect(assets.publish(target, "upload-pending", staged.hash)).toEqual(
      staged,
    );
    expect([...assets.read(target, staged.hash)]).toEqual([2]);
  });

  it("rejects malformed caller references before deleting anything", () => {
    const store = makeStore();
    const assets = new SharedAssets(store);
    const target = scope();
    const published = publish(
      assets,
      target,
      "upload-bad-ref",
      Uint8Array.of(1),
    );
    seedCut(store);
    expectCode(
      () => assets.collect(target, ["not-a-hash"], CUT),
      "INVALID_HASH",
    );
    expect([...assets.read(target, published.hash)]).toEqual([1]);
  });
});
