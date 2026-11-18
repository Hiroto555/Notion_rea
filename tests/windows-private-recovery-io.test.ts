import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWindowsPrivateRecoveryIoForTesting,
  observeWindowsRecoveryPublishNew,
  publishPrivateFileV3,
  WINDOWS_RECOVERY_MAX_BYTES,
  WINDOWS_RECOVERY_MAX_WIRE_BYTES,
  type WindowsRecoveryIo,
  type WindowsRecoveryIoExecRequest,
  type WindowsRecoveryIoExecResult,
  type WindowsRecoveryIoPublishRequest,
} from "../src/platform/windows/private-recovery-io";
import { WindowsRecoveryArchive } from "../src/platform/windows/recovery-archive";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import type { WindowsRuntimeFileStat } from "../src/platform/windows/runtime-platform";
import {
  armRecoveryPortObservation,
  consumeRecoveryPortObservation,
  createWindowsRecoveryFilePort,
  isRegisteredRecoveryFilePort,
  type CrashRecoveryNativePort,
} from "../src/platform/windows/recovery-file-port";
import { CrashRecoveryFile, getCrashRecoveryReadFailure } from "../src/persistence/crash-recovery-file";
import { CRASH_RECOVERY_MAX_BYTES, emptyCrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { canonicalOperation } from "../src/shared/save-contract";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  getCheckpointCapacityRefusal,
  getCheckpointGenerationConflict,
  getCheckpointPostPublicationUnknown,
  getCheckpointPriorPending,
  getRecoveryIoFailureCause,
  recordCheckpointCapacityRefusal,
} from "../src/platform/private-mutation-diagnostic";
import { PrivateFilePublicationUnknownError } from "../src/platform/private-file-port";
import { createPrivateRequestHandlers, type PrivateRequestContext } from "../src/main/private-request-handlers";
import type { Request } from "../src/shared/types";
import { createPrivatePersistenceLifecycle } from "../src/main/private-persistence-lifecycle";
import { WorkspaceSyncGate } from "../src/main/workspace-sync-gate";

// Contract-only fixture: a fake native executor doing a binary v3 roundtrip
// plus a real disposable archive on a PosixPrivatePlatform relabelled
// "windows". This is never Windows OS/filesystem acceptance.
const ROOT = "C:\\Folio";
const PARENT = `${ROOT}\\recovery`;
const LOGICAL = `${PARENT}\\crash-recovery.json`;
const TARGET = `${PARENT}\\.crash-recovery.json.generation-${"b".repeat(32)}.json`;
const STAGING = `${PARENT}\\.folio-recovery-${"a".repeat(32)}.tmp`;
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("in-memory pinned v3 executable fixture");
const ROOT_ID = "1".repeat(32);
const DIRECTORY_ID = "2".repeat(32);
const STAGE_ID = "5".repeat(32);
const VOLUME = "4".repeat(16);
const SID = "S-1-5-21-1000";
const ATTEMPT = "a".repeat(32);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
const archives: WindowsRecoveryArchive[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const archive of archives.splice(0)) { try { archive.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-recovery-io-")));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

/** Relabelled "windows" adapter over the POSIX platform. assertFile drops the
 * POSIX ledger's 16 MiB file bound (this archive holds 32 MiB originals) while
 * keeping the remaining contract checks; explicitly untrusted, not OS proof. */
function testingPlatform(failRoot = { current: false }): PrivatePlatform {
  const inner = new PosixPrivatePlatform();
  return {
    kind: "windows",
    bind: (d: string) => inner.bind(d),
    assertRoot: () => {
      if (failRoot.current) throw new Error("untrusted-root-failure");
      inner.assertRoot();
    },
    assertFile: (p: string) => {
      // Contract-only stand-in for the native identity/size proof: the POSIX
      // adapter's 16 MiB ledger bound cannot hold a 32 MiB recovery archive.
      inner.assertRoot();
      const stat = lstatSync(p);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error("untrusted-file-proof");
    },
    assertSidecars: (p: string) => inner.assertSidecars(p),
    createExclusive: (p: string) => inner.createExclusive(p),
    assertEmptyFile: (p: string) => inner.assertEmptyFile(p),
    close: () => inner.close(),
  };
}

function newArchive(binding = "binding:test", directory = tempDir()): WindowsRecoveryArchive {
  const archive = new WindowsRecoveryArchive(directory, testingPlatform(), binding, []);
  archives.push(archive);
  return archive;
}

type Wire = Record<string, unknown>;
function encode(header: Wire, payload: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(header), "ascii");
  const frame = Buffer.alloc(4 + json.byteLength + payload.byteLength);
  frame.writeUInt32LE(json.byteLength, 0);
  json.copy(frame, 4);
  frame.set(payload, 4 + json.byteLength);
  return frame;
}
function decode(buffer: Uint8Array): { header: Wire; payload: Uint8Array } {
  const length = buffer[0] | (buffer[1] << 8) | (buffer[2] << 16) | (buffer[3] << 24);
  return {
    header: JSON.parse(Buffer.from(buffer).subarray(4, 4 + length).toString("ascii")) as Wire,
    payload: Uint8Array.from(buffer.subarray(4 + length)),
  };
}

function proof(canonicalPath: string, root: string, fileId: string, rootFileId: string, rootVolumeId: string) {
  return {
    platform: "win32", sid: SID, ownerSid: SID, daclPrivate: true, reparsePoint: false,
    linkCount: 1, localFilesystem: true, canonicalPath, canonicalRoot: root,
    fileId, rootFileId, rootVolumeId, volumeId: rootVolumeId,
  };
}

type ExecFault = { malformed?: "dup-keys" | "truncated" | "binary-junk" | "bad-header"; once?: boolean };
function fixture(faults: {
  exec?: ExecFault; failCurrent?: { current: boolean }; afterCommit?: () => void;
  legacy?: boolean; capture?: Uint8Array; currentProof?: () => void;
  beforeIo?: (archive: WindowsRecoveryArchive) => void;
} = {}) {
  const calls: { phase: string; wire: Wire; payload: Uint8Array }[] = [];
  let staged: { id: string; bytes: Uint8Array } | undefined;
  const published = new Map<string, { fileId: string; bytes: Uint8Array }>();
  let identities = 0;
  const directory = tempDir();
  const fsPort = {
    lstat: (_path: string): WindowsRuntimeFileStat => ({
      isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
      nlink: 1, dev: 7, ino: 42, size: EXE_BYTES.byteLength, mtimeMs: 1000,
    }),
    readFile: (_path: string) => EXE_BYTES,
  };
  const exec = (request: WindowsRecoveryIoExecRequest): WindowsRecoveryIoExecResult => {
    const parsed = decode(request.input);
    const wire = parsed.header;
    calls.push({ phase: String(wire.operation), wire, payload: parsed.payload });
    if (faults.capture) return {status: null, signal: null, errorCode: "ENOBUFS",
      stdout: faults.capture, stderr: Buffer.from([255, 0, 128])};
    const fault = faults.exec;
    if (fault !== undefined && (!fault.once || calls.length === 1)) {
      if (fault.malformed === "dup-keys") {
        const duplicate = Buffer.from('{"a":1,"a":2}', "latin1");
        const framed = Buffer.alloc(4 + duplicate.byteLength);
        framed.writeUInt32LE(duplicate.byteLength, 0);
        duplicate.copy(framed, 4);
        return { status: 0, signal: null, stdout: framed, stderr: new Uint8Array(0) };
      }
      if (fault.malformed === "truncated")
        return { status: 0, signal: null, stdout: encode({ contractVersion: 3 }, new Uint8Array(0)).subarray(0, 10), stderr: new Uint8Array(0) };
      if (fault.malformed === "binary-junk")
        return { status: 0, signal: null, stdout: new Uint8Array([0xff, 0xfe, 0x00, 0x01]), stderr: new Uint8Array(0) };
      if (fault.malformed === "bad-header")
        return { status: 0, signal: null, stdout: encode({ contractVersion: 2, operation: "prepare", path: wire.path, root: wire.root, state: "PREPARED" }, new Uint8Array(0)), stderr: new Uint8Array(0) };
    }
    const base = {
      contractVersion: 3, operation: wire.operation, path: wire.path, root: wire.root,
      ...(wire.attemptId !== undefined ? { attemptId: wire.attemptId, stagingPath: wire.stagingPath } : {}),
    };
    const dir = proof(String(wire.path).slice(0, String(wire.path).lastIndexOf("\\")), String(wire.root), String(wire.directoryFileId), String(wire.rootFileId), String(wire.rootVolumeId));
    if (wire.operation === "prepare") {
      staged = { id: ++identities === 1 ? STAGE_ID : identities.toString(16).padStart(32, "0"), bytes: parsed.payload };
      return {
        status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({ ...base, state: "PREPARED", file: proof(String(wire.stagingPath), String(wire.root), staged.id, String(wire.rootFileId), String(wire.rootVolumeId)), directory: dir, byteLength: parsed.payload.byteLength, sha256: hash(parsed.payload), contentFlushed: true, filesystem: "NTFS" }, parsed.payload),
      };
    }
    if (wire.operation === "commit-prepared") {
      published.set(String(wire.path), { fileId: staged!.id, bytes: staged!.bytes });
      faults.afterCommit?.();
      return {
        status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({ ...base, state: "PUBLISHED", file: proof(String(wire.path), String(wire.root), staged!.id, String(wire.rootFileId), String(wire.rootVolumeId)), directory: dir, byteLength: staged!.bytes.byteLength, sha256: hash(staged!.bytes), contentFlushed: true, filesystem: "NTFS", stagingDisposition: "RENAMED_TO_FINAL", namespace: "EXCLUSIVE_NO_REPLACE", durability: { profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH" } }, staged!.bytes),
      };
    }
    const file = published.get(String(wire.path))!;
    return {
      status: 0, signal: null, stderr: new Uint8Array(0),
      stdout: encode({ ...base, state: "READ", file: proof(String(wire.path), String(wire.root), file.fileId, String(wire.rootFileId), String(wire.rootVolumeId)), directory: dir, byteLength: file.bytes.byteLength, sha256: hash(file.bytes), filesystem: "NTFS" }, file.bytes),
    };
  };
  const open = () => {
    const archive = newArchive("binding:test", directory);
    faults.beforeIo?.(archive);
    const assertCurrent = () => {
      if (faults.failCurrent?.current) throw new Error("fence");
      faults.currentProof?.();
    };
    const io = createWindowsPrivateRecoveryIoForTesting({
    root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
    expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
    archive,
    directoryIdentity: () => ({ fileId: DIRECTORY_ID, volumeId: VOLUME }),
    assertCurrent,
  }, { fs: fsPort, exec });
    const port = createWindowsRecoveryFilePort({archive, io, assertCurrent,
      parentIdentityFor: () => ({fileId: DIRECTORY_ID, volumeId: VOLUME}),
      assertLegacyAbsent() { if (faults.legacy) throw new Error("legacy original retained"); }});
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: port});
    return {archive, io, port, file};
  };
  return { ...open(), open, calls, published, staged: () => staged, fsPort,
    dispatches: () => calls.filter(c => c.phase !== "read-private").length };
}

const publish = (overrides: Partial<WindowsRecoveryIoPublishRequest> = {}, bytes?: Uint8Array): WindowsRecoveryIoPublishRequest => ({
  path: TARGET, stagingPath: STAGING, attemptId: ATTEMPT,
  bytes: bytes ?? new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]),
  logicalPath: LOGICAL, workspaceId: "ws-1",
  generation: 1, expectedHead: null,
  expectedDirectory: { canonicalPath: PARENT, fileId: DIRECTORY_ID, volumeId: VOLUME },
  beforePublish: () => {}, ...overrides,
});

