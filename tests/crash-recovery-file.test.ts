import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrashRecoveryFile } from "../src/persistence/crash-recovery-file";
import { PrivateFilePublicationUnknownError } from "../src/platform/private-file-port";
import { getCheckpointGenerationConflict } from "../src/platform/private-mutation-diagnostic";
import { emptyCrashRecoverySnapshot, type CrashRecoverySnapshot } from "../src/shared/crash-recovery";
import type { CrashRecoveryNativePort, CrashRecoveryNativeRead } from "../src/platform/windows/recovery-file-port";

// In-memory native port: contract-only Windows branch coverage. The real CAS
// archive + v3 native chain is NOT_RUN; this is never OS acceptance.
const PATH = "C:\\Folio\\ws\\crash-recovery.json";
const WS = "ws-abc-123";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryPort(faults: {
  failCas?: boolean; corruptOnRead?: boolean; swapToken?: string;
  rejectExpected?: boolean; foreignWorkspace?: boolean;
} = {}): { port: CrashRecoveryNativePort; casCalls: number } {
  let head: CrashRecoveryNativeRead | undefined;
  let casCalls = 0;
  const port: CrashRecoveryNativePort = {
    contractVersion: 3,
    platform: "win32",
    read(path, workspaceId) {
      if (path !== PATH || workspaceId !== WS) return undefined;
      if (faults.corruptOnRead && head !== undefined)
        return { generation: head.generation, token: head.token, bytes: new Uint8Array([0xff, 0x00, 0x28]) };
      return head === undefined ? undefined : { ...head, bytes: Uint8Array.from(head.bytes) };
    },
    compareAndSwap(request) {
      casCalls++;
      if (request.path !== PATH || request.workspaceId !== WS) throw new Error("foreign");
      const current = head;
      if (request.expected === undefined) {
        if (current !== undefined || faults.rejectExpected) throw new Error("conflict");
      } else {
        if (current === undefined || current.generation !== request.expected.generation ||
            current.token !== request.expected.token ||
            !Buffer.from(current.bytes).equals(request.expected.bytes))
          throw new Error("conflict");
      }
      if (request.generation !== (current?.generation ?? 0) + 1) throw new Error("conflict");
      if (faults.failCas) throw new Error("unresolved publication");
      head = {
        generation: request.generation,
        token: faults.swapToken ?? "f".repeat(32),
        bytes: Uint8Array.from(request.bytes),
      };
      return { ...head, bytes: Uint8Array.from(head.bytes) };
    },
  };
  return { port, casCalls: 0 };
}

const snapshot = (): CrashRecoverySnapshot => emptyCrashRecoverySnapshot();
const tracked = (faults: Parameters<typeof memoryPort>[0] = {}) => {
  const state = { casCalls: 0 };
  const inner = memoryPort(faults);
  const port: CrashRecoveryNativePort = {
    contractVersion: 3, platform: "win32",
    read: (p, w) => inner.port.read(p, w),
    compareAndSwap: (r) => { state.casCalls++; return inner.port.compareAndSwap(r); },
  };
  return { port, state };
};

