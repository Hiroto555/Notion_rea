import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import {
  CollaborationError,
  scopeKey,
  type Cut,
  type DocumentState,
  type Json,
  type Scope,
} from "../src/collaboration/runtime/contract";
import {
  COPY_ASSETS_NAMESPACE,
  COPY_DOCUMENTS_NAMESPACE,
  COPY_LIFECYCLES_NAMESPACE,
  COPY_PAGES_NAMESPACE,
  COPY_TITLES_NAMESPACE,
  type SharedCopySource,
} from "../src/collaboration/runtime/copy";
import {
  applyCopyPayload,
  previewCopyPayload,
} from "../src/collaboration/runtime/copy-command";
import { RuntimeStore } from "../src/collaboration/runtime/store";

const HEAD: Cut = { epoch: "epoch_one", seq: 0, hash: "a".repeat(64) };
const TARGET = { orgId: "org", workspaceId: "ws" };
const SCOPE: Scope = {
  orgId: "org",
  workspaceId: "ws",
  documentId: "scope_document",
  incarnationId: "scope_incarnation",
};

let directory: string;
let store: RuntimeStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "folio-copy-command-"));
  store = new RuntimeStore(directory);
  store.transaction(() => store.set("meta", "head", HEAD));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function paragraph(id: string, text: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    content: [{ type: "text", text }],
  };
}

function raw(...content: Doc[]): string {
  return JSON.stringify({ type: "doc", content });
}

function source(
  id: string,
  parentId: string | null,
  document: string,
  assets: { hash: string; bytes: Uint8Array }[] = [],
  title?: string,
): SharedCopySource {
  return {
    id,
    parentId,
    ...(title === undefined ? {} : { title }),
    raw: document,
    assets,
  };
}

function cloneJson<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectNoOutputs(hash?: string): void {
  expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toEqual([]);
  expect(store.all(COPY_PAGES_NAMESPACE)).toEqual([]);
  expect(store.all(COPY_TITLES_NAMESPACE)).toEqual([]);
  expect(store.all(COPY_LIFECYCLES_NAMESPACE)).toEqual([]);
  expect(store.all(COPY_ASSETS_NAMESPACE)).toEqual([]);
  if (hash !== undefined) expect(store.blobGet("org:ws", hash)).toBeNull();
}

describe("previewCopyPayload", () => {
  it("builds an exact selected-only payload with verified base64 assets", () => {
    const bytes = new TextEncoder().encode("copy-asset");
    const hash = sha(bytes);
    const selected = source(
      "a",
      null,
      raw(paragraph("a1", "selected")),
      [{ hash, bytes }],
      "Selected",
    );
    const unselected = source(
      "b",
      null,
      raw(paragraph("b1", "unselected-secret")),
      [
        {
          hash: sha(new TextEncoder().encode("other")),
          bytes: new TextEncoder().encode("other"),
        },
      ],
    );
    const before = structuredClone(selected) as SharedCopySource;

    const { preview, payload } = previewCopyPayload(
      [selected, unselected],
      ["a"],
      TARGET,
    );
    const value = payload as Record<string, unknown>;
    expect(Object.keys(value).sort()).toEqual([
      "allocatedIds",
      "fingerprint",
      "selectedIds",
      "sources",
    ]);
    expect(value.selectedIds).toEqual(["a"]);
    expect(value.allocatedIds).toEqual(
      preview.scopes.map((entry) => entry.documentId),
    );
    expect(value.fingerprint).toBe(preview.fingerprint);
    const sources = value.sources as {
      id: string;
      assets: { hash: string; base64: string }[];
    }[];
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe("a");
    expect(sources[0].assets).toEqual([
      { hash, base64: Buffer.from(bytes).toString("base64") },
    ]);
    expect(JSON.stringify(payload)).not.toContain("unselected-secret");
    expect(JSON.stringify(payload)).not.toContain(unselected.assets[0].hash);
    expect(selected).toEqual(before);
  });

  it("refuses a payload beyond the bounded capacity without changing the sources", () => {
    const huge = "x".repeat(900_000);
    const selected = source("a", null, raw(paragraph("a1", huge)), [], "Huge");
    const before = structuredClone(selected) as SharedCopySource;
    expect(() => previewCopyPayload([selected], ["a"], TARGET)).toThrow(
      "COPY_CAPACITY_EXCEEDED",
    );
    expect(selected).toEqual(before);
  });
});

