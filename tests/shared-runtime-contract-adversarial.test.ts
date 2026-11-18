import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Doc } from "../src/shared/types";
import { validDocument } from "../src/shared/validation";
import {
  CollaborationError,
  type Attempt,
  type Cut,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  locate,
  nodeText,
  initialState,
  materializedState,
} from "../src/collaboration/runtime/document";
import { applyText } from "../src/collaboration/runtime/text-intent";
import {
  parseAttempt,
  parseCanonicalWire,
  parseCut,
  parseScope,
} from "../src/collaboration/runtime/wire";
import { SharedDraftStore } from "../src/collaboration/draft-store";
import { Store } from "../src/persistence/store";
import { inspectWorkspaceSnapshot } from "../src/persistence/full-backup-verify";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    return (error as CollaborationError).code;
  }
  throw new Error("expected the operation to be refused");
}

function paragraphDoc(text: string): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "p1" },
        content: [{ type: "text", text }],
      },
    ],
  };
}

const scope: Scope = {
  orgId: "org",
  workspaceId: "ws",
  documentId: "doc",
  incarnationId: "inc",
};
const cut: Cut = { epoch: "epoch", seq: 0, hash: "a".repeat(64) };
const legalAttempt: Attempt = {
  v: 1,
  attemptId: "attempt-1",
  intent: {
    v: 1,
    intentId: "intent-1",
    writerId: "writer-1",
    scope,
    base: cut,
    command: {
      kind: "text",
      blockId: "p1",
      from: 0,
      to: 0,
      text: "x",
      before: "",
    },
  },
  base: cut,
};

describe("canonical JSON", () => {
  it("sorts keys, keeps unknown object attributes, and is deterministic", () => {
    const value = {
      z: 1,
      a: { inner: true, unknownAttr: "kept" },
      list: [3, 2, 1],
      nullProto: Object.assign(Object.create(null) as Record<string, unknown>, {
        b: 2,
        a: 1,
      }),
    };
    expect(canonical(value)).toBe(
      '{"a":{"inner":true,"unknownAttr":"kept"},"list":[3,2,1],"nullProto":{"a":1,"b":2},"z":1}',
    );
    expect(canonical(value)).toBe(canonical(value));
  });

  it("accepts finite safe integers and non-integer numbers", () => {
    expect(canonical({ n: 0, max: Number.MAX_SAFE_INTEGER, f: 1.5 })).toBe(
      '{"f":1.5,"max":9007199254740991,"n":0}',
    );
  });

  it("refuses unsafe, non-finite, negative zero and bigint numbers", () => {
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      -0,
    ])
      expect(codeOf(() => canonical(value))).toBe("UNSAFE_NUMBER");
    expect(codeOf(() => canonical(1n))).toBe("INVALID_JSON");
  });

  it("refuses lone surrogates in values and keys but keeps valid pairs", () => {
    expect(canonical("a\u{1F600}b")).toBe(JSON.stringify("a\u{1F600}b"));
    expect(codeOf(() => canonical("a\uD800b"))).toBe("UNICODE");
    expect(codeOf(() => canonical("a\uDC00b"))).toBe("UNICODE");
    expect(codeOf(() => canonical({ "\uD800": 1 }))).toBe("INVALID_ACCESSOR");
  });

  it("refuses accessors, hidden properties, symbols and exotic objects", () => {
    const withGetter = Object.defineProperty({ a: 1 }, "b", {
      enumerable: true,
      get: () => 2,
    });
    expect(codeOf(() => canonical(withGetter))).toBe("INVALID_ACCESSOR");
    const withHidden = Object.defineProperty({ a: 1 }, "hidden", {
      enumerable: false,
      value: 2,
    });
    expect(codeOf(() => canonical(withHidden))).toBe("INVALID_OBJECT");
    const withSymbol = { a: 1 } as Record<PropertyKey, unknown>;
    withSymbol[Symbol("s")] = 2;
    expect(codeOf(() => canonical(withSymbol))).toBe("INVALID_JSON");
    expect(codeOf(() => canonical(new Date(0)))).toBe("INVALID_OBJECT");
  });

  it("refuses sparse arrays and arrays with extra properties", () => {
    const sparse = new Array<unknown>(3);
    sparse[0] = 1;
    sparse[2] = 3;
    expect(codeOf(() => canonical(sparse))).toBe("INVALID_ARRAY");
    const extra = [1] as unknown[] & { extra?: number };
    extra.extra = 2;
    expect(codeOf(() => canonical(extra))).toBe("INVALID_ARRAY");
  });

  it("refuses cycles and depth/size limits but permits a shared acyclic value", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(codeOf(() => canonical(cyclic))).toBe("INVALID_JSON");
    const shared = { x: 1 };
    expect(canonical({ a: shared, b: shared })).toBe(
      '{"a":{"x":1},"b":{"x":1}}',
    );
    let deep: unknown = "x";
    for (let i = 0; i < 102; i++) deep = [deep];
    expect(codeOf(() => canonical(deep))).toBe("JSON_LIMIT");
    expect(codeOf(() => canonical({ a: "xxxxxxxx" }, 5))).toBe("JSON_LIMIT");
  });
});