describe("CrashRecoveryFile Windows native branch (contract-only, NOT_RUN)", () => {
  it("publishes generation 1 then 2 through the native CAS port", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    expect(file.read()).toEqual({ status: "empty", generation: 0 });
    const first = file.write(0, snapshot());
    expect(first.status).toBe("ready");
    expect(first.generation).toBe(1);
    const second = file.write(1, snapshot());
    expect(second.status).toBe("ready");
    expect(second.generation).toBe(2);
    expect(state.casCalls).toBe(2);
    expect(file.read().generation).toBe(2);
  });

  it("reports a corrupt or foreign checkpoint as blocked, never empty", () => {
    const faults = {corruptOnRead: false};
    const { port } = tracked(faults);
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    file.write(0, snapshot());
    faults.corruptOnRead = true;
    const read = file.read();
    expect(read.status).toBe("blocked");
    // A blocked read means the write path must fail closed, not publish over it.
    expect(() => file.write(1, snapshot())).toThrow();
  });

  it("enforces exact prior token and bytes in the CAS race check", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    file.write(0, snapshot());
    // Generation skew is a deterministic conflict; nothing is dispatched.
    expect(() => file.write(3, snapshot())).toThrow(/generation changed/);
    expect(state.casCalls).toBe(1);
  });

  it("tags only the validated writeNative generation conflict", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    file.write(0, snapshot());
    let conflict: unknown;
    try { file.write(3, snapshot()); } catch (error) { conflict = error; }
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toBe("Recovery generation changed; checkpoint retained");
    expect((conflict as Error).name).toBe("Error");
    expect(getCheckpointGenerationConflict(conflict)).toMatchObject({
      kind: "GENERATION_CONFLICT", family: "CHECKPOINT", stage: "PRECONDITION",
      failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "VALIDATED_PRECONDITION", attemptId: null,
      sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"],
      precondition: {
        expectedGeneration: 3,
        observedActualGeneration: 1,
        mismatch: "GENERATION",
      },
    });
    expect(state.casCalls).toBe(1);
    expect(file.read()).toEqual({ status: "ready", generation: 1, snapshot: snapshot() });
  });

  it("tags an empty-vs-nonzero expected conflict without dispatching", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    let conflict: unknown;
    try { file.write(5, snapshot()); } catch (error) { conflict = error; }
    expect(conflict).toBeInstanceOf(Error);
    expect(getCheckpointGenerationConflict(conflict)?.precondition).toEqual({
      expectedGeneration: 5,
      observedActualGeneration: 0,
      mismatch: "GENERATION",
    });
    expect(state.casCalls).toBe(0);
    expect(file.read()).toEqual({ status: "empty", generation: 0 });
  });

  it("rejects a different valid snapshot at expected generation 0 but still recovers the original ACK", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    const original = snapshot();
    const different: CrashRecoverySnapshot = {
      ...original,
      unverifiedInputs: [{ reason: "different snapshot", input: "different" }],
    };

    const published = file.write(0, original);
    expect(published.status).toBe("ready");
    expect(published.generation).toBe(1);
    const casAfterPublish = state.casCalls;
    expect(casAfterPublish).toBe(1);

    let conflict: unknown;
    try { file.write(0, different); } catch (error) { conflict = error; }
    expect(conflict).toBeInstanceOf(Error);
    if (!(conflict instanceof Error)) throw new Error("expected generation conflict");
    expect(conflict.message).toBe("Recovery generation changed; checkpoint retained");
    expect(conflict.name).toBe("Error");
    expect(getCheckpointGenerationConflict(conflict)).toMatchObject({
      kind: "GENERATION_CONFLICT", family: "CHECKPOINT", stage: "PRECONDITION",
      failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "VALIDATED_PRECONDITION", attemptId: null,
      sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"],
      precondition: {
        expectedGeneration: 0,
        observedActualGeneration: 1,
        mismatch: "GENERATION",
      },
    });
    expect(state.casCalls).toBe(casAfterPublish);
    expect(file.read()).toEqual({ status: "ready", generation: 1, snapshot: original });

    const replay = file.write(0, original);
    expect(replay.status).toBe("ready");
    expect(replay.generation).toBe(1);
    expect(state.casCalls).toBe(casAfterPublish);
  });

  it("keeps identical APPLIED snapshot ACK recovery untagged and undispatched", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    file.write(0, snapshot());
    const replay = file.write(0, snapshot());
    expect(replay.status).toBe("ready");
    expect(replay.generation).toBe(1);
    expect(state.casCalls).toBe(1);
  });

  it("never tags read failures, invalid expected values, malformed reads or unresolved CAS", () => {
    const { port, state } = tracked();
    const readFailure: CrashRecoveryNativePort = {
      ...port,
      read: () => { throw new Error("read failed"); },
    };
    const readFile = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: readFailure });
    let readError: unknown;
    try { readFile.write(0, snapshot()); } catch (error) { readError = error; }
    expect(readError).toBeInstanceOf(Error);
    expect(getCheckpointGenerationConflict(readError)).toBeUndefined();

    const invalidFile = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    let invalidError: unknown;
    try { invalidFile.write(Number.MAX_SAFE_INTEGER, snapshot()); } catch (error) { invalidError = error; }
    expect(invalidError).toBeInstanceOf(Error);
    expect(getCheckpointGenerationConflict(invalidError)).toBeUndefined();
    expect(state.casCalls).toBe(0);

    const malformed: CrashRecoveryNativePort = {
      ...port,
      read: () => ({ generation: 1, token: "not-a-token", bytes: new Uint8Array() }),
    };
    const malformedFile = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: malformed });
    let malformedError: unknown;
    try { malformedFile.write(0, snapshot()); } catch (error) { malformedError = error; }
    expect(malformedError).toBeInstanceOf(Error);
    expect(getCheckpointGenerationConflict(malformedError)).toBeUndefined();

    const { port: casPort, state: casState } = tracked({ failCas: true });
    const casFile = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: casPort });
    let casError: unknown;
    try { casFile.write(0, snapshot()); } catch (error) { casError = error; }
    expect(casError).toBeInstanceOf(Error);
    expect(getCheckpointGenerationConflict(casError)).toBeUndefined();
    expect(casState.casCalls).toBe(1);
  });

  it("does not resend an identical already-published snapshot", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    file.write(0, snapshot());
    // Lost-ACK replay: generation already advanced, identical snapshot returns
    // ready with zero new dispatches.
    const replay = file.write(0, snapshot());
    expect(replay.status).toBe("ready");
    expect(replay.generation).toBe(1);
    expect(state.casCalls).toBe(1);
  });

  it("surfaces an unresolved CAS from the in-memory port", () => {
    const faults = { failCas: true };
    const { port, state } = tracked(faults);
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    expect(() => file.write(0, snapshot())).toThrow(/unresolved|artifacts/i);
    expect(state.casCalls).toBe(1);
    // Persistence/no-resend is covered by the real composed archive tests,
    // not by this intentionally nonpersistent in-memory fixture.
  });

  it("never touches the injected fs operations on the Windows branch", () => {
    const { port } = tracked();
    const ops = {
      openSync: () => { throw new Error("fs must not be used"); },
      closeSync: () => { throw new Error("fs must not be used"); },
      readFileSync: () => { throw new Error("fs must not be used"); },
      writeFileSync: () => { throw new Error("fs must not be used"); },
      fsyncSync: () => { throw new Error("fs must not be used"); },
      renameSync: () => { throw new Error("fs must not be used"); },
      lstatSync: () => { throw new Error("fs must not be used"); },
      realpathSync: Object.assign((): never => { throw new Error("fs must not be used"); },
        {native: (): never => { throw new Error("fs must not be used"); }}),
      fstatSync: () => { throw new Error("fs must not be used"); },
    };
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port, operations: ops });
    expect(file.write(0, snapshot()).status).toBe("ready");
  });

  it("fails explicitly on Windows without a native port and on async ports", () => {
    expect(() => new CrashRecoveryFile(PATH, WS, { platform: "win32" })).toThrow(/native port/);
    const { port } = tracked();
    const asyncPort = { ...port, read: async () => undefined };
    expect(() => new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: asyncPort as unknown as CrashRecoveryNativePort })).toThrow();
    const wrongVersion = { ...port, contractVersion: 2 };
    expect(() => new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: wrongVersion as unknown as CrashRecoveryNativePort })).toThrow();
  });

  it("POSIX branch keeps the durable rename checkpoint behavior", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-crash-native-")));
    dirs.push(dir);
    const file = new CrashRecoveryFile(join(dir, "crash-recovery.json"), WS);
    expect(file.read()).toEqual({ status: "empty", generation: 0 });
    const written = file.write(0, snapshot());
    expect(written.status).toBe("ready");
    expect(written.generation).toBe(1);
    expect(file.read().generation).toBe(1);
  });
});

