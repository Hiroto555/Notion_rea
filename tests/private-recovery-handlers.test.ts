import {createHash} from "node:crypto";
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {Store} from "../src/persistence/store";
import {CrashRecoveryFile, crashRecoveryWorkspaceId} from "../src/persistence/crash-recovery-file";
import {createRecoveryCopy} from "../src/persistence/crash-recovery-copy";
import {retainStartupProtector} from "../src/persistence/startup-connection-owner";
import type {NativePrivateSqliteLease} from "../src/platform/private-persistence";
import {
  getCheckpointGenerationConflict,
  recordCheckpointGenerationConflict,
} from "../src/platform/private-mutation-diagnostic";
import {createPrivatePersistenceLifecycle} from "../src/main/private-persistence-lifecycle";
import {WorkspaceSyncGate} from "../src/main/workspace-sync-gate";
import {
  createPrivateRequestHandlers,
  type PrivateRequestContext,
} from "../src/main/private-request-handlers";
import {
  handlePrivateRecoveryRequest,
  isPrivateRecoveryRequest,
  type PrivateRecoveryDependencies,
} from "../src/main/private-recovery-handlers";
import {assertReadOnlyRequest} from "../src/main/read-only-workspace";
import {storageActionForRequest} from "../src/main/storage-write-policy";
import {requestSchema, type Page, type Request} from "../src/shared/types";
import {emptyCrashRecoverySnapshot, type CrashRecoveryRead} from "../src/shared/crash-recovery";
import {decodeRequestReplyV1} from "../src/shared/private-storage-failure";

/**
 * Node-only contract for the W06/D1 recovery-only split. It never imports the
 * real Main module or starts Electron/GUI. It couples:
 *  - a pure fake-DI check of the new synchronous helper,
 *  - the actual `createPrivateRequestHandlers` legacy/diagnostic entry feeding
 *    the helper through the same `withStorageAction` position as Main,
 *  - a disposable SQLite Store for copy dedupe/rollback and close counts,
 *  - a static source lock that reconstructs the accepted Main bytes by
 *    removing the new import and replacing the new block with the old lines.
 */

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) {try {store.close();} catch {}}
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {resolve = done;});
  return {promise, resolve};
};

const recoveryPage = (id: string): Page => ({
  id,
  parentId: null,
  title: "Recovered copy",
  icon: "",
  cover: "",
  position: 0,
  doc: {type: "doc", schemaVersion: 1, content: []},
  kind: "page",
  database: null,
  favorite: false,
  createdAt: 0,
  updatedAt: 0,
  revision: 1,
  deletedAt: null,
});

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-private-recovery-")));
  roots.push(root);
  const store = new Store(join(root, "workspace.sqlite"));
  stores.push(store);
  store.create(null, "page", "preserve");
  return {root, store};
}

const frame = {url: "https://folio.test/"};
const webContents = {mainFrame: frame};
let destroyed = false;
const requestWindow = {webContents, isDestroyed: () => destroyed};
type TestWindow = typeof requestWindow;
type RecoveryPorts = Pick<CrashRecoveryFile, "read" | "writeObserved">;

type HarnessOptions = {
  readOnly?: boolean;
  getRequestWindow?: () => TestWindow | undefined;
  getRendererGeneration?: () => number;
  getWorkspaceBinding?: () => object;
};

/** Wires the actual common handler to the new helper exactly where Main does:
 * inside `handle`, after the read-only gate, and wrapped once by
 * `context.withStorageAction`. */
