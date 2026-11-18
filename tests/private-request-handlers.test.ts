import {mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {seedDemo} from "../scripts/r7-demo-seed";
import {Store} from "../src/persistence/store";
import {CrashRecoveryFile} from "../src/persistence/crash-recovery-file";
import {retainStartupProtector} from "../src/persistence/startup-connection-owner";
import type {NativePrivateSqliteLease} from "../src/platform/private-persistence";
import {getKCapacityRefusal, recordCheckpointCapacityRefusal, recordCheckpointGenerationConflict, recordKCapacityRefusal, recordKMutationFailure} from "../src/platform/private-mutation-diagnostic";
import {assertPrivateOperationAuthority} from "../src/platform/private-operation-authority";
import {createPrivatePersistenceLifecycle} from "../src/main/private-persistence-lifecycle";
import {WorkspaceSyncGate} from "../src/main/workspace-sync-gate";
import {WorkspaceBackupService} from "../src/main/workspace-backup-service";
import {createPrivateRequestHandlers, type PrivateRequestContext} from "../src/main/private-request-handlers";
import {requestSchema, type Request} from "../src/shared/types";
import {decodeRequestReplyV1} from "../src/shared/private-storage-failure";
import {emptyCrashRecoverySnapshot} from "../src/shared/crash-recovery";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) { try { store.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return {promise, resolve};
};

type Dispatch = (req: Request, context: PrivateRequestContext<typeof requestWindow>) => Promise<unknown> | unknown;
const frame = {url: "https://folio.test/"};
const webContents = {mainFrame: frame};
let destroyed = false;
const requestWindow = {
  webContents,
  isDestroyed: () => destroyed,
};

type State = {
  window: typeof requestWindow;
  generation: number;
  binding: object;
};

function handlerFixture(
  dispatch: Dispatch,
  options: {
    getRequestWindow?: () => typeof requestWindow | undefined;
    getRendererGeneration?: () => number;
    getWorkspaceBinding?: () => object;
  } = {},
) {
  destroyed = false;
  const state: State = {window: requestWindow, generation: 1, binding: {}};
  const event = {sender: webContents, senderFrame: frame};
  const lifecycle = createPrivatePersistenceLifecycle();
  const syncGate = new WorkspaceSyncGate();
  const handlers = createPrivateRequestHandlers({
    lifecycle,
    syncGate,
    enterScope: (work) => work(),
    getRequestWindow: options.getRequestWindow ?? (() => state.window),
    getRendererGeneration: options.getRendererGeneration ?? (() => state.generation),
    getWorkspaceBinding: options.getWorkspaceBinding ?? (() => state.binding),
    trustedUrl: frame.url,
    dispatch,
  });
  return {state, event, lifecycle, syncGate, handlers};
}

function workspaceFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-request-handlers-")));
  roots.push(root);
  const directory = join(root, "workspace");
  mkdirSync(join(directory, "assets"), {recursive: true});
  const store = new Store(join(directory, "workspace.sqlite"));
  stores.push(store);
  store.create(null, "page", "preserve");
  return {root, directory, store};
}

function backupFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-request-backup-")));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  seedDemo(join(source, "workspace.sqlite"), undefined, resolve("tests/fixtures/image.png"));
  const store = new Store(join(source, "workspace.sqlite"));
  stores.push(store);
  const service = new WorkspaceBackupService(store.db, source);
  const chosen = service.choose(service.create().directory);
  const restored = service.restore(chosen.ticket, root);
  return {root, service, ticket: restored.ticket};
}