describe("canonical wire parsing", () => {
  it("accepts exactly canonical JSON and returns the parsed value", () => {
    const value = { b: [true, null, "é"], a: 1 };
    const raw = canonical(value);
    expect(parseCanonicalWire(raw)).toEqual(value);
  });

  it("refuses whitespace, key order and escape spelling that are not canonical", () => {
    expect(codeOf(() => parseCanonicalWire('{ "a": 1 }'))).toBe(
      "NON_CANONICAL_WIRE",
    );
    expect(codeOf(() => parseCanonicalWire('{"b":1,"a":2}'))).toBe(
      "NON_CANONICAL_WIRE",
    );
    expect(codeOf(() => parseCanonicalWire('"\\u0061"'))).toBe(
      "NON_CANONICAL_WIRE",
    );
    expect(codeOf(() => parseCanonicalWire("1.0"))).toBe("NON_CANONICAL_WIRE");
    expect(codeOf(() => parseCanonicalWire("1e3"))).toBe("NON_CANONICAL_WIRE");
  });

  it("refuses duplicate keys even when their values agree", () => {
    expect(codeOf(() => parseCanonicalWire('{"a":1,"a":2}'))).toBe(
      "NON_CANONICAL_WIRE",
    );
    expect(codeOf(() => parseCanonicalWire('{"a":1,"a":1}'))).toBe(
      "NON_CANONICAL_WIRE",
    );
  });

  it("refuses unsafe number lexemes and lone surrogate escapes", () => {
    expect(
      ["UNSAFE_NUMBER", "NON_CANONICAL_WIRE"].includes(
        codeOf(() => parseCanonicalWire('{"a":9007199254740993}')),
      ),
    ).toBe(true);
    expect(codeOf(() => parseCanonicalWire("-0"))).toBe("UNSAFE_NUMBER");
    expect(codeOf(() => parseCanonicalWire('"\\ud800"'))).toBe("UNICODE");
  });

  it("refuses malformed input, non-strings and oversized wire values", () => {
    expect(() => parseCanonicalWire("{")).toThrow(SyntaxError);
    expect(codeOf(() => parseCanonicalWire(1 as unknown as string))).toBe(
      "WIRE_LIMIT",
    );
    expect(codeOf(() => parseCanonicalWire('"abcdef"', 4))).toBe("WIRE_LIMIT");
    expect(() => parseCanonicalWire('"x"', 0)).toThrow(CollaborationError);
  });
});