function recoveryHarness(config: {
  store: Store;
  recovery: RecoveryPorts;
} & HarnessOptions) {
  destroyed = false;
  const state = {window: requestWindow, generation: 1, binding: {} as object};
  const event = {sender: requestWindow.webContents, senderFrame: frame};
  const lifecycle = createPrivatePersistenceLifecycle();
  const syncGate = new WorkspaceSyncGate();
  const calls = {read: 0, write: 0, copy: 0};
  const readOnly = config.readOnly ?? false;
  const dispatch = async (req: Request, context: PrivateRequestContext<TestWindow>) => {
    const handle = () => {
      if (readOnly) assertReadOnlyRequest(req);
      if (!isPrivateRecoveryRequest(req)) return "non-recovery";
      return handlePrivateRecoveryRequest(req, {
        readRecovery: () => {
          calls.read++;
          return context.readRecovery(config.recovery);
        },
        writeRecovery: (expectedGeneration, snapshot) => {
          calls.write++;
          return context.writeRecovery(config.recovery, expectedGeneration, snapshot);
        },
        copyRecovery: (recoveryId, input) => {
          calls.copy++;
          return createRecoveryCopy(config.store, recoveryId, input);
        },
      });
    };
    return context.withStorageAction(req, handle);
  };
  const handlers = createPrivateRequestHandlers<TestWindow>({
    lifecycle,
    syncGate,
    enterScope: (work) => work(),
    getRequestWindow: config.getRequestWindow ?? (() => state.window),
    getRendererGeneration: config.getRendererGeneration ?? (() => state.generation),
    getWorkspaceBinding: config.getWorkspaceBinding ?? (() => state.binding),
    trustedUrl: frame.url,
    dispatch,
  });
  return {state, event, lifecycle, syncGate, handlers, calls};
}

describe("pure private recovery dispatch", () => {
  it("recognizes only the three exact recovery tags and never touches deps for others", () => {
    const calls = {read: 0, write: 0, copy: 0};
    const empty: CrashRecoveryRead = {status: "empty", generation: 0};
    const deps: PrivateRecoveryDependencies = {
      readRecovery: () => {calls.read++; return empty;},
      writeRecovery: () => {calls.write++; return empty;},
      copyRecovery: () => {calls.copy++; return recoveryPage("copy");},
    };
    const recognized: Request[] = [
      requestSchema.parse({type: "recovery:read"}),
      requestSchema.parse({type: "recovery:write", expectedGeneration: 0, snapshot: emptyCrashRecoverySnapshot()}),
      requestSchema.parse({type: "recovery:copy", recoveryId: "copy-1", input: {title: "Copy", payload: {}}}),
    ];
    expect(recognized.map(isPrivateRecoveryRequest)).toEqual([true, true, true]);
    const ignored: Request[] = [
      requestSchema.parse({type: "recovery:list"}),
      requestSchema.parse({type: "startup:status"}),
      requestSchema.parse({type: "sync:run"}),
      {type: "unknown:recovery"} as unknown as Request,
    ];
    for (const req of ignored) expect(isPrivateRecoveryRequest(req)).toBe(false);
    expect(calls).toEqual({read: 0, write: 0, copy: 0});
  });

  it("forwards exact read/write/copy arguments to the matching dependency and returns its exact value", () => {
    const read: CrashRecoveryRead = {status: "ready", generation: 3};
    const write: CrashRecoveryRead = {status: "ready", generation: 4};
    const copied = recoveryPage("page-copy");
    const seen: unknown[] = [];
    const deps: PrivateRecoveryDependencies = {
      readRecovery: () => {seen.push(["read"]); return read;},
      writeRecovery: (expectedGeneration, snapshot) => {
        seen.push(["write", expectedGeneration, snapshot]);
        return write;
      },
      copyRecovery: (recoveryId, input) => {
        seen.push(["copy", recoveryId, input]);
        return copied;
      },
    };
    const readReq = requestSchema.parse({type: "recovery:read"});
    if (!isPrivateRecoveryRequest(readReq)) throw new Error("expected recovery:read");
    expect(handlePrivateRecoveryRequest(readReq, deps)).toBe(read);

    const writeReq = requestSchema.parse({
      type: "recovery:write",
      expectedGeneration: 2,
      snapshot: emptyCrashRecoverySnapshot(),
    });
    if (!isPrivateRecoveryRequest(writeReq)) throw new Error("expected recovery:write");
    expect(handlePrivateRecoveryRequest(writeReq, deps)).toBe(write);

    const input = {title: "Recovered", payload: {text: "keep"}};
    const copyReq = requestSchema.parse({type: "recovery:copy", recoveryId: "copy-id", input});
    if (!isPrivateRecoveryRequest(copyReq)) throw new Error("expected recovery:copy");
    const result = handlePrivateRecoveryRequest(copyReq, deps);
    expect(result).toBe(copied);
    expect((result as {then?: unknown}).then).toBeUndefined();

    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual(["read"]);
    expect(seen[1]).toEqual(["write", 2, emptyCrashRecoverySnapshot()]);
    const forwarded = seen[2] as ["copy", string, {title: string; payload: unknown}];
    expect(forwarded[0]).toBe("copy");
    expect(forwarded[1]).toBe("copy-id");
    expect(forwarded[2]).not.toBe(input);
    expect(forwarded[2]).toEqual(input);
  });
});

