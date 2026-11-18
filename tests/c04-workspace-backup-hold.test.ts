import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDiagnosticRequest,
  StorageFailureError,
} from "../src/renderer/private-request";
import { RecoveryCheckpoint } from "../src/renderer/recovery-checkpoint";
import { emptyCrashRecoverySnapshot } from "../src/shared/crash-recovery";
import type { StorageFailureV1 } from "../src/shared/private-storage-failure";
import type { Request } from "../src/shared/types";
import {
  backupCloseReleaseAllowed,
  backupLocalRefusal,
  backupWriteHoldMessage,
  createBackupWriteEntry,
  createBackupWriteHold,
  type BackupWriteEntryDeps,
} from "../src/renderer/workspace-backup/backup-write-hold";

const TICKET = "11111111-2222-4333-8444-555555555555";
const inventory = {
  pages: 2,
  recordDatabases: 1,
  records: 4,
  versions: 3,
  settings: 1,
  saveReceipts: 2,
  registeredAssets: 0,
};
const preview = {
  ticket: TICKET,
  directory: "/backups/source-snapshot",
  createdAt: "2026-11-04T03:00:00.000Z",
  inventory,
  bytes: 1024,
};
const restored = {
  ...preview,
  directory: "/restored/new-folder",
  sourceDirectory: preview.directory,
};

const createRequest: Request = {type: "workspaceBackup:create"};
const restoreRequest: Request = {type: "workspaceBackup:restore", ticket: TICKET};
const openRequest: Request = {type: "workspaceBackup:open", ticket: TICKET};
const chooseRequest: Request = {type: "workspaceBackup:choose"};
const mutations = [
  ["create", createRequest],
  ["restore", restoreRequest],
  ["open", openRequest],
] as const;

const envelope = (valueSlot: {present: false} | {present: true; value: unknown}) =>
  JSON.parse(JSON.stringify({tag: "folio-request-result", version: 1, ok: true, valueSlot}));
const failureReply = (failure: unknown) =>
  JSON.parse(JSON.stringify({tag: "folio-request-result", version: 1, ok: false, failure}));
const rejected = (promise: Promise<unknown>) =>
  promise.then(
    () => {throw new Error("unexpected resolve");},
    (error) => error,
  );

