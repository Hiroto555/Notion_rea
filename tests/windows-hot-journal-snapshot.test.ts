import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WINDOWS_HOT_JOURNAL_MAX_BYTES,
  WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS,
  WindowsHotJournalSnapshotError,
  createWindowsHotJournalSnapshot,
  type WindowsHotJournalSnapshotExecRequest,
  type WindowsHotJournalSnapshotExecResult,
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
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("in-memory pinned executable fixture");
const EXE_HASH = createHash("sha256").update(EXE_BYTES).digest("hex");
const OTHER_HASH = createHash("sha256")
  .update(Buffer.from("other"))
  .digest("hex");
const ROOT_ID = "1".repeat(32);
const DIR_ID = "2".repeat(32);
const FILE_ID = "3".repeat(32);
const JOURNAL_ID = "5".repeat(32);
const SLOT_ID = "7".repeat(32);
const VOL = "4".repeat(16);
const SID = "S-1-5-21-1000";
const MAIN_HASH = createHash("sha256")
  .update(Buffer.from("main"))
  .digest("hex");
const JOURNAL_HASH = createHash("sha256")
  .update(Buffer.from("journal"))
  .digest("hex");

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

function sources(mainPresent = true, journalPresent = true) {
  return [
    mainPresent
      ? {
          suffix: "",
          present: true,
          byteLength: 100,
          sha256: MAIN_HASH,
          evidence: proof(TARGET, FILE_ID),
        }
      : { suffix: "", present: false },
    journalPresent
      ? {
          suffix: "-journal",
          present: true,
          byteLength: 50,
          sha256: JOURNAL_HASH,
          evidence: proof(`${TARGET}-journal`, JOURNAL_ID),
        }
      : { suffix: "-journal", present: false },
    { suffix: "-wal", present: false },
    { suffix: "-shm", present: false },
  ];
}

function snapshotReply(attemptId: string, overrides: object = {}) {
  return {
    version: 1,
    operation: "snapshot",
    state: "SNAPSHOT",
    path: TARGET,
    root: ROOT,
    profile: "small-ledger",
    attemptId,
    slot: 0,
    snapshotDirectory: SLOT_DIR,
    snapshotPath: SNAPSHOT_PATH,
    sources: sources(),
    directory: proof(PARENT, DIR_ID),
    slotDirectory: proof(SLOT_DIR, SLOT_ID),
    ...overrides,
  };
}

function revalidateReply(attemptId: string, overrides: object = {}) {
  return {
    version: 1,
    operation: "revalidate",
    state: "REVALIDATED",
    path: TARGET,
    root: ROOT,
    profile: "small-ledger",
    attemptId,
    slot: 0,
    sources: sources(),
    directory: proof(PARENT, DIR_ID),
    slotDirectory: proof(SLOT_DIR, SLOT_ID),
    ...overrides,
  };
}

function sealReply(attemptId: string, overrides: object = {}) {
  return {
    version: 1,
    operation: "seal",
    state: "SEALED",
    path: TARGET,
    root: ROOT,
    profile: "small-ledger",
    attemptId,
    slot: 0,
    directory: proof(PARENT, DIR_ID),
    slotDirectory: proof(SLOT_DIR, SLOT_ID),
    ...overrides,
  };
}

function defaultOutcome(wire: Record<string, unknown>): ReplyOutcome {
  if (wire.operation === "snapshot")
    return { body: snapshotReply(wire.attemptId as string) };
  if (wire.operation === "revalidate")
    return { body: revalidateReply(wire.attemptId as string) };
  return { body: sealReply(wire.attemptId as string) };
}

function failureReply(
  operation: string,
  attemptId: string,
  state: "REJECTED" | "UNKNOWN",
  reason: string,
  slot?: number,
) {
  return {
    version: 1,
    operation,
    state,
    path: TARGET,
    root: ROOT,
    attemptId,
    ...(slot !== undefined ? { slot } : {}),
    reason,
  };
}

type ReplyOutcome = Readonly<{ body: object; status?: number }> | null;