describe("actual createPrivateRequestHandlers -> private recovery helper", () => {
  it("serves legacy and diagnostic through the same helper entry with the exact ready value", async () => {
    const f = workspace();
    const ready: CrashRecoveryRead = {status: "ready", generation: 5, snapshot: emptyCrashRecoverySnapshot()};
    const recovery: RecoveryPorts = {
      read: () => ready,
      writeObserved: () => Object.freeze({terminal: "RETURNED" as const, value: ready}),
    };
    const h = recoveryHarness({store: f.store, recovery});
    expect(await h.handlers.legacy(h.event, {type: "recovery:read"})).toBe(ready);
    const reply = await h.handlers.diagnostic(h.event, {type: "recovery:read"});
    expect(reply).toMatchObject({ok: true, valueSlot: {present: true, value: {status: "ready", generation: 5}}});
    if (!reply.ok || !reply.valueSlot.present) throw new Error("expected ready recovery value");
    expect(reply.valueSlot.value).toBe(ready);
    const decoded = decodeRequestReplyV1(JSON.parse(JSON.stringify(reply)), "recovery:read");
    expect(decoded).toMatchObject({ok: true, valueSlot: {present: true}});
    expect(h.calls.read).toBe(2);
  });

  it("returns the real APPLIED write ACK through the same helper", async () => {
    const f = workspace();
    const file = new CrashRecoveryFile(join(f.root, "crash-recovery.json"), crashRecoveryWorkspaceId(f.store));
    file.write(0, emptyCrashRecoverySnapshot());
    const h = recoveryHarness({store: f.store, recovery: file});
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:write",
      expectedGeneration: 0,
      snapshot: emptyCrashRecoverySnapshot(),
    });
    expect(reply).toMatchObject({
      ok: true,
      valueSlot: {present: true, value: {status: "ready", generation: 1, snapshot: emptyCrashRecoverySnapshot()}},
    });
    expect(h.calls.write).toBe(1);
  });

  it.each(["sender", "frame", "url", "destroyed", "generation", "window", "binding"])(
    "rejects wrong %s before parse and leaves every recovery dependency at zero",
    async (variant) => {
      const f = workspace();
      const file = new CrashRecoveryFile(join(f.root, "crash-recovery.json"), crashRecoveryWorkspaceId(f.store));
      const otherWindow: TestWindow = {
        webContents: {mainFrame: {url: frame.url}},
        isDestroyed: () => false,
      };
      const options: HarnessOptions = {};
      if (variant === "window") options.getRequestWindow = () => otherWindow;
      if (variant === "generation") {
        let value = 1;
        options.getRendererGeneration = () => value++;
      }
      if (variant === "binding") options.getWorkspaceBinding = () => ({});
      const h = recoveryHarness({store: f.store, recovery: file, ...options});
      if (variant === "sender") h.event.sender = otherWindow.webContents;
      if (variant === "frame") h.event.senderFrame = otherWindow.webContents.mainFrame;
      if (variant === "url") h.event.senderFrame = {url: "https://untrusted.test/"};
      if (variant === "destroyed") destroyed = true;
      const parse = vi.spyOn(requestSchema, "parse");
      const reply = await h.handlers.diagnostic(h.event, {type: "recovery:read"});
      expect(reply).toMatchObject({
        ok: false,
        failure: {kind: "UNCLASSIFIED", family: "REQUEST", stage: "REQUEST", requestType: "UNRECOGNIZED"},
      });
      await expect(h.handlers.legacy(h.event, {type: "recovery:read"})).rejects.toThrow("Unauthorized IPC sender");
      expect(h.calls).toEqual({read: 0, write: 0, copy: 0});
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it("never consumes non-recovery requests into the recovery deps", async () => {
    const f = workspace();
    const file = new CrashRecoveryFile(join(f.root, "crash-recovery.json"), crashRecoveryWorkspaceId(f.store));
    const h = recoveryHarness({store: f.store, recovery: file});
    for (const request of [{type: "recovery:list"}, {type: "startup:status"}]) {
      expect(await h.handlers.legacy(h.event, request)).toBe("non-recovery");
    }
    expect(h.calls).toEqual({read: 0, write: 0, copy: 0});
  });

  it("keeps the read-only gate ahead of all three branches with deps at zero", async () => {
    const f = workspace();
    const file = new CrashRecoveryFile(join(f.root, "crash-recovery.json"), crashRecoveryWorkspaceId(f.store));
    const h = recoveryHarness({store: f.store, recovery: file, readOnly: true});
    const requests: Request[] = [
      {type: "recovery:read"},
      {type: "recovery:write", expectedGeneration: 0, snapshot: emptyCrashRecoverySnapshot()},
      {type: "recovery:copy", recoveryId: "read-only-copy", input: {title: "No", payload: {}}},
    ];
    for (const request of requests) {
      await expect(h.handlers.legacy(h.event, request)).rejects.toThrow("読み取り専用");
      const reply = await h.handlers.diagnostic(h.event, request);
      expect(reply).toMatchObject({
        ok: false,
        failure: {kind: "UNCLASSIFIED", family: "REQUEST", requestType: request.type},
      });
    }
    expect(h.calls).toEqual({read: 0, write: 0, copy: 0});
    expect(storageActionForRequest("recovery:read")).toBe("read");
    expect(storageActionForRequest("recovery:write")).toBe("checkpoint");
    expect(storageActionForRequest("recovery:copy")).toBe("write");
  });

  it("re-authorizes after the copy sync-gate wait while a read bypasses the gate", async () => {
    const f = workspace();
    const file = new CrashRecoveryFile(join(f.root, "crash-recovery.json"), crashRecoveryWorkspaceId(f.store));
    const h = recoveryHarness({store: f.store, recovery: file});
    const release = deferred<void>();
    const sync = h.syncGate.sync(async () => {await release.promise;});
    const pending = h.handlers.diagnostic(h.event, {
      type: "recovery:copy",
      recoveryId: "gated-copy",
      input: {title: "Gated", payload: {}},
    });
    const readReply = await h.handlers.diagnostic(h.event, {type: "recovery:read"});
    expect(readReply).toMatchObject({ok: true, valueSlot: {present: true, value: {status: "empty"}}});
    expect(h.calls).toEqual({read: 1, write: 0, copy: 0});
    h.state.generation++;
    h.state.binding = {};
    release.resolve();
    await sync;
    const reply = await pending;
    expect(reply).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", family: "REQUEST", requestType: "recovery:copy"},
    });
    expect(h.calls.copy).toBe(0);
    expect(f.store.load().pages).toHaveLength(1);
  });

  it("keeps a blocked read's identity sidecar and only a retained native lease latches OUTCOME_UNKNOWN", async () => {
    const f = workspace();
    const path = join(f.root, "crash-recovery.json");
    writeFileSync(path, "not-json", "utf8");
    const ordinary = new CrashRecoveryFile(path, crashRecoveryWorkspaceId(f.store));
    const h = recoveryHarness({store: f.store, recovery: ordinary});
    expect(await h.handlers.legacy(h.event, {type: "recovery:read"})).toMatchObject({status: "blocked", generation: 0});
    const blocked = await h.handlers.diagnostic(h.event, {type: "recovery:read"});
    expect(blocked).toMatchObject({
      ok: true,
      valueSlot: {
        present: true,
        value: {status: "blocked", storageFailure: {kind: "UNCLASSIFIED", requestType: "recovery:read"}},
      },
    });
    expect(h.lifecycle.isUsable()).toBe(true);
    expect(h.lifecycle.retainedFailure()).toBeUndefined();

    let retained: unknown;
    try {retainStartupProtector({} as NativePrivateSqliteLease, [new Error("lease-close")]);}
    catch (error) {retained = error;}
    const nativePort = {
      contractVersion: 3 as const,
      platform: "win32" as const,
      read(): never {throw retained;},
      compareAndSwap(): never {throw new Error("unused");},
    };
    const latched = new CrashRecoveryFile("C:\\Folio\\crash-recovery.json", "ws-1", {platform: "win32", nativePort});
    const h2 = recoveryHarness({store: f.store, recovery: latched});
    const unknown = await h2.handlers.diagnostic(h2.event, {type: "recovery:read"});
    expect(unknown).toMatchObject({
      ok: true,
      valueSlot: {
        present: true,
        value: {
          status: "blocked",
          storageFailure: {kind: "OUTCOME_UNKNOWN", family: "REQUEST", failureSubject: "UNIDENTIFIED"},
        },
      },
    });
    expect(JSON.stringify(unknown)).not.toContain("lease-close");
    expect(h2.lifecycle.isUsable()).toBe(false);
    expect(h2.lifecycle.retainedFailure()).toBe(retained);
  });

  it("keeps a branded write throw's exact identity and typed generation-conflict facts", async () => {
    const f = workspace();
    const source = new Error("source-conflict");
    recordCheckpointGenerationConflict(source, 0, 1);
    const generationConflict = getCheckpointGenerationConflict(source);
    if (generationConflict === undefined) throw new Error("expected a generation-conflict brand");
    const recovery: RecoveryPorts = {
      read: () => ({status: "empty", generation: 0}),
      writeObserved: () => Object.freeze({terminal: "THREW" as const, value: source, generationConflict}),
    };
    const h = recoveryHarness({store: f.store, recovery});
    const request = {type: "recovery:write", expectedGeneration: 0, snapshot: emptyCrashRecoverySnapshot()};
    await expect(h.handlers.legacy(h.event, request)).rejects.toBe(source);
    const reply = await h.handlers.diagnostic(h.event, request);
    expect(reply).toMatchObject({
      ok: false,
      failure: {
        kind: "GENERATION_CONFLICT",
        family: "CHECKPOINT",
        stage: "PRECONDITION",
        requestType: "recovery:write",
        sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"],
        precondition: {expectedGeneration: 0, observedActualGeneration: 1, mismatch: "GENERATION"},
      },
    });
    expect(h.calls.write).toBe(2);
    expect(f.store.load().pages).toHaveLength(1);
  });

  it("keeps an ordinary raw write error as UNCLASSIFIED, distinct from retained OUTCOME_UNKNOWN", async () => {
    const f = workspace();
    const plain = new Error("plain-write");
    const recovery: RecoveryPorts = {
      read: () => ({status: "empty", generation: 0}),
      writeObserved: () => Object.freeze({terminal: "THREW" as const, value: plain}),
    };
    const h = recoveryHarness({store: f.store, recovery});
    const request = {type: "recovery:write", expectedGeneration: 0, snapshot: emptyCrashRecoverySnapshot()};
    await expect(h.handlers.legacy(h.event, request)).rejects.toBe(plain);
    const reply = await h.handlers.diagnostic(h.event, request);
    expect(reply).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", family: "REQUEST", requestType: "recovery:write"},
    });
  });

  it("validates a copy before the Store transaction and reports the raw error as UNCLASSIFIED", async () => {
    const f = workspace();
    const file = new CrashRecoveryFile(join(f.root, "crash-recovery.json"), crashRecoveryWorkspaceId(f.store));
    const h = recoveryHarness({store: f.store, recovery: file});
    const transaction = vi.spyOn(f.store, "transaction");
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:copy",
      recoveryId: "invalid-copy",
      input: {title: "Bad", payload: new Date(0)},
    });
    expect(reply).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", family: "REQUEST", requestType: "recovery:copy"},
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(h.calls.copy).toBe(1);
    expect(f.store.load().pages).toHaveLength(1);
  });

  it("deduplicates a copy by recovery id and rolls back a copy whose receipt cannot be written", async () => {
    const f = workspace();
    const file = new CrashRecoveryFile(join(f.root, "crash-recovery.json"), crashRecoveryWorkspaceId(f.store));
    const h = recoveryHarness({store: f.store, recovery: file});
    const close = vi.spyOn(f.store, "close");
    const request = {
      type: "recovery:copy",
      recoveryId: "dedupe-copy",
      input: {title: "Recovered copy", payload: {text: "keep"}},
    };
    const first = await h.handlers.diagnostic(h.event, request);
    if (!first.ok || !first.valueSlot.present) throw new Error("expected the first copy page");
    const firstPage = first.valueSlot.value as Page;
    expect(firstPage.kind).toBe("page");
    expect(firstPage.parentId).toBeNull();
    const second = await h.handlers.diagnostic(h.event, request);
    if (!second.ok || !second.valueSlot.present) throw new Error("expected the deduplicated copy page");
    expect((second.valueSlot.value as Page).id).toBe(firstPage.id);

    const before = f.store.load().pages.length;
    f.store.db.exec("CREATE TRIGGER fail_copy BEFORE INSERT ON crash_recovery_copies BEGIN SELECT RAISE(ABORT, 'receipt failed'); END");
    const rollback = {
      type: "recovery:copy",
      recoveryId: "rollback-copy",
      input: {title: "Do not duplicate", payload: {text: "keep"}},
    };
    let caught: unknown;
    try {await h.handlers.legacy(h.event, rollback);}
    catch (error) {caught = error;}
    expect(String(caught)).toMatch(/receipt failed/);
    expect(f.store.load().pages).toHaveLength(before);
    const failed = await h.handlers.diagnostic(h.event, rollback);
    expect(failed).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", family: "REQUEST", requestType: "recovery:copy"},
    });
    expect(f.store.load().pages).toHaveLength(before);
    expect(close).not.toHaveBeenCalled();
    expect(f.store.get(firstPage.id).title).toBe("Recovered copy");
    expect(f.store.load().pages.some((page) => page.title === "preserve")).toBe(true);
  });
});

