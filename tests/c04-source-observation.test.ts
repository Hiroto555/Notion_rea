import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import { CrashRecoveryFile, getCrashRecoveryReadFailure } from "../src/persistence/crash-recovery-file";
import {
  retainStartupProtector,
  startupHasRetainedNativeLease,
  startupRetainsNativeLease,
} from "../src/persistence/startup-connection-owner";
import {
  getCheckpointPriorPending,
  propagateCheckpointPriorPending,
  recordCheckpointPriorPending,
} from "../src/platform/private-mutation-diagnostic";
import type { NativePrivateSqliteLease } from "../src/platform/private-persistence";
import type { CrashRecoveryNativePort } from "../src/platform/windows/recovery-file-port";
import { createPrivatePersistenceLifecycle } from "../src/main/private-persistence-lifecycle";
import { canonicalOperation } from "../src/shared/save-contract";
import { emptyCrashRecoverySnapshot } from "../src/shared/crash-recovery";

const ID_A = "a".repeat(32), ID_B = "b".repeat(32);
const PATH = "C:\\folio\\recovery\\crash-recovery.json";

const fakePort = (read: () => unknown): CrashRecoveryNativePort => ({
  contractVersion: 3,
  platform: "win32",
  read,
  compareAndSwap: () => { throw new Error("not reached"); },
} as CrashRecoveryNativePort);

