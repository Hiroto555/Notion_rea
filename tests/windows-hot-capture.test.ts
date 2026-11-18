import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createWindowsHotJournalSnapshot,
  WindowsHotJournalSnapshotError,
  type WindowsHotJournalSnapshotExecRequest,
  type WindowsHotJournalSnapshotExecResult,
  type WindowsHotJournalSnapshotTestPort,
} from "../src/platform/windows/hot-journal-snapshot";

// Protocol simulation only. No Windows/filesystem/flush acceptance claim.
const ROOT = "C:\\Folio";
const PARENT = `${ROOT}\\private`;
const PATH = `${PARENT}\\state.sqlite`;
const SLOT = `${PARENT}\\.folio-hot-snapshot-0`;
const ROOT_ID = "1".repeat(32), DIR_ID = "2".repeat(32), FILE_ID = "3".repeat(32);
const SLOT_ID = "7".repeat(32), CAPTURE_ID = "8".repeat(32), VOL = "4".repeat(16);
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("capture protocol fixture");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const options = { root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows" };
const request = {
  path: PATH,
  expectedDirectory: { canonicalPath: PARENT, rootFileId: ROOT_ID, rootVolumeId: VOL, directoryFileId: DIR_ID, directoryVolumeId: VOL },
  expectedFile: { canonicalPath: PATH, fileId: FILE_ID, volumeId: VOL },
};
const reference = { attemptId: "a".repeat(32), slot: 0, slotFileId: SLOT_ID, slotVolumeId: VOL };
const inspection = { reference, state: "REVALIDATED" as const, fingerprint: hash("fingerprint"), evidence: {} };
const proof = (canonicalPath: string, fileId: string) => ({
  canonicalPath, canonicalRoot: ROOT, platform: "win32", sid: "S-1-5-21-1000",
  ownerSid: "S-1-5-21-1000", fileId, volumeId: VOL, rootFileId: ROOT_ID, rootVolumeId: VOL,
  daclPrivate: true, reparsePoint: false, linkCount: 1, localFilesystem: true,
});
type Wire = Record<string, any>;
type Saved = {
  intent: Wire;
  chunks: Map<number, Buffer>;
  ready?: Buffer;
  output?: { stdout: Buffer; stderr: Buffer; metadata: Wire };
};
type Core = "snapshot" | "revalidate" | "seal" | "inspect" | "release" | "commit-release-evidence";
const ok = (stdout: string): WindowsHotJournalSnapshotExecResult =>
  ({ status: 0, signal: null, stdout, stderr: "", captureEncoding: "latin1" });
function fixture(saved = new Map<string, Saved>()) {
  const operations: string[] = [], cores: { phase: Core; input: Buffer }[] = [];
  let onCore: ((phase: Core, wire: Wire) => WindowsHotJournalSnapshotExecResult | undefined) | undefined;
  let onCapture: ((operation: string, wire: Wire, reply: Wire) => WindowsHotJournalSnapshotExecResult | undefined) | undefined;
  let largeReplies = false;
  let executable: Buffer = EXE_BYTES;
  const port: WindowsHotJournalSnapshotTestPort = {
    fs: {
      lstat: () => ({
        isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        nlink: 1, dev: 1, ino: 1, size: executable.length, mtimeMs: 1,
      }) as ReturnType<WindowsHotJournalSnapshotTestPort["fs"]["lstat"]>,
      readFile: () => executable,
    },
    exec(call: WindowsHotJournalSnapshotExecRequest) {
      const wire: Wire = JSON.parse(Buffer.from(call.input).toString());
      const operation = wire.operation as string;
      operations.push(operation);
      expect(call.args).toEqual(["--private-journal-snapshot"]);
      expect(call.maxBuffer).toBe(64 * 1024);
      if (operation.startsWith("capture-")) {
        expect(call.input.length).toBeLessThanOrEqual(1024 * 1024);
        expect(wire.rootFileId).toBe(ROOT_ID);
        expect(wire.directoryFileId).toBe(DIR_ID);
        expect(wire.path).toBe(PATH);
        if (operation === "capture-intent") {
          expect(saved.has(wire.captureId)).toBe(false);
          saved.set(wire.captureId, { intent: wire, chunks: new Map() });
        } else {
          const entry = saved.get(wire.captureId)!;
          expect(entry).toBeDefined();
          expect(wire.captureFileId).toBe(CAPTURE_ID);
          expect(wire.wireSha256).toBe(entry.intent.wireSha256);
          if (operation === "capture-wire") {
            expect(entry.chunks.has(wire.index)).toBe(false);
            const bytes = Buffer.from(wire.bytes, "base64");
            expect(bytes.length).toBeLessThanOrEqual(64 * 1024);
            entry.chunks.set(wire.index, bytes);
          } else if (operation === "capture-ready") {
            entry.ready = Buffer.concat([...entry.chunks.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes));
            expect(entry.ready.length).toBe(wire.wireByteLength);
            expect(hash(entry.ready)).toBe(wire.wireSha256);
          } else {
            expect(operation).toBe("capture-output");
            expect(entry.ready).toBeDefined();
            expect(entry.output).toBeUndefined();
            entry.output = {
              stdout: Buffer.from(wire.stdout, "base64"), stderr: Buffer.from(wire.stderr, "base64"),
              metadata: JSON.parse(Buffer.from(wire.metadata, "base64").toString()),
            };
          }
        }
        const reply = {
          version: 1, operation, state: "CAPTURE_ACK", path: PATH, root: ROOT,
          profile: wire.profile, attemptId: wire.attemptId, captureId: wire.captureId,
          capturePhase: wire.capturePhase, requestSha256: hash(call.input),
          directory: proof(PARENT, DIR_ID),
          captureDirectory: proof(`${PARENT}\\.folio-hot-capture-${wire.captureId}`, CAPTURE_ID),
        };
        return onCapture?.(operation, wire, reply) ?? ok(JSON.stringify(reply));
      }
      const phase = operation as Core;
      const input = Buffer.from(call.input);
      // Every source/lifecycle dispatch must already have exact durable intent.
      const entry = [...saved.values()].find(item =>
        item.intent.capturePhase === phase && item.ready?.equals(input) && item.output === undefined);
      expect(entry).toBeDefined();
      cores.push({ phase, input });
      const override = onCore?.(phase, wire);
      if (override) return override;
      const envelope = {
        version: 1, operation, path: PATH, root: ROOT, profile: wire.profile,
        attemptId: wire.attemptId, slot: 0, directory: proof(PARENT, DIR_ID), slotDirectory: proof(SLOT, SLOT_ID),
      };
      const sources = [
        { suffix: "", present: true, byteLength: 100, sha256: hash("main"), evidence: proof(PATH, FILE_ID) },
        { suffix: "-journal", present: false }, { suffix: "-wal", present: false }, { suffix: "-shm", present: false },
      ];
      const body = phase === "snapshot"
        ? { ...envelope, state: "SNAPSHOT", sources, snapshotDirectory: SLOT, snapshotPath: `${SLOT}\\snapshot.sqlite` }
        : phase === "revalidate" ? { ...envelope, state: "REVALIDATED", sources }
          : { ...envelope, state: "SEALED" };
      const stdout = JSON.stringify(body);
      return ok(largeReplies && phase !== "seal" ? stdout.padEnd(62 * 1024, " ") : stdout);
    },
  };
  const controller = createWindowsHotJournalSnapshot(options, port);
  return {
    saved, operations, cores, controller,
    set onCore(value: typeof onCore) { onCore = value; },
    set onCapture(value: typeof onCapture) { onCapture = value; },
    set largeReplies(value: boolean) { largeReplies = value; },
    set executable(value: Buffer) { executable = value; },
    exercise(phase: Core, callback: () => void = () => {}) {
      if (phase === "snapshot" || phase === "revalidate" || phase === "seal")
        controller.withSnapshot(request, callback);
      else if (phase === "inspect") controller.inspectSnapshot(request, reference);
      else if (phase === "release")
        controller.releaseSnapshot(request, inspection, { fingerprint: "current-cut", assertCurrent() {} });
      else controller.commitReleaseEvidence(request, reference, { request: "e30=", response: "e30=", stderr: "" });
    },
  };
}
function caught(run: () => void): WindowsHotJournalSnapshotError {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(WindowsHotJournalSnapshotError);
    return error as WindowsHotJournalSnapshotError;
  }
  throw new Error("expected failure");
}
const UNKNOWN_CAPTURE = "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN_CAPTURE_NOT_ACKNOWLEDGED";