describe("common private request handlers (Node-only contract)", () => {
  it("runs one execute path for legacy and diagnostic calls and preserves falsy success", async () => {
    const values: unknown[] = [undefined, null, false, 0, ""];
    let calls = 0;
    const h = handlerFixture(async () => values[calls++]);
    expect(await h.handlers.legacy(h.event, {type: "startup:status"})).toBeUndefined();
    expect(calls).toBe(1);
    expect(await h.handlers.diagnostic(h.event, {type: "startup:status"})).toEqual({
      tag: "folio-request-result",
      version: 1,
      ok: true,
      valueSlot: {present: true, value: null},
    });
    expect(calls).toBe(2);
    expect(await h.handlers.diagnostic(h.event, {type: "startup:status"})).toMatchObject({
      ok: true,
      valueSlot: {present: true, value: false},
    });
    expect(await h.handlers.diagnostic(h.event, {type: "startup:status"})).toMatchObject({
      ok: true,
      valueSlot: {present: true, value: 0},
    });
    const last = await h.handlers.diagnostic(h.event, {type: "startup:status"});
    expect(last).toMatchObject({ok: true, valueSlot: {present: true, value: ""}});
    expect(calls).toBe(5);

    const original = new Error("exact failure");
    const throwing = handlerFixture(async () => { throw original; });
    let caught: unknown;
    try { await throwing.handlers.legacy(throwing.event, {type: "startup:status"}); }
    catch (error) { caught = error; }
    expect(caught).toBe(original);
    const reply = await throwing.handlers.diagnostic(throwing.event, {type: "startup:status"});
    const roundTrip = decodeRequestReplyV1(JSON.parse(JSON.stringify(reply)), "startup:status");
    expect(roundTrip).toMatchObject({ok: false, failure: {kind: "UNCLASSIFIED"}});
  });

  it.each([
    "sender",
    "frame",
    "url",
    "destroyed",
    "generation",
    "window",
    "binding",
  ])("uses the production authorizer and rejects wrong %s before parse or dispatch", async (variant) => {
    const parse = vi.spyOn(requestSchema, "parse");
    let calls = 0;
    const otherFrame = {url: "https://folio.test/"};
    const otherContents = {mainFrame: otherFrame};
    const otherWindow = {webContents: otherContents, isDestroyed: () => false};
    const h = handlerFixture(async () => { calls++; }, {
      getRequestWindow: variant === "window" ? () => otherWindow : undefined,
      getRendererGeneration: variant === "generation" ? (() => { let value = 1; return () => value++; })() : undefined,
      getWorkspaceBinding: variant === "binding" ? () => ({}) : undefined,
    });
    if (variant === "sender") h.event.sender = otherContents;
    if (variant === "frame") h.event.senderFrame = otherFrame;
    if (variant === "url") h.event.senderFrame = {url: "https://untrusted.test/"};
    if (variant === "destroyed") destroyed = true;
    const reply = await h.handlers.diagnostic(h.event, {type: "startup:status"});
    expect(reply).toMatchObject({
      ok: false,
      failure: {
        kind: "UNCLASSIFIED",
        family: "REQUEST",
        stage: "REQUEST",
        failureSubject: "UNIDENTIFIED",
        mutationDispatch: "UNPROVEN",
        proofOrigin: "NONE",
        requestType: "UNRECOGNIZED",
      },
    });
    await expect(h.handlers.legacy(h.event, {type: "startup:status"})).rejects.toThrow("Unauthorized IPC sender");
    expect(calls).toBe(0);
    expect(parse).not.toHaveBeenCalled();
  });

  it("rechecks the same authorizer after the real sync gate wait", async () => {
    let mutations = 0;
    const h = handlerFixture(async (req, context) =>
      context.withStorageAction(req, async () => { mutations++; }));
    const release = deferred<void>();
    const sync = h.syncGate.sync(async () => { await release.promise; });
    const pending = h.handlers.diagnostic(h.event, {type: "sync:run"});
    await Promise.resolve();
    expect(mutations).toBe(0);
    h.state.generation++;
    h.state.binding = {};
    release.resolve();
    await sync;
    const reply = await pending;
    expect(reply).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", family: "REQUEST", requestType: "sync:run"},
    });
    expect(mutations).toBe(0);
  });

  it("keeps ambient request authority across an actual deferred restore picker", async () => {
    const f = workspaceFixture();
    const service = new WorkspaceBackupService(f.store.db, f.directory);
    const backup = service.create();
    const pick = deferred<string | null>();
    let restores = 0;
    const h = handlerFixture(async (req, context) =>
      context.withStorageAction(req, async () => {
        const result = await service.restoreAfterPicker(
          (req as {ticket: string}).ticket,
          async () => {
            const selected = await pick.promise;
            assertPrivateOperationAuthority();
            return selected;
          },
          context.isAuthorized,
        );
        if (result !== null) restores++;
        return result;
      }));
    const before = readdirSync(f.root);
    const pending = h.handlers.diagnostic(h.event, {type: "workspaceBackup:restore", ticket: backup.ticket});
    await Promise.resolve();
    h.state.generation++;
    pick.resolve(f.root);
    const reply = await pending;
    expect(reply).toMatchObject({ok: false, failure: {kind: "UNCLASSIFIED"}});
    expect(restores).toBe(0);
    expect(readdirSync(f.root)).toEqual(before);
  });

  it("observes an exact blocked read and returns only the fixed safe value", async () => {
    let retained: unknown;
    try { retainStartupProtector({} as NativePrivateSqliteLease, [new Error("lease-close")]); }
    catch (error) { retained = error; }
    const nativePort = {
      contractVersion: 3 as const,
      platform: "win32" as const,
      read(): never { throw retained; },
      compareAndSwap(): never { throw new Error("unused"); },
    };
    const file = new CrashRecoveryFile("C:\\Folio\\crash-recovery.json", "ws-1", {
      platform: "win32",
      nativePort,
    });
    const h = handlerFixture(async (_req, context) => context.readRecovery(file));
    const reply = await h.handlers.diagnostic(h.event, {type: "recovery:read"});
    expect(reply.ok).toBe(true);
    if (!reply.ok || !reply.valueSlot.present) throw new Error("expected blocked value");
    const value = reply.valueSlot.value as Record<string, unknown>;
    expect(value).toMatchObject({
      status: "blocked",
      generation: 0,
      message: "Crash recovery read is blocked; original failure retained",
      storageFailure: {kind: "OUTCOME_UNKNOWN", family: "REQUEST", failureSubject: "UNIDENTIFIED"},
    });
    expect(JSON.stringify(value)).not.toContain("lease-close");
    expect(h.lifecycle.isUsable()).toBe(false);
    expect(h.lifecycle.retainedFailure()).toBe(retained);
  });

  it("keeps an ordinary blocked read diagnostic as E without leaking the raw message", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-recovery-read-")));
    roots.push(root);
    const path = join(root, "crash-recovery.json");
    writeFileSync(path, "not-json", "utf8");
    const file = new CrashRecoveryFile(path, "ws-1");
    const h = handlerFixture(async (_req, context) => context.readRecovery(file));
    const reply = await h.handlers.diagnostic(h.event, {type: "recovery:read"});
    expect(reply.ok).toBe(true);
    if (!reply.ok || !reply.valueSlot.present) throw new Error("expected blocked value");
    const value = reply.valueSlot.value as Record<string, unknown>;
    expect(value).toMatchObject({
      status: "blocked",
      generation: 0,
      message: "Crash recovery read is blocked; original failure retained",
      storageFailure: {kind: "UNCLASSIFIED", failureSubject: "UNIDENTIFIED"},
    });
    expect(JSON.stringify(value)).not.toContain("not-json");
    expect(h.lifecycle.isUsable()).toBe(true);
  });

  it("preserves the existing same-snapshot APPLIED ACK success", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-recovery-write-")));
    roots.push(root);
    const file = new CrashRecoveryFile(join(root, "crash-recovery.json"), "ws-1");
    file.write(0, emptyCrashRecoverySnapshot());
    const h = handlerFixture(async (req, context) =>
      context.withStorageAction(req, () => {
        const write = req as {expectedGeneration: number; snapshot: Parameters<CrashRecoveryFile["writeObserved"]>[1]};
        return context.writeRecovery(file, write.expectedGeneration, write.snapshot);
      }));
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:write",
      expectedGeneration: 0,
      snapshot: emptyCrashRecoverySnapshot(),
    });
    expect(reply).toMatchObject({
      ok: true,
      valueSlot: {
        present: true,
        value: {status: "ready", generation: 1, snapshot: emptyCrashRecoverySnapshot()},
      },
    });
  });

  it("marks omitted, primitive, sparse and arbitrary aggregate causes incomplete", async () => {
    const plain = handlerFixture(async () => { throw new Error("plain"); });
    expect(await plain.handlers.diagnostic(plain.event, {type: "startup:status"})).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", causeSummaryIncomplete: true},
    });

    const primitive = handlerFixture(async () => { throw "primitive"; });
    expect(await primitive.handlers.diagnostic(primitive.event, {type: "startup:status"})).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", causeSummaryIncomplete: true},
    });

    const sparse = new AggregateError([], "sparse");
    Object.defineProperty(sparse, "errors", {value: new Array(2)});
    const sparseHandler = handlerFixture(async () => { throw sparse; });
    expect(await sparseHandler.handlers.diagnostic(sparseHandler.event, {type: "startup:status"})).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", causeSummaryIncomplete: true},
    });

    const arbitrary = new AggregateError([new Error("leaf")], "arbitrary");
    const aggregate = handlerFixture(async () => { throw arbitrary; });
    expect(await aggregate.handlers.diagnostic(aggregate.event, {type: "startup:status"})).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", causeSummaryIncomplete: true},
    });
  });

  it("does not let captured terminal facts classify a replacement throw", async () => {
    const source = new Error("source-conflict");
    recordCheckpointGenerationConflict(source, 0, 1);
    const replacement = new Error("replacement");
    const file: Pick<CrashRecoveryFile, "writeObserved"> = {
      writeObserved() { throw source; },
    };
    const write = handlerFixture(async (req, context) =>
      context.withStorageAction(req, async () => {
        try { context.writeRecovery(file, 0, emptyCrashRecoverySnapshot()); }
        catch { throw replacement; }
      }));
    const writeReply = await write.handlers.diagnostic(write.event, {
      type: "recovery:write",
      expectedGeneration: 0,
      snapshot: emptyCrashRecoverySnapshot(),
    });
    expect(writeReply).toMatchObject({ok: false, failure: {kind: "UNCLASSIFIED"}});

    const launchSource = new Error("source-launch");
    const service: Pick<WorkspaceBackupService, "openObserved"> = {
      openObserved: async () => Object.freeze({
        terminal: "THREW" as const,
        value: launchSource,
        launchStarted: true,
      }),
    };
    const launch = handlerFixture(async (req, context) =>
      context.withStorageAction(req, async () => {
        try {
          await context.openBackup(service, (req as {ticket: string}).ticket, async () => {});
        } catch { throw replacement; }
      }));
    const launchReply = await launch.handlers.diagnostic(launch.event, {
      type: "workspaceBackup:open",
      ticket: "ticket",
    });
    expect(launchReply).toMatchObject({ok: false, failure: {kind: "UNCLASSIFIED"}});
  });

  it("classifies an actual started launch and refuses a second launch fact", async () => {
    const f = backupFixture();
    const original = "primitive-simulated-launch-failure";
    let launches = 0;
    const h = handlerFixture(async (req, context) =>
      context.withStorageAction(req, async () => {
        await context.openBackup(f.service, (req as {ticket: string}).ticket,
          async (_directory, _handoff, markStarted) => {
            launches++;
            markStarted?.();
            throw original;
          });
        return true;
      }));
    const first = await h.handlers.diagnostic(h.event, {type: "workspaceBackup:open", ticket: f.ticket});
    expect(first).toMatchObject({
      ok: false,
      failure: {
        kind: "OUTCOME_UNKNOWN",
        family: "REQUEST",
        stage: "REQUEST",
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "DISPATCHED",
        proofOrigin: "DISPATCH_OBSERVED",
        causeSummaryIncomplete: true,
      },
    });
    const second = await h.handlers.diagnostic(h.event, {type: "workspaceBackup:open", ticket: f.ticket});
    expect(second).toMatchObject({ok: false, failure: {kind: "UNCLASSIFIED"}});
    expect(launches).toBe(1);
  });

  it("maps exact K failure facts without promoting a bare reserve UNKNOWN", async () => {
    const attemptId = "a".repeat(32);
    const capacity = new Error("k-capacity");
    recordKMutationFailure(capacity, {
      attemptId,
      sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE"},
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      capacityRefusal: {
        kind: "PRE_DISPATCH_CAPACITY",
        family: "K",
        stage: "RESERVE",
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "NOT_DISPATCHED_PROVEN",
        proofOrigin: "LOCAL_ADMISSION_GUARD",
        attemptId,
        sourceCauseCodes: ["PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY"],
      },
    });
    const h = handlerFixture(async () => { throw capacity; });
    const first = await h.handlers.diagnostic(h.event, {type: "startup:status"});
    expect(first).toMatchObject({
      ok: false,
      failure: {
        kind: "PRE_DISPATCH_CAPACITY",
        family: "K",
        stage: "RESERVE",
        attemptId,
        sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE"},
      },
    });

    const unknown = new Error("k-unknown");
    recordKMutationFailure(unknown, {
      attemptId: "b".repeat(32),
      sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE"},
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
    });
    const plain = handlerFixture(async () => { throw unknown; });
    const second = await plain.handlers.diagnostic(plain.event, {type: "startup:status"});
    expect(second).toMatchObject({
      ok: false,
      failure: {
        kind: "UNCLASSIFIED",
        family: "K",
        stage: "UNSPECIFIED",
        failureSubject: "CURRENT_ATTEMPT",
        attemptId: "b".repeat(32),
        sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE"},
      },
    });
  });

  it("reports a raw guard K capacity leaf in the cause chain without promoting uncoded leaves", async () => {
    const attemptId = "c".repeat(32);
    const raw = new Error();
    recordKCapacityRefusal(raw, attemptId, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    const selected = getKCapacityRefusal(raw);
    expect(selected).toBeDefined();
    if (selected === undefined) {
      throw new Error("recordKCapacityRefusal did not brand the raw guard error");
    }
    const wrapper = new Error("wrapper", {cause: raw});
    recordKMutationFailure(wrapper, {
      attemptId,
      sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE"},
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      capacityRefusal: selected,
    });
    const h = handlerFixture(async () => { throw wrapper; });
    const first = await h.handlers.diagnostic(h.event, {type: "startup:status"});
    expect(first).toMatchObject({
      ok: false,
      failure: {
        kind: "PRE_DISPATCH_CAPACITY",
        family: "K",
        stage: "RESERVE",
        failureSubject: "CURRENT_ATTEMPT",
        attemptId,
        sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE"},
        causeSummaryIncomplete: false,
      },
    });

    const controlId = "d".repeat(32);
    const controlRaw = new Error();
    recordKCapacityRefusal(controlRaw, controlId, "PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    const controlSelected = getKCapacityRefusal(controlRaw);
    expect(controlSelected).toBeDefined();
    if (controlSelected === undefined) {
      throw new Error("recordKCapacityRefusal did not brand the control guard error");
    }
    const uncoded = new Error("uncoded-leaf");
    const controlWrapper = new Error("wrapper", {cause: uncoded});
    recordKMutationFailure(controlWrapper, {
      attemptId: controlId,
      sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE"},
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      capacityRefusal: controlSelected,
    });
    const control = handlerFixture(async () => { throw controlWrapper; });
    const third = await control.handlers.diagnostic(control.event, {type: "startup:status"});
    expect(third).toMatchObject({
      ok: false,
      failure: {
        kind: "UNCLASSIFIED",
        family: "K",
        stage: "UNSPECIFIED",
        failureSubject: "CURRENT_ATTEMPT",
        attemptId: controlId,
        sourceOutcome: {source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE"},
        causeSummaryIncomplete: true,
      },
    });
  });

  it("bounds causes, never invokes accessors, and rejects forged or stale positive proof", async () => {
    let getters = 0;
    const trapped: object = {};
    Object.defineProperty(trapped, "cause", {
      enumerable: true,
      get() { getters++; throw new Error("trap"); },
    });
    const h = handlerFixture(async () => { throw trapped; });
    const trappedReply = await h.handlers.diagnostic(h.event, {type: "startup:status"});
    expect(trappedReply).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", causeSummaryIncomplete: true},
    });
    expect(getters).toBe(0);

    const cyclic = new Error("cycle");
    Object.defineProperty(cyclic, "cause", {value: cyclic});
    const cyclicHandler = handlerFixture(async () => { throw cyclic; });
    const cyclicReply = await cyclicHandler.handlers.diagnostic(cyclicHandler.event, {type: "startup:status"});
    expect(cyclicReply).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", causeSummaryIncomplete: true},
    });

    const forged = new Error("forged");
    Object.defineProperty(forged, "code", {value: "WINDOWS_RECOVERY_ARCHIVE_CAPACITY"});
    const forgedHandler = handlerFixture(async () => { throw forged; });
    const forgedReply = await forgedHandler.handlers.diagnostic(forgedHandler.event, {type: "startup:status"});
    expect(forgedReply).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"]},
    });

    const stale = new Error("stale-capacity");
    recordCheckpointCapacityRefusal(stale, "f".repeat(32));
    const staleHandler = handlerFixture(async () => { throw stale; });
    const staleReply = await staleHandler.handlers.diagnostic(staleHandler.event, {type: "startup:status"});
    expect(staleReply).toMatchObject({
      ok: false,
      failure: {kind: "UNCLASSIFIED", causeSummaryIncomplete: true},
    });

    const decoded = decodeRequestReplyV1(JSON.parse(JSON.stringify(staleReply)), "startup:status");
    expect(decoded).toMatchObject({ok: false, failure: {kind: "UNCLASSIFIED"}});
  });
});
