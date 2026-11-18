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
  type Scope,
} from "../src/collaboration/runtime/contract";
import {
  COPY_ASSETS_NAMESPACE,
  COPY_DOCUMENTS_NAMESPACE,
  COPY_LIFECYCLES_NAMESPACE,
  COPY_PAGES_NAMESPACE,
  COPY_TITLES_NAMESPACE,
  commitSharedCopy,
  previewSharedCopy,
  type SharedCopySource,
} from "../src/collaboration/runtime/copy";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import type { StoragePort } from "../src/collaboration/runtime/storage-port";

const HEAD: Cut = { epoch: "epoch_one", seq: 0, hash: "a".repeat(64) };
const TARGET = { orgId: "org", workspaceId: "ws" };

let directory: string;
let store: RuntimeStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "folio-copy-"));
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

function paragraph(id: string, text: string, href?: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    content: text
      ? [
          {
            type: "text",
            text,
            ...(href ? { marks: [{ type: "link", attrs: { href } }] } : {}),
          },
        ]
      : [],
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

function allocator(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++];
}

function linkHref(document: Doc): string | undefined {
  return document.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.href as
    string | undefined;
}

function blockIds(document: Doc): string[] {
  const ids: string[] = [];
  const stack = [document];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node.attrs?.id === "string") ids.push(node.attrs.id);
    stack.push(...(node.content ?? []));
  }
  return ids;
}

function documentState(scope: Scope): DocumentState {
  const state = store.get(COPY_DOCUMENTS_NAMESPACE, scopeKey(scope));
  expect(state).not.toBeNull();
  return state as DocumentState;
}

class InjectingStore implements StoragePort {
  readonly db: RuntimeStore["db"];
  private documentWrites = 0;

  constructor(
    private readonly inner: RuntimeStore,
    private readonly failOnDocumentWrite: number,
  ) {
    this.db = inner.db;
  }

  transaction<T>(work: () => T): T {
    return this.inner.transaction(work);
  }

  get(namespace: string, key: string): unknown | null {
    return this.inner.get(namespace, key);
  }

  set(namespace: string, key: string, value: unknown | null): void {
    if (namespace === COPY_DOCUMENTS_NAMESPACE) {
      if (this.documentWrites >= this.failOnDocumentWrite)
        throw new Error("INJECTED_FAILURE");
      this.documentWrites++;
    }
    this.inner.set(namespace, key, value);
  }

  all(namespace: string): { key: string; value: unknown }[] {
    return this.inner.all(namespace);
  }

  blobGet(scope: string, hash: string): Uint8Array | null {
    return this.inner.blobGet(scope, hash);
  }

  blobPut(scope: string, hash: string, bytes: Uint8Array): void {
    this.inner.blobPut(scope, hash, bytes);
  }

  blobDelete(scope: string, hash: string): void {
    this.inner.blobDelete(scope, hash);
  }

  close(): void {
    this.inner.close();
  }
}

