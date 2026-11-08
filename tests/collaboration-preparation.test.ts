import { symlinkSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SharedDraftStore } from "../src/collaboration/draft-store";
import { SharedEditorPort } from "../src/collaboration/editor-port";
import { inspectSharedDocument } from "../src/collaboration/document-input";
import { parseSharedInput } from "../src/collaboration/raw-json";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { Store } from "../src/persistence/store";
import { SharedPreparationService } from "../src/main/shared-preparation";
import type { SharedSession } from "../src/collaboration/contract";
const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "folio-shared-prep-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const session: SharedSession = {
  scope: {
    workspaceId: "shared",
    documentId: "same-page",
    incarnationId: "life1",
  },
  sessionId: "s1",
  actorId: "u1",
  deviceId: "d1",
  epoch: "e1",
  generation: 1,
};
const doc = {
  type: "doc",
  schemaVersion: 1,
  content: [
    {
      type: "paragraph",
      attrs: { id: "p1" },
      content: [{ type: "text", text: "日本語😀" }],
    },
  ],
};
const raw = JSON.stringify(doc);
const envelope = (operationId = "op1", input = raw) => ({
  session,
  operationId,
  raw: input,
});

describe("shared raw input before ProseMirror coercion", () => {
  it.each([
    '{"n":9007199254740993}',
    '{"n":1.5}',
    '{"n":1e30}',
    '{"n":-0}',
    '{"a":1,"\\u0061":2}',
    '{"text":"\\ud800"}',
    '{"text":"\\udc00"}',
  ])("preserves refused input %s", (input) => {
    const result = parseSharedInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.raw).toBe(input);
  });
  it.each([
    "null",
    "[true,false,0,-1,9007199254740991]",
    '{"s":"😀日本語\\\""}',
  ])("accepts exact supported JSON %s", (input) =>
    expect(parseSharedInput(input).ok).toBe(true),
  );
  it("bounds bytes and recursion without parsing rounded values", () => {
    expect(parseSharedInput('"' + "あ".repeat(700000) + '"').ok).toBe(false);
    expect(parseSharedInput("[".repeat(102) + "0" + "]".repeat(102)).ok).toBe(
      false,
    );
  });
  it("refuses unknown schema and missing/duplicate IDs retaining raw", () => {
    const cases = [
      { ...doc, alien: 42 },
      { ...doc, content: [{ type: "paragraph" }] },
      { ...doc, content: [doc.content[0], doc.content[0]] },
    ];
    for (const value of cases) {
      const input = JSON.stringify(value);
      const r = inspectSharedDocument(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.raw).toBe(input);
    }
  });
  it("rejects prototype-named attributes before PM can silently drop them", () => {
    for (const key of ["constructor", "toString", "__proto__"]) {
      const input = JSON.stringify({
        ...doc,
        content: [
          { ...doc.content[0], attrs: { id: "p1", [key]: "authored" } },
        ],
      });
      expect(inspectSharedDocument(input).ok).toBe(false);
    }
  });
  it("normalizes defaults while retaining authored text, mark and id", () => {
    const result = inspectSharedDocument(raw);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.document.content?.[0]).toMatchObject(doc.content[0]);
  });
});