describe("wire schemas", () => {
  it("accepts a legal attempt, scope and cut", () => {
    expect(parseAttempt(legalAttempt)).toEqual(legalAttempt);
    expect(parseScope(scope)).toEqual(scope);
    expect(parseCut(cut)).toEqual(cut);
  });

  it("refuses unknown fields at every strict wire level", () => {
    expect(codeOf(() => parseAttempt({ ...legalAttempt, extra: true }))).toBe(
      "INVALID_ATTEMPT",
    );
    expect(
      codeOf(() =>
        parseAttempt({
          ...legalAttempt,
          intent: { ...legalAttempt.intent, extra: true },
        }),
      ),
    ).toBe("INVALID_ATTEMPT");
    expect(
      codeOf(() =>
        parseAttempt({
          ...legalAttempt,
          intent: {
            ...legalAttempt.intent,
            command: { ...legalAttempt.intent.command, extra: true },
          },
        }),
      ),
    ).toBe("INVALID_ATTEMPT");
    expect(() => parseScope({ ...scope, extra: true })).toThrow();
    expect(() => parseCut({ ...cut, extra: true })).toThrow();
  });

  it("refuses invalid identifiers, versions, counters and digests", () => {
    expect(codeOf(() => parseAttempt({ ...legalAttempt, v: 2 }))).toBe(
      "INVALID_ATTEMPT",
    );
    expect(
      codeOf(() => parseAttempt({ ...legalAttempt, attemptId: "bad.id" })),
    ).toBe("INVALID_ATTEMPT");
    expect(
      codeOf(() =>
        parseAttempt({
          ...legalAttempt,
          intent: {
            ...legalAttempt.intent,
            command: {
              ...legalAttempt.intent.command,
              blockId: "",
            },
          },
        }),
      ),
    ).toBe("INVALID_ATTEMPT");
    expect(
      codeOf(() =>
        parseAttempt({ ...legalAttempt, base: { ...cut, seq: -1 } }),
      ),
    ).toBe("INVALID_ATTEMPT");
    expect(
      codeOf(() =>
        parseAttempt({
          ...legalAttempt,
          base: { ...cut, hash: "A".repeat(64) },
        }),
      ),
    ).toBe("INVALID_ATTEMPT");
    expect(() => parseCut({ ...cut, seq: 2 ** 53 })).toThrow();
    expect(() => parseCut({ ...cut, seq: -1 })).toThrow();
  });

  it("applies canonical safety before schema validation", () => {
    const surrogate = {
      ...legalAttempt,
      intent: {
        ...legalAttempt.intent,
        command: {
          ...legalAttempt.intent.command,
          before: "\uD800",
        },
      },
    };
    expect(codeOf(() => parseAttempt(surrogate))).toBe("UNICODE");
    const unsafePayload = {
      ...legalAttempt,
      intent: {
        ...legalAttempt.intent,
        command: {
          kind: "resource",
          action: "file.write",
          payload: { offset: 2 ** 53 },
        },
      },
    };
    expect(codeOf(() => parseAttempt(unsafePayload))).toBe("UNSAFE_NUMBER");
    const getterPayload = {
      ...legalAttempt,
      intent: {
        ...legalAttempt.intent,
        command: {
          kind: "resource",
          action: "file.write",
          payload: Object.defineProperty({}, "value", {
            enumerable: true,
            get: () => 1,
          }),
        },
      },
    };
    expect(codeOf(() => parseAttempt(getterPayload))).toBe("INVALID_ACCESSOR");
  });
});

