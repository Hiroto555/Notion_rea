import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  CollaborationError,
  scopeKey,
  type Cut,
  type DocumentState,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { digest } from "../src/collaboration/runtime/digest";
import { SharedProjection } from "../src/collaboration/runtime/projection";
import { RuntimeStore } from "../src/collaboration/runtime/store";

const cut: Cut = { epoch: "epoch-1", seq: 7, hash: "a".repeat(64) };
const assetId = "0f8fad5b-d9cb-469f-a165-70867728950e";

type Harness = { store: RuntimeStore; directory: string };

const stores: Harness[] = [];

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

function memoryStore(): {
  store: RuntimeStore;
  rawInsert(namespace: string, key: string, value: string): void;
  rawGet(namespace: string, key: string): string | undefined;
  dump(): { namespace: string; key: string; value: string }[];
} {
  const directory = mkdtempSync(join(tmpdir(), "folio-runtime-projection-"));
  const store = new RuntimeStore(directory);
  stores.push({ store, directory });
  return {
    store,
    rawInsert(namespace, key, value) {
      store.db
        .prepare(
          "INSERT OR REPLACE INTO runtime_records(namespace,key,raw) VALUES(?,?,?)",
        )
        .run(namespace, key, value);
    },
    rawGet(namespace, key) {
      return (
        store.db
          .prepare(
            "SELECT raw FROM runtime_records WHERE namespace=? AND key=?",
          )
          .get(namespace, key) as { raw: string } | undefined
      )?.raw;
    },
    dump() {
      return store.db
        .prepare(
          "SELECT namespace,key,raw AS value FROM runtime_records ORDER BY namespace,key",
        )
        .all() as { namespace: string; key: string; value: string }[];
    },
  };
}

function setHead(store: RuntimeStore, value: Cut): void {
  store.transaction(() => store.set("meta", "head", value));
}

function scope(
  orgId: string,
  workspaceId: string,
  documentId = "doc-a",
  incarnationId = "inc-1",
): Scope {
  return { orgId, workspaceId, documentId, incarnationId };
}

function text(value: string, marks?: Doc["marks"]): Doc {
  return { type: "text", text: value, ...(marks ? { marks } : {}) };
}

function paragraph(id: string, content: Doc[] = []): Doc {
  return { type: "paragraph", attrs: { id }, content };
}

function heading(id: string, value: string): Doc {
  return { type: "heading", attrs: { id, level: 1 }, content: [text(value)] };
}

function linkAttrs(href: string): Record<string, unknown> {
  return { href };
}

function linked(value: string, href: string): Doc {
  return text(value, [{ type: "link", attrs: linkAttrs(href) }]);
}

function imageAsset(id: string, hash: string): Doc {
  return {
    type: "image",
    attrs: { id, src: `folio-asset://${hash}` },
  };
}

function documentOf(...content: Doc[]): Doc {
  return { type: "doc", content };
}

function state(document: Doc): DocumentState {
  return { document, tables: [], tombstones: [] };
}

function put(store: RuntimeStore, target: Scope, value: DocumentState): void {
  store.transaction(() => store.set("documents", scopeKey(target), value));
}