describe("windows private recovery port observation wiring (contract-only, NOT_RUN on Windows)", () => {
  it("matches the first THREW witness without native dispatch", () => {
    const f = fixture();
    const stableError = new Error("stable-readHead-failure");
    const spy = vi.spyOn(f.archive, "readHead").mockImplementation(() => {
      throw stableError;
    });
    const r = { path: LOGICAL, workspaceId: "ws-1", expected: undefined, generation: 1, bytes: new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]) };
    const handle = armRecoveryPortObservation(f.port, r);
    expect(handle).toBeDefined();
    let caught: unknown;
    try {
      f.port.compareAndSwap(r);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(stableError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(f.dispatches()).toBe(0);
    const first = consumeRecoveryPortObservation(handle, "THREW", caught);
    expect(first).toEqual({ matched: true, terminal: "THREW" });
    if (!first.matched) throw new Error("expected a matched observation");
    expect(first.publication).toBeUndefined();
    expect(first.generationConflict).toBeUndefined();
    expect(Object.isFrozen(first)).toBe(true);
    expect(consumeRecoveryPortObservation(handle, "THREW", caught)).toEqual({ matched: false });
  });

  it("keeps an old witness invalid after same-request reentry", () => {
    const f = fixture();
    const stableError = new Error("stable-readHead-failure");
    const spy = vi.spyOn(f.archive, "readHead").mockImplementation(() => {
      throw stableError;
    });
    const r = { path: LOGICAL, workspaceId: "ws-1", expected: undefined, generation: 1, bytes: new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]) };
    const handle = armRecoveryPortObservation(f.port, r);
    expect(handle).toBeDefined();
    let firstCaught: unknown;
    let secondCaught: unknown;
    try {
      f.port.compareAndSwap(r);
    } catch (error) {
      firstCaught = error;
    }
    try {
      f.port.compareAndSwap(r);
    } catch (error) {
      secondCaught = error;
    }
    expect(firstCaught).toBe(stableError);
    expect(secondCaught).toBe(stableError);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(f.dispatches()).toBe(0);
    expect(consumeRecoveryPortObservation(handle, "THREW", firstCaught)).toEqual({ matched: false });
  });

  it("matches a returned witness once and rejects a clone on first consume", () => {
    const first = fixture();
    const firstRequest = { path: LOGICAL, workspaceId: "ws-1", expected: undefined, generation: 1, bytes: new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]) };
    const firstHandle = armRecoveryPortObservation(first.port, firstRequest);
    expect(firstHandle).toBeDefined();
    const firstReturned = first.port.compareAndSwap(firstRequest);
    expect(firstReturned.generation).toBe(1);
    expect(Array.from(firstReturned.bytes)).toEqual(Array.from(firstRequest.bytes));
    expect(first.dispatches()).toBe(2);
    const firstConsume = consumeRecoveryPortObservation(firstHandle, "RETURNED", firstReturned);
    const firstAttemptId = first.archive.readHead(LOGICAL, "ws-1")!.pointer.attemptId;
    expect(firstConsume).toEqual({
      matched: true,
      terminal: "RETURNED",
      publication: {
        attemptId: firstAttemptId,
        stage: "READBACK",
        sourceOutcome: {
          source: "RECOVERY_IO",
          contractVersion: 3,
          state: "PUBLISHED",
          reason: null,
        },
      },
    });
    if (!firstConsume.matched) throw new Error("expected a matched observation");
    expect(Object.isFrozen(firstConsume)).toBe(true);
    expect(Object.isFrozen(firstConsume.publication)).toBe(true);
    expect(Object.isFrozen(firstConsume.publication!.sourceOutcome)).toBe(true);
    expect(firstConsume.generationConflict).toBeUndefined();
    expect(consumeRecoveryPortObservation(firstHandle, "RETURNED", firstReturned)).toEqual({ matched: false });

    const second = fixture();
    const secondRequest = { path: LOGICAL, workspaceId: "ws-1", expected: undefined, generation: 1, bytes: new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]) };
    const secondHandle = armRecoveryPortObservation(second.port, secondRequest);
    expect(secondHandle).toBeDefined();
    const secondReturned = second.port.compareAndSwap(secondRequest);
    expect(secondReturned.generation).toBe(1);
    expect(Array.from(secondReturned.bytes)).toEqual(Array.from(secondRequest.bytes));
    expect(second.dispatches()).toBe(2);
    expect(consumeRecoveryPortObservation(secondHandle, "RETURNED", { ...secondReturned })).toEqual({ matched: false });
    expect(consumeRecoveryPortObservation(secondHandle, "RETURNED", secondReturned)).toEqual({ matched: false });
  });

  it("returns the current generationConflict only for a matched precondition throw", () => {
    const f = fixture();
    f.port.compareAndSwap({
      path: LOGICAL, workspaceId: "ws-1", expected: undefined,
      generation: 1, bytes: new Uint8Array([1, 2, 3]),
    });
    const request = {
      path: LOGICAL, workspaceId: "ws-1", expected: undefined,
      generation: 1, bytes: new Uint8Array([4, 5, 6]),
    };
    const handle = armRecoveryPortObservation(f.port, request);
    expect(handle).toBeDefined();
    let caught: unknown;
    try {
      f.port.compareAndSwap(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CollaborationError);
    const error = caught as CollaborationError;
    expect(error.code).toBe("WINDOWS_RECOVERY_PORT_CONFLICT");
    const result = consumeRecoveryPortObservation(handle, "THREW", caught);
    expect(result).toEqual({
      matched: true,
      terminal: "THREW",
      generationConflict: {
        kind: "GENERATION_CONFLICT",
        family: "CHECKPOINT",
        stage: "PRECONDITION",
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "NOT_DISPATCHED_PROVEN",
        proofOrigin: "VALIDATED_PRECONDITION",
        attemptId: null,
        sourceCauseCodes: ["WINDOWS_RECOVERY_PORT_CONFLICT"],
        precondition: {
          expectedGeneration: 0,
          observedActualGeneration: 1,
          mismatch: "GENERATION",
        },
      },
    });
    if (!result.matched) throw new Error("expected a matched observation");
    expect(result.publication).toBeUndefined();
    expect(result.generationConflict).toBe(getCheckpointGenerationConflict(caught));
    expect(f.dispatches()).toBe(2);
  });
});

describe("windows private recovery io v3 (contract-only, NOT_RUN on Windows)", () => {
  it("publishes an exact 32 MiB payload over two binary wire calls", () => {
    const bytes = new Uint8Array(32 * 1024 * 1024);
    for (let index = 0; index < bytes.byteLength; index += 4096) bytes[index] = index & 0xff;
    const { io, calls, archive } = fixture();
    const receipt = io.publishNew(publish({}, bytes));
    expect(receipt.state).toBe("PUBLISHED");
    if (receipt.state !== "PUBLISHED") throw new Error("unreachable");
    expect(receipt.contractVersion).toBe(3);
    expect(receipt.byteLength).toBe(bytes.byteLength);
    expect(receipt.sha256).toBe(hash(bytes));
    expect(Buffer.from(receipt.readback).equals(bytes)).toBe(true);
    expect(receipt.stagingDisposition).toBe("RENAMED_TO_FINAL");
    expect(receipt.namespace).toBe("EXCLUSIVE_NO_REPLACE");
    expect(receipt.contentFlushed).toBe(true);
    expect(receipt.durability.profile).toBe("WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1");
    expect(calls.map((call) => call.phase)).toEqual(["prepare", "commit-prepared"]);
    // Exact original, both wires and both raw captures are durably archived.
    expect(Buffer.from(archive.readBlob(ATTEMPT, "original")!).equals(bytes)).toBe(true);
    expect(archive.readBlob(ATTEMPT, "wire:prepare")!.byteLength).toBeGreaterThan(4);
    expect(decode(archive.readBlob(ATTEMPT, "wire:prepare")!).payload.byteLength).toBe(bytes.byteLength);
    expect(archive.readBlob(ATTEMPT, "wire:commit-prepared")!.byteLength).toBeLessThanOrEqual(4 + 8192);
    expect(archive.readBlob(ATTEMPT, "capture:prepare:stdout")!.byteLength).toBeGreaterThan(4);
    expect(archive.readBlob(ATTEMPT, "capture:commit-prepared:stdout")!.byteLength).toBeGreaterThan(4);
    expect(archive.readBlob(ATTEMPT, "capture:prepare:stderr")!.byteLength).toBe(0);
    const captureMeta = JSON.parse(Buffer.from(archive.readBlob(ATTEMPT, "capture:prepare:metadata")!).toString("utf8")) as Record<string, unknown>;
    expect(captureMeta.status).toBe(0);
    expect(captureMeta.captureTruncated).toBe(false);
    expect(archive.terminalReceipt(ATTEMPT)).toContain('"PUBLISHED"');
  });

  it("rejects payload at max+1 before any helper dispatch", () => {
    const { io, calls } = fixture();
    const outcome = io.publishNew(publish({}, new Uint8Array(WINDOWS_RECOVERY_MAX_BYTES + 1)));
    expect(outcome.state).toBe("REJECTED");
    expect(calls).toHaveLength(0);
  });

  it("keeps the whole wire inside the bound", () => {
    expect(WINDOWS_RECOVERY_MAX_WIRE_BYTES).toBe(4 + 8192 + WINDOWS_RECOVERY_MAX_BYTES);
  });

  it("UNKNOWN on a throwing approval callback; commit is never dispatched and the original is retained", () => {
    const { io, calls, archive } = fixture();
    const outcome = io.publishNew(publish({ beforePublish: () => { throw new Error("deny"); } }));
    expect(outcome.state).toBe("UNKNOWN");
    expect(calls.map((call) => call.phase)).toEqual(["prepare"]);
    expect(archive.readBlob(ATTEMPT, "original")).toBeDefined();
    expect(archive.terminalReceipt(ATTEMPT)).toContain('"UNKNOWN"');
  });

  it("UNKNOWN on an asynchronous approval callback", () => {
    const { io, calls } = fixture();
    const outcome = io.publishNew(publish({
      beforePublish: () => Promise.resolve() as unknown as void,
    }));
    expect(outcome.state).toBe("UNKNOWN");
    expect(calls.map((call) => call.phase)).toEqual(["prepare"]);
  });

  it.each(["dup-keys", "truncated", "binary-junk", "bad-header"] as const)("UNKNOWN on malformed binary response: %s", (malformed) => {
    const { io, archive } = fixture({ exec: { malformed, once: true } });
    const outcome = io.publishNew(publish());
    expect(outcome.state).toBe("UNKNOWN");
    expect(archive.terminalReceipt(ATTEMPT)).toContain('"UNKNOWN"');
  });

  it("retains an oversized protocol capture EXACTLY within the finite bound and reports UNKNOWN", () => {
    const oversized = new Uint8Array(WINDOWS_RECOVERY_MAX_WIRE_BYTES + 512 * 1024).fill(0x41);
    const exec = (): WindowsRecoveryIoExecResult => ({
      status: 1, signal: null, errorCode: "ENOBUFS", stdout: oversized, stderr: new Uint8Array(0),
    });
    const archive = newArchive();
    const io = createWindowsPrivateRecoveryIoForTesting({
      root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
      archive,
      directoryIdentity: () => ({ fileId: DIRECTORY_ID, volumeId: VOLUME }),
      assertCurrent: () => {},
    }, { fs: { lstat: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1, dev: 1, ino: 1, size: EXE_BYTES.byteLength, mtimeMs: 1 }), readFile: () => EXE_BYTES }, exec });
    const outcome = io.publishNew(publish());
    expect(outcome.state).toBe("UNKNOWN");
    // The exact oversized capture is durable — never an empty substitute.
    const captured = archive.readBlob(ATTEMPT, "capture:prepare:stdout")!;
    expect(captured.byteLength).toBe(oversized.byteLength);
    expect(captured[captured.byteLength - 1]).toBe(0x41);
    const meta = JSON.parse(Buffer.from(archive.readBlob(ATTEMPT, "capture:prepare:metadata")!).toString("utf8")) as Record<string, unknown>;
    expect(meta.captureTruncated).toBe(true);
    expect(meta.errorCode).toBe("ENOBUFS");
    expect(archive.terminalReceipt(ATTEMPT)).toContain('"UNKNOWN"');
  });

  it("a reopened archive retains the original but grants no dispatch rights", () => {
    const dir = tempDir();
    const first = new WindowsRecoveryArchive(dir, testingPlatform(), "binding:test", []);
    archives.push(first);
    const exec = () => { throw new Error("helper gone"); };
    const io = createWindowsPrivateRecoveryIoForTesting({
      root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
      archive: first,
      directoryIdentity: () => ({ fileId: DIRECTORY_ID, volumeId: VOLUME }),
      assertCurrent: () => {},
    }, { fs: { lstat: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1, dev: 1, ino: 1, size: EXE_BYTES.byteLength, mtimeMs: 1 }), readFile: () => EXE_BYTES }, exec });
    const original = new Uint8Array([1, 2, 3]);
    expect(io.publishNew(publish({}, original)).state).toBe("UNKNOWN");
    first.close();
    archives.splice(archives.indexOf(first), 1);
    const reopened = new WindowsRecoveryArchive(dir, testingPlatform(), "binding:test", []);
    archives.push(reopened);
    expect(Buffer.from(reopened.readBlob(ATTEMPT, "original")!).equals(original)).toBe(true);
    // Reopen keeps every record but the new instance cannot record or resume.
    expect(() => reopened.record(ATTEMPT, "wire:commit-prepared", new Uint8Array(4))).toThrow();
    expect(() => reopened.recordTerminal(ATTEMPT, '{"outcome":"PUBLISHED"}')).toThrow();
    const meta = reopened.readMetadata(ATTEMPT)!;
    expect(meta.logicalPath).toBe(LOGICAL);
  });

  it("pins read-private by exact identity and hash", () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    const { io } = fixture();
    const receipt = io.publishNew(publish({}, bytes));
    if (receipt.state !== "PUBLISHED") throw new Error("expected published");
    const read = io.readPrivate({
      path: TARGET,
      expectedDirectory: { fileId: DIRECTORY_ID, volumeId: VOLUME },
      expectedFile: { canonicalPath: TARGET, fileId: STAGE_ID, volumeId: VOLUME },
      expectedSha256: hash(bytes),
      maxBytes: WINDOWS_RECOVERY_MAX_BYTES,
    });
    expect(read.state).toBe("READ");
    if (read.state !== "READ") throw new Error("unreachable");
    expect(Buffer.from(read.bytes).equals(bytes)).toBe(true);
  });

  it("rejects a revalidation callback returning a defined value", () => {
    const archive = newArchive();
    const io = createWindowsPrivateRecoveryIoForTesting({
      root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
      archive,
      directoryIdentity: () => ({ fileId: DIRECTORY_ID, volumeId: VOLUME }),
      assertCurrent: () => ({ fence: false }) as unknown as void,
    }, { fs: { lstat: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1, dev: 1, ino: 1, size: EXE_BYTES.byteLength, mtimeMs: 1 }), readFile: () => EXE_BYTES }, exec: () => { throw new Error("unreachable"); } });
    const outcome = io.publishNew(publish());
    expect(outcome.state).toBe("REJECTED");
  });

  it("publishPrivateFileV3 validates the receipt of a v3 product port", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const port = {
      contractVersion: 3 as const, platform: "win32" as const,
      publish: (request: { path: string; stagingPath: string; attemptId: string; bytes: Uint8Array; beforePublish(r: Uint8Array): void }) => {
        request.beforePublish(Uint8Array.from(request.bytes));
        return Object.freeze({
          contractVersion: 3 as const, state: "PUBLISHED" as const,
          path: request.path, stagingPath: request.stagingPath, attemptId: request.attemptId,
          identity: Object.freeze({ canonicalPath: request.path, fileId: "9".repeat(32), volumeId: "8".repeat(16) }),
          byteLength: request.bytes.byteLength, sha256: hash(request.bytes),
          readback: Uint8Array.from(request.bytes),
          stagingDisposition: "RENAMED_TO_FINAL" as const, contentFlushed: true as const,
          namespace: "EXCLUSIVE_NO_REPLACE" as const,
          durability: Object.freeze({ profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const, scope: "PROCESS_CRASH" as const }),
        });
      },
    };
    const receipt = publishPrivateFileV3(port, {
      path: TARGET, stagingPath: STAGING, attemptId: ATTEMPT, bytes, beforePublish: () => {},
    });
    expect(receipt.contractVersion).toBe(3);
    expect(receipt.stagingDisposition).toBe("RENAMED_TO_FINAL");
  });
});

