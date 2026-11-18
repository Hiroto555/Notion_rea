import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS,
  WindowsHotJournalSnapshotError,
  createWindowsHotJournalSnapshot,
  type WindowsHotJournalSnapshotExecRequest,
  type WindowsHotJournalSnapshotExecResult,
  type WindowsHotJournalSnapshotInspection,
  type WindowsHotJournalSnapshotReleaseAuthority,
  type WindowsHotJournalSnapshotRequest,
  type WindowsHotJournalSnapshotTestPort,
} from "../src/platform/windows/hot-journal-snapshot";

// Contract-only coverage: the injected transport is an untrusted simulation.
// Passing these tests is NOT Windows OS/filesystem acceptance.
const ROOT = "C:\\Folio";
const PARENT = `${ROOT}\\private`;
const TARGET = `${PARENT}\\state.sqlite`;
const SLOT_DIR = `${PARENT}\\.folio-hot-snapshot-0`;
const SNAPSHOT_PATH = `${SLOT_DIR}\\snapshot.sqlite`;
const ATTEMPT_ID = "a".repeat(32);
const ARCHIVE_DIR = `${PARENT}\\.folio-hot-archive-${ATTEMPT_ID}`;
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("in-memory pinned executable fixture");
const EXE_HASH = createHash("sha256").update(EXE_BYTES).digest("hex");
const ROOT_ID = "1".repeat(32);
const DIR_ID = "2".repeat(32);
const FILE_ID = "3".repeat(32);
const JOURNAL_ID = "5".repeat(32);
const SLOT_ID = "7".repeat(32);
const VOL = "4".repeat(16);
const SID = "S-1-5-21-1000";
const MAIN_HASH = createHash("sha256").update("main").digest("hex");
const FINGERPRINT = createHash("sha256").update("fingerprint").digest("hex");
const AUTHORITY_FINGERPRINT = "authority-fingerprint-current-epoch";

function statFor(size: number) {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    nlink: 1,
    dev: 1,
    ino: 1,
    size,
    mtimeMs: 1,
  };
}

function proof(canonicalPath: string, fileId: string) {
  return {
    platform: "win32",
    sid: SID,
    ownerSid: SID,
    daclPrivate: true,
    reparsePoint: false,
    linkCount: 1,
    localFilesystem: true,
    fileId,
    rootFileId: ROOT_ID,
    volumeId: VOL,
    rootVolumeId: VOL,
    canonicalPath,
    canonicalRoot: ROOT,
  };
}

function sources() {
  return [
    {
      suffix: "",
      present: true,
      byteLength: 100,
      sha256: MAIN_HASH,
      evidence: proof(TARGET, FILE_ID),
    },
    {
      suffix: "-journal",
      present: true,
      byteLength: 50,
      sha256: createHash("sha256").update("journal").digest("hex"),
      evidence: proof(`${TARGET}-journal`, JOURNAL_ID),
    },
    { suffix: "-wal", present: false },
    { suffix: "-shm", present: false },
  ];
}

function envelope(operation: string, state: string, attemptId: string) {
  return {
    version: 1,
    operation,
    state,
    path: TARGET,
    root: ROOT,
    profile: "small-ledger",
    attemptId,
    slot: 0,
  };
}

function snapshotReply(attemptId: string) {
  return {
    ...envelope("snapshot", "SNAPSHOT", attemptId),
    snapshotDirectory: SLOT_DIR,
    snapshotPath: SNAPSHOT_PATH,
    sources: sources(),
    directory: proof(PARENT, DIR_ID),
    slotDirectory: proof(SLOT_DIR, SLOT_ID),
  };
}

function revalidateReply(attemptId: string) {
  return {
    ...envelope("revalidate", "REVALIDATED", attemptId),
    sources: sources(),
    directory: proof(PARENT, DIR_ID),
    slotDirectory: proof(SLOT_DIR, SLOT_ID),
  };
}

function sealReply(attemptId: string) {
  return {
    ...envelope("seal", "SEALED", attemptId),
    directory: proof(PARENT, DIR_ID),
    slotDirectory: proof(SLOT_DIR, SLOT_ID),
  };
}

function inspectReply(
  attemptId: string,
  overrides: Record<string, unknown> = {},
  archived = false,
) {
  return {
    ...envelope("inspect", "INSPECTED", attemptId),
    fingerprint: FINGERPRINT,
    inspectionState: archived ? "RELEASED" : "REVALIDATED",
    evidence: {
      reference: {
        attemptId,
        slot: 0,
        slotFileId: SLOT_ID,
        slotVolumeId: VOL,
      },
      sources: sources(),
      files: ["intent.json", "prepared.json", "revalidated.json", "captures.json", "source.sqlite", "source.sqlite-journal",
        ...(archived ? ["release-intent.json", "released.json", "release-capture.json"] : [])].map((name, index) => ({
          name,
          present: true,
          fileId: (index + 9).toString(16).padStart(32, "0"),
          volumeId: VOL,
          byteLength: 10,
          sha256: MAIN_HASH,
        })),
      directory: proof(PARENT, DIR_ID),
      slotDirectory: proof(archived ? `${PARENT}\\.folio-hot-archive-${attemptId}` : SLOT_DIR, SLOT_ID),
    },
    ...overrides,
  };
}