describe("previewSharedCopy", () => {
  it("retains source raw, verified asset bytes, remapped ids and selected links", () => {
    const bytes = new TextEncoder().encode("asset-bytes");
    const hash = sha(bytes);
    const a = source(
      "a",
      null,
      raw(paragraph("a1", "to b", "folio-page://b")),
      [{ hash, bytes }],
      "Page A",
    );
    const b = source("b", "a", raw(paragraph("b1", "body")), [], "Page B");

    const preview = previewSharedCopy(
      [a, b],
      ["a", "b"],
      TARGET,
      allocator("page_a", "page_b"),
    );

    expect(preview.target).toEqual(TARGET);
    expect(preview.sourceIds).toEqual(["a", "b"]);
    expect(preview.sourceHashes).toHaveLength(2);
    expect(preview.scopes.map((scope) => scope.documentId)).toEqual([
      "page_a",
      "page_b",
    ]);
    expect(preview.warnings).toEqual([]);
    expect(preview.documents.map((entry) => entry.sourceRaw)).toEqual([
      a.raw,
      b.raw,
    ]);
    expect(preview.documents.map((entry) => entry.title)).toEqual([
      "Page A",
      "Page B",
    ]);
    expect(preview.assetManifests).toEqual([
      { sourceId: "a", hash, bytes: bytes.byteLength },
    ]);
    expect(preview.assets).toHaveLength(1);
    expect(preview.assets[0]).toMatchObject({ sourceId: "a", hash });
    expect(preview.assets[0].bytes).toEqual(bytes);
    expect(preview.assets[0].bytes).not.toBe(bytes);
    expect(linkHref(preview.documents[0].document)).toBe("folio-page://page_b");
    expect(blockIds(preview.documents[0].document)).not.toContain("a1");
    expect(blockIds(preview.documents[0].document)).not.toContain("b1");

    const scopes = store.transaction(() =>
      commitSharedCopy(store, preview, [a, b]),
    );
    expect(scopes).toEqual(preview.scopes);

    expect(linkHref(documentState(scopes[0]).document)).toBe(
      "folio-page://page_b",
    );
    expect(store.blobGet("org:ws", hash)).toEqual(bytes);
    expect(store.get(COPY_ASSETS_NAMESPACE, `org:ws:${hash}`)).toEqual({
      hash,
      bytes: bytes.byteLength,
      uploads: [],
    });
    expect(store.get(COPY_TITLES_NAMESPACE, scopeKey(scopes[0]))).toBe(
      "Page A",
    );
    expect(store.get(COPY_TITLES_NAMESPACE, scopeKey(scopes[1]))).toBe(
      "Page B",
    );
    expect(store.get(COPY_PAGES_NAMESPACE, "org:ws:page_a")).toEqual({
      id: "page_a",
      parentId: null,
      order: 0,
    });
    expect(store.get(COPY_PAGES_NAMESPACE, "org:ws:page_b")).toEqual({
      id: "page_b",
      parentId: "page_a",
      order: 0,
    });
    expect(store.get(COPY_LIFECYCLES_NAMESPACE, "org:ws:page_a")).toEqual({
      activeIncarnation: scopes[0].incarnationId,
      deleted: false,
      cut: HEAD,
    });
    expect(store.get("meta", "head")).toEqual(HEAD);
  });

  it("warns about links to pages outside the selection but keeps them", () => {
    const a = source(
      "a",
      null,
      raw(
        paragraph("a1", "to b", "folio-page://b"),
        paragraph("a2", "to c", "folio-page://c"),
      ),
    );
    const b = source("b", null, raw(paragraph("b1", "selected")));
    const c = source("c", null, raw(paragraph("c1", "private-secret")));

    const preview = previewSharedCopy(
      [a, b, c],
      ["a", "b"],
      TARGET,
      allocator("page_a", "page_b"),
    );
    expect(JSON.stringify(preview)).not.toContain("private-secret");
    expect(preview.documents[0].raw).toContain("folio-page://page_b");
    expect(preview.documents[0].raw).toContain("folio-page://c");
    expect(preview.warnings).toEqual([
      {
        code: "EXTERNAL_PRIVATE_PAGE_LINK",
        sourceId: "a",
        pageId: "page_a",
        targetId: "c",
        targetPageId: "c",
        href: "folio-page://c",
      },
    ]);

    const scopes = store.transaction(() =>
      commitSharedCopy(store, preview, [a, b]),
    );
    expect(scopes).toHaveLength(2);
    expect(
      documentState(scopes[0]).document.content?.[1].content?.[0].marks?.[0]
        .attrs?.href,
    ).toBe("folio-page://c");
  });

  it("rejects malformed page links instead of guessing an id", () => {
    const a = source(
      "a",
      null,
      raw(paragraph("a1", "bad", "folio-page://bad id")),
    );
    expect(() =>
      previewSharedCopy([a], ["a"], TARGET, allocator("page_a")),
    ).toThrow("INVALID_PAGE_LINK");
  });

  it("rejects unsupported raw and unknown or record sources without mutation", () => {
    const broken = source(
      "a",
      null,
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { id: "p1" },
            content: [{ type: "text", text: 1.5 }],
          },
        ],
      }),
    );
    const before = { ...broken, assets: [...broken.assets] };
    expect(() =>
      previewSharedCopy([broken], ["a"], TARGET, allocator("page_a")),
    ).toThrow(CollaborationError);
    expect(broken).toEqual(before);
    expect(broken.raw).toBe(before.raw);

    const base = source("a", null, raw(paragraph("a1", "body")));
    for (const key of ["recordOwner", "record", "db", "database"]) {
      const disguised = {
        ...base,
        [key]: { id: "record" },
      } as unknown as SharedCopySource;
      expect(() =>
        previewSharedCopy([disguised], ["a"], TARGET, allocator("page_a")),
      ).toThrow("RECORD_COPY_UNSUPPORTED");
      expect((disguised as unknown as Record<string, unknown>)[key]).toEqual({
        id: "record",
      });
    }

    const unknown = {
      ...base,
      unexpected: true,
    } as unknown as SharedCopySource;
    expect(() =>
      previewSharedCopy([unknown], ["a"], TARGET, allocator("page_a")),
    ).toThrow("UNKNOWN_SOURCE_FIELD");
  });

  it("rejects asset bytes that do not match their declared hash", () => {
    const bytes = new TextEncoder().encode("real bytes");
    const a = source("a", null, raw(paragraph("a1", "body")), [
      { hash: "0".repeat(64), bytes },
    ]);
    expect(() =>
      previewSharedCopy([a], ["a"], TARGET, allocator("page_a")),
    ).toThrow("ASSET_HASH_MISMATCH");
  });

  it("rejects duplicate source ids and duplicate selections", () => {
    const a = source("a", null, raw(paragraph("a1", "body")));
    expect(() =>
      previewSharedCopy([a, a], ["a"], TARGET, allocator("page_a")),
    ).toThrow("DUPLICATE_SOURCE_ID");
    expect(() =>
      previewSharedCopy([a], ["a", "a"], TARGET, allocator("page_a")),
    ).toThrow("DUPLICATE_SELECTED_ID");
  });
});