describe("document state", () => {
  it("creates a lossless initial state without mutating the caller document", () => {
    const raw = paragraphDoc("hello");
    const before = structuredClone(raw);
    const state = initialState(raw);
    expect(state.tables).toEqual([]);
    expect(state.tombstones).toEqual([]);
    expect(state.document.schemaVersion).toBe(1);
    expect(nodeText(state.document)).toBe("hello");
    expect(raw).toEqual(before);
  });

  it("preserves authored marks and heading attributes without normalizing raw input", () => {
    const raw: Doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { id: "h1", level: 2 },
          content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }],
        },
        {
          type: "paragraph",
          attrs: { id: "p1" },
          content: [
            { type: "text", text: "a", marks: [{ type: "bold" }] },
            { type: "text", text: "b" },
          ],
        },
      ],
    };
    const state = initialState(raw);
    expect(state.document.content?.[0].attrs).toMatchObject({
      id: "h1",
      level: 2,
    });
    expect(state.document.content?.[0].content?.[0].marks).toEqual([
      { type: "bold" },
    ]);
    const paragraph = state.document.content?.[1];
    expect(paragraph?.content).toHaveLength(2);
    expect(paragraph?.content?.map((node) => node.text)).toEqual(["a", "b"]);
  });

  it("refuses raw unknown attributes and retains the caller input", () => {
    const raw = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1", unknown: "x" },
          content: [],
        },
      ],
    } as Doc;
    const before = structuredClone(raw);
    const code = codeOf(() => initialState(raw));
    expect(code.startsWith("UNSUPPORTED_DOCUMENT")).toBe(true);
    expect(raw).toEqual(before);
  });

  it("refuses unsafe integers and lone surrogates before lossless projection", () => {
    const unsafe: Doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { id: "h1", level: 2 ** 53 },
          content: [{ type: "text", text: "x" }],
        },
      ],
    };
    expect(codeOf(() => initialState(unsafe))).toBe("UNSAFE_NUMBER");
    const surrogate = paragraphDoc("x\uD800");
    expect(codeOf(() => initialState(surrogate))).toBe("UNICODE");
  });

  it("reports duplicate and missing ids without guessing a target", () => {
    const duplicate: Doc = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { id: "same" }, content: [] },
        { type: "paragraph", attrs: { id: "same" }, content: [] },
      ],
    };
    expect(
      codeOf(() => initialState(duplicate)).startsWith("UNSUPPORTED_DOCUMENT"),
    ).toBe(true);
    expect(codeOf(() => locate(duplicate, "same"))).toBe("DUPLICATE_ID");
    expect(codeOf(() => locate(paragraphDoc("x"), "missing"))).toBe(
      "NODE_MISSING",
    );
    const found = locate(paragraphDoc("x"), "p1");
    expect(found.index).toBe(0);
    expect(found.ancestors).toEqual([]);
  });

  it("lets internal engine output materialize adjacent text runs", () => {
    const state = initialState(paragraphDoc("ab"));
    const result = applyText(
      state,
      {
        kind: "text",
        blockId: "p1",
        from: 1,
        to: 1,
        text: "X",
        before: "ab",
      },
      [],
    );
    const block = result.state.document.content?.[0];
    expect(block && nodeText(block)).toBe("aXb");
    expect(validDocument(result.state.document)).toBe(true);
    expect(result.appliedText).toEqual({
      kind: "text",
      blockId: "p1",
      from: 1,
      to: 1,
      text: "X",
    });
    expect(nodeText(state.document)).toBe("ab");
  });

  it("refuses invalid internal transforms without mutating the input state", () => {
    const state = initialState(paragraphDoc("ab"));
    const before = structuredClone(state);
    expect(
      codeOf(() =>
        applyText(
          state,
          {
            kind: "text",
            blockId: "p1",
            from: 1,
            to: 1,
            text: "X",
            before: "zz",
          },
          [],
        ),
      ),
    ).toBe("TEXT_BASE_MISMATCH");
    expect(
      codeOf(() =>
        applyText(
          state,
          {
            kind: "text",
            blockId: "p1",
            from: 1,
            to: 0,
            text: "X",
            before: "ab",
          },
          [],
        ),
      ),
    ).toBe("TEXT_RANGE");
    expect(
      codeOf(() =>
        applyText(
          state,
          {
            kind: "text",
            blockId: "missing",
            from: 0,
            to: 0,
            text: "X",
            before: "",
          },
          [],
        ),
      ),
    ).toBe("NODE_MISSING");
    const emoji = initialState(paragraphDoc("\u{1F600}"));
    expect(
      codeOf(() =>
        applyText(
          emoji,
          {
            kind: "text",
            blockId: "p1",
            from: 1,
            to: 1,
            text: "X",
            before: "\u{1F600}",
          },
          [],
        ),
      ),
    ).toBe("UNICODE_SPLIT");
    expect(state).toEqual(before);
  });

  it("materializedState refuses lossy raw attributes instead of repairing them", () => {
    const raw = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p1", unknown: "x" },
          content: [],
        },
      ],
    } as Doc;
    expect(
      codeOf(() =>
        materializedState({ document: raw, tables: [], tombstones: [] }),
      ),
    ).toBe("UNSUPPORTED_DOCUMENT");
  });
});

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "folio-r06-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const SHARED_RUNTIME_APPLICATION_ID = 0x464c5450;
const SHARED_DRAFT_APPLICATION_ID = 0x464c4452;