function fixture() {
  // Legacy lifecycle assertions count CORE operations. Capture protocol calls
  // are tracked separately and exercised by windows-hot-capture.test.ts.
  const captureCalls: WindowsHotJournalSnapshotExecRequest[] = [];
  const calls: WindowsHotJournalSnapshotExecRequest[] = [];
  const wires: Record<string, unknown>[] = [];
  let executable: Buffer = EXE_BYTES;
  let executableMissing = false;
  let onExec: ((wire: Record<string, unknown>) => ReplyOutcome) | undefined;
  let execThrows: Error | undefined;
  const port = {
    fs: {
      lstat(path: string) {
        if (executableMissing || path !== EXE) {
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
      if ((wire.operation as string).startsWith("capture-")) {
        captureCalls.push(request);
        return {status: 0, signal: null, stderr: "", captureEncoding: "latin1",
          stdout: JSON.stringify({
            version: 1, operation: wire.operation, state: "CAPTURE_ACK",
            path: wire.path, root: ROOT, profile: wire.profile, attemptId: wire.attemptId,
            captureId: wire.captureId, capturePhase: wire.capturePhase,
            requestSha256: createHash("sha256").update(request.input).digest("hex"),
            directory: proof(PARENT, DIR_ID),
            captureDirectory: proof(`${PARENT}\\.folio-hot-capture-${wire.captureId}`, "8".repeat(32)),
          })};
      }
      calls.push(request);
      wires.push(wire);
      if (execThrows !== undefined) throw execThrows;
      const outcome =
        onExec === undefined ? defaultOutcome(wire) : onExec(wire);
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
    captureCalls,
    calls,
    wires,
    port,
    options,
    set executable(value: Buffer) {
      executable = value;
    },
    set executableMissing(value: boolean) {
      executableMissing = value;
    },
    set onExec(
      handler: ((wire: Record<string, unknown>) => ReplyOutcome) | undefined,
    ) {
      onExec = handler;
    },
    set execThrows(error: Error | undefined) {
      execThrows = error;
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

function expectSnapshotError(
  work: () => unknown,
  code: string,
): WindowsHotJournalSnapshotError {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(WindowsHotJournalSnapshotError);
    expect((error as WindowsHotJournalSnapshotError).code).toBe(code);
    return error as WindowsHotJournalSnapshotError;
  }
  throw new Error(`expected ${code}`);
}

function eventsOf(
  error: WindowsHotJournalSnapshotError,
): { phase: string; captured?: Record<string, unknown>; reply?: unknown }[] {
  const evidence = error.evidence as {
    events?: { phase: string; captured?: Record<string, unknown>; reply?: unknown }[];
  } | null;
  return evidence?.events ?? [];
}

describe("windows hot journal snapshot controller (contract only)", () => {
  it("runs snapshot + revalidate + seal with pinned exec, one callback, exact wires", () => {
    const f = fixture();
    const controller = f.make();
    const callbacks: string[] = [];
    const result = controller.withSnapshot(f.request(), (snapshotPath) => {
      callbacks.push(snapshotPath);
    });
    expect(result).toBeUndefined();
    expect(callbacks).toEqual([SNAPSHOT_PATH]);
    expect(f.calls.length).toBe(3);
    for (const call of f.calls) {
      expect(call.executable).toBe(EXE);
      expect(call.args).toEqual(["--private-journal-snapshot"]);
      expect(call.cwd).toBe("C:\\Windows");
      expect(call.env).toEqual({
        SystemRoot: "C:\\Windows",
        windir: "C:\\Windows",
        TEMP: "C:\\Windows\\Temp",
        TMP: "C:\\Windows\\Temp",
      });
      expect(call.timeoutMs).toBe(15000);
      expect(call.maxBuffer).toBe(64 * 1024);
      expect(call.shell).toBe(false);
      expect(call.windowsHide).toBe(true);
      expect(call.stdio).toBe("pipe");
      expect(call.encoding).toBe("buffer");
      expect(call.input).toBeInstanceOf(Uint8Array);
    }
    expect(f.wires.length).toBe(3);
    const [snapshotWire, revalidateWire, sealWire] = f.wires;
    expect(snapshotWire).toMatchObject({
      version: 1,
      operation: "snapshot",
      path: TARGET,
      root: ROOT,
      rootFileId: ROOT_ID,
      rootVolumeId: VOL,
      directoryFileId: DIR_ID,
      directoryVolumeId: VOL,
      fileId: FILE_ID,
      volumeId: VOL,
      profile: "small-ledger",
    });
    expect(snapshotWire.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(snapshotWire).not.toHaveProperty("slot");
    expect(revalidateWire).toMatchObject({
      version: 1,
      operation: "revalidate",
      path: TARGET,
      root: ROOT,
      profile: "small-ledger",
      attemptId: snapshotWire.attemptId,
      slot: 0,
      slotFileId: SLOT_ID,
      slotVolumeId: VOL,
    });
    // The seal wire carries the exact captured request wires and pipe bytes
    // (base64) inside the separate 1MiB lifecycle cap, never DB bytes.
    expect(sealWire).toMatchObject({
      version: 1,
      operation: "seal",
      path: TARGET,
      root: ROOT,
      profile: "small-ledger",
      attemptId: snapshotWire.attemptId,
      slot: 0,
      slotFileId: SLOT_ID,
      slotVolumeId: VOL,
    });
    const captures = sealWire.captures as {
      snapshot: { request: string; response: string };
      revalidate: { request: string; response: string };
    };
    expect(
      JSON.parse(
        Buffer.from(captures.snapshot.request, "base64").toString("utf8"),
      ),
    ).toEqual(snapshotWire);
    expect(
      JSON.parse(
        Buffer.from(captures.revalidate.request, "base64").toString("utf8"),
      ),
    ).toEqual(revalidateWire);
    expect(
      JSON.parse(
        Buffer.from(captures.snapshot.response, "base64").toString("utf8"),
      ).state,
    ).toBe("SNAPSHOT");
    expect(
      JSON.parse(
        Buffer.from(captures.revalidate.response, "base64").toString("utf8"),
      ).state,
    ).toBe("REVALIDATED");
  });

  it("rejects a helper hash mismatch at construction", () => {
    const f = fixture();
    expectSnapshotError(
      () =>
        createWindowsHotJournalSnapshot(
          { ...f.options, expectedHash: OTHER_HASH },
          f.port,
        ),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_OPTIONS_OR_HELPER_UNTRUSTED",
    );
    expect(f.calls.length).toBe(0);
  });

  it("accepts absent sidecars and applies the 64 MiB cap to each present source", () => {
    for (const journalPresent of [false, true]) {
      const f = fixture();
      f.onExec = wire => {
        const manifest = sources(true, journalPresent).map(entry =>
          entry.present ? { ...entry, byteLength: WINDOWS_HOT_JOURNAL_MAX_BYTES } : entry,
        );
        return { body: wire.operation === "snapshot"
          ? snapshotReply(wire.attemptId as string, { sources: manifest })
          : wire.operation === "revalidate"
            ? revalidateReply(wire.attemptId as string, { sources: manifest })
            : sealReply(wire.attemptId as string) };
      };
      const paths: string[] = [];
      f.make().withSnapshot(f.request(), path => { paths.push(path); });
      expect(paths).toEqual([SNAPSHOT_PATH]);
      expect(f.calls).toHaveLength(3);
    }
  });

  it("rejects a mixed SID on the first manifest before the semantic callback", () => {
    const f = fixture();
    f.onExec = wire => ({ body: snapshotReply(wire.attemptId as string, {
      sources: [{
        ...sources()[0],
        evidence: { ...proof(TARGET, FILE_ID), sid: "S-1-5-21-9999", ownerSid: "S-1-5-21-9999" },
      }, ...sources().slice(1)],
    }) });
    let called = false;
    expectSnapshotError(() => f.make().withSnapshot(f.request(), () => { called = true; }),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_EVIDENCE");
    expect(called).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  it("pins the slot File ID through post-callback revalidation", () => {
    const f = fixture();
    f.onExec = wire => ({ body: wire.operation === "snapshot"
      ? snapshotReply(wire.attemptId as string)
      : revalidateReply(wire.attemptId as string, { slotDirectory: proof(SLOT_DIR, "8".repeat(32)) }) });
    const error = expectSnapshotError(() => f.make().withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_EVIDENCE");
    expect(f.wires[1]).toMatchObject({ slotFileId: SLOT_ID, slotVolumeId: VOL });
    expect(eventsOf(error).filter(event => event.captured)).toHaveLength(2);
  });

  it("retains immutable captures per controller through nested semantic callbacks", () => {
    const outer = fixture(), inner = fixture();
    const a = outer.make(), b = inner.make();
    const semantic = new Error("nested semantic failure");
    a.withSnapshot(outer.request(), () => {
      expect(() => b.withSnapshot(inner.request(), () => { throw semantic; })).toThrow(semantic);
    });
    const outerEvidence = a.inspectEvidence() as unknown as readonly { attemptId: string; events: { phase: string; captured?: object }[] }[];
    const innerEvidence = b.inspectEvidence() as unknown as readonly { attemptId: string; events: { phase: string }[] }[];
    expect(outerEvidence[0].attemptId).toBe(outer.wires[0].attemptId);
    expect(innerEvidence[0].attemptId).toBe(inner.wires[0].attemptId);
    expect(outerEvidence[0].events.map(event => event.phase)).toEqual(["snapshot", "callback", "revalidate", "seal", "complete"]);
    expect(innerEvidence[0].events.map(event => event.phase)).toEqual(["snapshot", "callback"]);
    expect(Object.isFrozen(outerEvidence)).toBe(true);
    expect(Object.isFrozen(outerEvidence[0].events[0].captured)).toBe(true);
  });

  it("preserves an undefined semantic throw and never authorizes revalidation", () => {
    const f = fixture(), controller = f.make();
    let caught = false, error: unknown = "not thrown";
    try { controller.withSnapshot(f.request(), () => { throw undefined; }); }
    catch (value) { caught = true; error = value; }
    expect(caught).toBe(true);
    expect(error).toBeUndefined();
    expect(f.calls).toHaveLength(1);
    expect(controller.inspectEvidence()).toMatchObject([{ events: [{ phase: "snapshot" }, { phase: "callback", outcome: "failed" }] }]);
  });

  it("preserves a semantic native-error object while retaining its attempt separately", () => {
    const f = fixture(), controller = f.make();
    const semantic = new WindowsHotJournalSnapshotError("SEMANTIC_FAILURE", null);
    let actual: unknown;
    try { controller.withSnapshot(f.request(), () => { throw semantic; }); }
    catch (error) { actual = error; }
    expect(actual).toBe(semantic);
    expect(f.calls).toHaveLength(1);
    expect(controller.inspectEvidence()).toHaveLength(1);
  });

  it("rejects known async callbacks before native dispatch and poisons subsequent calls", () => {
    const f = fixture(), controller = f.make();
    let entered = false;
    expectSnapshotError(() => controller.withSnapshot(f.request(), async () => { entered = true; }),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_CALLBACK");
    expectSnapshotError(() => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
    expect(entered).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("rejects a replaced or missing executable and never executes it", () => {
    const f = fixture();
    const controller = f.make();
    f.executableMissing = true;
    expectSnapshotError(
      () => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_HELPER_UNTRUSTED",
    );
    expect(f.calls.length).toBe(0);
    f.executableMissing = false;
    expectSnapshotError(() => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
    // Replacement across an in-flight exec boundary poisons permanently.
    const g = fixture();
    const second = g.make();
    const poisoned = expectSnapshotError(
      () =>
        second.withSnapshot(g.request(), () => {
          g.executable = Buffer.from("replaced helper bytes");
        }),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN_CAPTURE_NOT_ACKNOWLEDGED",
    );
    // The snapshot exec ran; revalidate is refused and the poison is stable.
    expect(g.calls.length).toBe(1);
    const again = expectSnapshotError(
      () => second.withSnapshot(g.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN_CAPTURE_NOT_ACKNOWLEDGED",
    );
    expect(again).toBe(poisoned);
    expect(g.calls.length).toBe(1);
  });

  it.each<
    [
      string,
      ((body: ReturnType<typeof snapshotReply>) => object) | "PRESENCE",
    ]
  >([
    [
      "sources wrong order",
      (body) => ({
        ...body,
        sources: [
          {
            suffix: "-journal",
            present: true,
            byteLength: 50,
            sha256: JOURNAL_HASH,
            evidence: proof(`${TARGET}-journal`, JOURNAL_ID),
          },
          {
            suffix: "",
            present: true,
            byteLength: 100,
            sha256: MAIN_HASH,
            evidence: proof(TARGET, FILE_ID),
          },
          { suffix: "-wal", present: false },
          { suffix: "-shm", present: false },
        ],
      }),
    ],
    [
      "main absent",
      (body) => ({ ...body, sources: sources(false, true) }),
    ],
    ["presence changed on revalidate", "PRESENCE"],
    [
      "evidence canonicalPath wrong",
      (body) => ({
        ...body,
        sources: [
          {
            suffix: "",
            present: true,
            byteLength: 100,
            sha256: MAIN_HASH,
            evidence: proof(`${TARGET}\\evil`, FILE_ID),
          },
          ...sources().slice(1),
        ],
      }),
    ],
    [
      "evidence fileId wrong",
      (body) => ({
        ...body,
        sources: [
          {
            suffix: "",
            present: true,
            byteLength: 100,
            sha256: MAIN_HASH,
            evidence: proof(TARGET, "9".repeat(32)),
          },
          ...sources().slice(1),
        ],
      }),
    ],
    [
      "evidence sid malformed",
      (body) => ({
        ...body,
        sources: [
          {
            suffix: "",
            present: true,
            byteLength: 100,
            sha256: MAIN_HASH,
            evidence: { ...proof(TARGET, FILE_ID), sid: "bogus" },
          },
          ...sources().slice(1),
        ],
      }),
    ],
    [
      "local filesystem false",
      (body) => ({
        ...body,
        sources: [
          {
            suffix: "",
            present: true,
            byteLength: 100,
            sha256: MAIN_HASH,
            evidence: { ...proof(TARGET, FILE_ID), localFilesystem: false },
          },
          ...sources().slice(1),
        ],
      }),
    ],
    [
      "hardlink count > 1",
      (body) => ({
        ...body,
        sources: [
          {
            suffix: "",
            present: true,
            byteLength: 100,
            sha256: MAIN_HASH,
            evidence: { ...proof(TARGET, FILE_ID), linkCount: 2 },
          },
          ...sources().slice(1),
        ],
      }),
    ],
    [
      "sha256 malformed",
      (body) => ({
        ...body,
        sources: [
          {
            suffix: "",
            present: true,
            byteLength: 100,
            sha256: "xyz",
            evidence: proof(TARGET, FILE_ID),
          },
          ...sources().slice(1),
        ],
      }),
    ],
    [
      "byteLength over the bound",
      (body) => ({
        ...body,
        sources: [
          {
            suffix: "",
            present: true,
            byteLength: WINDOWS_HOT_JOURNAL_MAX_BYTES + 1,
            sha256: MAIN_HASH,
            evidence: proof(TARGET, FILE_ID),
          },
          ...sources().slice(1),
        ],
      }),
    ],
    [
      "slot directory outside the parent",
      (body) => ({
        ...body,
        snapshotDirectory: `${ROOT}\\elsewhere\\.folio-hot-snapshot-0`,
        slotDirectory: proof(
          `${ROOT}\\elsewhere\\.folio-hot-snapshot-0`,
          SLOT_ID,
        ),
      }),
    ],
    [
      "snapshotPath not the fixed working file",
      (body) => ({ ...body, snapshotPath: `${PARENT}\\snapshot.sqlite` }),
    ],
    [
      "wrong attemptId",
      (body) => ({ ...body, attemptId: "0".repeat(32) }),
    ],
    [
      "path mismatch",
      (body) => ({ ...body, path: `${PARENT}\\other.sqlite` }),
    ],
    ["root mismatch", (body) => ({ ...body, root: "C:\\Other" })],
    ["slot out of range", (body) => ({ ...body, slot: 9 })],
    [
      "directory fileId wrong",
      (body) => ({ ...body, directory: proof(PARENT, "8".repeat(32)) }),
    ],
    [
      "directory rootFileId wrong",
      (body) => ({
        ...body,
        directory: { ...proof(PARENT, DIR_ID), rootFileId: "8".repeat(32) },
      }),
    ],
    [
      "directory owner differs",
      (body) => ({
        ...body,
        directory: { ...proof(PARENT, DIR_ID), ownerSid: "S-1-5-18" },
      }),
    ],
  ])("rejects malformed native evidence: %s", (_name, mutate) => {
    const f = fixture();
    const controller = f.make();
    f.onExec = (wire) => {
      if (wire.operation === "snapshot") {
        const reply = snapshotReply(wire.attemptId as string);
        return {
          body:
            mutate === "PRESENCE"
              ? reply
              : (mutate(reply) as ReturnType<typeof snapshotReply>),
        };
      }
      return {
        body:
          mutate === "PRESENCE"
            ? // The journal vanished between snapshot and revalidate.
              revalidateReply(wire.attemptId as string, {
                sources: sources(true, false),
              })
            : revalidateReply(wire.attemptId as string),
      };
    };
    let thrown: unknown;
    try {
      controller.withSnapshot(f.request(), () => {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WindowsHotJournalSnapshotError);
    expect(
      (thrown as WindowsHotJournalSnapshotError).code.startsWith(
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_",
      ),
    ).toBe(true);
    expect(f.calls.length).toBeLessThanOrEqual(2);
    // The raw reply stays captured as immutable attempt evidence.
    expect(eventsOf(thrown as WindowsHotJournalSnapshotError).length)
      .toBeGreaterThan(0);
  });

  it("rejects duplicate JSON keys in the native reply and retains raw output", () => {
    const f = fixture();
    const base = f.port.exec;
    f.port.exec = (request: WindowsHotJournalSnapshotExecRequest) => {
      const result = base(request);
      return JSON.parse(Buffer.from(request.input).toString()).operation.startsWith("capture-")
        ? result : { ...result, stdout: '{"version":1,"version":1}' };
    };
    const controller = f.make();
    const error = expectSnapshotError(
      () => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
    );
    expect(f.calls.length).toBe(1);
    expect(eventsOf(error)[0]?.captured?.stdout).toBe(
      '{"version":1,"version":1}',
    );
  });

  it("maps native REJECTED and UNKNOWN replies and retains the capture", () => {
    for (const [state, reason, status, expectedCode] of [
      [
        "REJECTED",
        "PRIVATE_JOURNAL_SNAPSHOT_REJECTED",
        1,
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_REJECTED",
      ],
      [
        "UNKNOWN",
        "PRIVATE_JOURNAL_SNAPSHOT_UNKNOWN",
        3,
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
      ],
      [
        "UNKNOWN",
        "PRIVATE_JOURNAL_SNAPSHOT_CAPACITY",
        3,
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
      ],
    ] as const) {
      const f = fixture();
      const controller = f.make();
      f.onExec = (wire) => ({
        body: failureReply(
          "snapshot",
          wire.attemptId as string,
          state,
          reason,
        ),
        status,
      });
      const error = expectSnapshotError(
        () => controller.withSnapshot(f.request(), () => {}),
        expectedCode,
      );
      expect(f.calls.length).toBe(1);
      expect(eventsOf(error).length).toBe(1);
      expect(eventsOf(error)[0].phase).toBe("snapshot");
    }
  });

  it("maps a thrown exec, a signal, and malformed output to UNKNOWN", () => {
    const thrown = fixture();
    const controller = thrown.make();
    thrown.execThrows = new Error("spawn failure");
    expectSnapshotError(
      () => controller.withSnapshot(thrown.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
    );
    const signalled = fixture();
    const second = signalled.make();
    signalled.onExec = () => null;
    const error = expectSnapshotError(
      () => second.withSnapshot(signalled.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
    );
    expect(eventsOf(error)[0]?.captured?.signal).toBe("SIGKILL");
    const garbage = fixture();
    const base = garbage.port.exec;
    garbage.port.exec = (request: WindowsHotJournalSnapshotExecRequest) => {
      const result = base(request);
      return JSON.parse(Buffer.from(request.input).toString()).operation.startsWith("capture-")
        ? result : { ...result, stdout: "not json at all" };
    };
    const third = garbage.make();
    expectSnapshotError(
      () => third.withSnapshot(garbage.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
    );
    expect(garbage.calls.length).toBe(1);
  });

  it("does not resend after a failure and keeps per-attempt raw evidence", () => {
    const f = fixture();
    const controller = f.make();
    let failFirst = true;
    f.onExec = (wire) =>
      wire.operation === "snapshot" && failFirst
        ? {
            body: failureReply(
              "snapshot",
              wire.attemptId as string,
              "UNKNOWN",
              "PRIVATE_JOURNAL_SNAPSHOT_UNKNOWN",
            ),
            status: 3,
          }
        : defaultOutcome(wire);
    expectSnapshotError(
      () => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN",
    );
    failFirst = false;
    controller.withSnapshot(f.request(), () => {});
    expect(f.calls.length).toBe(4);
    // Distinct attemptIds: the failed attempt was retained, not resent.
    expect(f.wires[0].attemptId).not.toBe(f.wires[1].attemptId);
    expect(f.wires[1].attemptId).toBe(f.wires[2].attemptId);
    expect(f.wires[0].operation).toBe("snapshot");
    expect(f.wires[1].operation).toBe("snapshot");
    expect(f.wires[2].operation).toBe("revalidate");
    expect(f.wires[3].operation).toBe("seal");
  });

  it("a semantic callback failure skips revalidate but keeps the snapshot", () => {
    const f = fixture();
    const controller = f.make();
    const semantic = new Error("callback semantics failed");
    let observed: unknown;
    try {
      controller.withSnapshot(f.request(), () => {
        throw semantic;
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(semantic);
    // Exactly one native call: no revalidate, no source recovery.
    expect(f.calls.length).toBe(1);
    expect(f.wires[0].operation).toBe("snapshot");
    // A callback failure is not provider fault: the controller stays usable.
    controller.withSnapshot(f.request(), () => {});
    expect(f.calls.length).toBe(4);
  });

  it("poisons permanently on a late async callback or a malformed ack", () => {
    const f = fixture();
    const controller = f.make();
    const first = expectSnapshotError(
      () =>
        controller.withSnapshot(
          f.request(),
          () => Promise.resolve() as unknown as void,
        ),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED",
    );
    const second = expectSnapshotError(
      () => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED",
    );
    expect(second).toBe(first);
    // The snapshot ran once; revalidate and all later calls are refused.
    expect(f.calls.length).toBe(1);

    const g = fixture();
    const other = g.make();
    expectSnapshotError(
      () =>
        other.withSnapshot(f.request(), () => 1 as unknown as void),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED",
    );
    expect(g.calls.length).toBe(1);
  });

  it("poisons on callback reentrancy", () => {
    const f = fixture();
    const controller = f.make();
    let inner: unknown;
    const error = expectSnapshotError(
      () =>
        controller.withSnapshot(f.request(), () => {
          try {
            controller.withSnapshot(f.request(), () => {});
          } catch (caught) {
            inner = caught;
          }
        }),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED",
    );
    expect(inner).toBeInstanceOf(WindowsHotJournalSnapshotError);
    expect((inner as WindowsHotJournalSnapshotError).code).toBe(
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED",
    );
    expect(error.code).toBe("WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
    // The reentrant call is refused before any exec; the subsequent
    // revalidate is also refused by the stable poison.
    expect(f.calls.length).toBe(1);
  });

  it("bounds the controller to four attempts then fails closed", () => {
    const f = fixture();
    const controller = f.make();
    for (let index = 0; index < WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS; index++)
      controller.withSnapshot(f.request(), () => {});
    expect(f.calls.length).toBe(12);
    expectSnapshotError(
      () => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_CONSUMED",
    );
    expect(f.calls.length).toBe(12);
  });

  it("validates request fields strictly before any exec", () => {
    const f = fixture();
    const controller = f.make();
    const cases: [string, Record<string, unknown>][] = [
      ["non-canonical path", { ...f.request(), path: "not-a-path" }],
      [
        "malformed fileId",
        {
          ...f.request(),
          expectedFile: {
            canonicalPath: TARGET,
            fileId: "zz",
            volumeId: VOL,
          },
        },
      ],
      ["extra key", { ...f.request(), extra: 1 }],
    ];
    for (const [_name, request] of cases) {
      let thrown: unknown;
      try {
        controller.withSnapshot(
          request as unknown as WindowsHotJournalSnapshotRequest,
          () => {},
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WindowsHotJournalSnapshotError);
    }
    expect(f.calls.length).toBe(0);
  });

  it("omitted profile defaults to small-ledger and rejects 64 MiB + 1", () => {
    const f = fixture();
    const controller = f.make();
    const manifest = sources().map((entry, index) =>
      index === 0 && entry.present
        ? { ...entry, byteLength: WINDOWS_HOT_JOURNAL_MAX_BYTES + 1 }
        : entry,
    );
    f.onExec = (wire) => ({
      body: snapshotReply(wire.attemptId as string, { sources: manifest }),
    });
    expectSnapshotError(
      () => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_SIZE",
    );
    expect(f.calls).toHaveLength(1);
  });

  it("recovery-archive accepts the 1 GiB main and 1 GiB sidecar boundary", () => {
    const f = fixture();
    const controller = createWindowsHotJournalSnapshot(
      { ...f.options, profile: "recovery-archive" },
      f.port,
    );
    const manifest = sources().map((entry) =>
      entry.present
        ? {
            ...entry,
            byteLength:
              1024 * 1024 * 1024,
          }
        : entry,
    );
    f.onExec = (wire) => ({
      body:
        wire.operation === "snapshot"
          ? snapshotReply(wire.attemptId as string, {
              profile: "recovery-archive",
              sources: manifest,
            })
          : wire.operation === "revalidate"
            ? revalidateReply(wire.attemptId as string, {
                profile: "recovery-archive",
                sources: manifest,
              })
            : sealReply(wire.attemptId as string, {
                profile: "recovery-archive",
              }),
    });
    const paths: string[] = [];
    controller.withSnapshot(f.request(), (path) => { paths.push(path); });
    expect(paths).toEqual([SNAPSHOT_PATH]);
    expect(f.wires[0].profile).toBe("recovery-archive");
    // Archive profiles use the extended multi-pass streaming timeout.
    expect(f.calls[0].timeoutMs).toBe(30 * 60 * 1000);
  });

  it("recovery-archive refuses a main file one byte above 1 GiB before callback", () => {
    const f = fixture();
    const controller = createWindowsHotJournalSnapshot({ ...f.options, profile: "recovery-archive" }, f.port);
    f.onExec = wire => ({ body: snapshotReply(wire.attemptId as string, {
      profile: "recovery-archive",
      sources: sources().map(entry => entry.suffix === "" ? { ...entry, byteLength: 1024 ** 3 + 1 } : entry),
    }) });
    let callbacks = 0;
    expectSnapshotError(() => controller.withSnapshot(f.request(), () => { callbacks++; }),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_SIZE");
    expect(callbacks).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.captureCalls.map(call => JSON.parse(Buffer.from(call.input).toString()).operation))
      .toEqual(["capture-intent", "capture-wire", "capture-ready", "capture-output"]);
  });

  it("backup-artifact accepts 4 GiB main and 8 GiB sidecars, rejects +1", () => {
    const f = fixture();
    const controller = createWindowsHotJournalSnapshot(
      { ...f.options, profile: "backup-artifact" },
      f.port,
    );
    const manifest = sources().map((entry) =>
      entry.present
        ? {
            ...entry,
            byteLength:
              entry.suffix === ""
                ? 4 * 1024 * 1024 * 1024
                : 8 * 1024 * 1024 * 1024,
          }
        : entry,
    );
    let over = false;
    f.onExec = (wire) => ({
      body:
        wire.operation === "snapshot"
          ? snapshotReply(wire.attemptId as string, {
              profile: "backup-artifact",
              sources: manifest.map((entry) =>
                over && entry.present && entry.suffix === "-journal"
                  ? { ...entry, byteLength: 8 * 1024 * 1024 * 1024 + 1 }
                  : entry,
              ),
            })
          : wire.operation === "revalidate"
            ? revalidateReply(wire.attemptId as string, {
                profile: "backup-artifact",
                sources: manifest,
              })
            : sealReply(wire.attemptId as string, {
                profile: "backup-artifact",
              }),
    });
    controller.withSnapshot(f.request(), () => {});
    expect(f.calls).toHaveLength(3);
    // The 8 GiB + 1 sidecar exceeds the profile's sidecar limit.
    over = true;
    const second = createWindowsHotJournalSnapshot(
      { ...f.options, profile: "backup-artifact" },
      f.port,
    );
    expectSnapshotError(
      () => second.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_SIZE",
    );
  });

  it("rejects a combined manifest above the profile total", () => {
    const f = fixture();
    const controller = createWindowsHotJournalSnapshot(
      { ...f.options, profile: "recovery-archive" },
      f.port,
    );
    // Each entry is inside its per-role bound, but 512MiB + 1GiB + 700MiB
    // exceeds the 2 GiB combined cap.
    const manifest = [
      {
        suffix: "",
        present: true,
        byteLength: 512 * 1024 * 1024,
        sha256: MAIN_HASH,
        evidence: proof(TARGET, FILE_ID),
      },
      {
        suffix: "-journal",
        present: true,
        byteLength: 1024 * 1024 * 1024,
        sha256: JOURNAL_HASH,
        evidence: proof(`${TARGET}-journal`, JOURNAL_ID),
      },
      {
        suffix: "-wal",
        present: true,
        byteLength: 700 * 1024 * 1024,
        sha256: JOURNAL_HASH,
        evidence: proof(`${TARGET}-wal`, "6".repeat(32)),
      },
      { suffix: "-shm", present: false },
    ];
    f.onExec = (wire) => ({
      body: snapshotReply(wire.attemptId as string, {
        profile: "recovery-archive",
        sources: manifest,
      }),
    });
    expectSnapshotError(
      () => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_MANIFEST",
    );
    expect(f.calls).toHaveLength(1);
  });

  it("rejects a mismatched profile on any reply", () => {
    const f = fixture();
    const controller = f.make();
    f.onExec = (wire) => ({
      body: snapshotReply(wire.attemptId as string, {
        profile: "recovery-archive",
      }),
    });
    expectSnapshotError(
      () => controller.withSnapshot(f.request(), () => {}),
      "WINDOWS_HOT_JOURNAL_SNAPSHOT_RECEIPT",
    );
  });

  it("rejects the real transport off Windows and a test port on win32", () => {
    const f = fixture();
    if (process.platform === "win32") {
      expectSnapshotError(
        () => createWindowsHotJournalSnapshot(f.options, f.port),
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_TEST_PORT_FORBIDDEN",
      );
    } else {
      expectSnapshotError(
        () => createWindowsHotJournalSnapshot(f.options),
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNSUPPORTED_PLATFORM",
      );
      // The untrusted port keeps contract tests running on non-Windows CI.
      const controller = f.make();
      controller.withSnapshot(f.request(), () => {});
      expect(f.calls.length).toBe(3);
    }
  });
});

describe("PrivateJournalSnapshot.cs source contract (source inspection only, not OS acceptance)", () => {
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

  it("declares the native entry point and fixed four-slot bounds", () => {
    expect(source).toContain(
      "internal static partial class PrivateRootProbeProgram",
    );
    expect(source).toContain("PrivateJournalSnapshotMode()");
    expect(source).toContain("JsSnapshotSlots=4");
    expect(source).toContain('JsSlotPrefix=".folio-hot-snapshot-"');
    expect(source).toContain("JsHotJournalMaxBytes=64*1024*1024");
  });

  it("opens sources read-only with read-only sharing and reparse flags", () => {
    expect(source).toContain(
      "CreateFileW(source,IoGenericRead|IoReadControl,IoShareRead,IntPtr.Zero,OpenExisting,FileFlagOpenReparsePoint,IntPtr.Zero)",
    );
    // Sources never take write access or write sharing.
    expect(source).not.toMatch(/CreateFileW\(source,[^;]*IoGenericWrite/);
    expect(source).not.toMatch(/CreateFileW\(source,[^;]*FileShare\.Write/);
  });

  it("only treats FILE_NOT_FOUND(2) as absent and keeps main mandatory", () => {
    expect(source).toContain("JsErrorFileNotFound=2");
    expect(source).toContain("IoRequire(error==JsErrorFileNotFound&&!required)");
    expect(source).toContain("JsOpenSource(r,sid,suffix,suffix.Length==0,profile)");
    expect(source).toContain("list[0].Present");
  });

  it("holds all source handles through streaming copy and same-handle recheck", () => {
    expect(source).toContain("foreach(string suffix in JsSuffixes)");
    expect(source).toContain("JsRecheckSources(r,sid,sources)");
    // Source payloads are streamed: IncrementalHash over a fixed 64KiB
    // buffer with long lengths, never a source byte[] materialization.
    expect(source).toContain("JsStreamBuffer=64*1024");
    expect(source).toContain("IncrementalHash.CreateHash");
    expect(source).toContain("JsStreamHash(entry.Stream,entry.Length)");
    expect(source).toContain("JsStreamHash(s.Stream,s.Length)");
    expect(source).toContain("JsCopyStreaming(s.Stream,s.Length,s.Sha256");
    expect(source).not.toContain("entry.Bytes");
    expect(source).not.toMatch(/IoReadExact\((?:s|entry)\.Stream/);
    expect(source).toContain("JsDisposeSources(sources)");
  });

  it("creates the slot and every file exclusively with a protected DACL", () => {
    expect(source).toContain('EntryPoint="NtCreateFile",ExactSpelling=true');
    expect(source).toContain("JsFileCreate=2");
    expect(source).toContain("JsCreateSlot(directories.ParentHandle,JsSlotPrefix+index,sid,ref attempted)");
    expect(source).toContain("block.Information.ToUInt64()==2");
    expect(source).toContain("IoCreateNew");
    expect(source).toContain("D:P(A;;FA;;;");
    expect(source).toContain("D:P(A;OICI;FA;;;");
    expect(source).toContain("JsStatusNameCollision");
    expect(source).toContain("PRIVATE_JOURNAL_SNAPSHOT_CAPACITY");
  });

  it("keeps sidecar IDs distinct and revalidates receipts, raw bytes and the held slot", () => {
    expect(source).toContain("suffix.Length==0?r.FileId:null");
    expect(source).not.toContain("required?r.FileId:null");
    expect(source).toContain("sources.Add(s); // Own the handle before any comparison can throw.");
    expect(source).toContain("JsOpenSlot(slotPath,r,sid,request.SlotFileId,out slotProof)");
    expect(source).toContain('JsParseIntent(JsReadPrivate(IoChild(slotPath,"prepared.json")');
    expect(source).toContain("retained.Sha256==expected.Sha256");
    expect(source).toContain("JsHashPrivate(");
    expect(source).toContain("JsProveDirectory(directories.RootHandle,r.Root,r,sid)");
    expect(source).toContain("directories.RecheckExclusive()");
    expect(source).not.toContain("OpenDirectoryHandle(");
  });

  it("rejects super-journal redirects via the 8-byte tail before any writable open", () => {
    expect(source).toContain('if(suffix=="-journal")JsCheckJournalTail(entry.Stream,entry.Length)');
    expect(source).toContain("0xd9,0xd5,0x05,0xf9,0x20,0xa1,0x63,0xd7");
    expect(source).toContain("stream.Position=length-8");
    expect(source).toContain("IoRequire(!trailer)");
  });

  it("persists immutable intent, raw and working copies, and receipts", () => {
    expect(source).toContain('"intent.json"');
    expect(source).toContain('"source.sqlite"+s.Suffix');
    expect(source).toContain('"snapshot.sqlite"+s.Suffix');
    expect(source).toContain('"prepared.json"');
    expect(source).toContain('"revalidated.json"');
    expect(source).toContain('"revalidation-failed.json"');
  });

  it("binds the selected profile into wire and persisted manifests", () => {
    expect(source).toContain('"small-ledger"');
    expect(source).toContain('"recovery-archive"');
    expect(source).toContain('"backup-artifact"');
    expect(source).toContain('Profile="small-ledger"');
    expect(source).toContain("profile=request.Profile");
    expect(source).toContain('IoString(fields["profile"])==request.Profile');
    expect(source).toContain("JsProfiles[2].CombinedBytes");
  });

  it("serializes admission on a fixed exclusive lock with bounded inventory", () => {
    expect(source).toContain('JsAdmissionLockName=".folio-hot-admission.lock"');
    expect(source).toContain('JsArchivePrefix=".folio-hot-archive-"');
    expect(source).toContain("JsMaxArchives=16");
    expect(source).toContain("JsRetainedBudgetBytes=64L*1024*1024*1024");
    expect(source).toContain("JsFreeReserveBytes=256L*1024*1024");
    expect(source).toContain("JsFileOpenIf=3");
    expect(source).toContain("JsAcquireAdmission(");
    expect(source).toContain("JsGetDiskFreeSpaceExW");
    expect(source).toContain("Directory.EnumerateFileSystemEntries");
  });

  it("exposes explicit seal, inspect and release operations only", () => {
    expect(source).toContain('operation=="seal"');
    expect(source).toContain('operation=="inspect"');
    expect(source).toContain('operation=="release"');
    expect(source).toContain('"captures.json"');
    expect(source).toContain('"release-intent.json"');
    expect(source).toContain('"released.json"');
    expect(source).toContain("JsMaxLifecycleStdinBytes=1024*1024");
    // Working-copy disposal is held-handle DELETE only; never a path
    // unlink, recursive delete, or automatic cleanup.
    expect(source).toContain("JsFileDispositionInformation=4");
    expect(source).toContain("IoSetFileInformation(work,JsFileDispositionInformation");
    expect(source).toContain("IoDeleteAccess");
    expect(source).toContain("IoRenameNoReplace(slotHandle,archivePath");
  });

  it("never deletes sources or evidence, never rewrites, and preserves UNKNOWN evidence", () => {
    expect(source).not.toContain("File.Delete");
    expect(source).not.toContain("Directory.Delete");
    expect(source).not.toMatch(/CreateFileW\(source,[^;]*IoGenericWrite/);
    // No path unlink APIs: deletion is FileDispositionInfo on held handles
    // for the fixed snapshot.sqlite{suffix} working names only.
    expect(source).toContain('string name="snapshot.sqlite"+suffix;');
    expect(source).toContain("attempted=true");
    expect(source).toContain("PRIVATE_JOURNAL_SNAPSHOT_UNKNOWN");
    expect(source).toContain("PRIVATE_JOURNAL_SNAPSHOT_REJECTED");
  });
});