describe("hot journal persistent raw capture protocol (simulation only)", () => {
  it("commits snapshot raw before callback and all three phases before returning", () => {
    const f = fixture();
    let callbacks = 0;
    f.exercise("snapshot", () => {
      callbacks++;
      const entries = [...f.saved.values()];
      expect(entries).toHaveLength(1);
      expect(entries[0].output?.metadata.complete).toBe(true);
      expect(JSON.parse(entries[0].output!.stdout.toString()).state).toBe("SNAPSHOT");
      expect(f.operations.at(-1)).toBe("capture-output");
    });
    expect(callbacks).toBe(1);
    expect([...f.saved.values()].map(entry => entry.intent.capturePhase)).toEqual(["snapshot", "revalidate", "seal"]);
    expect([...f.saved.values()].every(entry => entry.output?.metadata.complete)).toBe(true);
    expect(f.operations).toEqual(["snapshot", "revalidate", "seal"].flatMap(phase =>
      ["capture-intent", "capture-wire", "capture-ready", phase, "capture-output"]));
    // A fresh controller sees the same retained records; creation is never adoption.
    const retained = [...f.saved.entries()];
    fixture(f.saved);
    expect([...f.saved.entries()]).toEqual(retained);
  });

  it.each<Core>(["snapshot", "revalidate", "seal", "inspect", "release", "commit-release-evidence"])(
    "persists malformed raw before rejecting %s and never dispatches a later phase", phase => {
      const f = fixture();
      const stdout = Buffer.from([0xff, 0, 0x7b, 0x22, 0x80]);
      const stderr = Buffer.from([0xfe, 0x0a]);
      f.onCore = current => current === phase
        ? { status: 3, signal: null, stdout: stdout.toString("latin1"), stderr: stderr.toString("latin1"), captureEncoding: "latin1" }
        : undefined;
      const error = caught(() => f.exercise(phase));
      expect(error.code).toBe("WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN");
      const entry = [...f.saved.values()].find(item => item.intent.capturePhase === phase)!;
      expect(entry.output!.stdout).toEqual(stdout);
      expect(entry.output!.stderr).toEqual(stderr);
      expect(entry.output!.metadata).toMatchObject({ status: 3, signal: null, complete: true });
      expect(entry.ready).toEqual(f.cores.at(-1)!.input);
      expect(f.cores.at(-1)!.phase).toBe(phase);
      expect(f.operations.at(-1)).toBe("capture-output");
    },
  );

  it.each(["duplicate JSON", "signal", "limit", "throw"] as const)("retains exact %s failure metadata", kind => {
    const f = fixture();
    const raw = kind === "limit" ? "\x80".repeat(64 * 1024) : '{"version":1,"version":1}';
    f.onCore = () => {
      if (kind === "throw") throw Object.assign(new Error("transport"), {
        code: "EPIPE", stdout: Buffer.from([0xff, 0]), stderr: Buffer.from([0xfe]),
      });
      return { ...ok(raw), status: kind === "signal" ? null : 0,
        signal: kind === "signal" ? "SIGTERM" : null,
        ...(kind === "limit" ? { errorCode: "ENOBUFS" } : {}) };
    };
    caught(() => f.exercise("snapshot"));
    const output = [...f.saved.values()][0].output!;
    expect(output.metadata.complete).toBe(true);
    if (kind === "throw") {
      expect(output.metadata).toMatchObject({ exec: "threw", errorCode: "EPIPE" });
      expect(output.stdout).toEqual(Buffer.from([0xff, 0]));
      expect(output.stderr).toEqual(Buffer.from([0xfe]));
    }
    else expect(output.stdout).toEqual(Buffer.from(raw, "latin1"));
    if (kind === "signal") expect(output.metadata.signal).toBe("SIGTERM");
    if (kind === "limit") expect(output.metadata.errorCode).toBe("ENOBUFS");
    expect(f.cores).toHaveLength(1);
  });

  it("chunks a lifecycle wire above 64 KiB without enlarging any component", () => {
    const f = fixture();
    f.largeReplies = true;
    f.exercise("snapshot");
    const seal = [...f.saved.values()].find(entry => entry.intent.capturePhase === "seal")!;
    expect(seal.ready!.length).toBeGreaterThan(64 * 1024);
    expect(seal.ready!.length).toBeLessThanOrEqual(1024 * 1024);
    expect(seal.chunks.size).toBeGreaterThan(1);
    expect(seal.ready).toEqual(f.cores.find(core => core.phase === "seal")!.input);
    expect(seal.output?.metadata.complete).toBe(true);
  });

  it.each(["capture-intent", "capture-wire", "capture-ready", "capture-output"])(
    "treats a missing %s ACK as UNKNOWN, preserving evidence without retry", lost => {
      const f = fixture();
      f.onCapture = operation => operation === lost ? { ...ok(""), status: null, signal: "SIGKILL" } : undefined;
      let callbacks = 0;
      const error = caught(() => f.exercise("snapshot", () => { callbacks++; }));
      expect(error.code).toBe(UNKNOWN_CAPTURE);
      expect(callbacks).toBe(0);
      expect(f.cores).toHaveLength(lost === "capture-output" ? 1 : 0);
      const calls = f.operations.length;
      expect(caught(() => f.exercise("snapshot"))).toBe(error);
      expect(f.operations).toHaveLength(calls);
      const evidence = error.evidence as { events: { captured: { requestBase64: string; stdout?: string } }[] };
      expect(Buffer.from(evidence.events[0].captured.requestBase64, "base64").length).toBeGreaterThan(0);
      if (lost === "capture-output") {
        expect([...f.saved.values()][0].output).toBeDefined();
        expect(evidence.events[0].captured.stdout).toContain('"SNAPSHOT"');
      }
    },
  );

  it.each(["root", "parent", "destination", "request hash", "reservation"])(
    "refuses %s capture authority failure before source dispatch", failure => {
      const f = fixture();
      f.onCapture = (operation, _wire, reply) => {
        if (operation !== "capture-ready") return undefined;
        if (failure === "root") reply.directory.rootFileId = "f".repeat(32);
        if (failure === "parent") reply.directory.fileId = "f".repeat(32);
        if (failure === "destination") reply.captureDirectory.canonicalPath = `${ROOT}\\other`;
        if (failure === "request hash") reply.requestSha256 = "f".repeat(64);
        return failure === "reservation"
          ? { ...ok("PRIVATE_JOURNAL_SNAPSHOT_CAPACITY"), status: 3 }
          : ok(JSON.stringify(reply));
      };
      expect(caught(() => f.exercise("snapshot")).code).toBe(UNKNOWN_CAPTURE);
      expect(f.cores).toHaveLength(0);
    },
  );

  it("keeps an oversized observed result in memory and never claims full durable capture", () => {
    const f = fixture();
    const raw = "\xff".repeat(64 * 1024 + 1);
    f.onCore = () => ({ ...ok(raw), errorCode: "ENOBUFS" });
    const error = caught(() => f.exercise("snapshot"));
    expect(error.code).toBe(UNKNOWN_CAPTURE);
    const output = [...f.saved.values()][0].output!;
    expect(output.stdout).toHaveLength(64 * 1024);
    expect(output.metadata).toMatchObject({ complete: false, stdoutByteLength: 64 * 1024 + 1, stdoutSha256: hash(Buffer.from(raw, "latin1")) });
    expect((error.evidence as any).events[0].captured.stdout).toBe(raw);
    expect(caught(() => f.exercise("snapshot"))).toBe(error);
  });

  it("retains committed snapshot evidence when semantic validation rejects", () => {
    const f = fixture(), semantic = new Error("wrong workspace");
    expect(() => f.exercise("snapshot", () => { throw semantic; })).toThrow(semantic);
    expect(f.cores.map(core => core.phase)).toEqual(["snapshot"]);
    expect([...f.saved.values()][0].output?.metadata.complete).toBe(true);
  });

  it("retains exact raw in memory when helper replacement prevents the output commit", () => {
    const f = fixture();
    f.onCore = () => {
      f.executable = Buffer.from("replaced executable");
      return ok("exact unparsed reply");
    };
    const error = caught(() => f.exercise("snapshot"));
    expect(error.code).toBe(UNKNOWN_CAPTURE);
    expect(f.cores).toHaveLength(1);
    expect([...f.saved.values()][0].ready).toEqual(f.cores[0].input);
    expect([...f.saved.values()][0].output).toBeUndefined();
    expect((error.evidence as any).events[0].captured.stdout).toBe("exact unparsed reply");
    expect(caught(() => f.exercise("snapshot"))).toBe(error);
  });

  it("rechecks release authority after capture readiness and before release dispatch", () => {
    const f = fixture(), lost = new Error("current cut changed");
    let ready = false;
    f.onCapture = operation => { if (operation === "capture-ready") ready = true; return undefined; };
    expect(() => f.controller.releaseSnapshot(request, inspection, {
      fingerprint: "current-cut",
      assertCurrent() { expect(ready).toBe(true); throw lost; },
    })).toThrow(lost);
    expect(f.cores).toHaveLength(0);
    expect([...f.saved.values()][0].ready).toBeDefined();
  });

  it("does not dispatch the source if a capture ACK boundary poisons the controller", () => {
    const f = fixture();
    f.onCapture = operation => {
      if (operation === "capture-ready")
        expect(caught(() => f.exercise("snapshot")).code).toBe("WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
      return undefined;
    };
    expect(caught(() => f.exercise("snapshot")).code).toBe("WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED");
    expect(f.cores).toHaveLength(0);
  });
});