function createSqliteFile(
  path: string,
  applicationId: number,
  userVersion: number,
  sql = "CREATE TABLE runtime_log(seq INTEGER PRIMARY KEY)",
): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(
      `PRAGMA application_id=${applicationId}; PRAGMA user_version=${userVersion}; ${sql}`,
    );
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("private store isolation", () => {
  it("opens a fresh private Store and records its private schema version", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "workspace.sqlite");
    const store = new Store(path);
    store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA application_id").get()?.application_id).toBe(0);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "pages",
          "settings",
          "versions",
          "save_receipts",
          "assets",
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("refuses a schema-1003 shared runtime file without changing its bytes", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "workspace.sqlite");
    createSqliteFile(path, SHARED_RUNTIME_APPLICATION_ID, 1003);
    const before = fileHash(path);
    expect(() => new Store(path)).toThrow(/newer Folio version/);
    expect(() => new Store(path, { readOnly: true })).toThrow(
      /newer Folio version/,
    );
    expect(fileHash(path)).toBe(before);
    for (const suffix of ["-wal", "-shm", "-journal"])
      expect(existsSync(path + suffix)).toBe(false);
  });

  it("refuses a shared draft application id as a private workspace", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "workspace.sqlite");
    createSqliteFile(path, SHARED_DRAFT_APPLICATION_ID, 1001);
    const before = fileHash(path);
    expect(() => new Store(path)).toThrow(/newer Folio version/);
    expect(fileHash(path)).toBe(before);
  });

  it("keeps the shared draft store out of schema-1003 runtime files", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "shared-drafts.sqlite");
    createSqliteFile(path, SHARED_RUNTIME_APPLICATION_ID, 1003);
    const before = fileHash(path);
    expect(() => new SharedDraftStore(directory)).toThrow(
      /NOT_SHARED_DRAFT_FORMAT/,
    );
    expect(fileHash(path)).toBe(before);
  });

  it("keeps the shared draft store out of a private Store file", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "shared-drafts.sqlite");
    const store = new Store(path);
    store.close();
    const before = fileHash(path);
    expect(() => new SharedDraftStore(directory)).toThrow(
      /NOT_SHARED_DRAFT_FORMAT/,
    );
    expect(fileHash(path)).toBe(before);
  });

  it("writes and re-reads a legal shared draft in its own quarantine file", () => {
    const directory = temporaryDirectory();
    const drafts = new SharedDraftStore(directory);
    try {
      const raw = JSON.stringify(paragraphDoc("draft"));
      const envelope = {
        session: {
          scope: {
            workspaceId: "ws",
            documentId: "doc",
            incarnationId: "inc",
          },
          sessionId: "session",
          actorId: "actor",
          deviceId: "device",
          epoch: "epoch",
          generation: 0,
        },
        operationId: "operation-1",
        raw,
      };
      const staged = drafts.stage(envelope);
      expect(staged.state).toBe("STAGED");
      expect(staged.validationCode).toBe("SUPPORTED");
      expect(drafts.stage(envelope)).toEqual(staged);
      drafts.markUnknown("operation-1");
      expect(drafts.get("operation-1")?.state).toBe("UNKNOWN");
    } finally {
      drafts.close();
    }
  });

  it("refuses a schema-1003 shared runtime file in full workspace inspection", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "workspace.sqlite");
    createSqliteFile(path, SHARED_RUNTIME_APPLICATION_ID, 1003);
    const before = fileHash(path);
    expect(() => inspectWorkspaceSnapshot(directory)).toThrow(
      /Unsupported workspace database version/,
    );
    expect(fileHash(path)).toBe(before);
    for (const suffix of ["-wal", "-shm", "-journal"])
      expect(existsSync(path + suffix)).toBe(false);
  });

  it("inspects a complete private workspace snapshot", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "workspace.sqlite");
    const store = new Store(path);
    store.close();
    const inspection = inspectWorkspaceSnapshot(directory);
    expect(inspection.storeVersion).toBe(3);
    expect(inspection.inventory.pages).toBe(0);
    expect(inspection.assets).toEqual([]);
  });
});