describe("composed archive + binary IO + logical CAS + CrashRecoveryFile", () => {
  const snapshot = (value: string) => ({...emptyCrashRecoverySnapshot(),
    rawDrafts: [{scope: "record" as const, pageId: "record", key: "text", value}]});

  const expectPortConflict = (
    action: () => unknown,
    expectedGeneration: number,
    observedActualGeneration: number,
    mismatch: "GENERATION" | "HEAD_TOKEN_OR_BYTES",
  ): CollaborationError => {
    let caught: unknown = undefined;
    try { action(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CollaborationError);
    const error = caught as CollaborationError;
    expect(error.name).toBe("CollaborationError");
    expect(error.message).toBe("WINDOWS_RECOVERY_PORT_CONFLICT");
    expect(error.code).toBe("WINDOWS_RECOVERY_PORT_CONFLICT");
    const diagnostic = getCheckpointGenerationConflict(error);
    expect(diagnostic).toMatchObject({
      kind: "GENERATION_CONFLICT",
      family: "CHECKPOINT",
      stage: "PRECONDITION",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "VALIDATED_PRECONDITION",
      attemptId: null,
    });
    expect(diagnostic?.precondition).toEqual({
      expectedGeneration,
      observedActualGeneration,
      mismatch,
    });
    return error;
  };

  it("records GENERATION when the expectation is absent and a head exists", () => {
    const f = fixture();
    f.file.write(0, snapshot("existing"));
    const current = f.port.read(LOGICAL, "ws-1")!;
    const before = f.archive.readHead(LOGICAL, "ws-1")!;
    const pointer = before.pointer;
    const original = Uint8Array.from(before.original);
    const dispatches = f.dispatches();
    expectPortConflict(
      () => f.port.compareAndSwap({
        path: LOGICAL,
        workspaceId: "ws-1",
        expected: undefined,
        generation: 1,
        bytes: new Uint8Array([1, 2, 3]),
      }),
      0,
      current.generation,
      "GENERATION",
    );
    expect(f.dispatches()).toBe(dispatches);
    const after = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(after.pointer).toEqual(pointer);
    expect(Buffer.from(after.original).equals(Buffer.from(original))).toBe(true);
  });

  it("records GENERATION when the expectation is present and the head is empty", () => {
    const f = fixture();
    expect(f.port.read(LOGICAL, "ws-1")).toBeUndefined();
    const dispatches = f.dispatches();
    expectPortConflict(
      () => f.port.compareAndSwap({
        path: LOGICAL,
        workspaceId: "ws-1",
        generation: 2,
        expected: { generation: 1, token: "d".repeat(32), bytes: new Uint8Array([9, 8, 7]) },
        bytes: new Uint8Array([1, 2, 3]),
      }),
      1,
      0,
      "GENERATION",
    );
    expect(f.dispatches()).toBe(dispatches);
    expect(f.archive.readHead(LOGICAL, "ws-1")).toBeUndefined();
  });

  it("records GENERATION for a present expectation with a different actual generation", () => {
    const f = fixture();
    f.file.write(0, snapshot("existing"));
    const current = f.port.read(LOGICAL, "ws-1")!;
    const expectedGeneration = current.generation + 1;
    const before = f.archive.readHead(LOGICAL, "ws-1")!;
    const pointer = before.pointer;
    const original = Uint8Array.from(before.original);
    const dispatches = f.dispatches();
    expectPortConflict(
      () => f.port.compareAndSwap({
        path: LOGICAL,
        workspaceId: "ws-1",
        generation: expectedGeneration + 1,
        expected: {
          generation: expectedGeneration,
          token: current.token,
          bytes: Uint8Array.from(current.bytes),
        },
        bytes: new Uint8Array([1, 2, 3]),
      }),
      expectedGeneration,
      current.generation,
      "GENERATION",
    );
    expect(f.dispatches()).toBe(dispatches);
    const after = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(after.pointer).toEqual(pointer);
    expect(Buffer.from(after.original).equals(Buffer.from(original))).toBe(true);
  });

  it("records HEAD_TOKEN_OR_BYTES for an equal-generation token mismatch", () => {
    const f = fixture();
    f.file.write(0, snapshot("existing"));
    const current = f.port.read(LOGICAL, "ws-1")!;
    const differentToken = current.token === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32);
    const before = f.archive.readHead(LOGICAL, "ws-1")!;
    const pointer = before.pointer;
    const original = Uint8Array.from(before.original);
    const dispatches = f.dispatches();
    expectPortConflict(
      () => f.port.compareAndSwap({
        path: LOGICAL,
        workspaceId: "ws-1",
        generation: current.generation + 1,
        expected: {
          generation: current.generation,
          token: differentToken,
          bytes: Uint8Array.from(current.bytes),
        },
        bytes: new Uint8Array([1, 2, 3]),
      }),
      current.generation,
      current.generation,
      "HEAD_TOKEN_OR_BYTES",
    );
    expect(f.dispatches()).toBe(dispatches);
    const after = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(after.pointer).toEqual(pointer);
    expect(Buffer.from(after.original).equals(Buffer.from(original))).toBe(true);
  });

  it("records HEAD_TOKEN_OR_BYTES for an equal-generation byte mismatch", () => {
    const f = fixture();
    f.file.write(0, snapshot("existing"));
    const current = f.port.read(LOGICAL, "ws-1")!;
    const differentBytes = Uint8Array.from(current.bytes, (byte, index) =>
      index === 0 ? byte ^ 0xff : byte);
    const before = f.archive.readHead(LOGICAL, "ws-1")!;
    const pointer = before.pointer;
    const original = Uint8Array.from(before.original);
    const dispatches = f.dispatches();
    expectPortConflict(
      () => f.port.compareAndSwap({
        path: LOGICAL,
        workspaceId: "ws-1",
        generation: current.generation + 1,
        expected: {
          generation: current.generation,
          token: current.token,
          bytes: differentBytes,
        },
        bytes: new Uint8Array([1, 2, 3]),
      }),
      current.generation,
      current.generation,
      "HEAD_TOKEN_OR_BYTES",
    );
    expect(f.dispatches()).toBe(dispatches);
    const after = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(after.pointer).toEqual(pointer);
    expect(Buffer.from(after.original).equals(Buffer.from(original))).toBe(true);
  });

  it("keeps a matching expectation with the wrong next generation untagged", () => {
    const f = fixture();
    f.file.write(0, snapshot("existing"));
    const current = f.port.read(LOGICAL, "ws-1")!;
    const before = f.archive.readHead(LOGICAL, "ws-1")!;
    const pointer = before.pointer;
    const original = Uint8Array.from(before.original);
    const dispatches = f.dispatches();
    let caught: unknown = undefined;
    try {
      f.port.compareAndSwap({
        path: LOGICAL,
        workspaceId: "ws-1",
        generation: current.generation + 2,
        expected: {
          generation: current.generation,
          token: current.token,
          bytes: Uint8Array.from(current.bytes),
        },
        bytes: new Uint8Array([1, 2, 3]),
      });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CollaborationError);
    const error = caught as CollaborationError;
    expect(error.name).toBe("CollaborationError");
    expect(error.message).toBe("WINDOWS_RECOVERY_PORT_CONFLICT");
    expect(error.code).toBe("WINDOWS_RECOVERY_PORT_CONFLICT");
    expect(getCheckpointGenerationConflict(error)).toBeUndefined();
    expect(f.dispatches()).toBe(dispatches);
    const after = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(after.pointer).toEqual(pointer);
    expect(Buffer.from(after.original).equals(Buffer.from(original))).toBe(true);
  });

  it("publishes six generations and reopens without purging earlier originals/wires", () => {
    const f = fixture(), retained: {id: string; bytes: Uint8Array}[] = [];
    for (let n = 0; n < 6; n++) {
      expect(f.file.write(n, snapshot(`draft-${n}`)).generation).toBe(n + 1);
      const head = f.archive.readHead(LOGICAL, "ws-1")!;
      retained.push({id: head.pointer.attemptId, bytes: head.original});
    }
    expect(f.dispatches()).toBe(12);
    f.archive.close();
    const fresh = f.open();
    expect(fresh.file.read()).toMatchObject({status: "ready", generation: 6, snapshot: snapshot("draft-5")});
    expect(fresh.file.write(5, snapshot("draft-5")).generation).toBe(6);
    expect(f.dispatches()).toBe(12);
    for (const item of retained) {
      expect(Buffer.from(fresh.archive.readBlob(item.id, "original")!).equals(item.bytes)).toBe(true);
      expect(fresh.archive.readBlob(item.id, "wire:prepare")).toBeDefined();
      expect(fresh.archive.readBlob(item.id, "capture:commit-prepared:stdout")).toBeDefined();
    }
  });

  it("publishes and reopens an exact 32 MiB snapshot through the actual logical port", () => {
    const f = fixture(), input = snapshot("");
    input.unverifiedInputs = [{reason: "bounded raw contract fixture", input: ""}];
    const overhead = Buffer.byteLength(canonicalOperation(input));
    input.unverifiedInputs[0].input = "x".repeat(CRASH_RECOVERY_MAX_BYTES - overhead);
    expect(Buffer.byteLength(canonicalOperation(input))).toBe(CRASH_RECOVERY_MAX_BYTES);
    expect(f.file.write(0, input).generation).toBe(1);
    expect(f.archive.readHead(LOGICAL, "ws-1")!.original.byteLength).toBeGreaterThan(CRASH_RECOVERY_MAX_BYTES);
    f.archive.close();
    expect(f.open().file.read().snapshot).toEqual(input);
    expect(f.dispatches()).toBe(2);
  });

  it("case aliases share one pointer; foreign workspaces cannot read or replace it", () => {
    const f = fixture();
    f.file.write(0, snapshot("one"));
    const alias = new CrashRecoveryFile(LOGICAL.toUpperCase(), "ws-1", {platform: "win32", nativePort: f.port});
    expect(alias.read().generation).toBe(1);
    expect(alias.write(1, snapshot("two")).generation).toBe(2);
    const foreign = new CrashRecoveryFile(LOGICAL, "other-workspace", {platform: "win32", nativePort: f.port});
    expect(foreign.read().status).toBe("blocked");
    expect(() => foreign.write(0, snapshot("foreign"))).toThrow();
    expect(f.dispatches()).toBe(4);
  });

  it("rejects a competing live owner before a second native dispatch", () => {
    const f = fixture(), other = f.open();
    const first = publish({beforePublish() {
      expect(other.io.publishNew(publish({attemptId: "c".repeat(32),
        path: `${PARENT}\\another-generation.json`, stagingPath: `${PARENT}\\another-stage.tmp`})).state).toBe("REJECTED");
    }});
    expect(f.io.publishNew(first).state).toBe("PUBLISHED");
    expect(f.dispatches()).toBe(2);
    expect(() => other.port.read(LOGICAL.toUpperCase(), "foreign")).toThrow();
  });

  it.each(["auth", "session", "cut", "source"])("keeps pointer UNKNOWN after %s loss and refuses resend after reopen", (fence) => {
    let revoked = false;
    const f = fixture({currentProof() { if (revoked) throw new Error(`${fence} changed`); },
      afterCommit() { revoked = true; }});
    let caught: unknown;
    try { f.file.write(0, snapshot("unknown")); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(PrivateFilePublicationUnknownError);
    // A post-dispatch UNKNOWN never carries a pre-dispatch capacity origin.
    expect(getCheckpointCapacityRefusal((caught as { cause?: unknown }).cause)).toBeUndefined();
    expect(f.dispatches()).toBe(2);
    const pending = f.archive.pendingAttempts(LOGICAL, "ws-1");
    expect(pending).toHaveLength(1);
    const original = f.archive.readBlob(pending[0], "original")!;
    f.archive.close(); revoked = false;
    const fresh = f.open();
    expect(fresh.file.read().status).toBe("blocked");
    expect(() => fresh.file.write(0, snapshot("unknown"))).toThrow();
    const reopened = fresh.file.read();
    const readFailure = getCrashRecoveryReadFailure(reopened);
    expect(readFailure?.priorPending?.attemptId).toBe(pending[0]);
    expect(readFailure?.priorPending?.mutationDispatch).toBe("UNPROVEN");
    let resend: unknown;
    try { fresh.file.write(0, snapshot("unknown")); } catch (error) { resend = error; }
    const resendPending = getCheckpointPriorPending(resend);
    expect(resendPending?.attemptId).toBe(pending[0]);
    expect(resendPending?.proofOrigin).toBe("NONE");
    expect(resendPending?.failureSubject).toBe("PRIOR_ATTEMPT");
    expect(f.dispatches()).toBe(2);
    expect(Buffer.from(fresh.archive.readBlob(pending[0], "original")!).equals(original)).toBe(true);
  });

  it("retains the exact precondition conflict when the CAS token is stale", () => {
    const f = fixture();
    const first = snapshot("first");
    f.file.write(0, first);
    const headBefore = f.archive.readHead(LOGICAL, "ws-1")!;
    const pointer = headBefore.pointer;
    const original = Uint8Array.from(headBefore.original);
    const dispatches = f.dispatches();
    const realPort = f.port;
    type CasRequest = Parameters<typeof realPort.compareAndSwap>[0];
    let captured: CollaborationError | undefined;
    const port: typeof realPort = {
      ...realPort,
      read: (path: string, workspaceId: string) => realPort.read(path, workspaceId),
      compareAndSwap: (request: CasRequest) => {
        if (request.expected === undefined) throw new Error("expected generation must be present");
        const differentToken = `${request.expected.token[0] === "c" ? "d" : "c"}${request.expected.token.slice(1)}`;
        try {
          return realPort.compareAndSwap({
            ...request,
            expected: {...request.expected, token: differentToken},
          });
        } catch (error) {
          if (!(error instanceof CollaborationError)) throw error;
          captured = error;
          throw error;
        }
      },
    };
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: port});
    let unresolved: unknown;
    try {
      file.write(1, snapshot("second"));
    } catch (error) {
      unresolved = error;
    }
    expect(unresolved).toBeInstanceOf(PrivateFilePublicationUnknownError);
    if (!(unresolved instanceof PrivateFilePublicationUnknownError))
      throw new Error("expected an unresolved publication");
    if (captured === undefined) throw new Error("expected a captured CollaborationError");
    expect(unresolved.cause).toBe(captured);
    expect(unresolved.result).toBeUndefined();
    const diagnostic = getCheckpointGenerationConflict(unresolved);
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toBe(getCheckpointGenerationConflict(captured));
    if (diagnostic === undefined) throw new Error("missing generation conflict diagnostic");
    expect(diagnostic.kind).toBe("GENERATION_CONFLICT");
    expect(diagnostic.family).toBe("CHECKPOINT");
    expect(diagnostic.stage).toBe("PRECONDITION");
    expect(diagnostic.failureSubject).toBe("CURRENT_ATTEMPT");
    expect(diagnostic.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
    expect(diagnostic.proofOrigin).toBe("VALIDATED_PRECONDITION");
    expect(diagnostic.attemptId).toBeNull();
    expect(diagnostic.sourceCauseCodes).toEqual(["WINDOWS_RECOVERY_PORT_CONFLICT"]);
    expect(diagnostic.precondition).toEqual({
      expectedGeneration: 1,
      observedActualGeneration: 1,
      mismatch: "HEAD_TOKEN_OR_BYTES",
    });
    expect(f.dispatches()).toBe(dispatches);
    const headAfter = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(headAfter.pointer).toEqual(pointer);
    expect(Buffer.from(headAfter.original).equals(Buffer.from(original))).toBe(true);
    const readable = f.file.read()!;
    if (readable.status !== "ready") throw new Error("first snapshot is not readable");
    expect(readable.generation).toBe(1);
    expect(canonicalOperation(readable.snapshot)).toBe(canonicalOperation(first));
  });
  it("proves APPLIED after acknowledgement loss without another publication", () => {
    const f = fixture(), actual = f.archive.compareAndSwapHead.bind(f.archive);
    const lostAckError = new Error("APPLIED acknowledgement lost");
    vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation((...args) => {
      actual(...args);
      throw lostAckError;
    });
    let error: unknown;
    try {
      f.file.write(0, snapshot("applied"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
    if (!(error instanceof PrivateFilePublicationUnknownError)) throw new Error("expected publication error");
    expect(error.message).toBe("Recovery pointer advance unresolved");
    expect(error.code).toBe("PRIVATE_FILE_PUBLICATION_UNKNOWN");
    expect(error.cause).toBe(lostAckError);
    const head = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(head.pointer.generation).toBe(1);
    const currentId = head.pointer.attemptId;
    expect(error.result).toMatchObject({ state: "PUBLISHED", attemptId: head.pointer.attemptId });
    const c = getCheckpointPostPublicationUnknown(error)!;
    expect(c).toEqual({
      kind: "OUTCOME_UNKNOWN",
      family: "CHECKPOINT",
      stage: "HEAD_CAS",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "DISPATCHED",
      proofOrigin: "DISPATCH_OBSERVED",
      attemptId: currentId,
      sourceOutcome: { source: "RECOVERY_IO", contractVersion: 3, state: "PUBLISHED", reason: null },
    });
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c.sourceOutcome)).toBe(true);
    expect(getCheckpointGenerationConflict(error)).toBeUndefined();
    expect(getCheckpointGenerationConflict(lostAckError)).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(lostAckError)).toBeUndefined();
    const original = Uint8Array.from(head.original);
    const rawWire = f.archive.readBlob(currentId, "wire:prepare");
    expect(rawWire).toBeDefined();
    const wire = Uint8Array.from(rawWire!);
    const terminal = f.archive.terminalReceipt(currentId);
    expect(typeof terminal).toBe("string");
    expect(f.published.size).toBe(1);
    const [entry] = [...f.published.values()];
    expect(Buffer.from(entry!.bytes).equals(head.original)).toBe(true);
    f.archive.close();
    const reopened = f.open();
    expect(reopened.file.write(0, snapshot("applied"))).toMatchObject({ status: "ready", generation: 1 });
    const reopenedHead = reopened.archive.readHead(LOGICAL, "ws-1")!;
    expect(reopenedHead.pointer).toEqual(head.pointer);
    expect(Buffer.from(reopenedHead.original).equals(original)).toBe(true);
    const reopenedWire = reopened.archive.readBlob(currentId, "wire:prepare");
    expect(reopenedWire).toBeDefined();
    expect(Buffer.from(reopenedWire!).equals(wire)).toBe(true);
    const reopenedTerminal = reopened.archive.terminalReceipt(currentId);
    expect(typeof reopenedTerminal).toBe("string");
    expect(reopenedTerminal).toBe(terminal);
    expect(f.dispatches()).toBe(2);
    expect(f.published.size).toBe(1);
  });

  it("surfaces PUBLISHED publication uncertainty without erasing the APPLIED head or minting a D conflict", () => {
    const f = fixture();
    f.file.write(0, snapshot("first"));
    const head = f.archive.readHead(LOGICAL, "ws-1")!;
    const pointer = head.pointer;
    const original = Uint8Array.from(head.original);
    expect(pointer.generation).toBe(1);
    const dispatches = f.dispatches();
    const conflict = new CollaborationError("WINDOWS_RECOVERY_ARCHIVE_CONFLICT");
    const casSpy = vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation(() => { throw conflict; });
    let postPublicationDiagnostic: ReturnType<typeof getCheckpointPostPublicationUnknown> | undefined;
    let publishedResultId: string | undefined;
    try {
      f.file.write(1, snapshot("second"));
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
      if (!(error instanceof PrivateFilePublicationUnknownError)) throw error;
      expect(error.cause).toBe(conflict);
      expect(error.result).toMatchObject({state: "PUBLISHED"});
      const result = error.result;
      if (typeof result !== "object" || result === null ||
          (result as { state?: unknown }).state !== "PUBLISHED" ||
          typeof (result as { attemptId?: unknown }).attemptId !== "string")
        throw new Error("expected PUBLISHED result with attemptId");
      publishedResultId = (result as { attemptId: string }).attemptId;
      const diagnostic = getCheckpointPostPublicationUnknown(error);
      expect(diagnostic).toEqual({
        kind: "OUTCOME_UNKNOWN",
        family: "CHECKPOINT",
        stage: "HEAD_CAS",
        failureSubject: "CURRENT_ATTEMPT",
        mutationDispatch: "DISPATCHED",
        proofOrigin: "DISPATCH_OBSERVED",
        attemptId: publishedResultId,
        sourceOutcome: {
          source: "RECOVERY_IO",
          contractVersion: 3,
          state: "PUBLISHED",
          reason: null,
        },
      });
      expect(Object.isFrozen(diagnostic)).toBe(true);
      expect(Object.isFrozen(diagnostic!.sourceOutcome)).toBe(true);
      postPublicationDiagnostic = diagnostic;
      expect(getCheckpointCapacityRefusal(error.cause)).toBeUndefined();
      expect(getCheckpointGenerationConflict(error)).toBeUndefined();
      expect(getCheckpointGenerationConflict(error.cause)).toBeUndefined();
      expect(getCheckpointGenerationConflict(error.result)).toBeUndefined();
      expect(getCheckpointPostPublicationUnknown(error.cause)).toBeUndefined();
      expect(getCheckpointPostPublicationUnknown(error.result)).toBeUndefined();
    }
    casSpy.mockRestore();
    expect(f.dispatches()).toBe(dispatches + 2);
    const after = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(after.pointer).toEqual(pointer);
    expect(Buffer.from(after.original).equals(Buffer.from(original))).toBe(true);
    const pending = f.archive.pendingAttempts(LOGICAL, "ws-1");
    expect(pending).toHaveLength(1);
    const pendingId = pending[0]!;
    expect(postPublicationDiagnostic).toBeDefined();
    expect(postPublicationDiagnostic!.attemptId).toBe(pendingId);
    expect(postPublicationDiagnostic!.attemptId).toBe(publishedResultId);
    const pendingOriginal = f.archive.readBlob(pendingId, "original");
    const pendingWire = f.archive.readBlob(pendingId, "wire:prepare");
    const pendingReceipt = f.archive.terminalReceipt(pendingId);
    expect(pendingOriginal).toBeInstanceOf(Uint8Array);
    expect(pendingWire).toBeInstanceOf(Uint8Array);
    expect(typeof pendingReceipt).toBe("string");
    const pendingOriginalBytes = Uint8Array.from(pendingOriginal!);
    const pendingWireBytes = Uint8Array.from(pendingWire!);
    const dispatchesBeforePending = f.dispatches();
    try {
      f.file.write(1, snapshot("third"));
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PrivateFilePublicationUnknownError);
      if (!(error instanceof PrivateFilePublicationUnknownError)) throw error;
      expect(error.cause).toBeInstanceOf(CollaborationError);
      const cause = error.cause;
      if (!(cause instanceof CollaborationError)) throw cause;
      expect(cause.code).toBe("WINDOWS_RECOVERY_PORT_PENDING");
      expect(getCheckpointPostPublicationUnknown(error)).toBeUndefined();
      expect(getCheckpointPostPublicationUnknown(cause)).toBeUndefined();
      expect(getCheckpointGenerationConflict(error)).toBeUndefined();
      expect(getCheckpointGenerationConflict(cause)).toBeUndefined();
    }
    expect(f.dispatches()).toBe(dispatchesBeforePending);
    expect(f.archive.pendingAttempts(LOGICAL, "ws-1")).toEqual([pendingId]);
    expect(Buffer.from(f.archive.readBlob(pendingId, "original")!).equals(Buffer.from(pendingOriginalBytes))).toBe(true);
    expect(Buffer.from(f.archive.readBlob(pendingId, "wire:prepare")!).equals(Buffer.from(pendingWireBytes))).toBe(true);
    expect(f.archive.terminalReceipt(pendingId)).toBe(pendingReceipt);
    const finalHead = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(finalHead.pointer).toEqual(pointer);
    expect(Buffer.from(finalHead.original).equals(Buffer.from(original))).toBe(true);
  });

  it("surfaces READBACK C after a real CAS commit and one missing normal post-CAS head read", () => {
    const f = fixture();
    const workspaceId = "ws-1";
    f.file.write(0, snapshot("readback-first"));

    const oldHead = f.archive.readHead(LOGICAL, workspaceId);
    expect(oldHead).toBeDefined();
    const oldPointer = { ...oldHead!.pointer };
    const oldId = oldPointer.attemptId;
    const oldHeadOriginal = Uint8Array.from(oldHead!.original);
    const oldWire = f.archive.readBlob(oldId, "wire:prepare");
    const oldOriginal = f.archive.readBlob(oldId, "original");
    expect(oldWire).toBeDefined();
    expect(oldOriginal).toBeDefined();
    const oldWireBytes = Uint8Array.from(oldWire!);
    const oldOriginalBytes = Uint8Array.from(oldOriginal!);
    expect(Buffer.from(oldHeadOriginal).equals(Buffer.from(oldOriginalBytes))).toBe(true);
    const oldTerminal = f.archive.terminalReceipt(oldId);
    expect(typeof oldTerminal).toBe("string");

    const baselineNative = [...f.published.values()][0];
    expect(baselineNative).toBeDefined();
    const baselineNativeBytes = Uint8Array.from(baselineNative!.bytes);
    expect(Buffer.from(baselineNativeBytes).equals(Buffer.from(oldOriginalBytes))).toBe(true);
    const initialDispatches = f.dispatches();
    expect(initialDispatches).toBe(2);
    expect(f.published.size).toBe(1);

    const actualReadHead = f.archive.readHead.bind(f.archive);
    const actualCas = f.archive.compareAndSwapHead.bind(f.archive);
    let hideNextRead = false;
    const casSpy = vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation((...args) => {
      const returned = actualCas(...args);
      hideNextRead = true;
      return returned;
    });
    const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
      if (hideNextRead) {
        hideNextRead = false;
        return undefined;
      }
      return actualReadHead(...args);
    });

    let thrown: unknown;
    try {
      f.file.write(1, snapshot("readback-second"));
    } catch (cause) {
      thrown = cause;
    }
    casSpy.mockRestore();
    readSpy.mockRestore();

    expect(thrown).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const error = thrown as PrivateFilePublicationUnknownError;
    expect(error.message).toBe("Recovery published readback unresolved");
    expect(error.code).toBe("PRIVATE_FILE_PUBLICATION_UNKNOWN");
    expect(error.path).toBe(LOGICAL);
    expect(error.cause).toBeUndefined();

    const newHead = f.archive.readHead(LOGICAL, workspaceId);
    expect(newHead).toBeDefined();
    const newId = newHead!.pointer.attemptId;
    expect(newHead!.pointer.generation).toBe(2);
    expect(newId).not.toBe(oldId);
    expect(error.result).toMatchObject({ state: "PUBLISHED", attemptId: newId });

    const newWire = f.archive.readBlob(newId, "wire:prepare");
    const newOriginal = f.archive.readBlob(newId, "original");
    expect(newWire).toBeDefined();
    expect(newOriginal).toBeDefined();
    const newWireBytes = Uint8Array.from(newWire!);
    const newOriginalBytes = Uint8Array.from(newOriginal!);
    const decodedNewWire = decode(newWireBytes);
    expect(typeof decodedNewWire.header.stagingPath).toBe("string");
    expect(error.stagingPath).toBe(decodedNewWire.header.stagingPath);
    const newTerminal = f.archive.terminalReceipt(newId);
    expect(typeof newTerminal).toBe("string");
    const newTerminalValue = newTerminal!;

    const newWireAfter = f.archive.readBlob(newId, "wire:prepare");
    const newOriginalAfter = f.archive.readBlob(newId, "original");
    expect(newWireAfter).toBeDefined();
    expect(newOriginalAfter).toBeDefined();
    expect(Buffer.from(newWireAfter!).equals(Buffer.from(newWireBytes))).toBe(true);
    expect(Buffer.from(newOriginalAfter!).equals(Buffer.from(newOriginalBytes))).toBe(true);
    const newTerminalAfter = f.archive.terminalReceipt(newId);
    expect(typeof newTerminalAfter).toBe("string");
    expect(newTerminalAfter).toBe(newTerminalValue);

    const oldWireAfter = f.archive.readBlob(oldId, "wire:prepare");
    const oldOriginalAfter = f.archive.readBlob(oldId, "original");
    expect(oldWireAfter).toBeDefined();
    expect(oldOriginalAfter).toBeDefined();
    expect(Buffer.from(oldWireAfter!).equals(Buffer.from(oldWireBytes))).toBe(true);
    expect(Buffer.from(oldOriginalAfter!).equals(Buffer.from(oldOriginalBytes))).toBe(true);
    const oldTerminalAfter = f.archive.terminalReceipt(oldId);
    expect(typeof oldTerminalAfter).toBe("string");
    expect(oldTerminalAfter).toBe(oldTerminal);

    const diagnostic = getCheckpointPostPublicationUnknown(error);
    expect(diagnostic).toEqual({
      kind: "OUTCOME_UNKNOWN",
      family: "CHECKPOINT",
      stage: "READBACK",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "DISPATCHED",
      proofOrigin: "DISPATCH_OBSERVED",
      attemptId: newId,
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "PUBLISHED",
        reason: null,
      },
    });
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic!.sourceOutcome)).toBe(true);
    expect(getCheckpointGenerationConflict(error)).toBeUndefined();

    expect(f.dispatches()).toBe(initialDispatches + 2);
    expect(f.published.size).toBe(2);
    const publishedValues = [...f.published.values()];
    expect(publishedValues.some(v => Buffer.from(v.bytes).equals(Buffer.from(oldOriginalBytes)))).toBe(true);
    expect(publishedValues.some(v => Buffer.from(v.bytes).equals(Buffer.from(newOriginalBytes)))).toBe(true);
    expect(f.archive.pendingAttempts(LOGICAL, workspaceId)).toEqual([]);
  });

  it("keeps a malformed expectation and an authority fence out of the D diagnostic lane", () => {
    const failCurrent = {current: false};
    const f = fixture({failCurrent});
    f.file.write(0, snapshot("first"));
    const current = f.port.read(LOGICAL, "ws-1")!;
    const head = f.archive.readHead(LOGICAL, "ws-1")!;
    const pointer = head.pointer;
    const original = Uint8Array.from(head.original);
    const dispatches = f.dispatches();
    const malformedExpected = {...current, token: "invalid-token"};
    try {
      f.port.compareAndSwap({
        path: LOGICAL,
        workspaceId: "ws-1",
        expected: malformedExpected,
        generation: current.generation + 1,
        bytes: new Uint8Array([1, 2, 3]),
      });
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CollaborationError);
      if (!(error instanceof CollaborationError)) throw error;
      expect(error.code).toBe("WINDOWS_RECOVERY_PORT_REQUEST");
      expect(getCheckpointGenerationConflict(error)).toBeUndefined();
    }
    expect(f.dispatches()).toBe(dispatches);
    const afterMalformed = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(afterMalformed.pointer).toEqual(pointer);
    expect(Buffer.from(afterMalformed.original).equals(Buffer.from(original))).toBe(true);
    failCurrent.current = true;
    const dispatchesFenced = f.dispatches();
    try {
      f.file.write(1, snapshot("blocked"));
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw error;
      expect(error.message).toBe("fence");
      expect(getCheckpointGenerationConflict(error)).toBeUndefined();
    }
    expect(f.dispatches()).toBe(dispatchesFenced);
    const afterFence = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(afterFence.pointer).toEqual(pointer);
    expect(Buffer.from(afterFence.original).equals(Buffer.from(original))).toBe(true);
  });

  it("refuses a physical legacy file when the archive has no head", () => {
    const f = fixture({legacy: true});
    expect(f.file.read().status).toBe("blocked");
    expect(() => f.file.write(0, snapshot("new"))).toThrow();
    expect(f.dispatches()).toBe(0);
  });

  it("rechecks native prior bytes inside CAS and retains the original on corruption", () => {
    const faults: {afterCommit?: () => void} = {}, f = fixture(faults);
    f.file.write(0, snapshot("one"));
    const prior = f.archive.readHead(LOGICAL, "ws-1")!;
    const path = JSON.parse(prior.receipt).evidence.path as string;
    faults.afterCommit = () => { f.published.get(path)!.bytes = Buffer.from("corrupt foreign bytes"); };
    expect(() => f.file.write(1, snapshot("two"))).toThrow();
    expect(f.archive.readHead(LOGICAL, "ws-1")!.pointer.attemptId).toBe(prior.pointer.attemptId);
    expect(Buffer.from(f.archive.readBlob(prior.pointer.attemptId, "original")!).equals(prior.original)).toBe(true);
    expect(f.archive.pendingAttempts(LOGICAL, "ws-1")).toHaveLength(1);
    f.archive.close();
    expect(() => f.open().file.write(1, snapshot("two"))).toThrow();
    expect(f.dispatches()).toBe(4);
  });

  it("refuses the 65th attempt before dispatch and retains all preceding generations", () => {
    let overflowId = "";
    const f = fixture({ beforeIo(archive) {
      const actual = archive.reserve.bind(archive);
      vi.spyOn(archive, "reserve").mockImplementation((request) => {
        overflowId = request.attemptId;
        return actual(request);
      });
    } });
    for (let n = 0; n < 64; n++) f.file.write(n, snapshot(String(n)));
    const before = f.dispatches();
    const headBefore = f.archive.readHead(LOGICAL, "ws-1")!;
    let caught: unknown;
    try { f.file.write(64, snapshot("overflow")); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const error = caught as PrivateFilePublicationUnknownError;
    const result = error.result as { state: string; reason: string };
    expect(result.state).toBe("REJECTED");
    expect(result.reason).toBe("PRIVATE_IO_V3_REJECTED");
    expect(error.cause).toBe(getRecoveryIoFailureCause(error.result));
    expect((error.cause as Error).message).toContain("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    const originalRefusal = getCheckpointCapacityRefusal(error.cause)!;
    expect(originalRefusal).toMatchObject({
      kind: "PRE_DISPATCH_CAPACITY", family: "CHECKPOINT", stage: "RESERVE",
      failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "LOCAL_ADMISSION_GUARD", attemptId: overflowId,
      sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"],
    });
    expect(getCheckpointCapacityRefusal(error)).toBe(originalRefusal);
    expect(getCheckpointCapacityRefusal(result)).toBe(originalRefusal);
    expect(f.dispatches()).toBe(before);
    const headAfter = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(f.file.read().generation).toBe(64);
    expect(headAfter.pointer).toEqual(headBefore.pointer);
    expect(Buffer.from(headAfter.original).equals(headBefore.original)).toBe(true);
    expect(f.published.size).toBe(64);
  }, 30_000);

  it("keeps a plain string-CAPACITY reserve throw typed but grants no origin", () => {
    const original = new Error("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    const f = fixture({ beforeIo(archive) {
      vi.spyOn(archive, "reserve").mockImplementation(() => { throw original; });
    } });
    const outcome = f.io.publishNew(publish());
    expect(outcome).toMatchObject({ state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED" });
    expect(getRecoveryIoFailureCause(outcome)).toBe(original);
    expect(getCheckpointCapacityRefusal(outcome)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(original)).toBeUndefined();
    expect(f.dispatches()).toBe(0);
  });

  it("does not promote an Aggregate containing a tagged error to a capacity origin", () => {
    const tagged = new Error("tagged");
    recordCheckpointCapacityRefusal(tagged, ATTEMPT);
    const original = new AggregateError([tagged], "WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    const f = fixture({ beforeIo(archive) {
      vi.spyOn(archive, "reserve").mockImplementation(() => { throw original; });
    } });
    const outcome = f.io.publishNew(publish());
    expect(outcome).toMatchObject({ state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED" });
    expect(getRecoveryIoFailureCause(outcome)).toBe(original);
    expect(getCheckpointCapacityRefusal(outcome)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(original)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(tagged)).toBeDefined();
    expect(f.dispatches()).toBe(0);
  });

  it("keeps a non-matching Aggregate reserve throw UNKNOWN without recursive origin promotion", () => {
    const tagged = new Error("tagged");
    recordCheckpointCapacityRefusal(tagged, ATTEMPT);
    const original = new AggregateError([tagged], "reserve transaction uncertain");
    const f = fixture({ beforeIo(archive) {
      vi.spyOn(archive, "reserve").mockImplementation(() => { throw original; });
    } });
    let caught: unknown;
    try { f.file.write(0, snapshot("uncertain")); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const error = caught as PrivateFilePublicationUnknownError;
    expect(error.result).toMatchObject({ state: "UNKNOWN", reason: "PRIVATE_IO_V3_UNCONFIRMED" });
    expect(error.cause).toBe(original);
    expect(getRecoveryIoFailureCause(error.result)).toBe(original);
    expect(getCheckpointCapacityRefusal(error.result)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(error)).toBeUndefined();
    expect(getCheckpointCapacityRefusal(tagged)).toBeDefined();
    expect(f.dispatches()).toBe(0);
  });

  it("retains protocol-oversize/error captures exactly and records truncation metadata", () => {
    const capture = Buffer.alloc(WINDOWS_RECOVERY_MAX_WIRE_BYTES + 17, 0xff), f = fixture({capture});
    expect(f.io.publishNew(publish()).state).toBe("UNKNOWN");
    expect(Buffer.from(f.archive.readBlob(ATTEMPT, "capture:prepare:stdout")!).equals(capture)).toBe(true);
    expect(JSON.parse(Buffer.from(f.archive.readBlob(ATTEMPT, "capture:prepare:metadata")!).toString())).toMatchObject({
      captureTruncated: true, errorCode: "ENOBUFS", stdoutLength: capture.byteLength,
    });
  });

  it("snapshots the payload before caller revalidation mutates its buffer", () => {
    const bytes = Buffer.from([1, 2, 3, 4]), original = Buffer.from(bytes);
    const f = fixture({currentProof() { bytes.fill(9); }});
    expect(f.io.publishNew(publish({}, bytes)).state).toBe("PUBLISHED");
    expect(Buffer.from(f.archive.readBlob(ATTEMPT, "original")!).equals(original)).toBe(true);
    expect(Buffer.from(decode(f.archive.readBlob(ATTEMPT, "wire:prepare")!).payload).equals(original)).toBe(true);
  });
});

describe("windows recovery read-missing (contract-only, NOT_RUN on Windows)", () => {
  /** Minimal transport answering only read-missing — no publication captures. */
  function missingFixture(reply: (wire: Wire) => { header: Wire; payload?: Uint8Array; status?: number }) {
    const calls: Wire[] = [];
    const fsPort = {
      lstat: (_path: string): WindowsRuntimeFileStat => ({
        isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        nlink: 1, dev: 7, ino: 42, size: EXE_BYTES.byteLength, mtimeMs: 1000,
      }),
      readFile: (_path: string) => EXE_BYTES,
    };
    const exec = (request: WindowsRecoveryIoExecRequest): WindowsRecoveryIoExecResult => {
      const parsed = decode(request.input);
      calls.push(parsed.header);
      const answer = reply(parsed.header);
      return {
        status: answer.status ?? 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode(answer.header, answer.payload ?? new Uint8Array(0)),
      };
    };
    const archive = newArchive();
    const io = createWindowsPrivateRecoveryIoForTesting({
      root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME }, archive,
      directoryIdentity: () => ({ fileId: DIRECTORY_ID, volumeId: VOLUME }),
      assertCurrent: () => {},
    }, { fs: fsPort, exec });
    return { io, calls };
  }
  const missingRequest = { path: LOGICAL, expectedDirectory: { fileId: DIRECTORY_ID, volumeId: VOLUME } };
  const base = (wire: Wire) => ({
    contractVersion: 3, operation: "read-missing", path: wire.path, root: wire.root,
  });

  it("returns ABSENT only for an exact held-parent helper verdict", () => {
    const f = missingFixture((wire) => ({
      header: { ...base(wire), state: "ABSENT",
        directory: proof(PARENT, String(wire.root), String(wire.directoryFileId), String(wire.rootFileId), String(wire.rootVolumeId)) },
    }));
    const receipt = f.io.readMissing(missingRequest);
    expect(receipt.state).toBe("ABSENT");
    if (receipt.state !== "ABSENT") throw new Error("unreachable");
    expect(receipt.path).toBe(LOGICAL);
    expect(receipt.directory.fileId).toBe(DIRECTORY_ID);
    expect(f.calls.length).toBe(1);
    expect(f.calls[0].operation).toBe("read-missing");
  });

  it("returns the typed EXISTS verdict for a live physical file", () => {
    const f = missingFixture((wire) => ({ header: { ...base(wire), state: "EXISTS", reason: "PRIVATE_IO_V3_EXISTS" }, status: 2 }));
    const outcome = f.io.readMissing(missingRequest);
    expect(outcome.state).toBe("EXISTS");
  });

  it("any other helper verdict, error, or malformed reply is UNKNOWN — never absent", () => {
    for (const reply of [
      (wire: Wire) => ({ header: { ...base(wire), state: "UNKNOWN", reason: "ACCESS_DENIED" }, status: 1 }),
      (wire: Wire) => ({ header: { ...base(wire), state: "ABSENT" }, status: 1 }),           // nonzero status
      (wire: Wire) => ({ header: { ...base(wire), state: "ABSENT" }, payload: Uint8Array.from([1]) }), // payload junk
    ]) {
      const f = missingFixture(reply);
      const outcome = f.io.readMissing(missingRequest);
      expect(outcome.state).toBe("UNKNOWN");
      if (outcome.state !== "UNKNOWN") throw new Error("unreachable");
      expect(outcome.preserve).toBe(true);
    }
  });
});