function base(requestType: string): StorageFailureV1 {
  return {
    version: 1, kind: "UNCLASSIFIED", family: "REQUEST", stage: "REQUEST",
    failureSubject: "UNIDENTIFIED", mutationDispatch: "UNPROVEN", proofOrigin: "NONE",
    requestType, sourceOutcome: null, sourceCauseCodes: [], causeSummaryIncomplete: true,
    attemptId: null, precondition: null, operationProgress: "PARTIAL_OR_UNKNOWN",
    retryAuthority: "NONE", preserve: true,
  };
}
function capacityA(requestType: string): StorageFailureV1 {
  return {
    ...base(requestType), kind: "PRE_DISPATCH_CAPACITY", family: "CHECKPOINT",
    stage: "RESERVE", failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "NOT_DISPATCHED_PROVEN", proofOrigin: "LOCAL_ADMISSION_GUARD",
    sourceOutcome: {source: "RECOVERY_IO", contractVersion: 3, state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED"},
    sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"],
    causeSummaryIncomplete: false, attemptId: "a".repeat(32),
  };
}
function unknownC(requestType: string): StorageFailureV1 {
  return {
    ...base(requestType), kind: "OUTCOME_UNKNOWN", family: "CHECKPOINT",
    stage: "HEAD_CAS", failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "DISPATCHED", proofOrigin: "DISPATCH_OBSERVED",
    sourceOutcome: {source: "RECOVERY_IO", contractVersion: 3, state: "PUBLISHED", reason: null},
    sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CONFLICT"],
    causeSummaryIncomplete: false, attemptId: "b".repeat(32),
  };
}
function conflictD(requestType: string): StorageFailureV1 {
  return {
    ...base(requestType), kind: "GENERATION_CONFLICT", family: "CHECKPOINT",
    stage: "PRECONDITION", failureSubject: "CURRENT_ATTEMPT",
    mutationDispatch: "NOT_DISPATCHED_PROVEN", proofOrigin: "VALIDATED_PRECONDITION",
    sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"], causeSummaryIncomplete: false,
    precondition: {expectedGeneration: 1, observedActualGeneration: 2, mismatch: "GENERATION"},
  };
}
function priorAttemptC(): StorageFailureV1 {
  return {
    ...base("recovery:write"), kind: "OUTCOME_UNKNOWN", family: "CHECKPOINT",
    stage: "PRIOR_ATTEMPT", failureSubject: "PRIOR_ATTEMPT",
    mutationDispatch: "UNPROVEN", proofOrigin: "NONE",
    sourceCauseCodes: ["WINDOWS_RECOVERY_PORT_PENDING"], causeSummaryIncomplete: false,
  };
}
const snapshot = (value: string) => ({
  ...emptyCrashRecoverySnapshot(),
  rawDrafts: [{scope: "record" as const, pageId: "page", key: "number", value}],
});
/** Mirrors the App's latchedRecoveryError: the queue's own bounded
 * diagnostic when it is in error state, else null. */
function queueHeldError(queue: RecoveryCheckpoint): Error | null {
  const status = queue.getStatus();
  if (status.state !== "error") return null;
  return status.storageFailure
    ? new StorageFailureError(status.storageFailure)
    : new Error(status.error);
}

/** Production wiring shape: the real v1 adapter over a fake invoke, the real
 * hold and the real entry controller with an injected backup prepare. */
function harness(
  reply: (request: Request) => unknown | Promise<unknown>,
  prepare: () => Promise<void> = async () => {},
  prepareFailure?: () => unknown,
) {
  const sent: Request[] = [];
  let prepares = 0;
  const send = createDiagnosticRequest(async (request: Request) => {
    sent.push(request);
    return reply(request);
  });
  const hold = createBackupWriteHold();
  const deps: BackupWriteEntryDeps = {
    send,
    prepare: async () => {
      prepares++;
      await prepare();
    },
    prepareFailure,
  };
  const entry = createBackupWriteEntry(hold, deps);
  return {hold, deps, entry, sent, prepares: () => prepares};
}

function runMutation(
  entry: ReturnType<typeof createBackupWriteEntry>,
  request: Request,
): Promise<unknown> {
  return request.type === "workspaceBackup:create"
    ? entry.create(request)
    : entry.write(request);
}

describe("C04 backup write hold — production hold, entry and adapter", () => {
  it.each(mutations)(
    "latches valid A/C/D/E and raw/invalid failures from %s and blocks every later mutation",
    async (_name, request) => {
      const requestType = request.type;
      const cases: Array<[string, () => unknown, StorageFailureV1]> = [
        ["valid A", () => failureReply(capacityA(requestType)), capacityA(requestType)],
        ["valid C", () => failureReply(unknownC(requestType)), unknownC(requestType)],
        ["valid D", () => failureReply(conflictD(requestType)), conflictD(requestType)],
        ["valid E", () => failureReply(base(requestType)), base(requestType)],
        ["raw transport rejection", () => {throw new Error("raw transport /Users/alice/secret");}, base(requestType)],
        ["invalid success reply", () => ({unexpected: true}), base(requestType)],
        ["invalid failure envelope", () => failureReply({kind: "OUTCOME_UNKNOWN"}), base(requestType)],
      ];
      for (const [label, reply, expected] of cases) {
        const h = harness(() => reply());
        const error = await rejected(runMutation(h.entry, request));
        expect(error, label).toBeInstanceOf(StorageFailureError);
        expect((error as StorageFailureError).storageFailure, label).toEqual(expected);
        expect(h.hold.held(), label).toBe(true);
        expect(h.hold.failure(), label).toEqual(expected);
        expect(h.hold.failure()!.operationProgress, label).toBe("PARTIAL_OR_UNKNOWN");
        expect(h.hold.failure()!.retryAuthority, label).toBe("NONE");
        expect(h.sent, label).toHaveLength(1);
        expect(h.prepares(), label).toBe(request.type === "workspaceBackup:create" ? 1 : 0);
        // All three mutations retry: entry guard refuses before prepare and
        // before any request — including direct or stale callback calls.
        for (const [, retryRequest] of mutations) {
          const retryError = await rejected(runMutation(h.entry, retryRequest));
          expect(retryError, label).toBeInstanceOf(StorageFailureError);
          expect((retryError as StorageFailureError).storageFailure, label).toEqual(expected);
        }
        expect(h.sent, label).toHaveLength(1);
        expect(h.prepares(), label).toBe(request.type === "workspaceBackup:create" ? 1 : 0);
        expect(JSON.stringify(h.hold.failure()), label).not.toContain("secret");
      }
    },
  );

  it.each([["checkpoint outcome unknown", () => unknownC("recovery:write")],
    ["checkpoint generation conflict", () => conflictD("recovery:write")]])(
    "latches a v1 %s from prepare with its own requestType and sends no backup request",
    async (_label, dto) => {
      const failure = dto();
      const h = harness(
        () => envelope({present: true, value: preview}),
        async () => {throw new StorageFailureError(failure);},
      );
      const error = await rejected(h.entry.create(createRequest));
      expect(error).toBeInstanceOf(StorageFailureError);
      expect((error as StorageFailureError).storageFailure).toEqual(failure);
      expect(h.hold.failure()).toEqual(failure);
      expect(h.hold.failure()!.requestType).toBe("recovery:write");
      expect(h.sent).toHaveLength(0);
      expect(h.prepares()).toBe(1);
    },
  );

  it("a known App-local refusal refuses the attempt with send 0 and no hold", async () => {
    let refusing = true;
    const h = harness(
      () => envelope({present: true, value: preview}),
      async () => {
        if (refusing) throw backupLocalRefusal("未保存の変更があります。");
      },
    );
    const error = await rejected(h.entry.create(createRequest));
    expect(error).not.toBeInstanceOf(StorageFailureError);
    expect((error as Error).message).toBe("未保存の変更があります。");
    expect(h.hold.held()).toBe(false);
    expect(h.sent).toHaveLength(0);
    // The current attempt sent nothing but no permanent hold exists: a later
    // healthy create still reaches Main once and returns its real value.
    refusing = false;
    expect(await h.entry.create(createRequest)).toEqual(preview);
    expect(h.sent).toEqual([createRequest]);
  });

  it("an untagged look-alike prepare failure fails closed as bounded E — no spoofing the local refusal", async () => {
    const h = harness(
      () => envelope({present: true, value: preview}),
      async () => {throw new Error("未保存の変更があります。");},
    );
    const error = await rejected(h.entry.create(createRequest));
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure).toEqual(base("workspaceBackup:create"));
    expect(h.hold.held()).toBe(true);
    expect(h.sent).toHaveLength(0);
    expect(h.prepares()).toBe(1);
  });

  it("a real v1 queue diagnostic latched during an awaited prepare beats the post-await local refusal", async () => {
    const queue = new RecoveryCheckpoint(
      async () => {throw new Error("queue send unused");},
      0, undefined, {diagnostics: "v1"},
    );
    let releasePrepare!: () => void;
    const prepared = new Promise<void>((resolvePromise) => {
      releasePrepare = resolvePromise;
    });
    const h = harness(
      () => envelope({present: true, value: preview}),
      async () => {
        await prepared;
        // The App post-await guard sees captureError/error state and
        // refuses as a known local refusal — the F01 collapse.
        throw backupLocalRefusal("復旧記録の保存を確認してからバックアップしてください。");
      },
      () => queueHeldError(queue),
    );
    const pending = h.entry.create(createRequest);
    // A concurrent capture failure latches the real v1 queue mid-prepare.
    queue.captureFailure(new Error("capture broke at /Users/alice/secret"));
    releasePrepare();
    const error = await rejected(pending);
    expect(error).toBeInstanceOf(StorageFailureError);
    const dto = (error as StorageFailureError).storageFailure;
    expect(dto.requestType).toBe("recovery:write");
    expect(dto.kind).toBe("UNCLASSIFIED");
    expect(h.hold.held()).toBe(true);
    expect(h.hold.failure()).toEqual(dto);
    expect(h.sent).toHaveLength(0);
    for (const [, mutationRequest] of mutations) {
      await rejected(runMutation(h.entry, mutationRequest));
    }
    expect(h.sent).toHaveLength(0);
    expect(backupCloseReleaseAllowed(h.hold)).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("secret");
  });

  it("a real v1 queue diagnostic latched after a fulfilled prepare stops the actual send", async () => {
    const queue = new RecoveryCheckpoint(
      async () => {throw new Error("queue send unused");},
      0, undefined, {diagnostics: "v1"},
    );
    const h = harness(
      () => envelope({present: true, value: preview}),
      async () => {
        // Prepare resolved normally through its final saved check; the
        // concurrent capture failure lands before the send boundary (F01
        // microtask offset 3).
        queue.captureFailure(new Error("capture broke at /Users/alice/secret"));
      },
      () => queueHeldError(queue),
    );
    const error = await rejected(h.entry.create(createRequest));
    expect(error).toBeInstanceOf(StorageFailureError);
    const dto = (error as StorageFailureError).storageFailure;
    expect(dto.requestType).toBe("recovery:write");
    expect(dto.kind).toBe("UNCLASSIFIED");
    expect(dto.family).toBe("REQUEST");
    expect(dto.operationProgress).toBe("PARTIAL_OR_UNKNOWN");
    expect(h.hold.held()).toBe(true);
    expect(h.hold.failure()).toEqual(dto);
    expect(h.prepares()).toBe(1);
    expect(h.sent).toHaveLength(0);
    for (const [, mutationRequest] of mutations) {
      await rejected(runMutation(h.entry, mutationRequest));
    }
    expect(h.sent).toHaveLength(0);
    expect(backupCloseReleaseAllowed(h.hold)).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("secret");
  });

  it("a pre-latched queue diagnostic stops create at the entry boundary — prepare 0, send 0", async () => {
    const queue = new RecoveryCheckpoint(
      async () => {throw new Error("queue send unused");},
      0, undefined, {diagnostics: "v1"},
    );
    queue.captureFailure(new Error("capture broke at /Users/alice/secret"));
    const h = harness(
      () => envelope({present: true, value: preview}),
      async () => {},
      () => queueHeldError(queue),
    );
    const error = await rejected(h.entry.create(createRequest));
    expect(error).toBeInstanceOf(StorageFailureError);
    const dto = (error as StorageFailureError).storageFailure;
    expect(dto.requestType).toBe("recovery:write");
    expect(h.hold.held()).toBe(true);
    expect(h.hold.failure()).toEqual(dto);
    expect(h.prepares()).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it("a typed PRIOR checkpoint failure latched mid-prepare reaches the hold with its original DTO", async () => {
    const prior = priorAttemptC();
    const queue = new RecoveryCheckpoint(
      createDiagnosticRequest(async () => failureReply(prior)),
      0, undefined, {diagnostics: "v1"},
    );
    queue.offer(snapshot("held"));
    await rejected(queue.flush());
    expect(queue.getStatus().storageFailure).toEqual(prior);
    const h = harness(
      () => envelope({present: true, value: preview}),
      async () => {
        throw backupLocalRefusal("復旧記録の保存を確認してからバックアップしてください。");
      },
      () => queueHeldError(queue),
    );
    const error = await rejected(h.entry.create(createRequest));
    expect(error).toBeInstanceOf(StorageFailureError);
    expect((error as StorageFailureError).storageFailure).toEqual(prior);
    expect(h.hold.held()).toBe(true);
    expect(h.hold.failure()).toEqual(prior);
    expect(h.sent).toHaveLength(0);
    for (const [, mutationRequest] of mutations) {
      await rejected(runMutation(h.entry, mutationRequest));
    }
    expect(h.sent).toHaveLength(0);
    expect(backupCloseReleaseAllowed(h.hold)).toBe(false);
  });

  it("a local refusal with a healthy queue stays a refusal — send 0, no hold, later create works", async () => {
    const queue = new RecoveryCheckpoint(
      async () => {throw new Error("queue send unused");},
      0, undefined, {diagnostics: "v1"},
    );
    let refusing = true;
    const h = harness(
      () => envelope({present: true, value: preview}),
      async () => {
        if (refusing) throw backupLocalRefusal("未保存の変更があります。");
      },
      () => queueHeldError(queue),
    );
    const error = await rejected(h.entry.create(createRequest));
    expect(error).not.toBeInstanceOf(StorageFailureError);
    expect((error as Error).message).toBe("未保存の変更があります。");
    expect(h.hold.held()).toBe(false);
    expect(h.sent).toHaveLength(0);
    refusing = false;
    expect(await h.entry.create(createRequest)).toEqual(preview);
    expect(h.sent).toEqual([createRequest]);
  });

  it("a hold latched during an awaited prepare still stops the actual send", async () => {
    let releasePrepare!: () => void;
    const prepared = new Promise<void>((resolvePromise) => {
      releasePrepare = resolvePromise;
    });
    const h = harness(
      () => failureReply(unknownC("workspaceBackup:restore")),
      () => prepared,
    );
    const pending = h.entry.create(createRequest);
    const writeError = await rejected(h.entry.write(restoreRequest));
    expect(writeError).toBeInstanceOf(StorageFailureError);
    expect(h.hold.held()).toBe(true);
    releasePrepare();
    const createError = await rejected(pending);
    expect(createError).toBeInstanceOf(StorageFailureError);
    expect((createError as StorageFailureError).storageFailure).toEqual(
      unknownC("workspaceBackup:restore"),
    );
    // The restore send happened; the in-flight create's actual backup send
    // was refused by the post-prepare guard.
    expect(h.sent).toEqual([restoreRequest]);
    expect(h.prepares()).toBe(1);
  });

  it("keeps the first latched failure through later failures, choose, previews and a new controller", async () => {
    const first = unknownC("workspaceBackup:restore");
    let reply: (request: Request) => unknown = () => failureReply(first);
    const sent: Request[] = [];
    const send = createDiagnosticRequest(async (request: Request) => {
      sent.push(request);
      return reply(request);
    });
    const hold = createBackupWriteHold();
    const deps: BackupWriteEntryDeps = {send, prepare: async () => {}};
    const entry = createBackupWriteEntry(hold, deps);
    await rejected(entry.write(restoreRequest));
    expect(hold.failure()).toEqual(first);
    // Later A and E can neither clear nor reclassify the first latch.
    hold.latch(new StorageFailureError(capacityA("workspaceBackup:open")), "workspaceBackup:open");
    expect(hold.failure()).toEqual(first);
    hold.latch(new Error("raw /secret"), "workspaceBackup:create");
    expect(hold.failure()).toEqual(first);
    // Choose results — success, cancel and pure read failure — never clear it.
    reply = () => envelope({present: true, value: preview});
    expect(await entry.query(chooseRequest)).toEqual(preview);
    reply = () => envelope({present: true, value: null});
    expect(await entry.query(chooseRequest)).toBeNull();
    reply = () => failureReply(capacityA("workspaceBackup:choose"));
    await rejected(entry.query(chooseRequest));
    expect(hold.failure()).toEqual(first);
    // A recreated controller on the same root hold still sees the latch and
    // refuses every mutation without a send.
    const reopened = createBackupWriteEntry(hold, deps);
    expect(reopened.held()).toBe(true);
    expect(reopened.heldFailure()).toEqual(first);
    for (const [, mutationRequest] of mutations) {
      await rejected(runMutation(reopened, mutationRequest));
    }
    expect(sent.filter((request) => request.type !== "workspaceBackup:choose"))
      .toHaveLength(1);
    expect(JSON.stringify(hold.failure())).not.toContain("secret");
  });

  it("a pure choose failure or cancel alone creates no hold", async () => {
    const h = harness(() => failureReply(capacityA("workspaceBackup:choose")));
    await rejected(h.entry.query(chooseRequest));
    expect(h.hold.held()).toBe(false);
    const h2 = harness(() => envelope({present: true, value: null}));
    expect(await h2.entry.query(chooseRequest)).toBeNull();
    expect(h2.hold.held()).toBe(false);
  });

  it("held close closes the dialog only — no release, cleanup or mutation request", async () => {
    const h = harness(() => failureReply(unknownC("workspaceBackup:create")));
    await rejected(h.entry.create(createRequest));
    expect(h.hold.held()).toBe(true);
    expect(backupCloseReleaseAllowed(h.hold)).toBe(false);
    // Close and reopen with a fresh controller on the same root hold: the
    // dialog may unmount, but no release or mutation request is dispatched.
    const reopened = createBackupWriteEntry(h.hold, h.deps);
    for (const [, mutationRequest] of mutations) {
      await rejected(runMutation(reopened, mutationRequest));
    }
    expect(h.sent).toEqual([createRequest]);
    expect(h.prepares()).toBe(1);
  });

  it("healthy create/restore/open/choose keep their original values and the release contract", async () => {
    const sent: Request[] = [];
    const replies = new Map<string, unknown>([
      ["workspaceBackup:create", envelope({present: true, value: preview})],
      ["workspaceBackup:restore", envelope({present: true, value: restored})],
      ["workspaceBackup:open", envelope({present: false})],
      ["workspaceBackup:choose", envelope({present: true, value: null})],
    ]);
    const send = createDiagnosticRequest(async (request: Request) => {
      sent.push(request);
      return replies.get(request.type);
    });
    const hold = createBackupWriteHold();
    let prepares = 0;
    const entry = createBackupWriteEntry(hold, {
      send,
      prepare: async () => {
        prepares++;
      },
    });
    expect(await entry.create(createRequest)).toEqual(preview);
    expect(prepares).toBe(1);
    expect(await entry.write(restoreRequest)).toEqual(restored);
    expect(await entry.write(openRequest)).toBeUndefined();
    expect(await entry.query(chooseRequest)).toBeNull();
    expect(hold.held()).toBe(false);
    expect(sent).toEqual([createRequest, restoreRequest, openRequest, chooseRequest]);
    // Healthy close keeps the original release-then-close contract.
    expect(backupCloseReleaseAllowed(hold)).toBe(true);
  });

  it("renders fixed stop guidance with no raw cause, path or wire text", () => {
    const hold = createBackupWriteHold();
    hold.latch(new Error("raw transport /Users/alice/secret"), "workspaceBackup:create");
    const message = backupWriteHoldMessage(hold.failure());
    expect(message).toContain("未確認");
    expect(message).toContain("再送");
    expect(message).toContain("新しい保存");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("/Users/");
    const typed = createBackupWriteHold();
    typed.latch(new StorageFailureError(unknownC("workspaceBackup:restore")), "workspaceBackup:restore");
    const typedMessage = backupWriteHoldMessage(typed.failure());
    expect(typedMessage).toContain("確認・救出");
    expect(typedMessage).not.toContain("secret");
  });
});

describe("C04 backup write hold — actual App and dialog wiring", () => {
  it("App owns one root hold and routes every backup callback through the entry", () => {
    const source = readFileSync(resolve("src/renderer/App.tsx"), "utf8");
    expect(source).toContain('from "./workspace-backup/backup-write-hold"');
    expect(source).toContain("createBackupWriteHold()");
    expect(source).toContain("createBackupWriteEntry(hold, deps)");
    expect(source).toContain("deps.prepare = prepareWorkspaceBackup");
    expect(source).toContain("deps.prepareFailure = latchedRecoveryError");
    expect(source).toContain("backupLocalRefusal(");
    expect(source).toContain("backupHold={backupWriteHold}");
    expect(source).toContain("backupCloseReleaseAllowed(backupWriteHold)");
    expect(source).toContain('backupWriteEntry.create<BackupPreview>({type: "workspaceBackup:create"})');
    expect(source).toContain('backupWriteEntry.query<BackupPreview | null>({type: "workspaceBackup:choose"})');
    expect(source).toContain('backupWriteEntry.write<BackupRestored | null>({type: "workspaceBackup:restore"');
    expect(source).toContain('backupWriteEntry.write({type: "workspaceBackup:open"');
    // The healthy-close release contract is retained, gated behind the hold.
    expect(source).toContain('api({type: "workspaceBackup:release"})');
    const closeIndex = source.indexOf("backupCloseReleaseAllowed(backupWriteHold)");
    const releaseIndex = source.indexOf('api({type: "workspaceBackup:release"})');
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThan(closeIndex);
  });

  it("the dialog receives the hold as a read-only view and renders the fixed stop text", () => {
    const source = readFileSync(
      resolve("src/renderer/workspace-backup/WorkspaceBackupDialog.tsx"),
      "utf8",
    );
    expect(source).toContain('from "./backup-write-hold"');
    expect(source).toContain("backupHold?.held()");
    expect(source).toContain("backupWriteHoldMessage");
    // The dialog holds no authoritative hold of its own.
    expect(source).not.toContain("createBackupWriteHold");
  });
});