describe("applyCopyPayload", () => {
  it("rebuilds the preview, commits every namespace and marks the next cut provisional", () => {
    const bytes = new TextEncoder().encode("copy-asset");
    const hash = sha(bytes);
    const selected = source(
      "a",
      null,
      raw(paragraph("a1", "selected")),
      [{ hash, bytes }],
      "Selected",
    );
    const unselected = source(
      "b",
      null,
      raw(paragraph("b1", "unselected-secret")),
    );
    const { preview, payload } = previewCopyPayload(
      [selected, unselected],
      ["a"],
      TARGET,
    );

    const result = store.transaction(() =>
      applyCopyPayload(store, SCOPE, payload),
    );

    expect(result.scopes).toEqual(preview.scopes);
    const scope = result.scopes[0];
    const state = store.get(
      COPY_DOCUMENTS_NAMESPACE,
      scopeKey(scope),
    ) as DocumentState;
    expect(state.document).toBeTruthy();
    expect(store.get(COPY_TITLES_NAMESPACE, scopeKey(scope))).toBe("Selected");
    expect(
      store.get(COPY_PAGES_NAMESPACE, `org:ws:${scope.documentId}`),
    ).toEqual({
      id: scope.documentId,
      parentId: null,
      order: 0,
    });
    expect(
      store.get(COPY_LIFECYCLES_NAMESPACE, `org:ws:${scope.documentId}`),
    ).toEqual({
      activeIncarnation: scope.incarnationId,
      deleted: false,
      cut: { epoch: HEAD.epoch, seq: HEAD.seq + 1, hash: "" },
    });
    expect(store.blobGet("org:ws", hash)).toEqual(bytes);
    expect(store.get(COPY_ASSETS_NAMESPACE, `org:ws:${hash}`)).toEqual({
      hash,
      bytes: bytes.byteLength,
      uploads: [],
    });
    expect(store.get("meta", "head")).toEqual(HEAD);
  });

  it("keeps the exact allocation order and marks every created scope provisional", () => {
    const a = source("a", null, raw(paragraph("a1", "parent")), [], "Parent");
    const b = source("b", "a", raw(paragraph("b1", "child")), [], "Child");
    const { preview, payload } = previewCopyPayload([a, b], ["b", "a"], TARGET);

    const result = store.transaction(() =>
      applyCopyPayload(store, SCOPE, payload),
    );

    expect(result.scopes.map((entry) => entry.documentId)).toEqual(
      preview.scopes.map((entry) => entry.documentId),
    );
    expect(
      store.get(COPY_PAGES_NAMESPACE, `org:ws:${result.scopes[0].documentId}`),
    ).toMatchObject({ parentId: result.scopes[1].documentId });
    for (const created of result.scopes) {
      expect(
        store.get(COPY_LIFECYCLES_NAMESPACE, `org:ws:${created.documentId}`),
      ).toEqual({
        activeIncarnation: created.incarnationId,
        deleted: false,
        cut: { epoch: HEAD.epoch, seq: HEAD.seq + 1, hash: "" },
      });
    }
  });

  it("rejects extra keys, mismatched allocation and a different auth target without output", () => {
    const bytes = new TextEncoder().encode("copy-asset");
    const hash = sha(bytes);
    const selected = source("a", null, raw(paragraph("a1", "body")), [
      { hash, bytes },
    ]);
    const { payload } = previewCopyPayload([selected], ["a"], TARGET);

    const extraPayload = cloneJson(payload) as Record<string, Json>;
    extraPayload.extra = true;
    expect(() =>
      store.transaction(() =>
        applyCopyPayload(store, SCOPE, extraPayload as Json),
      ),
    ).toThrow("INVALID_COPY_PAYLOAD");
    expectNoOutputs(hash);

    const extraSource = cloneJson(payload) as {
      sources: Record<string, Json>[];
    } & Record<string, Json>;
    extraSource.sources[0].recordOwner = "owner";
    expect(() =>
      store.transaction(() =>
        applyCopyPayload(store, SCOPE, extraSource as Json),
      ),
    ).toThrow("INVALID_COPY_SOURCE");
    expectNoOutputs(hash);

    const extraAsset = cloneJson(payload) as {
      sources: { assets: Record<string, Json>[] }[];
    } & Record<string, Json>;
    extraAsset.sources[0].assets[0].bytes = "not-allowed";
    expect(() =>
      store.transaction(() =>
        applyCopyPayload(store, SCOPE, extraAsset as Json),
      ),
    ).toThrow("INVALID_COPY_ASSET");
    expectNoOutputs(hash);

    const shortAllocation = cloneJson(payload) as Record<string, Json>;
    shortAllocation.allocatedIds = [];
    expect(() =>
      store.transaction(() =>
        applyCopyPayload(store, SCOPE, shortAllocation as Json),
      ),
    ).toThrow("COPY_ALLOCATION_MISMATCH");
    expectNoOutputs(hash);

    const otherTarget = { ...SCOPE, orgId: "other" };
    expect(() =>
      store.transaction(() => applyCopyPayload(store, otherTarget, payload)),
    ).toThrow("COPY_FINGERPRINT_MISMATCH");
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toEqual([]);
    expect(store.blobGet("other:ws", hash)).toBeNull();
  });

  it("rejects changed fingerprint, malformed base64, mismatched hash and unknown raw", () => {
    const bytes = new TextEncoder().encode("copy-asset");
    const hash = sha(bytes);
    const selected = source("a", null, raw(paragraph("a1", "body")), [
      { hash, bytes },
    ]);
    const { payload } = previewCopyPayload([selected], ["a"], TARGET);

    const changed = cloneJson(payload) as Record<string, Json>;
    changed.fingerprint = "0".repeat(64);
    expect(() =>
      store.transaction(() => applyCopyPayload(store, SCOPE, changed as Json)),
    ).toThrow("COPY_FINGERPRINT_MISMATCH");
    expectNoOutputs(hash);

    const badBase64 = cloneJson(payload) as {
      sources: { assets: { base64: string }[] }[];
    } & Record<string, Json>;
    badBase64.sources[0].assets[0].base64 = "%%%";
    expect(() =>
      store.transaction(() =>
        applyCopyPayload(store, SCOPE, badBase64 as Json),
      ),
    ).toThrow("INVALID_COPY_BASE64");
    expectNoOutputs(hash);

    const otherBytes = new TextEncoder().encode("different");
    const wrongHash = cloneJson(payload) as {
      sources: { assets: { base64: string }[] }[];
    } & Record<string, Json>;
    wrongHash.sources[0].assets[0].base64 =
      Buffer.from(otherBytes).toString("base64");
    expect(() =>
      store.transaction(() =>
        applyCopyPayload(store, SCOPE, wrongHash as Json),
      ),
    ).toThrow("ASSET_HASH_MISMATCH");
    expectNoOutputs(hash);

    const unknownRaw = cloneJson(payload) as {
      sources: { raw: string }[];
    } & Record<string, Json>;
    unknownRaw.sources[0].raw = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [{ type: "text", text: 1.5 }],
        },
      ],
    });
    expect(() =>
      store.transaction(() =>
        applyCopyPayload(store, SCOPE, unknownRaw as Json),
      ),
    ).toThrow(CollaborationError);
    expectNoOutputs(hash);
  });

  it("refuses an oversized payload before any source is committed", () => {
    const payload: Json = {
      sources: [
        {
          id: "a",
          parentId: null,
          title: "Huge",
          raw: "x".repeat(900_000),
          assets: [],
        },
      ],
      selectedIds: ["a"],
      allocatedIds: ["page_a"],
      fingerprint: "a".repeat(64),
    };
    expect(() =>
      store.transaction(() => applyCopyPayload(store, SCOPE, payload)),
    ).toThrow("COPY_CAPACITY_EXCEEDED");
    expectNoOutputs();
  });
});