describe("Main source lock and helper shape (static, no Electron import)", () => {
  const acceptedMainSha256 = "02d14fede9e465b6d93824b48f4ac8d346ca5e710a5710a8744a7771dffad04c";
  const acceptedMainBytes = 50793;
  const indexSource = () => readFileSync(join(__dirname, "..", "src", "main", "index.ts"), "utf8");

  it("reconstructs the accepted Main bytes by removing the new import and restoring the old three lines", () => {
    const source = indexSource();
    const importLine = 'import {handlePrivateRecoveryRequest, isPrivateRecoveryRequest} from "./private-recovery-handlers";';
    expect(source).toContain(importLine);
    const lines = source.split("\n");
    const importIndex = lines.findIndex((line) => line === importLine);
    expect(importIndex).toBeGreaterThan(-1);
    lines.splice(importIndex, 1);
    const start = lines.findIndex((line) => line.trimStart().startsWith("if (isPrivateRecoveryRequest(req)) return handlePrivateRecoveryRequest(req, {"));
    expect(start).toBeGreaterThan(-1);
    let end = start + 1;
    while (end < lines.length && lines[end] !== "        });") end++;
    expect(end).toBeGreaterThan(start);
    const original = [
      '        if (req.type === "recovery:read") return context.readRecovery(crashRecovery!);',
      '        if (req.type === "recovery:write") return context.writeRecovery(crashRecovery!, req.expectedGeneration, req.snapshot);',
      '        if (req.type === "recovery:copy") return createRecoveryCopy(store, req.recoveryId, {...req.input, payload: req.input.payload});',
    ];
    expect(lines[start]).not.toBe(original[0]);
    lines.splice(start, end - start + 1, ...original);
    const restored = lines.join("\n");
    expect(Buffer.byteLength(restored, "utf8")).toBe(acceptedMainBytes);
    expect(createHash("sha256").update(restored, "utf8").digest("hex")).toBe(acceptedMainSha256);
  });

  it("keeps the guard after the read-only/storage gates and before the single withStorageAction wrap", () => {
    const source = indexSource();
    const start = source.indexOf("if (isPrivateRecoveryRequest(req))");
    expect(start).toBeGreaterThan(-1);
    const readOnlyAt = source.indexOf("if (readOnly) assertReadOnlyRequest(req)");
    const storageAt = source.indexOf("storage.admitRequest(req)");
    const withAt = source.indexOf("return context.withStorageAction(req, handle);");
    expect(readOnlyAt).toBeGreaterThan(-1);
    expect(storageAt).toBeGreaterThan(readOnlyAt);
    expect(start).toBeGreaterThan(storageAt);
    expect(withAt).toBeGreaterThan(start);
    expect(source.slice(0, start)).toContain("const handle = async () => {");
  });

  it("adds no await, try/catch, Store/CrashRecoveryFile ownership, close or IPC, and leaves recovery-list alone", () => {
    const source = indexSource();
    const start = source.indexOf("if (isPrivateRecoveryRequest(req))");
    const end = source.indexOf('if (req.type === "pageOrder:preview"', start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(block).not.toContain("await ");
    expect(block).not.toContain("try {");
    expect(block).not.toContain("catch");
    expect(block).not.toContain("new Store");
    expect(block).not.toContain("new CrashRecoveryFile");
    expect(block).not.toContain(".close(");
    expect((source.match(/ipcMain\.handle\(/g) ?? []).length).toBe(3);
    expect(source).toContain('if (req.type === "recovery:list")');
    expect(source).toContain('if (req.type === "recovery:status")');
    expect(source).toContain('if (req.type === "recovery:export" || req.type === "recovery:restore")');
  });

  it("keeps the helper a synchronous type-only DI module with no Electron, IPC or ownership", () => {
    const helper = readFileSync(join(__dirname, "..", "src", "main", "private-recovery-handlers.ts"), "utf8");
    expect(helper).toContain("export function isPrivateRecoveryRequest");
    expect(helper).toContain("export function handlePrivateRecoveryRequest");
    expect(helper).toContain('Extract<Request, { type: "recovery:read" }>');
    expect(helper).toContain('Extract<Request, { type: "recovery:write" }>');
    expect(helper).toContain('Extract<Request, { type: "recovery:copy" }>');
    expect(helper).not.toContain("await ");
    expect(helper).not.toContain("async ");
    expect(helper).not.toContain("try {");
    expect(helper).not.toContain("catch");
    expect(helper).not.toContain("new Store");
    expect(helper).not.toContain("new CrashRecoveryFile");
    expect(helper).not.toContain("ipcMain");
    expect(helper).not.toContain("electron");
    expect(helper).not.toContain(".close(");
  });
});