describe("isolated shared raw draft durability", () => {
  it("reopens exact unsupported and supported raw; repeated identity is idempotent", () => {
    const d = dir();
    let store = new SharedDraftStore(d);
    const input = '{ "future":9007199254740993 }';
    expect(store.stage(envelope("unsupported", input)).validationCode).toBe(
      "UNSAFE_NUMBER",
    );
    store.stage(envelope());
    store.markUnknown("op1");
    store.close();
    store = new SharedDraftStore(d);
    try {
      expect(store.get("unsupported")?.envelope.raw).toBe(input);
      expect(store.stage(envelope()).state).toBe("UNKNOWN");
      expect(() => store.stage(envelope("op1", raw + " "))).toThrow(
        "DRAFT_ID_REUSE",
      );
      expect(store.get("op1")?.envelope.raw).toBe(raw);
    } finally {
      store.close();
    }
  });
  it("binds all session/lifecycle fields without silently rewriting retries", () => {
    const store = new SharedDraftStore(dir());
    try {
      store.stage(envelope());
      for (const changed of [
        { ...session, epoch: "e2" },
        { ...session, generation: 2 },
        { ...session, actorId: "u2" },
        { ...session, scope: { ...session.scope, incarnationId: "life2" } },
      ])
        expect(() => store.stage({ ...envelope(), session: changed })).toThrow(
          "DRAFT_ID_REUSE",
        );
    } finally {
      store.close();
    }
  });
  it("actual private Store refuses shared file before writes", () => {
    const store = new SharedDraftStore(dir());
    store.stage(envelope());
    const path = store.path;
    store.close();
    const before = readFileSync(path);
    expect(() => new Store(path)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
  it("Lv4 checkpoint builder refuses the shared draft database", () => {
    const store = new SharedDraftStore(dir());
    store.stage(envelope());
    const db = new DatabaseSync(store.path, { readOnly: true });
    try {
      expect(() => buildWorkspaceCheckpoint(db)).toThrow();
    } finally {
      db.close();
      store.close();
    }
  });
  it("shared opener refuses renamed private DB without writes", () => {
    const privateDir = dir(),
      sharedDir = dir();
    const path = join(privateDir, "folio.sqlite");
    const privateStore = new Store(path);
    privateStore.close();
    const target = join(sharedDir, "shared-drafts.sqlite");
    copyFileSync(path, target);
    const before = readFileSync(target);
    expect(() => new SharedDraftStore(sharedDir)).toThrow(
      "NOT_SHARED_DRAFT_FORMAT",
    );
    expect(readFileSync(target)).toEqual(before);
  });
  it.each([
    "UPDATE drafts SET envelope='{}'",
    "UPDATE drafts SET fingerprint='wrong'",
    "UPDATE drafts SET operation_id='other'",
    "DROP TABLE drafts",
  ])("fails closed on persistent corruption %s", (sql) => {
    const d = dir();
    const store = new SharedDraftStore(d);
    store.stage(envelope());
    const path = store.path;
    store.close();
    const corrupt = new DatabaseSync(path);
    corrupt.exec(sql);
    corrupt.close();
    const before = readFileSync(path);
    expect(() => new SharedDraftStore(d)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
});

describe("headless shared editor projection port", () => {
  it("suppresses projection echo and fences duplicate/stale session and lifecycle", () => {
    const staged: string[] = [];
    let displays = 0;
    let port: SharedEditorPort;
    port = new SharedEditorPort(
      session,
      (input) => staged.push(input),
      () => {
        displays++;
        expect(port.local(raw, "LOCAL_USER")).toBe("REMOTE_ORIGIN");
      },
      true,
    );
    expect(port.local(raw, "LOCAL_USER")).toBe("STAGED");
    expect(port.remote({ session, sequence: 1, raw })).toBe("APPLIED");
    expect(port.remote({ session, sequence: 1, raw })).toBe("STALE_SEQUENCE");
    for (const changed of [
      { ...session, sessionId: "s2" },
      { ...session, generation: 2 },
      { ...session, epoch: "e2" },
      { ...session, scope: { ...session.scope, incarnationId: "life2" } },
    ])
      expect(port.remote({ session: changed, sequence: 2, raw })).toBe(
        "STALE_SESSION",
      );
    expect(displays).toBe(1);
    expect(staged).toEqual([raw]);
    port.close();
    expect(port.local(raw, "LOCAL_USER")).toBe("CLOSED");
    expect(port.remote({ session, sequence: 2, raw })).toBe("CLOSED");
  });
  it("defaults read-only; unsupported projection cannot replace visible content", () => {
    let n = 0;
    const port = new SharedEditorPort(
      session,
      () => {
        throw Error("unexpected staging");
      },
      () => n++,
    );
    expect(port.local(raw, "LOCAL_USER")).toBe("READ_ONLY");
    expect(port.remote({ session, sequence: 1, raw: '{"unknown":1}' })).toBe(
      "UNSUPPORTED",
    );
    expect(n).toBe(0);
    expect(port.remote({ session, sequence: 1, raw })).toBe("APPLIED");
  });
  it("display failure resets remote origin and keeps sequence retryable", () => {
    let fail = true;
    const staged: string[] = [];
    const port = new SharedEditorPort(
      session,
      (x) => staged.push(x),
      () => {
        if (fail) throw Error("display");
      },
      true,
    );
    expect(() => port.remote({ session, sequence: 2, raw })).toThrow("display");
    expect(port.local(raw, "LOCAL_USER")).toBe("STAGED");
    fail = false;
    expect(port.remote({ session, sequence: 2, raw })).toBe("APPLIED");
  });
});

describe("main preparation boundary is explicit and identity is main-owned", () => {
  it("rejects sender identity fields, read-only staging, stale/revoked bindings and cross-scope reads", () => {
    const store = new SharedDraftStore(dir());
    const service = new SharedPreparationService(store);
    try {
      const readOnly = service.bindTrusted(session);
      const request = { type: "shared-draft:stage", operationId: "op1", raw };
      expect(() => service.request(readOnly, request)).toThrow(
        "SHARED_READ_ONLY",
      );
      const binding = service.bindTrusted(session, true);
      for (const fields of [
        { actorId: "attacker" },
        { session },
        { role: "owner" },
        { scope: session.scope },
      ])
        expect(() =>
          service.request(binding, { ...request, ...fields }),
        ).toThrow();
      const result = service.request(binding, request);
      expect(result.kind).toBe("LOCAL_DRAFT");
      expect(result.draft?.state).toBe("STAGED");
      const other = service.bindTrusted(
        { ...session, scope: { ...session.scope, workspaceId: "other" } },
        true,
      );
      expect(() =>
        service.request(other, {
          type: "shared-draft:read",
          operationId: "op1",
        }),
      ).toThrow("SHARED_DRAFT_SCOPE_MISMATCH");
      service.revoke(binding);
      expect(() => service.request(binding, request)).toThrow(
        "STALE_SHARED_BINDING",
      );
      service.close();
      expect(() =>
        service.request(readOnly, {
          type: "shared-draft:read",
          operationId: "op1",
        }),
      ).toThrow("STALE_SHARED_BINDING");
    } finally {
      service.close();
      store.close();
    }
  });
});

describe("independent review regressions", () => {
  it("recovers a heavily escaped 2M-character raw draft after reopening", () => {
    const d = dir();
    let store = new SharedDraftStore(d);
    const input = '"'.repeat(2_000_000);
    store.stage(envelope("escape", input));
    store.close();
    store = new SharedDraftStore(d);
    try {
      expect(store.get("escape")?.envelope.raw).toBe(input);
    } finally {
      store.close();
    }
  });
  it("rejects dangling main links, linked sidecars and orphan journals before creating a DB", () => {
    const d = dir(),
      target = join(dir(), "outside.sqlite");
    symlinkSync(target, join(d, "shared-drafts.sqlite"));
    expect(() => new SharedDraftStore(d)).toThrow("UNSAFE_SHARED_DRAFT_PATH");
    expect(existsSync(target)).toBe(false);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const root = dir(),
        victim = join(dir(), "keep");
      writeFileSync(victim, "keep");
      symlinkSync(victim, join(root, "shared-drafts.sqlite" + suffix));
      expect(() => new SharedDraftStore(root)).toThrow(
        "UNSAFE_SHARED_DRAFT_PATH",
      );
      expect(readFileSync(victim, "utf8")).toBe("keep");
      expect(existsSync(join(root, "shared-drafts.sqlite"))).toBe(false);
    }
    const root = dir();
    writeFileSync(join(root, "shared-drafts.sqlite-journal"), "orphan");
    expect(() => new SharedDraftStore(root)).toThrow(
      "ORPHAN_SHARED_DRAFT_SIDECAR",
    );
  });
  it("old-session raw can be read/listed after reconnect without rewriting the envelope", () => {
    const d = dir();
    let store = new SharedDraftStore(d);
    let service = new SharedPreparationService(store);
    const binding = service.bindTrusted(session, true);
    service.request(binding, {
      type: "shared-draft:stage",
      operationId: "op1",
      raw,
    });
    service.close();
    store.close();
    store = new SharedDraftStore(d);
    service = new SharedPreparationService(store);
    try {
      const reconnect = service.bindTrusted({
        ...session,
        epoch: "e2",
        sessionId: "s2",
        generation: 2,
      });
      const found = service.request(reconnect, {
        type: "shared-draft:read",
        operationId: "op1",
      });
      expect(found.kind).toBe("LOCAL_DRAFT");
      if (found.kind === "LOCAL_DRAFT")
        expect(found.draft.envelope.session).toEqual(session);
      const list = service.request(reconnect, { type: "shared-draft:list" });
      expect(list.kind).toBe("LOCAL_DRAFTS");
      if (list.kind === "LOCAL_DRAFTS")
        expect(list.drafts.map((x) => x.envelope.raw)).toEqual([raw]);
      for (const changed of [
        { ...session, actorId: "other" },
        { ...session, deviceId: "other" },
      ]) {
        const other = service.bindTrusted(changed);
        expect(() =>
          service.request(other, {
            type: "shared-draft:read",
            operationId: "op1",
          }),
        ).toThrow("SHARED_DRAFT_SCOPE_MISMATCH");
      }
      expect(() =>
        service.request(reconnect, {
          type: "shared-draft:read",
          operationId: "missing",
        }),
      ).toThrow("SHARED_DRAFT_NOT_FOUND");
      service.close();
      expect(() => service.bindTrusted(session, true)).toThrow(
        "SHARED_SERVICE_CLOSED",
      );
    } finally {
      service.close();
      store.close();
    }
  });
  it("propagates REMOTE origin through deferred display; rejects reentrant projection", async () => {
    const staged: string[] = [];
    let nested = "",
      deferred = "";
    let port: SharedEditorPort;
    port = new SharedEditorPort(
      session,
      (x) => staged.push(x),
      (_doc, origin) => {
        nested = port.remote({ session, sequence: 2, raw });
        queueMicrotask(() => {
          deferred = port.local(raw, origin);
        });
      },
      true,
    );
    expect(port.remote({ session, sequence: 1, raw })).toBe("APPLIED");
    await Promise.resolve();
    expect(nested).toBe("REENTRANT");
    expect(deferred).toBe("REMOTE_ORIGIN");
    expect(staged).toEqual([]);
    expect(port.remote({ session, sequence: 1, raw })).toBe("STALE_SEQUENCE");
    expect(port.local(raw, "LOCAL_USER")).toBe("STAGED");
  });
  it("keeps entire directory unchanged when an existing private store rejects shared format", () => {
    const d = dir(),
      store = new SharedDraftStore(d);
    store.stage(envelope());
    const path = store.path;
    store.close();
    const snapshot = () =>
      readdirSync(d)
        .sort()
        .map((name) => ({ name, bytes: readFileSync(join(d, name)) }));
    const before = snapshot();
    expect(() => new Store(path)).toThrow("newer Folio version");
    expect(snapshot()).toEqual(before);
  });
  it("retains a real authored mark and fills a heading's schema defaults", () => {
    const marked = {
      type: "doc",
      schemaVersion: 1,
      content: [
        {
          type: "heading",
          attrs: { id: "h1" },
          content: [{ type: "text", text: "hi", marks: [{ type: "bold" }] }],
        },
      ],
    };
    const inspected = inspectSharedDocument(JSON.stringify(marked));
    expect(inspected.ok).toBe(true);
    if (inspected.ok) {
      expect(inspected.document.content?.[0].attrs).toEqual({
        id: "h1",
        level: 1,
      });
      expect(inspected.document.content?.[0].content?.[0].marks).toEqual([
        { type: "bold" },
      ]);
    }
  });
});

it("accepts explicitly newer document metadata and semantically empty containers", () => {
  for (const value of [
    { ...doc, schemaVersion: 2 },
    {
      ...doc,
      content: [
        {
          ...doc.content[0],
          content: [{ type: "text", text: "x", marks: [], attrs: {} }],
        },
      ],
    },
    {
      ...doc,
      content: [{ type: "paragraph", attrs: { id: "p1" }, content: [] }],
    },
  ]) {
    const input = inspectSharedDocument(JSON.stringify(value));
    expect(input.ok).toBe(true);
    if (input.ok)
      expect(input.document.schemaVersion).toBe(value.schemaVersion);
  }
});

it("WAL-only foreign application id cannot pass the private writable preflight", () => {
  const directory = dir(),
    path = join(directory, "workspace.sqlite");
  const initial = new Store(path);
  initial.close();
  const writer = new DatabaseSync(path);
  writer.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA application_id=1179403346",
  );
  try {
    expect(readFileSync(path).readUInt32BE(68)).toBe(0);
    expect(writer.prepare("PRAGMA application_id").get()?.application_id).toBe(
      1179403346,
    );
    const wal = readFileSync(path + "-wal");
    const catalog = writer
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    let opening = false;
    expect(
      () =>
        new Store(path, {
          beforeOpen() {
            opening = true;
          },
        }),
    ).toThrow("Foreign application id");
    expect(opening).toBe(false);
    expect(readFileSync(path + "-wal")).toEqual(wal);
    expect(
      writer.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(catalog);
  } finally {
    writer.close();
  }
});