function releaseReply(attemptId: string) {
  const archive = `${PARENT}\\.folio-hot-archive-${attemptId}`;
  return {
    ...envelope("release", "RELEASED", attemptId),
    archive,
    fingerprint: FINGERPRINT,
    directory: proof(PARENT, DIR_ID),
    slotDirectory: proof(archive, SLOT_ID),
  };
}

function committedReply(attemptId: string) {
  const archive = `${PARENT}\\.folio-hot-archive-${attemptId}`;
  return {...envelope("commit-release-evidence", "EVIDENCE_COMMITTED", attemptId),
    archive, directory: proof(PARENT, DIR_ID), slotDirectory: proof(archive, SLOT_ID)};
}

// Native failure replies carry no profile field; the strict failure record
// only permits the base envelope, an optional slot and the reason.
function failureReply(
  operation: string,
  attemptId: string,
  state: "REJECTED" | "UNKNOWN",
  reason: string,
) {
  return {
    version: 1,
    operation,
    state,
    path: TARGET,
    root: ROOT,
    attemptId,
    slot: 0,
    reason,
  };
}

type ReplyOutcome = Readonly<{ body: object; status?: number }> | null;

function fixture() {
  // Lifecycle call counts below are core operations; the separate capture
  // protocol suite checks all evidence operations and their failure boundary.
  const calls: WindowsHotJournalSnapshotExecRequest[] = [];
  const wires: Record<string, unknown>[] = [];
  let executable: Buffer = EXE_BYTES;
  let onExec:
    | ((wire: Record<string, unknown>) => ReplyOutcome)
    | undefined;
  const port = {
    fs: {
      lstat(path: string) {
        if (path !== EXE) {
          const error = new Error("ENOENT") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return statFor(executable.length) as ReturnType<
          WindowsHotJournalSnapshotTestPort["fs"]["lstat"]
        >;
      },
      readFile(path: string) {
        if (path !== EXE) throw new Error("unexpected readFile");
        return executable;
      },
    },
    exec(
      request: WindowsHotJournalSnapshotExecRequest,
    ): WindowsHotJournalSnapshotExecResult {
      const wire = JSON.parse(
        Buffer.from(request.input).toString("utf8"),
      ) as Record<string, unknown>;
      if ((wire.operation as string).startsWith("capture-"))
        return {status: 0, signal: null, stderr: "", captureEncoding: "latin1",
          stdout: JSON.stringify({
            version: 1, operation: wire.operation, state: "CAPTURE_ACK",
            path: wire.path, root: ROOT, profile: wire.profile, attemptId: wire.attemptId,
            captureId: wire.captureId, capturePhase: wire.capturePhase,
            requestSha256: createHash("sha256").update(request.input).digest("hex"),
            directory: proof(PARENT, DIR_ID),
            captureDirectory: proof(`${PARENT}\\.folio-hot-capture-${wire.captureId}`, "8".repeat(32)),
          })};
      calls.push(request);
      wires.push(wire);
      const outcome =
        onExec === undefined
          ? wire.operation === "snapshot"
            ? { body: snapshotReply(wire.attemptId as string) }
            : wire.operation === "revalidate"
              ? { body: revalidateReply(wire.attemptId as string) }
              : wire.operation === "seal"
                ? { body: sealReply(wire.attemptId as string) }
                : wire.operation === "inspect"
                  ? { body: inspectReply(wire.attemptId as string, {}, wire.archived === true) }
                  : wire.operation === "commit-release-evidence"
                    ? {body: committedReply(wire.attemptId as string)}
                    : { body: releaseReply(wire.attemptId as string) }
          : onExec(wire);
      if (outcome === null)
        return {
          status: null,
          signal: "SIGKILL",
          stdout: "",
          stderr: "",
          captureEncoding: "latin1",
        };
      return {
        status: outcome.status ?? 0,
        signal: null,
        stdout: JSON.stringify(outcome.body),
        stderr: "",
        captureEncoding: "latin1",
      };
    },
  };
  const options = {
    root: ROOT,
    probeExecutable: EXE,
    expectedHash: EXE_HASH,
    systemRoot: "C:\\Windows",
  };
  return {
    calls,
    wires,
    port,
    options,
    set executable(value: Buffer) {
      executable = value;
    },
    set onExec(
      handler: ((wire: Record<string, unknown>) => ReplyOutcome) | undefined,
    ) {
      onExec = handler;
    },
    make() {
      return createWindowsHotJournalSnapshot(options, port);
    },
    request(): WindowsHotJournalSnapshotRequest {
      return {
        path: TARGET,
        expectedDirectory: {
          canonicalPath: PARENT,
          directoryFileId: DIR_ID,
          directoryVolumeId: VOL,
          rootFileId: ROOT_ID,
          rootVolumeId: VOL,
        },
        expectedFile: {
          canonicalPath: TARGET,
          fileId: FILE_ID,
          volumeId: VOL,
        },
      };
    },
  };
}

function referenceOf(wire: Record<string, unknown>) {
  return {
    attemptId: wire.attemptId as string,
    slot: 0,
    slotFileId: SLOT_ID,
    slotVolumeId: VOL,
  };
}

function authority(
  overrides: Partial<WindowsHotJournalSnapshotReleaseAuthority> = {},
): WindowsHotJournalSnapshotReleaseAuthority {
  return {
    fingerprint: AUTHORITY_FINGERPRINT,
    assertCurrent() {},
    ...overrides,
  };
}

function expectError(work: () => unknown, code: string) {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(WindowsHotJournalSnapshotError);
    expect((error as WindowsHotJournalSnapshotError).code).toBe(code);
    return error as WindowsHotJournalSnapshotError;
  }
  throw new Error(`expected ${code}`);
}