describe("commitSharedCopy", () => {
  it("requires the caller to own an active transaction", () => {
    const a = source("a", null, raw(paragraph("a1", "body")));
    const preview = previewSharedCopy([a], ["a"], TARGET, allocator("page_a"));
    expect(() => commitSharedCopy(store, preview, [a])).toThrow(
      "TRANSACTION_REQUIRED",
    );
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toEqual([]);
  });

  it("rolls back every namespace and blob when a late write fails", () => {
    const bytes = new TextEncoder().encode("asset");
    const hash = sha(bytes);
    const a = source("a", null, raw(paragraph("a1", "body")), [
      { hash, bytes },
    ]);
    const b = source("b", "a", raw(paragraph("b1", "body")));
    const preview = previewSharedCopy(
      [a, b],
      ["a", "b"],
      TARGET,
      allocator("page_a", "page_b"),
    );
    const injected = new InjectingStore(store, 1);

    expect(() =>
      store.transaction(() => commitSharedCopy(injected, preview, [a, b])),
    ).toThrow("INJECTED_FAILURE");

    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toEqual([]);
    expect(store.all(COPY_PAGES_NAMESPACE)).toEqual([]);
    expect(store.all(COPY_TITLES_NAMESPACE)).toEqual([]);
    expect(store.all(COPY_LIFECYCLES_NAMESPACE)).toEqual([]);
    expect(store.all(COPY_ASSETS_NAMESPACE)).toEqual([]);
    expect(store.blobGet("org:ws", hash)).toBeNull();
    expect(store.get("meta", "head")).toEqual(HEAD);
  });

  it("rejects changed sources and changed previews before writing", () => {
    const bytes = new TextEncoder().encode("original");
    const hash = sha(bytes);
    const a = source("a", null, raw(paragraph("a1", "body")), [
      { hash, bytes },
    ]);
    const preview = previewSharedCopy([a], ["a"], TARGET, allocator("page_a"));

    expect(() =>
      store.transaction(() =>
        commitSharedCopy(store, preview, [
          source("a", null, raw(paragraph("a1", "changed")), [{ hash, bytes }]),
        ]),
      ),
    ).toThrow("SOURCE_CHANGED");
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toEqual([]);
    expect(store.all(COPY_ASSETS_NAMESPACE)).toEqual([]);
    expect(store.blobGet("org:ws", hash)).toBeNull();

    const tampered = {
      ...preview,
      scopes: [{ ...preview.scopes[0], documentId: "other" }],
    };
    expect(() =>
      store.transaction(() => commitSharedCopy(store, tampered, [a])),
    ).toThrow("PREVIEW_CHANGED");
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toEqual([]);
  });

  it("refuses to overwrite an existing destination", () => {
    const a = source("a", null, raw(paragraph("a1", "body")));
    const preview = previewSharedCopy([a], ["a"], TARGET, allocator("page_a"));
    const scope = preview.scopes[0];
    const existing: DocumentState = {
      document: { type: "doc", content: [] },
      tables: [],
      tombstones: [],
    };
    store.transaction(() =>
      store.set(COPY_DOCUMENTS_NAMESPACE, scopeKey(scope), existing),
    );

    expect(() =>
      store.transaction(() => commitSharedCopy(store, preview, [a])),
    ).toThrow("DESTINATION_EXISTS");
    expect(store.get(COPY_DOCUMENTS_NAMESPACE, scopeKey(scope))).toEqual(
      existing,
    );
    expect(store.all(COPY_PAGES_NAMESPACE)).toEqual([]);
    expect(store.all(COPY_TITLES_NAMESPACE)).toEqual([]);
    expect(store.all(COPY_LIFECYCLES_NAMESPACE)).toEqual([]);
  });

  it("does not need to advance the authority head and seeds a non-deleted lifecycle", () => {
    const a = source("a", null, raw(paragraph("a1", "body")));
    const preview = previewSharedCopy([a], ["a"], TARGET, allocator("page_a"));
    const [scope] = store.transaction(() =>
      commitSharedCopy(store, preview, [a]),
    );
    expect(store.get("meta", "head")).toEqual(HEAD);
    expect(store.get(COPY_LIFECYCLES_NAMESPACE, "org:ws:page_a")).toMatchObject(
      {
        activeIncarnation: scope.incarnationId,
        deleted: false,
      },
    );
  });
});