describe("CrashRecoveryFile writeObserved current-fact lane (contract-only, NOT_RUN on Windows)", () => {
  const snapshot = (value: string) => ({...emptyCrashRecoverySnapshot(),
    rawDrafts: [{scope: "record" as const, pageId: "record", key: "text", value}]});

  type DiagnosticWindow = {
    webContents: {mainFrame: {url: string}};
    isDestroyed(): boolean;
  };
  const diagnosticWrite = (
    f: ReturnType<typeof fixture>,
    run?: (req: Request, context: PrivateRequestContext<DiagnosticWindow>) => Promise<unknown> | unknown,
  ) => {
    const frame = {url: "https://folio.test/"};
    const webContents = {mainFrame: frame};
    const requestWindow: DiagnosticWindow = {webContents, isDestroyed: () => false};
    const event = {sender: webContents, senderFrame: frame};
    const binding = {};
    const baseLifecycle = createPrivatePersistenceLifecycle();
    const observed: unknown[] = [];
    const lifecycle = {
      ...baseLifecycle,
      observe(error: unknown) { observed.push(error); baseLifecycle.observe(error); },
    };
    const handlers = createPrivateRequestHandlers({
      lifecycle,
      syncGate: new WorkspaceSyncGate(),
      enterScope: (work) => work(),
      getRequestWindow: () => requestWindow,
      getRendererGeneration: () => 1,
      getWorkspaceBinding: () => binding,
      trustedUrl: frame.url,
      dispatch: run ?? (async (req, context) => {
        const write = req as {expectedGeneration: number; snapshot: Parameters<CrashRecoveryFile["writeObserved"]>[1]};
        return context.withStorageAction(req, () =>
          context.writeRecovery(f.file, write.expectedGeneration, write.snapshot));
      }),
    });
    return {handlers, event, lifecycle, observed};
  };

  it("observes the factory publish result and each current dispatch boundary", () => {
    const success = fixture();
    const published = observeWindowsRecoveryPublishNew(success.io, publish());
    expect(published).toMatchObject({
      terminal: "RETURNED",
      trusted: true,
      dispatch: {attemptId: ATTEMPT, stage: "COMMIT"},
    });
    if (published.terminal !== "RETURNED") throw new Error("expected RETURNED");
    expect(published.value.state).toBe("PUBLISHED");
    expect(success.dispatches()).toBe(2);

    const prepare = fixture({exec: {malformed: "bad-header", once: true}});
    const prepareObserved = observeWindowsRecoveryPublishNew(prepare.io, publish());
    expect(prepareObserved).toMatchObject({
      terminal: "RETURNED",
      trusted: true,
      dispatch: {attemptId: ATTEMPT, stage: "PREPARE"},
    });
    if (prepareObserved.terminal !== "RETURNED") throw new Error("expected RETURNED");
    expect(prepareObserved.value.state).toBe("UNKNOWN");
    expect(prepare.calls).toHaveLength(1);

    const commitFault = new Error("commit-exec-fault");
    const commit = fixture({afterCommit() { throw commitFault; }});
    const commitObserved = observeWindowsRecoveryPublishNew(commit.io, publish());
    expect(commitObserved).toMatchObject({
      terminal: "RETURNED",
      trusted: true,
      dispatch: {attemptId: ATTEMPT, stage: "COMMIT"},
    });
    if (commitObserved.terminal !== "RETURNED") throw new Error("expected RETURNED");
    expect(commitObserved.value.state).toBe("UNKNOWN");
    expect(commit.calls).toHaveLength(2);
  });

  it("keeps a pin rejection before exec free of dispatch proof", () => {
    const f = fixture();
    const observed = observeWindowsRecoveryPublishNew(f.io, publish({
      expectedDirectory: {canonicalPath: PARENT, fileId: "9".repeat(32), volumeId: VOLUME},
    }));
    expect(observed.trusted).toBe(true);
    expect(observed.terminal).toBe("RETURNED");
    if (observed.terminal !== "RETURNED") throw new Error("expected RETURNED");
    expect(observed.value).toMatchObject({state: "REJECTED", reason: "PRIVATE_IO_V3_REJECTED"});
    expect(observed.dispatch).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  it("invokes an unregistered lookalike once but issues no trusted fact", () => {
    const f = fixture();
    const outcome = Object.freeze({
      contractVersion: 3 as const,
      state: "REJECTED" as const,
      path: TARGET,
      reason: "PRIVATE_IO_V3_REJECTED",
      preserve: true as const,
    });
    let calls = 0;
    const lookalike: WindowsRecoveryIo = {
      contractVersion: 3,
      platform: "win32",
      trust: "untrusted-test",
      publishNew() { calls++; return outcome; },
      readPrivate: f.io.readPrivate,
      readMissing: f.io.readMissing,
    };
    const observed = observeWindowsRecoveryPublishNew(lookalike, publish());
    expect(calls).toBe(1);
    expect(observed.trusted).toBe(false);
    expect(observed.terminal).toBe("RETURNED");
    if (observed.terminal !== "RETURNED") throw new Error("expected RETURNED");
    expect(observed.value).toBe(outcome);
    expect(observed.dispatch).toBeUndefined();
  });

  it("exposes the current capacity refusal only for a registered no-dispatch attempt", () => {
    let overflowId = "";
    const f = fixture({ beforeIo(archive) {
      const actual = archive.reserve.bind(archive);
      vi.spyOn(archive, "reserve").mockImplementation((request) => {
        overflowId = request.attemptId;
        return actual(request);
      });
    } });
    for (let n = 0; n < 64; n++) f.file.write(n, snapshot(String(n)));
    const before = f.dispatches();
    const observed = f.file.writeObserved(64, snapshot("overflow"));
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const failure = observed.recoveryIoFailure;
    expect(failure).toMatchObject({
      attemptId: overflowId,
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "REJECTED",
        reason: "PRIVATE_IO_V3_REJECTED",
      },
    });
    if (failure === undefined) throw new Error("expected recovery IO failure facts");
    expect(failure.dispatch).toBeUndefined();
    expect(failure.capacityRefusal).toMatchObject({
      attemptId: overflowId,
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "LOCAL_ADMISSION_GUARD",
      sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"],
    });
    expect(observed.postPublication).toBeUndefined();
    expect(f.dispatches()).toBe(before);
  }, 30_000);

  it("does not promote a capacity origin replayed from another attempt", () => {
    const oldAttempt = "c".repeat(32);
    const original = new Error("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    recordCheckpointCapacityRefusal(original, oldAttempt);
    let currentId = "";
    const f = fixture({ beforeIo(archive) {
      vi.spyOn(archive, "reserve").mockImplementation((request) => {
        currentId = request.attemptId;
        throw original;
      });
    } });
    const observed = f.file.writeObserved(0, snapshot("replayed-origin"));
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    const failure = observed.recoveryIoFailure;
    expect(failure).toMatchObject({
      attemptId: currentId,
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "REJECTED",
        reason: "PRIVATE_IO_V3_REJECTED",
      },
    });
    if (failure === undefined) throw new Error("expected recovery IO failure facts");
    expect(failure.dispatch).toBeUndefined();
    expect(failure.capacityRefusal).toBeUndefined();
    const error = observed.value as PrivateFilePublicationUnknownError;
    expect(getCheckpointCapacityRefusal(error.cause)).toMatchObject({attemptId: oldAttempt});
    expect(f.dispatches()).toBe(0);
  });

  it("retains current dispatch facts for prepare and commit non-publication", () => {
    const prepare = fixture({exec: {malformed: "bad-header", once: true}});
    const prepareObserved = prepare.file.writeObserved(0, snapshot("prepare-dispatch"));
    expect(prepareObserved.terminal).toBe("THREW");
    if (prepareObserved.terminal !== "THREW") throw new Error("expected THREW");
    const prepareError = prepareObserved.value as PrivateFilePublicationUnknownError;
    const prepareAttempt = (prepareError.result as {attemptId?: string}).attemptId;
    expect(prepareAttempt).toMatch(/^[0-9a-f]{32}$/);
    expect(prepareObserved.recoveryIoFailure).toMatchObject({
      attemptId: prepareAttempt,
      dispatch: {attemptId: prepareAttempt, stage: "PREPARE"},
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "UNKNOWN",
        reason: "PRIVATE_IO_V3_UNCONFIRMED",
      },
    });
    expect(prepare.dispatches()).toBe(1);

    const commitFault = new Error("commit-exec-fault");
    const commit = fixture({afterCommit() { throw commitFault; }});
    const commitObserved = commit.file.writeObserved(0, snapshot("commit-dispatch"));
    expect(commitObserved.terminal).toBe("THREW");
    if (commitObserved.terminal !== "THREW") throw new Error("expected THREW");
    const commitError = commitObserved.value as PrivateFilePublicationUnknownError;
    const commitAttempt = (commitError.result as {attemptId?: string}).attemptId;
    expect(commitObserved.recoveryIoFailure).toMatchObject({
      attemptId: commitAttempt,
      dispatch: {attemptId: commitAttempt, stage: "COMMIT"},
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "UNKNOWN",
        reason: "PRIVATE_IO_V3_UNCONFIRMED",
      },
    });
    expect(commit.dispatches()).toBe(2);
  });

  it("keeps a pre-dispatch authority rejection free of recovery IO facts", () => {
    const failCurrent = {current: true};
    const f = fixture({failCurrent});
    const observed = f.file.writeObserved(0, snapshot("authority"));
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect((observed.value as Error).message).toBe("fence");
    expect(observed.recoveryIoFailure).toBeUndefined();
    expect(observed.generationConflict).toBeUndefined();
    expect(observed.postPublication).toBeUndefined();
    expect(f.dispatches()).toBe(0);
  });

  it("does not trust an unregistered IO lookalike result shape", () => {
    const f = fixture();
    const archive = newArchive();
    const replayed = Object.freeze({
      contractVersion: 3 as const,
      state: "UNKNOWN" as const,
      path: TARGET,
      stagingPath: STAGING,
      attemptId: "d".repeat(32),
      reason: "PRIVATE_IO_V3_UNCONFIRMED",
      preserve: true as const,
    });
    let calls = 0;
    const lookalike: WindowsRecoveryIo = {
      contractVersion: 3,
      platform: "win32",
      trust: "untrusted-test",
      publishNew() { calls++; return replayed; },
      readPrivate: f.io.readPrivate,
      readMissing: f.io.readMissing,
    };
    const port = createWindowsRecoveryFilePort({
      archive,
      io: lookalike,
      assertCurrent() {},
      parentIdentityFor: () => ({fileId: DIRECTORY_ID, volumeId: VOLUME}),
      assertLegacyAbsent() {},
    });
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", {platform: "win32", nativePort: port});
    const observed = file.writeObserved(0, snapshot("lookalike"));
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(calls).toBe(1);
    expect(observed.recoveryIoFailure).toBeUndefined();
  });

  it("strips recovery IO facts when the terminal witness does not match", () => {
    const original = new Error("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    recordCheckpointCapacityRefusal(original, "e".repeat(32));
    const f = fixture({ beforeIo(archive) {
      vi.spyOn(archive, "reserve").mockImplementation(() => { throw original; });
    } });
    const request = {
      path: LOGICAL,
      workspaceId: "ws-1",
      expected: undefined,
      generation: 1,
      bytes: new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]),
    };
    const handle = armRecoveryPortObservation(f.port, request);
    expect(handle).toBeDefined();
    let caught: unknown;
    try { f.port.compareAndSwap(request); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(consumeRecoveryPortObservation(handle, "THREW", new Error("different-terminal"))).toEqual({matched: false});
    expect(consumeRecoveryPortObservation(handle, "THREW", caught)).toEqual({matched: false});
  });

  it("carries an actual prepare dispatch into the v1 envelope", async () => {
    const f = fixture({exec: {malformed: "bad-header", once: true}});
    const h = diagnosticWrite(f);
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:write",
      expectedGeneration: 0,
      snapshot: snapshot("source-envelope"),
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("expected failure");
    expect(reply.failure).toMatchObject({
      kind: "OUTCOME_UNKNOWN",
      family: "CHECKPOINT",
      stage: "PREPARE",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "DISPATCHED",
      proofOrigin: "DISPATCH_OBSERVED",
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "UNKNOWN",
        reason: "PRIVATE_IO_V3_UNCONFIRMED",
      },
    });
    expect(f.dispatches()).toBe(1);
  });

  it("carries an actual post-publication fact into the v1 envelope", async () => {
    const original = new Error("stable-head-cas-failure");
    const f = fixture({ beforeIo(archive) {
      vi.spyOn(archive, "compareAndSwapHead").mockImplementation(() => { throw original; });
    } });
    const h = diagnosticWrite(f);
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:write",
      expectedGeneration: 0,
      snapshot: snapshot("post-publication"),
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("expected failure");
    expect(reply.failure).toMatchObject({
      kind: "OUTCOME_UNKNOWN",
      family: "CHECKPOINT",
      stage: "HEAD_CAS",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "DISPATCHED",
      proofOrigin: "DISPATCH_OBSERVED",
      sourceOutcome: {source: "RECOVERY_IO", contractVersion: 3, state: "PUBLISHED", reason: null},
    });
    expect(reply.failure.causeSummaryIncomplete).toBe(true);
    expect(reply.failure.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(f.dispatches()).toBe(2);
  });

  it("carries an actual current generation conflict into the v1 envelope", async () => {
    const f = fixture();
    f.file.write(0, snapshot("first"));
    const h = diagnosticWrite(f);
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:write",
      expectedGeneration: 0,
      snapshot: snapshot("conflict"),
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("expected failure");
    expect(reply.failure).toMatchObject({
      kind: "GENERATION_CONFLICT",
      family: "CHECKPOINT",
      stage: "PRECONDITION",
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "VALIDATED_PRECONDITION",
      precondition: {expectedGeneration: 0, observedActualGeneration: 1, mismatch: "GENERATION"},
      sourceCauseCodes: ["CHECKPOINT_PRECONDITION_MISMATCH"],
      causeSummaryIncomplete: false,
    });
  });

  it("carries an actual current capacity refusal into the v1 envelope", async () => {
    let overflowId = "";
    const f = fixture({ beforeIo(archive) {
      const actual = archive.reserve.bind(archive);
      vi.spyOn(archive, "reserve").mockImplementation((request) => {
        overflowId = request.attemptId;
        return actual(request);
      });
    } });
    for (let n = 0; n < 64; n++) f.file.write(n, snapshot(String(n)));
    const h = diagnosticWrite(f);
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:write",
      expectedGeneration: 64,
      snapshot: snapshot("capacity-envelope"),
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("expected failure");
    expect(reply.failure).toMatchObject({
      kind: "PRE_DISPATCH_CAPACITY",
      family: "CHECKPOINT",
      stage: "RESERVE",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "LOCAL_ADMISSION_GUARD",
      attemptId: overflowId,
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "REJECTED",
        reason: "PRIVATE_IO_V3_REJECTED",
      },
      sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY", "PRIVATE_FILE_PUBLICATION_UNKNOWN"],
      causeSummaryIncomplete: false,
    });
  }, 30_000);

  it("preserves an actual trusted source outcome without positive proof as E", async () => {
    const original = new Error("reserve transaction uncertain");
    const f = fixture({ beforeIo(archive) {
      vi.spyOn(archive, "reserve").mockImplementation(() => { throw original; });
    } });
    const h = diagnosticWrite(f);
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:write",
      expectedGeneration: 0,
      snapshot: snapshot("plain-reserve"),
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("expected failure");
    expect(reply.failure).toMatchObject({
      kind: "UNCLASSIFIED",
      family: "CHECKPOINT",
      stage: "UNSPECIFIED",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE",
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "UNKNOWN",
        reason: "PRIVATE_IO_V3_UNCONFIRMED",
      },
      causeSummaryIncomplete: true,
    });
    expect(reply.failure.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(f.dispatches()).toBe(0);
  });

  it("uses the read-scoped pending fact for an actual blocked pending read", async () => {
    const f = fixture();
    const published = f.io.publishNew(publish());
    expect(published.state).toBe("PUBLISHED");
    let produced: ReturnType<CrashRecoveryFile["read"]> | undefined;
    const h = diagnosticWrite(f, async (_req, context) => {
      produced = context.readRecovery(f.file);
      return produced;
    });
    const reply = await h.handlers.diagnostic(h.event, {type: "recovery:read"});
    expect(reply.ok).toBe(true);
    if (!reply.ok || !reply.valueSlot.present) throw new Error("expected blocked value");
    expect(produced).toMatchObject({status: "blocked", generation: 0});
    expect(typeof produced?.message).toBe("string");
    expect(produced?.message).not.toBe("Crash recovery read is blocked; original failure retained");
    const sidecar = getCrashRecoveryReadFailure(produced);
    expect(sidecar?.error).toBeDefined();
    expect(h.observed).toEqual([sidecar?.error]);
    expect(reply.valueSlot.value).toMatchObject({
      status: "blocked",
      generation: 0,
      message: "Crash recovery read is blocked; original failure retained",
      storageFailure: {
        kind: "OUTCOME_UNKNOWN",
        family: "CHECKPOINT",
        stage: "READBACK",
        failureSubject: "UNIDENTIFIED",
        mutationDispatch: "UNPROVEN",
        proofOrigin: "NONE",
        attemptId: null,
        precondition: null,
      },
    });
  });

  it("keeps current capacity source facts as incomplete E with an unrelated uncoded cause", async () => {
    let overflowId = "";
    const f = fixture({ beforeIo(archive) {
      const actual = archive.reserve.bind(archive);
      vi.spyOn(archive, "reserve").mockImplementation((request) => {
        overflowId = request.attemptId;
        try {
          return actual(request);
        } catch (error) {
          if (error instanceof Error && Object.getOwnPropertyDescriptor(error, "cause") === undefined) {
            Object.defineProperty(error, "cause", {value: new Error("independent-uncoded-cause")});
          }
          throw error;
        }
      });
    } });
    for (let n = 0; n < 64; n++) f.file.write(n, snapshot(String(n)));
    const before = f.dispatches();
    const h = diagnosticWrite(f);
    const reply = await h.handlers.diagnostic(h.event, {
      type: "recovery:write",
      expectedGeneration: 64,
      snapshot: snapshot("capacity-uncoded-leaf"),
    });
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("expected failure");
    expect(reply.failure).toMatchObject({
      kind: "UNCLASSIFIED",
      family: "CHECKPOINT",
      stage: "UNSPECIFIED",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "UNPROVEN",
      proofOrigin: "NONE",
      attemptId: overflowId,
      sourceOutcome: {
        source: "RECOVERY_IO",
        contractVersion: 3,
        state: "REJECTED",
        reason: "PRIVATE_IO_V3_REJECTED",
      },
      causeSummaryIncomplete: true,
    });
    expect(f.dispatches()).toBe(before);
  }, 30_000);

  it("identifies only exact factory-registered ports", () => {
    const f = fixture();
    expect(isRegisteredRecoveryFilePort(f.port)).toBe(true);
    expect(isRegisteredRecoveryFilePort({ ...f.port })).toBe(false);
    expect(isRegisteredRecoveryFilePort({
      contractVersion: 3, platform: "win32",
      read: f.port.read, compareAndSwap: f.port.compareAndSwap,
    })).toBe(false);
    expect(isRegisteredRecoveryFilePort(undefined)).toBe(false);
    expect(isRegisteredRecoveryFilePort(null)).toBe(false);
    expect(isRegisteredRecoveryFilePort("port")).toBe(false);
    expect(isRegisteredRecoveryFilePort(1)).toBe(false);
  });

  it("returns a frozen RETURNED observation without failure facts", () => {
    const f = fixture();
    const observed = f.file.writeObserved(0, snapshot("observed"));
    expect(observed).toEqual({
      terminal: "RETURNED",
      value: { status: "ready", generation: 1, snapshot: snapshot("observed") },
    });
    expect(Object.isFrozen(observed)).toBe(true);
    if (observed.terminal !== "RETURNED") throw new Error("expected RETURNED");
    expect(Object.keys(observed).sort()).toEqual(["terminal", "value"]);
    expect(f.dispatches()).toBe(2);
    expect(f.file.read()).toMatchObject({ status: "ready", generation: 1 });
    expect(f.dispatches()).toBe(2);
  });

  it("matches the legacy write call-for-call on a registered success", () => {
    const input = snapshot("parity");
    const measure = <T>(f: ReturnType<typeof fixture>, invoke: () => T) => {
      const readHead = vi.spyOn(f.archive, "readHead");
      const pendingAttempts = vi.spyOn(f.archive, "pendingAttempts");
      const compareAndSwapHead = vi.spyOn(f.archive, "compareAndSwapHead");
      const from = vi.spyOn(Uint8Array, "from");
      const callsBefore = f.calls.length;
      const value = invoke();
      const phases = f.calls.slice(callsBefore).map((call) => call.phase);
      const measured = {
        value,
        counts: {
          readHead: readHead.mock.calls.length,
          pendingAttempts: pendingAttempts.mock.calls.length,
          compareAndSwapHead: compareAndSwapHead.mock.calls.length,
          publishNew: phases.filter((phase) => phase === "prepare").length,
          readPrivate: phases.filter((phase) => phase === "read-private").length,
          clones: from.mock.calls.length,
        },
        cloneInputs: from.mock.calls.map((call) => {
          const arg = call[0] as { byteLength?: number; length?: number } | undefined;
          return arg?.byteLength ?? arg?.length ?? -1;
        }),
        phases,
      };
      vi.restoreAllMocks();
      return measured;
    };
    const legacy = fixture();
    const observedF = fixture();
    const left = measure(legacy, () => legacy.file.write(0, input));
    const right = measure(observedF, () => {
      const observation = observedF.file.writeObserved(0, input);
      expect(observation.terminal).toBe("RETURNED");
      if (observation.terminal !== "RETURNED") throw new Error("expected RETURNED");
      expect(Object.keys(observation).sort()).toEqual(["terminal", "value"]);
      return observation.value;
    });
    expect(right.value).toEqual(left.value);
    expect(left.counts.readHead).toBe(4);
    expect(left.counts.compareAndSwapHead).toBe(1);
    expect(left.counts.publishNew).toBe(1);
    expect(right.counts).toEqual(left.counts);
    expect(right.cloneInputs).toEqual(left.cloneInputs);
    expect(right.cloneInputs.length).toBeGreaterThan(0);
    expect(right.phases).toEqual(left.phases);
    expect(legacy.dispatches()).toBe(2);
    expect(observedF.dispatches()).toBe(2);
  });

  it("keeps the identical-snapshot ACK replay free of facts and dispatches", () => {
    const f = fixture();
    f.file.write(0, snapshot("ack"));
    const dispatches = f.dispatches();
    const observed = f.file.writeObserved(0, snapshot("ack"));
    expect(observed).toEqual({
      terminal: "RETURNED",
      value: { status: "ready", generation: 1, snapshot: snapshot("ack") },
    });
    expect(Object.keys(observed).sort()).toEqual(["terminal", "value"]);
    expect(f.dispatches()).toBe(dispatches);
  });

  it("captures the current own precondition conflict without dispatch", () => {
    const f = fixture();
    f.file.write(0, snapshot("first"));
    const dispatches = f.dispatches();
    const observed = f.file.writeObserved(3, snapshot("other"));
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
    expect(f.dispatches()).toBe(dispatches);
    expect(f.archive.readHead(LOGICAL, "ws-1")!.pointer.generation).toBe(1);
  });

  it("carries the consumed port precondition conflict without dispatch", () => {
    const f = fixture();
    f.file.write(0, snapshot("first"));
    const actualReadHead = f.archive.readHead.bind(f.archive);
    let reads = 0;
    const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
      reads += 1;
      return reads === 1 ? undefined : actualReadHead(...args);
    });
    const dispatches = f.dispatches();
    const observed = f.file.writeObserved(0, snapshot("second"));
    readSpy.mockRestore();
    expect(reads).toBe(2);
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const wrapped = observed.value as PrivateFilePublicationUnknownError;
    expect(wrapped.cause).toBeInstanceOf(CollaborationError);
    const cause = wrapped.cause as CollaborationError;
    expect(cause.code).toBe("WINDOWS_RECOVERY_PORT_CONFLICT");
    expect(wrapped.result).toBeUndefined();
    expect(observed.postPublication).toBeUndefined();
    expect(observed.generationConflict).toBeDefined();
    expect(observed.generationConflict).toBe(getCheckpointGenerationConflict(cause));
    expect(observed.generationConflict).toBe(getCheckpointGenerationConflict(wrapped));
    expect(observed.generationConflict).toMatchObject({
      kind: "GENERATION_CONFLICT",
      stage: "PRECONDITION",
      attemptId: null,
      sourceCauseCodes: ["WINDOWS_RECOVERY_PORT_CONFLICT"],
      precondition: {
        expectedGeneration: 0,
        observedActualGeneration: 1,
        mismatch: "GENERATION",
      },
    });
    expect(f.dispatches()).toBe(dispatches);
    expect(f.archive.readHead(LOGICAL, "ws-1")!.pointer.generation).toBe(1);
  });

  it("never promotes a stale tagged error thrown on the prior read", () => {
    const f = fixture();
    f.file.write(0, snapshot("first"));
    let stale: unknown;
    try {
      f.port.compareAndSwap({
        path: LOGICAL, workspaceId: "ws-1", expected: undefined,
        generation: 1, bytes: new Uint8Array([1, 2, 3]),
      });
      expect.unreachable();
    } catch (error) {
      stale = error;
    }
    const staleTag = getCheckpointGenerationConflict(stale)!;
    expect(staleTag).toBeDefined();
    const actualReadHead = f.archive.readHead.bind(f.archive);
    let reads = 0;
    const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
      reads += 1;
      if (reads === 1) throw stale;
      return actualReadHead(...args);
    });
    const observed = f.file.writeObserved(1, snapshot("second"));
    readSpy.mockRestore();
    expect(reads).toBe(1);
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBe(stale);
    expect(observed.postPublication).toBeUndefined();
    expect(observed.generationConflict).toBeUndefined();
    expect(getCheckpointGenerationConflict(stale)).toBe(staleTag);
    expect(f.archive.readHead(LOGICAL, "ws-1")!.pointer.generation).toBe(1);
  });

  it("does not qualify a stale PUBLISHED typed error thrown on the prior read", () => {
    const old = fixture();
    const oldConflict = new CollaborationError("WINDOWS_RECOVERY_ARCHIVE_CONFLICT");
    vi.spyOn(old.archive, "compareAndSwapHead").mockImplementation(() => { throw oldConflict; });
    let oldError: unknown;
    try {
      old.file.write(0, snapshot("old"));
      expect.unreachable();
    } catch (error) {
      oldError = error;
    }
    expect(oldError).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const oldTyped = oldError as PrivateFilePublicationUnknownError;
    const oldTag = getCheckpointPostPublicationUnknown(oldTyped)!;
    expect(oldTag.stage).toBe("HEAD_CAS");

    const f = fixture();
    const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation(() => { throw oldTyped; });
    const observed = f.file.writeObserved(0, snapshot("second"));
    readSpy.mockRestore();
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBe(oldTyped);
    expect(observed.postPublication).toBeUndefined();
    expect(observed.generationConflict).toBeUndefined();
    expect(f.dispatches()).toBe(0);
    expect(getCheckpointPostPublicationUnknown(oldTyped)).toBe(oldTag);
    expect(f.archive.readHead(LOGICAL, "ws-1")).toBeUndefined();
  });

  it("surfaces the current HEAD_CAS fact while preserving the existing wrapper", () => {
    const f = fixture();
    const lostAckError = new Error("APPLIED acknowledgement lost");
    const actualCas = f.archive.compareAndSwapHead.bind(f.archive);
    vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation((...args) => {
      actualCas(...args);
      throw lostAckError;
    });
    const observed = f.file.writeObserved(0, snapshot("applied"));
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const error = observed.value as PrivateFilePublicationUnknownError;
    expect(error.message).toBe("Recovery pointer advance unresolved");
    expect(error.cause).toBe(lostAckError);
    const head = f.archive.readHead(LOGICAL, "ws-1")!;
    const currentId = head.pointer.attemptId;
    expect(error.result).toMatchObject({ state: "PUBLISHED", attemptId: currentId });
    expect(observed.postPublication).toEqual({
      kind: "OUTCOME_UNKNOWN",
      family: "CHECKPOINT",
      stage: "HEAD_CAS",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "DISPATCHED",
      proofOrigin: "DISPATCH_OBSERVED",
      attemptId: currentId,
      sourceOutcome: { source: "RECOVERY_IO", contractVersion: 3, state: "PUBLISHED", reason: null },
    });
    expect(Object.isFrozen(observed.postPublication)).toBe(true);
    expect(observed.generationConflict).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(error)).toMatchObject({
      stage: "HEAD_CAS",
      attemptId: currentId,
    });
    expect(getCheckpointGenerationConflict(error)).toBeUndefined();
    expect(f.dispatches()).toBe(2);
    expect(f.archive.pendingAttempts(LOGICAL, "ws-1")).toEqual([]);
    const original = Uint8Array.from(head.original);
    const wire = f.archive.readBlob(currentId, "wire:prepare");
    expect(wire).toBeDefined();
    const wireBytes = Uint8Array.from(wire!);
    const terminal = f.archive.terminalReceipt(currentId);
    expect(typeof terminal).toBe("string");
    expect(f.published.size).toBe(1);
    const [entry] = [...f.published.values()];
    expect(Buffer.from(entry!.bytes).equals(head.original)).toBe(true);
    const replay = f.file.writeObserved(0, snapshot("applied"));
    expect(replay).toEqual({
      terminal: "RETURNED",
      value: { status: "ready", generation: 1, snapshot: snapshot("applied") },
    });
    expect(f.dispatches()).toBe(2);
    expect(Buffer.from(f.archive.readBlob(currentId, "original")!).equals(original)).toBe(true);
    expect(Buffer.from(f.archive.readBlob(currentId, "wire:prepare")!).equals(wireBytes)).toBe(true);
    expect(f.archive.terminalReceipt(currentId)).toBe(terminal);
  });

  it("does not surface a historical conflict tag as the current fact after publication", () => {
    const seed = fixture();
    seed.file.write(0, snapshot("seed"));
    let tagged: unknown;
    try {
      seed.port.compareAndSwap({
        path: LOGICAL, workspaceId: "ws-1", expected: undefined,
        generation: 1, bytes: new Uint8Array([1, 2, 3]),
      });
      expect.unreachable();
    } catch (error) {
      tagged = error;
    }
    const tag = getCheckpointGenerationConflict(tagged)!;
    expect(tag).toBeDefined();
    const f = fixture();
    f.file.write(0, snapshot("first"));
    const actualCas = f.archive.compareAndSwapHead.bind(f.archive);
    const actualReadHead = f.archive.readHead.bind(f.archive);
    let casCompleted = false;
    const casSpy = vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation((...args) => {
      const returned = actualCas(...args);
      casCompleted = true;
      return returned;
    });
    const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
      if (casCompleted) throw tagged;
      return actualReadHead(...args);
    });
    const observed = f.file.writeObserved(1, snapshot("second"));
    casSpy.mockRestore();
    readSpy.mockRestore();
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    const wrapped = observed.value as PrivateFilePublicationUnknownError;
    expect(wrapped).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(wrapped.cause).toBe(tagged);
    expect(getCheckpointGenerationConflict(wrapped)).toBe(tag);
    const currentId = f.archive.readHead(LOGICAL, "ws-1")!.pointer.attemptId;
    expect(observed.postPublication).toMatchObject({ stage: "READBACK", attemptId: currentId });
    expect(observed.generationConflict).toBeUndefined();
  });

  it("surfaces the current READBACK fact when the port readback throws a raw error", () => {
    const f = fixture();
    f.file.write(0, snapshot("first"));
    const priorId = f.archive.readHead(LOGICAL, "ws-1")!.pointer.attemptId;
    const priorOriginal = Uint8Array.from(f.archive.readBlob(priorId, "original")!);
    const priorWire = Uint8Array.from(f.archive.readBlob(priorId, "wire:prepare")!);
    const priorTerminal = f.archive.terminalReceipt(priorId);
    expect(priorTerminal).toBeDefined();
    const rawError = new Error("raw readback failure");
    const actualCas = f.archive.compareAndSwapHead.bind(f.archive);
    const actualReadHead = f.archive.readHead.bind(f.archive);
    let casCompleted = false;
    const casSpy = vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation((...args) => {
      const returned = actualCas(...args);
      casCompleted = true;
      return returned;
    });
    const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
      if (casCompleted) throw rawError;
      return actualReadHead(...args);
    });
    const observed = f.file.writeObserved(1, snapshot("second"));
    casSpy.mockRestore();
    readSpy.mockRestore();
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const wrapped = observed.value as PrivateFilePublicationUnknownError;
    expect(wrapped.cause).toBe(rawError);
    expect(wrapped.result).toBeUndefined();
    const head = f.archive.readHead(LOGICAL, "ws-1")!;
    expect(head.pointer.generation).toBe(2);
    const currentId = head.pointer.attemptId;
    expect(observed.postPublication).toEqual({
      kind: "OUTCOME_UNKNOWN",
      family: "CHECKPOINT",
      stage: "READBACK",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "DISPATCHED",
      proofOrigin: "DISPATCH_OBSERVED",
      attemptId: currentId,
      sourceOutcome: { source: "RECOVERY_IO", contractVersion: 3, state: "PUBLISHED", reason: null },
    });
    expect(Object.isFrozen(observed.postPublication)).toBe(true);
    expect(observed.generationConflict).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(wrapped)).toBeUndefined();
    expect(getCheckpointGenerationConflict(wrapped)).toBeUndefined();
    expect(f.dispatches()).toBe(4);
    const original = Uint8Array.from(head.original);
    const wireBytes = Uint8Array.from(f.archive.readBlob(currentId, "wire:prepare")!);
    const terminal = f.archive.terminalReceipt(currentId);
    expect(terminal).toBeDefined();
    const replay = f.file.writeObserved(1, snapshot("second"));
    expect(replay).toEqual({
      terminal: "RETURNED",
      value: { status: "ready", generation: 2, snapshot: snapshot("second") },
    });
    expect(f.dispatches()).toBe(4);
    expect(f.archive.pendingAttempts(LOGICAL, "ws-1")).toEqual([]);
    expect(Buffer.from(f.archive.readBlob(currentId, "original")!).equals(original)).toBe(true);
    expect(Buffer.from(f.archive.readBlob(currentId, "wire:prepare")!).equals(wireBytes)).toBe(true);
    expect(f.archive.terminalReceipt(currentId)).toBe(terminal);
    expect(currentId).not.toBe(priorId);
    expect(Buffer.from(f.archive.readBlob(priorId, "original")!).equals(priorOriginal)).toBe(true);
    expect(Buffer.from(f.archive.readBlob(priorId, "wire:prepare")!).equals(priorWire)).toBe(true);
    expect(f.archive.terminalReceipt(priorId)).toBe(priorTerminal);
  });

  it("retains the raw terminal when the port readback throws a primitive", () => {
    const f = fixture();
    f.file.write(0, snapshot("first"));
    const actualCas = f.archive.compareAndSwapHead.bind(f.archive);
    const actualReadHead = f.archive.readHead.bind(f.archive);
    let casCompleted = false;
    const casSpy = vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation((...args) => {
      const returned = actualCas(...args);
      casCompleted = true;
      return returned;
    });
    const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
      if (casCompleted) throw undefined;
      return actualReadHead(...args);
    });
    const observed = f.file.writeObserved(1, snapshot("second"));
    casSpy.mockRestore();
    readSpy.mockRestore();
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    const wrapped = observed.value as PrivateFilePublicationUnknownError;
    expect(wrapped).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(wrapped.cause).toBeUndefined();
    expect(wrapped.result).toBeUndefined();
    const currentId = f.archive.readHead(LOGICAL, "ws-1")!.pointer.attemptId;
    expect(observed.postPublication).toMatchObject({ stage: "READBACK", attemptId: currentId });
    expect(observed.generationConflict).toBeUndefined();
  });

  it("preserves the reused typed identity while reporting the current READBACK attempt", () => {
    const old = fixture();
    const oldConflict = new CollaborationError("WINDOWS_RECOVERY_ARCHIVE_CONFLICT");
    vi.spyOn(old.archive, "compareAndSwapHead").mockImplementation(() => { throw oldConflict; });
    let oldError: unknown;
    try {
      old.file.write(0, snapshot("old"));
      expect.unreachable();
    } catch (error) {
      oldError = error;
    }
    expect(oldError).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const oldTyped = oldError as PrivateFilePublicationUnknownError;
    const oldTag = getCheckpointPostPublicationUnknown(oldTyped)!;
    expect(oldTag.stage).toBe("HEAD_CAS");
    const oldId = oldTag.attemptId;

    const f = fixture();
    f.file.write(0, snapshot("first"));
    const actualCas = f.archive.compareAndSwapHead.bind(f.archive);
    const actualReadHead = f.archive.readHead.bind(f.archive);
    let casCompleted = false;
    const casSpy = vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation((...args) => {
      const returned = actualCas(...args);
      casCompleted = true;
      return returned;
    });
    const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
      if (casCompleted) throw oldTyped;
      return actualReadHead(...args);
    });
    const observed = f.file.writeObserved(1, snapshot("second"));
    casSpy.mockRestore();
    readSpy.mockRestore();
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBe(oldTyped);
    expect(oldTyped.cause).toBe(oldConflict);
    expect(oldTyped.result).toMatchObject({ state: "PUBLISHED", attemptId: oldId });
    const head = f.archive.readHead(LOGICAL, "ws-1")!;
    const currentId = head.pointer.attemptId;
    expect(currentId).not.toBe(oldId);
    expect(observed.postPublication).toMatchObject({ stage: "READBACK", attemptId: currentId });
    expect(observed.generationConflict).toBeUndefined();
    expect(getCheckpointPostPublicationUnknown(oldTyped)).toBe(oldTag);
  });

  it.each(["raw error", "undefined", "missing head", "corrupt original"] as const)(
    "carries the current READBACK fact when the post-return read fails: %s",
    (mode) => {
      const f = fixture();
      f.file.write(0, snapshot("first"));
      const rawError = new Error("post-return read failure");
      const actualReadHead = f.archive.readHead.bind(f.archive);
      let reads = 0;
      const readSpy = vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
        reads += 1;
        if (reads === 4) {
          if (mode === "raw error") throw rawError;
          if (mode === "undefined") throw undefined;
          const head = actualReadHead(...args);
          if (mode === "missing head" || head === undefined) return undefined;
          return Object.freeze({ ...head, original: Uint8Array.from([1, 2, 3]) });
        }
        return actualReadHead(...args);
      });
      const observed = f.file.writeObserved(1, snapshot("second"));
      readSpy.mockRestore();
      expect(reads).toBe(4);
      expect(observed.terminal).toBe("THREW");
      if (observed.terminal !== "THREW") throw new Error("expected THREW");
      const value = observed.value;
      if (mode === "raw error") expect(value).toBe(rawError);
      else if (mode === "undefined") expect(value).toBeUndefined();
      else if (mode === "missing head") {
        expect(value).toBeInstanceOf(Error);
        expect((value as Error).message).toBe("Recovery published readback differs; artifacts retained");
      } else {
        expect(value).toBeInstanceOf(CollaborationError);
        expect((value as CollaborationError).code).toBe("WINDOWS_RECOVERY_ARCHIVE_STORED");
      }
      const head = f.archive.readHead(LOGICAL, "ws-1")!;
      const currentId = head.pointer.attemptId;
      expect(head.pointer.generation).toBe(2);
      expect(observed.postPublication).toMatchObject({ stage: "READBACK", attemptId: currentId });
      expect(observed.generationConflict).toBeUndefined();
      expect(f.dispatches()).toBe(4);
    },
  );

  it("does not promote a non-PUBLISHED outcome to a publication fact", () => {
    const original = new Error("reserve transaction uncertain");
    const f = fixture({ beforeIo(archive) {
      vi.spyOn(archive, "reserve").mockImplementation(() => { throw original; });
    } });
    const observed = f.file.writeObserved(0, snapshot("uncertain"));
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    expect(observed.value).toBeInstanceOf(PrivateFilePublicationUnknownError);
    const error = observed.value as PrivateFilePublicationUnknownError;
    expect(error.result).toMatchObject({ state: "UNKNOWN", reason: "PRIVATE_IO_V3_UNCONFIRMED" });
    expect(error.cause).toBe(original);
    expect(observed.postPublication).toBeUndefined();
    expect(observed.generationConflict).toBeUndefined();
    expect(f.dispatches()).toBe(0);
  });

  it("does not promote an unregistered facade over the registered port", () => {
    const f = fixture();
    const facade: CrashRecoveryNativePort = {
      contractVersion: 3,
      platform: "win32",
      read: (path, workspaceId) => f.port.read(path, workspaceId),
      compareAndSwap: (request) => f.port.compareAndSwap(request),
    };
    expect(isRegisteredRecoveryFilePort(f.port)).toBe(true);
    expect(isRegisteredRecoveryFilePort(facade)).toBe(false);
    const file = new CrashRecoveryFile(LOGICAL, "ws-1", { platform: "win32", nativePort: facade });
    const first = file.writeObserved(0, snapshot("facade"));
    expect(first).toEqual({
      terminal: "RETURNED",
      value: { status: "ready", generation: 1, snapshot: snapshot("facade") },
    });
    const rawError = new Error("facade readback failure");
    const actualCas = f.archive.compareAndSwapHead.bind(f.archive);
    const actualReadHead = f.archive.readHead.bind(f.archive);
    let casCompleted = false;
    vi.spyOn(f.archive, "compareAndSwapHead").mockImplementation((...args) => {
      const returned = actualCas(...args);
      casCompleted = true;
      return returned;
    });
    vi.spyOn(f.archive, "readHead").mockImplementation((...args) => {
      if (casCompleted) throw rawError;
      return actualReadHead(...args);
    });
    const observed = file.writeObserved(1, snapshot("second"));
    expect(observed.terminal).toBe("THREW");
    if (observed.terminal !== "THREW") throw new Error("expected THREW");
    const wrapped = observed.value as PrivateFilePublicationUnknownError;
    expect(wrapped).toBeInstanceOf(PrivateFilePublicationUnknownError);
    expect(wrapped.cause).toBe(rawError);
    expect(observed.postPublication).toBeUndefined();
    expect(observed.generationConflict).toBeUndefined();
    expect(f.dispatches()).toBe(4);
  });
});