describe("windows hot journal snapshot lifecycle (contract only)", () => {
  it("seals a snapshot, inspects it, and releases it explicitly", () => {
    const f = fixture();
    const controller = f.make();
    controller.withSnapshot(f.request(), () => {});
    expect(f.wires.map((wire) => wire.operation)).toEqual([
      "snapshot",
      "revalidate",
      "seal",
    ]);
    const reference = referenceOf(f.wires[0]);
    const inspection = controller.inspectSnapshot(f.request(), reference);
    expect(inspection.state).toBe("REVALIDATED");
    expect(inspection.fingerprint).toBe(FINGERPRINT);
    expect(inspection.reference.attemptId).toBe(reference.attemptId);
    const inspectWire = f.wires[3];
    expect(inspectWire).toMatchObject({
      operation: "inspect",
      attemptId: reference.attemptId,
      slot: 0,
      slotFileId: SLOT_ID,
      slotVolumeId: VOL,
      profile: "small-ledger",
    });
    controller.releaseSnapshot(f.request(), inspection, authority());
    const releaseWire = f.wires[4];
    expect(releaseWire).toMatchObject({
      operation: "release",
      attemptId: reference.attemptId,
      slot: 0,
      fingerprint: FINGERPRINT,
      authorityFingerprint: AUTHORITY_FINGERPRINT,
      inspectionState: "REVALIDATED",
    });
    // Normal preflight never released anything: no release wire was sent
    // during withSnapshot.
    expect(
      f.wires.filter((wire) => wire.operation === "release"),
    ).toHaveLength(1);
    expect(f.wires[5].operation).toBe("commit-release-evidence");
    const capture = f.wires[5].capture as Record<string, {value: string; byteLength: number; sha256: string}>;
    const bytes = Buffer.from(capture.response.value, "base64");
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(releaseReply(reference.attemptId));
    expect(bytes.length).toBe(capture.response.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture.response.sha256);
    expect(capture.stderr).toEqual({value: "", byteLength: 0, sha256: createHash("sha256").digest("hex")});
    expectError(() => controller.releaseSnapshot(f.request(), inspection, authority()), "WINDOWS_HOT_JOURNAL_SNAPSHOT_CONSUMED");
    expect(f.wires).toHaveLength(6);
    const retained = f.make().inspectSnapshot(f.request(), reference, true);
    expect(retained.state).toBe("RELEASED");
  });

  it("inspects a sealed slot on a fresh controller without prior evidence", () => {
    const f = fixture();
    f.make().withSnapshot(f.request(), () => {});
    const reference = referenceOf(f.wires[0]);
    const fresh = f.make();
    const inspection = fresh.inspectSnapshot(f.request(), reference);
    expect(inspection.state).toBe("REVALIDATED");
    expect(inspection.reference).toEqual(reference);
    expect(f.wires[f.wires.length - 1].operation).toBe("inspect");
  });

  it("fails closed if terminal evidence commit is UNKNOWN and never releases again", () => {
    const f = fixture();
    const controller = f.make();
    const reference = referenceOf({attemptId: ATTEMPT_ID});
    const inspection = controller.inspectSnapshot(f.request(), reference);
    f.onExec = wire => wire.operation === "release"
      ? {body: releaseReply(ATTEMPT_ID)}
      : {body: failureReply("commit-release-evidence", ATTEMPT_ID, "UNKNOWN", "PRIVATE_JOURNAL_SNAPSHOT_UNKNOWN"), status: 3};
    const error = expectError(() => controller.releaseSnapshot(f.request(), inspection, authority()),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN");
    expect(f.wires.map(w => w.operation)).toEqual(["inspect", "release", "commit-release-evidence"]);
    expect(JSON.stringify(error.evidence)).toContain("requestBase64");
    expectError(() => controller.releaseSnapshot(f.request(), inspection, authority()), "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
    expect(f.wires).toHaveLength(3);
  });

  it("commits supplied exact release capture on a fresh controller without a release dispatch", () => {
    const f = fixture();
    const capture = {
      request: Buffer.from(JSON.stringify({operation: "release", attemptId: ATTEMPT_ID})).toString("base64"),
      response: Buffer.from(JSON.stringify(releaseReply(ATTEMPT_ID))).toString("base64"),
      stderr: "",
    };
    // The test port simulates native validation. Production additionally
    // compares all request/receipt identities and the persisted release intent.
    const controller = f.make();
    controller.commitReleaseEvidence(f.request(), referenceOf({attemptId: ATTEMPT_ID}), capture);
    expect(f.wires.map(w => w.operation)).toEqual(["commit-release-evidence"]);
    expectError(() => controller.commitReleaseEvidence(f.request(), referenceOf({attemptId: ATTEMPT_ID}), capture),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_CONSUMED");
    expect(f.calls).toHaveLength(1);
  });

  it("rejects REVALIDATED without persisted receipts or a pinned slot", () => {
    for (const mutation of ["files", "slotDirectory"] as const) {
      const f = fixture(), controller = f.make();
      f.onExec = wire => {
        const reply = inspectReply(wire.attemptId as string);
        return {body: {...reply, evidence: {...reply.evidence,
          [mutation]: mutation === "files" ? [] : null}}};
      };
      expectError(() => controller.inspectSnapshot(f.request(), referenceOf({attemptId: ATTEMPT_ID})),
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_EVIDENCE");
    }
  });

  it("preserves throw undefined from authority and seals the controller", () => {
    const f = fixture(), controller = f.make();
    const inspection = controller.inspectSnapshot(f.request(), referenceOf({attemptId: ATTEMPT_ID}));
    let failed = false;
    try { controller.releaseSnapshot(f.request(), inspection, authority({assertCurrent() {throw undefined;}})); }
    catch (error) { failed = true; expect(error).toBeUndefined(); }
    expect(failed).toBe(true);
    expect(f.calls).toHaveLength(1);
    expectError(() => controller.releaseSnapshot(f.request(), inspection, authority()), "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
  });

  it("rejects release when the source fingerprint no longer matches", () => {
    const f = fixture();
    const controller = f.make();
    const inspection: WindowsHotJournalSnapshotInspection = {
      reference: referenceOf({ attemptId: ATTEMPT_ID }),
      state: "REVALIDATED",
      fingerprint: FINGERPRINT,
      evidence: {},
    };
    // The native recomputes the fingerprint over CURRENT state and reports
    // UNKNOWN: a stale inspection never releases and is never resent.
    f.onExec = (wire) => ({
      body: failureReply(
        "release",
        wire.attemptId as string,
        "UNKNOWN",
        "PRIVATE_JOURNAL_SNAPSHOT_UNKNOWN",
      ),
      status: 3,
    });
    expectError(
      () => controller.releaseSnapshot(f.request(), inspection, authority()),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
    );
    expect(f.calls).toHaveLength(1);
    expectError(() => controller.releaseSnapshot(f.request(), inspection, authority()), "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
    expect(f.calls).toHaveLength(1);
  });

  it("rejects release for an UNKNOWN inspection state before any dispatch", () => {
    const f = fixture();
    const controller = f.make();
    const inspection: WindowsHotJournalSnapshotInspection = {
      reference: referenceOf({ attemptId: ATTEMPT_ID }),
      state: "UNKNOWN",
      fingerprint: FINGERPRINT,
      evidence: {},
    };
    expectError(
      () => controller.releaseSnapshot(f.request(), inspection, authority()),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_INSPECTION",
    );
    expect(f.calls).toHaveLength(0);
  });

  it("rejects a replaced slot File ID and an absent slot identity", () => {
    const f = fixture();
    const controller = f.make();
    f.onExec = (wire) => ({
      body: {
        ...envelope("inspect", "INSPECTED", wire.attemptId as string),
        fingerprint: FINGERPRINT,
        inspectionState: "UNKNOWN",
        evidence: {
          reference: {
            attemptId: wire.attemptId,
            slot: 0,
            slotFileId: "9".repeat(32),
            slotVolumeId: VOL,
          },
          sources: [],
          files: [],
          directory: proof(PARENT, DIR_ID),
          slotDirectory: null,
        },
      },
    });
    expectError(
      () =>
        controller.inspectSnapshot(
          f.request(),
          referenceOf({ attemptId: ATTEMPT_ID }),
        ),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_REFERENCE",
    );
  });

  it("poisons on async, non-void or throwing-into-mutation authority callbacks", () => {
    const f = fixture();
    const controller = f.make();
    const inspection: WindowsHotJournalSnapshotInspection = {
      reference: referenceOf({ attemptId: ATTEMPT_ID }),
      state: "REVALIDATED",
      fingerprint: FINGERPRINT,
      evidence: {},
    };
    expectError(
      () =>
        controller.releaseSnapshot(f.request(), inspection, {
          fingerprint: AUTHORITY_FINGERPRINT,
          assertCurrent: (() => 1) as unknown as () => void,
        }),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_AUTHORITY",
    );
    expect(f.calls).toHaveLength(0);
    // The poison is stable: a clean authority is still refused.
    expectError(
      () => controller.releaseSnapshot(f.request(), inspection, authority()),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED",
    );
  });

  it("poisons on an async authority function", () => {
    const f = fixture();
    const controller = f.make();
    const inspection: WindowsHotJournalSnapshotInspection = {
      reference: referenceOf({ attemptId: ATTEMPT_ID }),
      state: "REVALIDATED",
      fingerprint: FINGERPRINT,
      evidence: {},
    };
    expectError(
      () =>
        controller.releaseSnapshot(f.request(), inspection, {
          fingerprint: AUTHORITY_FINGERPRINT,
          assertCurrent: (async () => {}) as unknown as () => void,
        }),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_AUTHORITY",
    );
    expectError(
      () => controller.releaseSnapshot(f.request(), inspection, authority()),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED",
    );
    expect(f.calls).toHaveLength(0);
  });

  it("runs the authority before and after release and surfaces its failure", () => {
    const f = fixture();
    const controller = f.make();
    const inspection: WindowsHotJournalSnapshotInspection = {
      reference: referenceOf({ attemptId: ATTEMPT_ID }),
      state: "REVALIDATED",
      fingerprint: FINGERPRINT,
      evidence: {},
    };
    const calls: string[] = [];
    const semantic = new Error("authority lost current epoch");
    try {
      controller.releaseSnapshot(f.request(), inspection, {
        fingerprint: AUTHORITY_FINGERPRINT,
        assertCurrent() {
          calls.push("assert");
          if (calls.length === 2) throw semantic;
        },
      });
    } catch (error) {
      expect(error).toBe(semantic);
    }
    // The release itself succeeded; the post-response authority failure is
    // surfaced, never silently dropped.
    expect(calls).toEqual(["assert", "assert"]);
    expect(f.wires[f.wires.length - 1].operation).toBe("commit-release-evidence");
    expectError(() => controller.releaseSnapshot(f.request(), inspection, authority()), "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
  });

  it("rejects a malformed inspection reply", () => {
    const f = fixture();
    const controller = f.make();
    f.onExec = (wire) => ({
      body: { ...inspectReply(wire.attemptId as string), evidence: "broken" },
    });
    expectError(
      () =>
        controller.inspectSnapshot(
          f.request(),
          referenceOf({ attemptId: ATTEMPT_ID }),
        ),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_SCHEMA",
    );
    expect(f.calls).toHaveLength(1);
  });

  it("returns UNKNOWN state on an unsealed slot and release refuses it", () => {
    const f = fixture();
    const controller = f.make();
    f.onExec = (wire) => ({
      body: inspectReply(wire.attemptId as string, {
        inspectionState: "UNKNOWN",
      }),
    });
    const inspection = controller.inspectSnapshot(
      f.request(),
      referenceOf({ attemptId: ATTEMPT_ID }),
    );
    expect(inspection.state).toBe("UNKNOWN");
    // A slot that is not REVALIDATED can never be released.
    expectError(
      () => controller.releaseSnapshot(f.request(), inspection, authority()),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_INSPECTION",
    );
    expect(f.calls).toHaveLength(1);
  });

  it("propagates a native UNKNOWN on inspection without resend", () => {
    const f = fixture();
    const controller = f.make();
    f.onExec = (wire) => ({
      body: failureReply(
        "inspect",
        wire.attemptId as string,
        "UNKNOWN",
        "PRIVATE_JOURNAL_SNAPSHOT_UNKNOWN",
      ),
      status: 3,
    });
    expectError(
      () =>
        controller.inspectSnapshot(
          f.request(),
          referenceOf({ attemptId: ATTEMPT_ID }),
        ),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
    );
    expect(f.calls).toHaveLength(1);
  });

  it("keeps capacity at four attempts including lifecycle operations", () => {
    const f = fixture();
    const controller = f.make();
    for (let index = 0; index < WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS; index++)
      controller.withSnapshot(f.request(), () => {});
    expectError(
      () =>
        controller.inspectSnapshot(
          f.request(),
          referenceOf({ attemptId: ATTEMPT_ID }),
        ),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_CONSUMED",
    );
    expect(f.wires).toHaveLength(12);
  });

  it("a thrown native release retains evidence and never resends", () => {
    const f = fixture();
    const controller = f.make();
    const inspection: WindowsHotJournalSnapshotInspection = {
      reference: referenceOf({ attemptId: ATTEMPT_ID }),
      state: "REVALIDATED",
      fingerprint: FINGERPRINT,
      evidence: {},
    };
    f.onExec = () => {
      throw new Error("transport exploded");
    };
    const error = expectError(
      () => controller.releaseSnapshot(f.request(), inspection, authority()),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
    );
    // The failure kept its immutable attempt evidence and nothing resent.
    expect(f.calls).toHaveLength(1);
    const evidence = error.evidence as {
      events?: { phase: string; captured?: object }[];
    } | null;
    expect(evidence?.events?.[0]?.phase).toBe("release");
    expect(controller.inspectEvidence()).toHaveLength(1);
    expectError(() => controller.releaseSnapshot(f.request(), inspection, authority()), "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
    expect(f.calls).toHaveLength(1);
  });
});

describe("windows app private binding wrapper with injected runtime", () => {
  afterEach(() => {
    vi.doUnmock("../src/platform/windows/runtime-platform");
    vi.doUnmock("../src/platform/windows/source-binding-guard");
    vi.doUnmock("../src/platform/windows/authority-lease");
    vi.resetModules();
  });

  async function bindingFixture(options: {enroll?: boolean; receipt?: boolean} = {}) {
    const state = {
      exists: true, fileId: FILE_ID, retained: FILE_ID as string | undefined,
      creates: 0, prepares: 0, databaseChecks: 0, syncs: 0,
      runtimeCloseError: undefined as Error | undefined,
      bindingCloseError: undefined as Error | undefined,
      constructorProfiles: [] as unknown[],
      acquired: [] as {root: string; path: string; fileId: string; closed: boolean}[],
    };
    vi.resetModules();
    vi.doMock("../src/platform/windows/runtime-platform", () => ({
      WindowsRuntimePlatform: class {
        readonly databaseName: string;
        private bound = false;
        private path = "";
        constructor(input: {databaseName: string; snapshotProfile?: unknown}) {
          this.databaseName = input.databaseName;
          state.constructorProfiles.push(input.snapshotProfile);
          if (options.receipt === false)
            Object.defineProperty(this, "createExclusiveDurablyWithReceipt", {value: undefined});
        }
        bind(path: string) { if (this.bound) throw new Error("already bound"); this.bound = true; this.path = path; return path; }
        prepareDirectory() { state.prepares++; }
        assertRoot() { if (!this.bound) throw new Error("identity before bind"); }
        validatedDirectoryIdentity() {
          this.assertRoot();
          return {canonicalPath: this.path, directoryFileId: this.path === ROOT ? ROOT_ID : DIR_ID, directoryVolumeId: VOL, rootFileId: ROOT_ID, rootVolumeId: VOL};
        }
        validatedFileIdentity(path: string) {
          this.assertRoot();
          if (!state.exists) throw new Error("missing file");
          if (!path.endsWith(this.databaseName)) throw new Error("not the named database");
          return {canonicalPath: path, fileId: state.fileId, volumeId: VOL};
        }
        validatedPrivateFileIdentity(path: string) {
          this.assertRoot();
          return {canonicalPath: path, fileId: state.fileId, volumeId: VOL};
        }
        assertFile(path: string) { this.validatedFileIdentity(path); }
        assertDatabase(path: string) { this.assertFile(path); state.databaseChecks++; }
        assertSidecars() { this.assertRoot(); }
        assertEmptyFile() { this.assertRoot(); }
        createExclusiveDirectory() { this.assertRoot(); return {state: "CREATED"}; }
        createExclusiveDurably() { this.assertRoot(); state.creates++; state.exists = true; }
        createExclusiveDurablyWithReceipt(path: string) {
          const created = !state.exists;
          this.createExclusiveDurably();
          return {state: created ? "CREATED" : "EXISTING", identity: this.validatedFileIdentity(path)};
        }
        syncCreatedDatabase() { this.assertRoot(); state.syncs++; }
        close() { if (state.runtimeCloseError) throw state.runtimeCloseError; }
      },
    }));
    vi.doMock("../src/platform/windows/source-binding-guard", () => ({
      createWindowsSourceBindingGuard(_config: unknown, enroll: boolean) {
        return {
          directory() {},
          file(identity: {fileId: string}, newlyCreated = false) {
            if (state.retained !== undefined && state.retained !== identity.fileId) throw new Error("binding mismatch");
            if (enroll || newlyCreated) state.retained = identity.fileId;
            if (state.retained === undefined) throw new Error("binding absent");
          },
          close() { if (state.bindingCloseError) throw state.bindingCloseError; },
        };
      },
    }));
    vi.doMock("../src/platform/windows/authority-lease", async original => {
      const actual = await original<typeof import("../src/platform/windows/authority-lease")>();
      const minted = new WeakSet<Function>();
      return {...actual,
        createNativeAuthorityLeaseAcquirer(input: {root: string; expectedRoot: {rootFileId: string; volumeId: string}; identityFor(path: string): {fileId: string}}) {
          if (input.root !== ROOT || input.expectedRoot.rootFileId !== ROOT_ID || input.expectedRoot.volumeId !== VOL)
            throw new Error("SOURCE_ROOT_REQUIRED");
          const acquire = (path: string) => {
            const identity = input.identityFor(path);
            const item = {root: input.root, path, fileId: identity.fileId, closed: false}; state.acquired.push(item);
            return {trust: "untrusted-test" as const, assertHeld() {if(item.closed) throw new Error("LEASE_CLOSED");}, close() {item.closed = true;}};
          };
          minted.add(acquire); return acquire;
        },
        withPrivateAuthorityLease(platform: import("../src/sync/private-platform").PrivatePlatform, acquire: import("../src/platform/windows/authority-lease").AcquirePrivateAuthorityLease) {
          if (!minted.has(acquire)) throw new Error("ORIGINAL_ACQUIRER_REQUIRED");
          return actual.withPrivateAuthorityLeaseForTesting(platform, acquire);
        },
      };
    });
    const {createWindowsAppPrivate} = await import("../src/platform/windows/app-private");
    const app = createWindowsAppPrivate({root: ROOT, probeExecutable: EXE, expectedHash: EXE_HASH, systemRoot: "C:\\Windows"}, {
      sourceBindings: {publicationStateRoot: "C:\\Binding", publicationStateDirectory: "C:\\Binding\\state",
        enrollExistingSources: options.enroll === true},
      hotJournalSnapshotProfile: "recovery-archive",
    });
    return {state, app};
  }

  it("preserves concrete methods and bind's path while strict preparation never creates", async () => {
    const {app, state} = await bindingFixture();
    const runtime = app.runtimePlatform(PARENT, "state.sqlite", true);
    expect(state.prepares).toBe(0);
    expect(runtime.bind(PARENT)).toBe(PARENT);
    expect(runtime.databaseName).toBe("state.sqlite");
    runtime.assertDatabase(TARGET); runtime.syncCreatedDatabase(TARGET);
    expect([state.databaseChecks, state.syncs]).toEqual([3, 1]);
    expect(state.acquired).toEqual([{root: ROOT, path: TARGET, fileId: FILE_ID, closed: false}]);
    expect(typeof runtime.withHotJournalSnapshot).toBe("function");
    expect(state.constructorProfiles.every(profile => profile === "recovery-archive")).toBe(true);
    runtime.close();
  });

  it("does not read a prepared identity before bind during explicit initial enrollment", async () => {
    const {app, state} = await bindingFixture({enroll: true});
    state.retained = undefined;
    const runtime = app.runtimePlatform(PARENT, "state.sqlite");
    expect(state.prepares).toBe(1);
    expect(runtime.bind(PARENT)).toBe(PARENT);
    runtime.assertFile(TARGET);
    expect(state.retained).toBe(FILE_ID);
    runtime.close();
  });

  it("accepts retained identity across fresh runtimes but never enrolls a replacement", async () => {
    const {app, state} = await bindingFixture();
    for (let index = 0; index < 2; index++) {
      const runtime = app.runtimePlatform(PARENT, "state.sqlite", false);
      runtime.bind(PARENT); runtime.assertDatabase(TARGET); runtime.close();
    }
    state.fileId = "e".repeat(32);
    const replacement = app.runtimePlatform(PARENT, "state.sqlite", false);
    replacement.bind(PARENT);
    expect(() => replacement.assertDatabase(TARGET)).toThrow("binding mismatch");
    expect(state.databaseChecks).toBe(4);
    expect(state.acquired).toHaveLength(2);
    expect(state.acquired.every(lease => lease.closed)).toBe(true);
    replacement.close();
  });

  it("enrolls a positively CREATED private file in ordinary mode", async () => {
    const {app, state} = await bindingFixture();
    state.exists = false; state.retained = undefined;
    const runtime = app.runtimePlatform(PARENT, "state.sqlite", false);
    runtime.bind(PARENT); runtime.createExclusiveDurably(TARGET); runtime.assertFile(TARGET);
    expect(state.creates).toBe(1);
    expect(state.retained).toBe(FILE_ID);
    runtime.close();
  });

  it("refuses unbound existing files and never promotes a void create return", async () => {
    const {app, state} = await bindingFixture({receipt: false});
    state.retained = undefined;
    const runtime = app.runtimePlatform(PARENT, "state.sqlite", false);
    runtime.bind(PARENT);
    expect(() => runtime.createExclusiveDurably(TARGET)).toThrow("binding absent");
    expect(state.creates).toBe(0);
    state.exists = false;
    expect(() => runtime.createExclusiveDurably(TARGET)).toThrow("missing file");
    expect(state.creates).toBe(0);
    runtime.close();
  });

  it("uses the arbitrary private-file proof rather than the database basename validator", async () => {
    const {app} = await bindingFixture();
    expect(app.privateFileIdentity(`${PARENT}\\attachment.bin`).canonicalPath).toBe(`${PARENT}\\attachment.bin`);
  });

  it("preserves both close causes and an operation error alongside cleanup", async () => {
    const {app, state} = await bindingFixture();
    const runtime = app.runtimePlatform(PARENT, "state.sqlite", false);
    runtime.bind(PARENT);
    state.runtimeCloseError = new Error("runtime close");
    state.bindingCloseError = new Error("binding close");
    try { runtime.close(); throw new Error("expected aggregate"); }
    catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([state.runtimeCloseError, state.bindingCloseError]);
    }
    state.fileId = "e".repeat(32);
    try { app.workspaceIdentity(TARGET); throw new Error("expected aggregate"); }
    catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors[0].message).toBe("binding mismatch");
      expect((error as AggregateError).errors[1]).toBeInstanceOf(AggregateError);
    }
  });
});

describe("windows app private binding wrapper (contract only)", () => {
  // These tests exercise the exported option surface and layering only;
  // the persistent guard is Windows-only and never simulated as acceptance.
  it("exposes the new factory and controller API shapes", async () => {
    const module = await import("../src/platform/windows/app-private");
    expect(typeof module.createWindowsAppPrivate).toBe("function");
    const config = {
      root: "C:\\Folio",
      probeExecutable: EXE,
      expectedHash: EXE_HASH,
      systemRoot: "C:\\Windows",
    };
    // Mere config/type construction is allowed off-host.
    const app = module.createWindowsAppPrivate(config);
    expect(typeof app.runtimePlatform).toBe("function");
    expect(typeof app.ledgerPlatform).toBe("function");
    expect(typeof app.snapshotController).toBe("function");
    const bound = module.createWindowsAppPrivate(config, {
      sourceBindings: {
        publicationStateRoot: "C:\\FolioPub",
        publicationStateDirectory: "C:\\FolioPub\\state",
      },
      hotJournalSnapshotProfile: "recovery-archive",
    });
    expect(typeof bound.snapshotController).toBe("function");
  });

  it("connects the original source acquirer to the single held platform composition", () => {
    const source = readFileSync(
      join(__dirname, "..", "src", "platform", "windows", "app-private.ts"),
      "utf8",
    );
    expect(source).toContain("withPrivateAuthorityLease");
    expect(source).toContain("withRuntimeAuthorityLease(runtime, acquireFor(runtime))");
    expect(source).toContain("createWindowsSourceBindingGuard");
    expect(source).toContain("enrollExistingSources");
    expect(source).toContain("WINDOWS_SOURCE_BINDINGS_REQUIRED");
    expect(source).toContain("hotJournalSnapshotProfile");
  });

  // Enrollment/refusal and preservation of both cleanup causes are exercised
  // above through the runtime behavior, without matching implementation prose.
});

describe("PrivateJournalSnapshot.cs lifecycle source contract (not OS acceptance)", () => {
  const source = readFileSync(
    join(
      __dirname,
      "..",
      "scripts",
      "platform",
      "windows",
      "PrivateJournalSnapshot.cs",
    ),
    "utf8",
  );

  it("keeps archive count, retained budget and free-space reserve finite", () => {
    expect(source).toContain("JsMaxArchives=16");
    expect(source).toContain("JsRetainedBudgetBytes=64L*1024*1024*1024");
    expect(source).toContain("JsFreeReserveBytes=256L*1024*1024");
    expect(source).toContain("JsLifecycleReserveBytes=2*1024*1024");
    expect(source).toContain("admission.Retained+reserve<=JsRetainedBudgetBytes");
    expect(source).toContain("Math.Max(0,admission.Retained-admission.Actual)+reserve+JsFreeReserveBytes");
    expect(source).toContain("admission.Archives<=JsMaxArchives");
    expect(source).toContain("admission.Archives<JsMaxArchives");
    expect(source).toContain("long reserve=2*profile.CombinedBytes+JsLifecycleReserveBytes");
  });

  it("requires the immutable release-intent before the first deletion", () => {
    const intentAt = source.indexOf('JsWriteNewFile(IoChild(slotPath,"release-intent.json")');
    const deleteAt = source.indexOf(
      "IoSetFileInformation(work,JsFileDispositionInformation",
    );
    const renameAt = source.indexOf(
      "IoRenameNoReplace(slotHandle,archivePath",
    );
    expect(intentAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(intentAt);
    expect(renameAt).toBeGreaterThan(deleteAt);
    // The fingerprint is recomputed and compared before any mutation.
    expect(source).toContain("Same(fingerprint,request.Fingerprint)");
    expect(source).toContain('IoRequire(request.InspectionState=="REVALIDATED")');
    const handleAt = source.indexOf("workHandles.Add(work)");
    expect(handleAt).toBeLessThan(intentAt);
    expect(source).toContain("JsStreamHash(stream,inspected.Length)==inspected.Sha256");
    expect(source).toContain("JsProveSlot(slotHandle,archivePath,r,sid,request.SlotFileId)");
    expect(source).toContain("JsFileDispositionInformation=4");
    expect(source).not.toContain("using(var lockFile=JsOpenPrivate");
    expect(source).toContain('JsSavedManifest(request,request.Slot,slotProof,sources,"REVALIDATED","revalidate")');
    expect(source).toContain('IoChild(archivePath,"release-capture.json")');
  });
});