describe("SharedProjection", () => {
  it("searches only the requested space and exports the original body read-only", () => {
    const memory = memoryStore();
    setHead(memory.store, cut);
    const first = scope("org-1", "ws-1", "doc-a", "inc-1");
    const second = scope("org-1", "ws-2", "doc-a", "inc-1");
    const third = scope("org-2", "ws-1", "doc-a", "inc-1");
    const firstState = state(
      documentOf(
        heading("h-1", "Alpha title"),
        paragraph("p-1", [text("alpha shared body")]),
      ),
    );
    put(memory.store, first, firstState);
    put(
      memory.store,
      second,
      state(documentOf(paragraph("p-1", [text("delta elsewhere")]))),
    );
    put(
      memory.store,
      third,
      state(documentOf(paragraph("p-1", [text("alpha other org")]))),
    );
    const before = memory.dump();
    const projection = new SharedProjection(memory.store, () => {});

    const results = projection.search("org-1", "ws-1", "ALPHA");
    expect(results).toHaveLength(1);
    expect(results[0].scope).toEqual(first);
    expect(results[0].title).toBe("Alpha title");
    expect(results[0].text).toContain("alpha shared body");
    expect(results[0].cut).toEqual(cut);

    expect(projection.search("org-1", "ws-2", "delta")[0].scope).toEqual(
      second,
    );
    expect(projection.search("org-2", "ws-1", "alpha")[0].scope).toEqual(third);
    expect(projection.search("org-1", "ws-1", "alpha", 0)).toEqual([]);

    const exported = projection.exportDocument(first);
    expect(exported.scope).toEqual(first);
    expect(exported.state).toEqual(firstState);
    expect(exported.raw).toBe(canonical(firstState));
    expect(digest(JSON.parse(exported.raw) as unknown)).toBe(
      digest(firstState),
    );
    expect(exported.cut).toEqual(cut);
    expect(memory.dump()).toEqual(before);
  });

  it("authorizes every scanned document and honors revocation on later queries", () => {
    const memory = memoryStore();
    setHead(memory.store, cut);
    const first = scope("org-1", "ws-1", "doc-a", "inc-1");
    const second = scope("org-1", "ws-1", "doc-b", "inc-1");
    put(
      memory.store,
      first,
      state(documentOf(paragraph("p-1", [text("one")]))),
    );
    put(
      memory.store,
      second,
      state(documentOf(paragraph("p-1", [text("two")]))),
    );
    const revoked = new Set<string>();
    const seen: string[] = [];
    const projection = new SharedProjection(memory.store, (target) => {
      const key = scopeKey(target);
      if (revoked.has(key)) throw new CollaborationError("UNAUTHORIZED");
      seen.push(key);
    });

    expect(projection.search("org-1", "ws-1", "")).toHaveLength(2);
    expect(new Set(seen)).toEqual(new Set([scopeKey(first), scopeKey(second)]));

    seen.length = 0;
    revoked.add(scopeKey(second));
    expect(() => projection.search("org-1", "ws-1", "")).toThrow(
      CollaborationError,
    );
    expect(seen).toContain(scopeKey(first));

    expect(() => projection.exportDocument(second)).toThrow(CollaborationError);
    expect(() => projection.rebuild("org-1", "ws-1")).toThrow(
      CollaborationError,
    );
  });

  it("returns backlinks by source scope and containing block mark", () => {
    const memory = memoryStore();
    setHead(memory.store, cut);
    const target = scope("org-1", "ws-1", "target", "inc-1");
    const sourceOne = scope("org-1", "ws-1", "source-1", "inc-1");
    const sourceTwo = scope("org-1", "ws-1", "source-2", "inc-1");
    const otherWorkspace = scope("org-1", "ws-2", "source-1", "inc-1");
    const otherOrg = scope("org-2", "ws-1", "source-1", "inc-1");

    put(
      memory.store,
      target,
      state(
        documentOf(paragraph("t-1", [linked("self", "folio-page://target")])),
      ),
    );
    put(
      memory.store,
      sourceOne,
      state(
        documentOf(
          paragraph("p-1", [
            text("See "),
            linked("target", "folio-page://target"),
            text(" and "),
            linked("again", "folio-page://target/"),
          ]),
          paragraph("p-2", [text("no link here")]),
        ),
      ),
    );
    put(
      memory.store,
      sourceTwo,
      state(
        documentOf(
          paragraph("q-1", [
            linked("target", "folio-page://target/"),
            linked("bad", "folio-page://target/extra"),
          ]),
          imageAsset("7a6f0e1c-5b4a-4b6e-9c3d-2f1a0b9c8d7e", assetId),
        ),
      ),
    );
    put(
      memory.store,
      otherWorkspace,
      state(
        documentOf(paragraph("p-1", [linked("target", "folio-page://target")])),
      ),
    );
    put(
      memory.store,
      otherOrg,
      state(
        documentOf(paragraph("p-1", [linked("target", "folio-page://target")])),
      ),
    );
    const authorized: string[] = [];
    const projection = new SharedProjection(memory.store, (value) => {
      authorized.push(scopeKey(value));
    });

    const links = projection.backlinks(target);
    expect(links.map((link) => [scopeKey(link.scope), link.blockId])).toEqual([
      [scopeKey(sourceOne), "p-1"],
      [scopeKey(sourceTwo), "q-1"],
    ]);
    expect(links[0].cut).toEqual(cut);
    expect(links.every((link) => link.cut === links[0].cut)).toBe(true);
    expect(authorized).toContain(scopeKey(target));
    expect(authorized).toContain(scopeKey(sourceOne));
    expect(authorized).toContain(scopeKey(sourceTwo));
    expect(authorized).not.toContain(scopeKey(otherWorkspace));
    expect(authorized).not.toContain(scopeKey(otherOrg));
  });

  it("keeps strict validation for invalid rich-link attributes", () => {
    const memory = memoryStore();
    setHead(memory.store, cut);
    const target = scope("org-1", "ws-1", "target", "inc-1");
    const source = scope("org-1", "ws-1", "source", "inc-1");
    put(
      memory.store,
      source,
      state(
        documentOf(
          paragraph("p-1", [
            text("bad", [
              {
                type: "link",
                attrs: { href: "folio-page://target", onClick: "steal()" },
              },
            ]),
          ]),
        ),
      ),
    );
    const projection = new SharedProjection(memory.store, () => {});
    expect(() => projection.backlinks(target)).toThrow(CollaborationError);
    expect(() => projection.exportDocument(source)).toThrow(CollaborationError);
  });

  it("fails closed on corrupt stored JSON without rewriting the original row", () => {
    const memory = memoryStore();
    setHead(memory.store, cut);
    const target = scope("org-1", "ws-1", "doc-a", "inc-1");
    const raw = '{"document":';
    memory.rawInsert("documents", scopeKey(target), raw);
    const projection = new SharedProjection(memory.store, () => {});

    expect(() => projection.search("org-1", "ws-1", "")).toThrow(
      CollaborationError,
    );
    expect(() => projection.rebuild("org-1", "ws-1")).toThrow(
      CollaborationError,
    );
    expect(() => projection.exportDocument(target)).toThrow(CollaborationError);
    expect(memory.rawGet("documents", scopeKey(target))).toBe(raw);
  });

  it("rejects an unknown stored document instead of substituting a coercible state", () => {
    const memory = memoryStore();
    setHead(memory.store, cut);
    const target = scope("org-1", "ws-1", "doc-a", "inc-1");
    put(memory.store, target, {
      document: { type: "doc", content: [{ type: "unknownBlock" }] },
      tables: [],
      tombstones: [],
    });
    const projection = new SharedProjection(memory.store, () => {});
    expect(() => projection.search("org-1", "ws-1", "")).toThrow(
      CollaborationError,
    );
    expect(() => projection.exportDocument(target)).toThrow(CollaborationError);
  });

  it("rejects malformed scope keys and corrupt table/tombstone metadata", () => {
    const memory = memoryStore();
    setHead(memory.store, cut);
    memory.rawInsert(
      "documents",
      "org:ws:doc",
      canonical(state(documentOf(paragraph("p-1", [text("x")])))),
    );
    expect(() =>
      new SharedProjection(memory.store, () => {}).search("org", "ws", ""),
    ).toThrow(CollaborationError);

    const clean = memoryStore();
    setHead(clean.store, cut);
    const target = scope("org", "ws");
    put(clean.store, target, {
      document: documentOf(paragraph("p-1", [text("x")])),
      tables: [{ tableId: "t-1", rowIds: ["r-1"], columnIds: [] }],
      tombstones: ["p-1", "p-1"],
    });
    expect(() =>
      new SharedProjection(clean.store, () => {}).exportDocument(target),
    ).toThrow(CollaborationError);
  });

  it("reports search and rebuild counts at one consistent cut", () => {
    const memory = memoryStore();
    const head: Cut = { epoch: "epoch-2", seq: 19, hash: "b".repeat(64) };
    setHead(memory.store, head);
    const scopes = [
      scope("org-1", "ws-1", "doc-a", "inc-1"),
      scope("org-1", "ws-1", "doc-b", "inc-1"),
      scope("org-1", "ws-1", "doc-c", "inc-1"),
      scope("org-1", "ws-2", "doc-d", "inc-1"),
    ];
    for (const target of scopes) {
      put(
        memory.store,
        target,
        state(documentOf(paragraph("p-1", [text("shared match")]))),
      );
    }
    const projection = new SharedProjection(memory.store, () => {});
    const results = projection.search("org-1", "ws-1", "match");
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.cut === results[0].cut)).toBe(true);
    expect(results[0].cut).toEqual(head);
    expect(projection.rebuild("org-1", "ws-1")).toEqual({
      indexed: 3,
      cut: head,
    });
  });
});