describe("C04 source observation (contract-only)", () => {
  it("positively recognizes the actual retained protector through own data wrappers", () => {
    let retained: unknown;
    try {
      retainStartupProtector({} as NativePrivateSqliteLease, [new Error("close-failed")]);
    } catch (error) { retained = error; }
    expect(startupHasRetainedNativeLease(retained)).toBe(true);
    expect(startupRetainsNativeLease(retained)).toBe(true);
    const wrapped = new Error("outer", { cause: retained });
    expect(startupHasRetainedNativeLease(wrapped)).toBe(true);
    expect(startupHasRetainedNativeLease(new AggregateError([wrapped], "batch"))).toBe(true);
    // An unrelated unknown sibling cannot hide the known brand and its
    // accessor is never invoked.
    let getterCalled = false;
    const sibling = new Error("sibling");
    Object.defineProperty(sibling, "cause", { get: () => { getterCalled = true; return retained; } });
    expect(startupHasRetainedNativeLease(new AggregateError([sibling, wrapped], "mixed"))).toBe(true);
    expect(getterCalled).toBe(false);
  });

  it("returns false for ordinary, forged, cyclic, oversize and trap evidence", () => {
    expect(startupHasRetainedNativeLease(new Error("ordinary"))).toBe(false);
    expect(startupHasRetainedNativeLease("not an object")).toBe(false);
    const forged = new Error("Native SQLite protector close outcome unknown; owner retained");
    Object.defineProperties(forged, { retainedNativeLease: { value: {} }, code: { value: "UNKNOWN" } });
    expect(startupHasRetainedNativeLease(forged)).toBe(false);
    expect(startupRetainsNativeLease(forged)).toBe(false);
    const cyclic = new Error("cycle");
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(startupHasRetainedNativeLease(cyclic)).toBe(false);
    // Uncertainty alone keeps the conservative hold but is not positive proof.
    const oversize = new Error("held");
    Object.defineProperty(oversize, "errors", { value: new Array(200).fill(new Error("x")) });
    expect(startupRetainsNativeLease(oversize)).toBe(true);
    expect(startupHasRetainedNativeLease(oversize)).toBe(false);
    const accessor = new Error("held2");
    const entries: unknown[] = [];
    Object.defineProperty(entries, "0", { get: () => new Error("hidden") });
    Object.defineProperty(accessor, "errors", { value: entries });
    expect(startupRetainsNativeLease(accessor)).toBe(true);
    expect(startupHasRetainedNativeLease(accessor)).toBe(false);
    const trap = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    expect(startupHasRetainedNativeLease(trap)).toBe(false);
    expect(startupRetainsNativeLease(trap)).toBe(true);
    // A benign own cause accessor is ignored like the original walk: no
    // getter invocation, conservative false without other evidence.
    let accessorReads = 0;
    const accessorCause = new Error("ac");
    Object.defineProperty(accessorCause, "cause", { get: () => { accessorReads++; return new Error("hidden"); } });
    expect(startupHasRetainedNativeLease(accessorCause)).toBe(false);
    expect(startupRetainsNativeLease(accessorCause)).toBe(false);
    expect(accessorReads).toBe(0);
    const accessorErrors = new Error("ae");
    Object.defineProperty(accessorErrors, "errors", { get: () => { accessorReads++; return [new Error("hidden")]; } });
    expect(startupHasRetainedNativeLease(accessorErrors)).toBe(false);
    expect(startupRetainsNativeLease(accessorErrors)).toBe(false);
    expect(accessorReads).toBe(0);
  });

  it("binds the exact blocked read result to the original failure only", () => {
    const original = new CollaborationError("WINDOWS_RECOVERY_ARCHIVE_PENDING");
    recordCheckpointPriorPending(original, [ID_A]);
    const file = new CrashRecoveryFile(PATH, "ws-1",
      { platform: "win32", nativePort: fakePort(() => { throw original; }) });
    const result = file.read();
    expect(result.status).toBe("blocked");
    expect(result.generation).toBe(0);
    expect(result.message).toBe("WINDOWS_RECOVERY_ARCHIVE_PENDING");
    const failure = getCrashRecoveryReadFailure(result);
    expect(failure?.error).toBe(original);
    expect(failure?.priorPending?.attemptId).toBe(ID_A);
    // Identity only: a structural clone or look-alike carries nothing, and a
    // same-code error is not proof.
    expect(getCrashRecoveryReadFailure(structuredClone(result))).toBeUndefined();
    expect(getCrashRecoveryReadFailure({ ...result })).toBeUndefined();
    expect(getCheckpointPriorPending(new CollaborationError("WINDOWS_RECOVERY_ARCHIVE_PENDING"))).toBeUndefined();
  });

  it("leaves ready and empty reads without a sidecar", () => {
    const empty = new CrashRecoveryFile(PATH, "ws-1",
      { platform: "win32", nativePort: fakePort(() => undefined) }).read();
    expect(empty.status).toBe("empty");
    expect(getCrashRecoveryReadFailure(empty)).toBeUndefined();
    const snapshot = emptyCrashRecoverySnapshot();
    const body = { format: "folio-crash-recovery-v1", workspaceId: "ws-1", generation: 1, snapshot };
    const content = canonicalOperation({ ...body, checksum: createHash("sha256").update(canonicalOperation(body)).digest("hex") });
    const ready = new CrashRecoveryFile(PATH, "ws-1", { platform: "win32",
      nativePort: fakePort(() => ({ generation: 1, token: "0".repeat(32), bytes: Buffer.from(content, "utf8") })) }).read();
    expect(ready.status).toBe("ready");
    expect(getCrashRecoveryReadFailure(ready)).toBeUndefined();
  });

  it("records single and ambiguous prior-pending facts by exact identity", () => {
    const single = new Error("one");
    recordCheckpointPriorPending(single, [ID_A]);
    expect(getCheckpointPriorPending(single)).toMatchObject({
      kind: "OUTCOME_UNKNOWN", family: "CHECKPOINT", stage: "PRIOR_ATTEMPT",
      failureSubject: "PRIOR_ATTEMPT", mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE", attemptId: ID_A });
    const ambiguous = new Error("many");
    recordCheckpointPriorPending(ambiguous, [ID_A, ID_B]);
    expect(getCheckpointPriorPending(ambiguous)?.attemptId).toBeNull();
    // Causes are never explored: a wrapper of a recorded error proves nothing.
    expect(getCheckpointPriorPending(new Error("wrap", { cause: single }))).toBeUndefined();
  });

  it("rejects malformed pending lists and preserves the first association", () => {
    const rejected = (ids: unknown) => {
      const error = new Error("r");
      recordCheckpointPriorPending(error, ids as readonly string[]);
      expect(getCheckpointPriorPending(error)).toBeUndefined();
    };
    rejected([]);
    rejected("not-an-array");
    rejected(["bad-id"]);
    rejected([ID_A, "bad-id", ID_B]);
    rejected(Array.from({ length: 65 }, () => ID_A));
    let invoked = false;
    const accessorIds = [ID_A];
    Object.defineProperty(accessorIds, "0", { get: () => { invoked = true; return ID_A; } });
    rejected(accessorIds);
    expect(invoked).toBe(false);
    rejected(new Proxy([ID_A], { getOwnPropertyDescriptor: () => { throw new Error("trap"); } }));
    // First association wins: neither record nor known-wrapper propagate overwrites.
    const error = new Error("first");
    recordCheckpointPriorPending(error, [ID_A]);
    recordCheckpointPriorPending(error, [ID_B]);
    expect(getCheckpointPriorPending(error)?.attemptId).toBe(ID_A);
    const wrapper = new Error("wrapper");
    recordCheckpointPriorPending(wrapper, [ID_B]);
    propagateCheckpointPriorPending(wrapper, error);
    expect(getCheckpointPriorPending(wrapper)?.attemptId).toBe(ID_B);
    const fresh = new Error("fresh");
    propagateCheckpointPriorPending(fresh, error);
    expect(getCheckpointPriorPending(fresh)?.attemptId).toBe(ID_A);
    propagateCheckpointPriorPending(fresh, wrapper);
    expect(getCheckpointPriorPending(fresh)?.attemptId).toBe(ID_A);
  });

  it("finds the actual brand through safe branches a descriptor trap cannot hide", () => {
    let retained: unknown;
    try {
      retainStartupProtector({} as NativePrivateSqliteLease, [new Error("sentinel")]);
    } catch (error) { retained = error; }
    // errors is a Proxy whose every own-descriptor trap throws; the
    // independent own-data cause branch still reaches the actual brand.
    const root1 = new Error("root1");
    (root1 as { cause?: unknown }).cause = retained;
    Object.defineProperty(root1, "errors", {
      value: new Proxy([], { getOwnPropertyDescriptor: () => { throw new Error("trap"); } }),
    });
    expect(startupHasRetainedNativeLease(root1)).toBe(true);
    expect(startupRetainsNativeLease(root1)).toBe(true);
    // A trap on index 0 must not hide the real brand at index 1.
    const root2 = new Error("root2");
    Object.defineProperty(root2, "errors", {
      value: new Proxy([new Error("plain"), retained], {
        getOwnPropertyDescriptor: (target, prop) => {
          if (prop === "0") throw new Error("trap");
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      }),
    });
    expect(startupHasRetainedNativeLease(root2)).toBe(true);
    expect(startupRetainsNativeLease(root2)).toBe(true);
    // The trap alone is only uncertainty: positive false, conservative held.
    expect(startupHasRetainedNativeLease(Object.getOwnPropertyDescriptor(root1, "errors")?.value)).toBe(false);
    expect(startupRetainsNativeLease(Object.getOwnPropertyDescriptor(root1, "errors")?.value)).toBe(true);
  });

  it("latches the original failure through lifecycle observe and run despite traps", async () => {
    let retained: unknown;
    try {
      retainStartupProtector({} as NativePrivateSqliteLease, [new Error("sentinel")]);
    } catch (error) { retained = error; }
    const roots: Error[] = [];
    const root1 = new Error("root1");
    (root1 as { cause?: unknown }).cause = retained;
    Object.defineProperty(root1, "errors", {
      value: new Proxy([], { getOwnPropertyDescriptor: () => { throw new Error("trap"); } }),
    });
    roots.push(root1);
    const root2 = new Error("root2");
    Object.defineProperty(root2, "errors", {
      value: new Proxy([new Error("plain"), retained], {
        getOwnPropertyDescriptor: (target, prop) => {
          if (prop === "0") throw new Error("trap");
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
      }),
    });
    roots.push(root2);
    for (const root of roots) {
      const observing = createPrivatePersistenceLifecycle();
      observing.observe(root);
      expect(observing.isUsable()).toBe(false);
      expect(observing.retainedFailure()).toBe(root);
      const sync = createPrivatePersistenceLifecycle();
      let caught: unknown;
      try { sync.run(() => { throw root; }); } catch (error) { caught = error; }
      expect(caught).toBe(root);
      expect(sync.isUsable()).toBe(false);
      expect(sync.retainedFailure()).toBe(root);
      const asyncLife = createPrivatePersistenceLifecycle();
      let rejected: unknown;
      try { await asyncLife.run(async () => { throw root; }); } catch (error) { rejected = error; }
      expect(rejected).toBe(root);
      expect(asyncLife.isUsable()).toBe(false);
      expect(asyncLife.retainedFailure()).toBe(root);
    }
  });
});