describe("CrashRecoveryFile writeObserved (contract-only, NOT_RUN)", () => {
  it("returns a frozen RETURNED observation identical to a write result", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    const observed = file.writeObserved(0, snapshot());
    expect(observed).toEqual({
      terminal: "RETURNED",
      value: { status: "ready", generation: 1, snapshot: snapshot() },
    });
    expect(Object.isFrozen(observed)).toBe(true);
    if (observed.terminal !== "RETURNED") throw new Error("expected RETURNED");
    expect(Object.keys(observed).sort()).toEqual(["terminal", "value"]);
    expect(state.casCalls).toBe(1);
    const replay = file.writeObserved(0, snapshot());
    expect(replay).toMatchObject({ terminal: "RETURNED", value: { status: "ready", generation: 1 } });
    expect(state.casCalls).toBe(1);
  });

  it("captures the current own precondition conflict without dispatch", () => {
    const { port, state } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    file.write(0, snapshot());
    const observed = file.writeObserved(3, snapshot());
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(Error);
    const error = observed.value as Error;
    expect(error.message).toBe("Recovery generation changed; checkpoint retained");
    expect(observed.postPublication).toBeUndefined();
    expect(observed.generationConflict).toBeDefined();
    expect(observed.generationConflict).toBe(getCheckpointGenerationConflict(observed.value));
    expect(observed.generationConflict).toMatchObject({
      kind: "GENERATION_CONFLICT",
      family: "CHECKPOINT",
      stage: "PRECONDITION",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "VALIDATED_PRECONDITION",
      attemptId: null,
      sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"],
      precondition: {
        expectedGeneration: 3,
        observedActualGeneration: 1,
        mismatch: "GENERATION",
      },
    });
    expect(state.casCalls).toBe(1);
  });

  it("does not mint publication facts for an unregistered port", () => {
    const { port, state } = tracked({ failCas: true });
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    const observed = file.writeObserved(0, snapshot());
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const error = observed.value as PrivateFilePublicationUnknownError;
    expect((error.cause as Error).message).toBe("unresolved publication");
    expect(observed.postPublication).toBeUndefined();
    expect(observed.generationConflict).toBeUndefined();
    expect(state.casCalls).toBe(1);
  });

  it("reads the custom compareAndSwap member once and preserves the receiver", () => {
    const inner = tracked();
    let getterCalls = 0;
    const receivers: unknown[] = [];
    const port: CrashRecoveryNativePort = {
      contractVersion: 3,
      platform: "win32",
      read: (path, workspaceId) => inner.port.read(path, workspaceId),
      get compareAndSwap() {
        getterCalls += 1;
        return function (this: CrashRecoveryNativePort, request: Parameters<CrashRecoveryNativePort["compareAndSwap"]>[0]) {
          receivers.push(this);
          return inner.port.compareAndSwap(request);
        };
      },
    };
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    const before = getterCalls;
    const observed = file.writeObserved(0, snapshot());
    expect(observed.terminal).toBe("RETURNED");
    expect(getterCalls).toBe(before + 1);
    expect(receivers).toEqual([port]);
    receivers.length = 0;
    file.write(1, snapshot());
    expect(getterCalls).toBe(before + 2);
    expect(receivers).toEqual([port]);
  });

  it("throws a custom getter error before any request evaluation", () => {
    const inner = tracked();
    let failGetter = false;
    let getterCalls = 0;
    let invocations = 0;
    const getterError = new Error("custom getter failure");
    const port: CrashRecoveryNativePort = {
      contractVersion: 3,
      platform: "win32",
      read: (path, workspaceId) => inner.port.read(path, workspaceId),
      get compareAndSwap() {
        getterCalls += 1;
        if (failGetter) throw getterError;
        return (request: Parameters<CrashRecoveryNativePort["compareAndSwap"]>[0]) => {
          invocations += 1;
          return inner.port.compareAndSwap(request);
        };
      },
    };
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    failGetter = true;
    const baseline = getterCalls;
    const input = snapshot();
    const fromSpy = vi.spyOn(Uint8Array, "from");
    const observed = file.writeObserved(0, input);
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect((observed.value as PrivateFilePublicationUnknownError).cause).toBe(getterError);
    expect(getterCalls).toBe(baseline + 1);
    let legacyError: unknown;
    try {
      file.write(0, input);
      expect.unreachable();
    } catch (error) {
      legacyError = error;
    }
    expect(legacyError).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect((legacyError as PrivateFilePublicationUnknownError).cause).toBe(getterError);
    expect(getterCalls).toBe(baseline + 2);
    expect(invocations).toBe(0);
    expect(fromSpy).not.toHaveBeenCalled();
    fromSpy.mockRestore();
  });

  it("keeps invalid input and POSIX writes free of observed port facts", () => {
    const { port } = tracked();
    const file = new CrashRecoveryFile(PATH, WS, { platform: "win32", nativePort: port });
    const invalid = file.writeObserved(Number.MAX_SAFE_INTEGER, snapshot());
    expect(invalid.terminal).toBe("THREW");
    if (invalid.terminal !== "THREW") throw new Error("expected THREW");
    expect((invalid.value as Error).message).toBe("Invalid recovery generation");
    expect(invalid.postPublication).toBeUndefined();
    expect(invalid.generationConflict).toBeUndefined();

    const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-crash-observed-")));
    dirs.push(dir);
    const posix = new CrashRecoveryFile(join(dir, "crash-recovery.json"), WS);
    const written = posix.writeObserved(0, snapshot());
    expect(written).toMatchObject({ terminal: "RETURNED", value: { status: "ready", generation: 1 } });
    if (written.terminal !== "RETURNED") throw new Error("expected RETURNED");
    expect(Object.keys(written).sort()).toEqual(["terminal", "value"]);
    const blocked = posix.writeObserved(5, snapshot());
    expect(blocked.terminal).toBe("THREW");
    if (blocked.terminal !== "THREW") throw new Error("expected THREW");
    expect((blocked.value as Error).message).toBe("Recovery generation changed; checkpoint retained");
    expect(blocked.postPublication).toBeUndefined();
    expect(blocked.generationConflict).toBeUndefined();
    expect(getCheckpointGenerationConflict(blocked.value)).toBeUndefined();
  });
});
