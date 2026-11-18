import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWindowsBackupArtifact,
  createWindowsBackupArtifactForTesting,
  WINDOWS_BACKUP_ARTIFACT_MAX_BYTES,
  WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES,
  WINDOWS_BACKUP_ARTIFACT_PROFILE,
  type WindowsBackupArtifactExecRequest,
  type WindowsBackupArtifactExecResult,
  type WindowsBackupArtifactOptions,
  type WindowsBackupArtifactRequest,
} from "../src/platform/windows/backup-artifact";
import {
  WindowsBackupArtifactJournal,
  WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BYTES,
} from "../src/platform/windows/backup-artifact-journal";
import { exportSharedBackup } from "../src/main/shared-backup-export";
import { SharedRuntimeService } from "../src/main/shared-runtime-service";
import { SharedBackupProvider } from "../src/collaboration/runtime/backup-provider";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { canonical } from "../src/collaboration/runtime/canonical";
import { exportBackup, restoreBackup, validateRuntimeBackup } from "../src/collaboration/runtime/backup";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import type { WindowsRuntimeFileStat } from "../src/platform/windows/runtime-platform";

// Contract-only fixture: a fake native executor doing a binary artifact
// roundtrip plus a real disposable journal on a PosixPrivatePlatform
// relabelled "windows". This is never Windows OS/filesystem acceptance.
const ROOT = "C:\\Out";
const PARENT = ROOT;
const TARGET = `${PARENT}\\backup-export.json`;
const STAGING = `${PARENT}\\.folio-backup-${"a".repeat(32)}.tmp`;
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("in-memory pinned artifact executable fixture");
const ROOT_ID = "1".repeat(32);
const STAGE_ID = "5".repeat(32);
const VOLUME = "4".repeat(16);
const SID = "S-1-5-21-1000";
const ATTEMPT = "a".repeat(32);
const SOURCE = Object.freeze({
  head: Object.freeze({ epoch: "epoch-1", seq: 3, hash: "b".repeat(64) }),
  hash: "c".repeat(64),
});
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
const journals: WindowsBackupArtifactJournal[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) { try { journal.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-backup-artifact-")));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

/** Relabelled "windows" adapter over the POSIX platform. assertFile drops the
 * POSIX ledger's 16 MiB file bound (this journal holds 256 MiB originals and
 * ~2.25 GiB lifecycle reservations) while keeping the remaining contract
 * checks; explicitly untrusted, not OS proof. */
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
      // adapter's 16 MiB ledger bound cannot hold a 256 MiB artifact journal.
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

function newJournal(binding = "binding:test", forbiddenRoots: readonly string[] = []): WindowsBackupArtifactJournal {
  const journal = new WindowsBackupArtifactJournal(tempDir(), testingPlatform(), binding, forbiddenRoots);
  journals.push(journal);
  return journal;
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

type ExecFault = {
  malformed?: "dup-keys" | "truncated" | "binary-junk" | "bad-header";
  once?: boolean;
  exists?: "prepare" | "commit-prepared";
  tamper?: "prepare" | "commit-prepared";
  throwOn?: "prepare" | "commit-prepared";
  loseCommitAck?: boolean;
  proofField?: "sid" | "rootFileId" | "fileId";
};
function fixture(faults: { exec?: ExecFault; failCurrent?: { current: boolean }; directoryId?: () => string } = {}) {
  const calls: { phase: string; wire: Wire; payload: Uint8Array }[] = [];
  let staged: { id: string; bytes: Uint8Array } | undefined;
  const published = new Map<string, { fileId: string; bytes: Uint8Array }>();
  const fsPort = {
    lstat: (_path: string): WindowsRuntimeFileStat => ({
      isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
      nlink: 1, dev: 7, ino: 42, size: EXE_BYTES.byteLength, mtimeMs: 1000,
    }),
    readFile: (_path: string) => EXE_BYTES,
  };
  const failureFrame = (wire: Wire, state: "EXISTS" | "UNKNOWN" | "REJECTED") => {
    const reason = state === "EXISTS" ? "BACKUP_ARTIFACT_EXISTS" : state === "UNKNOWN" ? "BACKUP_ARTIFACT_UNKNOWN" : "BACKUP_ARTIFACT_REJECTED";
    const status = state === "EXISTS" ? 2 : state === "UNKNOWN" ? 3 : 1;
    return {
      status, signal: null, stderr: new Uint8Array(0),
      stdout: encode({
        contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE, operation: wire.operation,
        path: wire.path, root: wire.root, attemptId: wire.attemptId, stagingPath: wire.stagingPath,
        state, reason,
      }, new Uint8Array(0)),
    } satisfies WindowsBackupArtifactExecResult;
  };
  const exec = (request: WindowsBackupArtifactExecRequest): WindowsBackupArtifactExecResult => {
    const parsed = decode(request.input);
    const wire = parsed.header;
    calls.push({ phase: String(wire.operation), wire, payload: parsed.payload });
    const fault = faults.exec;
    if (fault?.throwOn === wire.operation) throw new Error("helper gone");
    if (fault !== undefined && fault.malformed !== undefined && (!fault.once || calls.length === 1)) {
      if (fault.malformed === "dup-keys") {
        const header = Buffer.from('{"a":1,"a":2}', "ascii");
        const frame = Buffer.alloc(4 + header.byteLength);
        frame.writeUInt32LE(header.byteLength);
        header.copy(frame, 4);
        return { status: 0, signal: null, stdout: frame, stderr: new Uint8Array(0) };
      }
      if (fault.malformed === "truncated")
        return { status: 0, signal: null, stdout: encode({ contractVersion: 1 }, new Uint8Array(0)).subarray(0, 10), stderr: new Uint8Array(0) };
      if (fault.malformed === "binary-junk")
        return { status: 0, signal: null, stdout: new Uint8Array([0xff, 0xfe, 0x00, 0x01]), stderr: new Uint8Array(0) };
      if (fault.malformed === "bad-header")
        return { status: 0, signal: null, stdout: encode({ contractVersion: 3, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE, operation: "prepare", path: wire.path, root: wire.root, state: "PREPARED" }, new Uint8Array(0)), stderr: new Uint8Array(0) };
    }
    if (fault?.exists === wire.operation) return failureFrame(wire, "EXISTS");
    const base = {
      contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE, operation: wire.operation,
      path: wire.path, root: wire.root, attemptId: wire.attemptId, stagingPath: wire.stagingPath,
    };
    const dir = proof(String(wire.path).slice(0, String(wire.path).lastIndexOf("\\")), String(wire.root), String(wire.directoryFileId), String(wire.rootFileId), String(wire.rootVolumeId));
    if (wire.operation === "prepare") {
      staged = { id: STAGE_ID, bytes: parsed.payload };
      const readback = fault?.tamper === "prepare" ? Uint8Array.from([...parsed.payload.slice(0, -1), parsed.payload.at(-1)! ^ 0xff]) : parsed.payload;
      return {
        status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({ ...base, state: "PREPARED", file: proof(String(wire.stagingPath), String(wire.root), STAGE_ID, String(wire.rootFileId), String(wire.rootVolumeId)), directory: dir, byteLength: parsed.payload.byteLength, sha256: hash(parsed.payload), contentFlushed: true, filesystem: "NTFS" }, readback),
      };
    }
    if (published.has(String(wire.path))) return failureFrame(wire, "EXISTS");
    if (!staged || wire.fileId !== staged.id || !Buffer.from(staged.bytes).equals(parsed.payload))
      return failureFrame(wire, "UNKNOWN");
    published.set(String(wire.path), { fileId: staged.id, bytes: staged.bytes });
    if (fault?.loseCommitAck)
      return { status: null, signal: null, errorCode: "ACK_LOST", stdout: new Uint8Array(0), stderr: Buffer.from([0xff, 0x00, 0x80]) };
    const readback = fault?.tamper === "commit-prepared" ? Uint8Array.from([...staged!.bytes.slice(0, -1), staged!.bytes.at(-1)! ^ 0xff]) : staged!.bytes;
    const finalProof = proof(String(wire.path), String(wire.root), staged.id, String(wire.rootFileId), String(wire.rootVolumeId));
    if (fault?.proofField === "sid") finalProof.sid = "S-1-5-21-2000";
    if (fault?.proofField === "rootFileId") finalProof.rootFileId = "9".repeat(32);
    if (fault?.proofField === "fileId") finalProof.fileId = "9".repeat(32);
    return {
      status: 0, signal: null, stderr: new Uint8Array(0),
      stdout: encode({ ...base, state: "PUBLISHED", file: finalProof, directory: dir, byteLength: staged!.bytes.byteLength, sha256: hash(staged!.bytes), contentFlushed: true, filesystem: "NTFS", stagingDisposition: "RENAMED_TO_FINAL", namespace: "EXCLUSIVE_NO_REPLACE", durability: { profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH" } }, readback),
    };
  };
  const journal = newJournal();
  const options: WindowsBackupArtifactOptions = {
    root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
    expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
    journal,
    directoryIdentity: () => ({ fileId: faults.directoryId?.() ?? ROOT_ID, volumeId: VOLUME }),
    assertCurrent: () => { if (faults.failCurrent?.current) throw new Error("fence"); },
  };
  const io = createWindowsBackupArtifactForTesting(options, { fs: fsPort, exec });
  return { calls, io, journal, published, staged: () => staged, fsPort, options };
}

const publish = (overrides: Partial<WindowsBackupArtifactRequest> = {}, bytes?: Uint8Array): WindowsBackupArtifactRequest => ({
  path: TARGET, stagingPath: STAGING, attemptId: ATTEMPT,
  bytes: bytes ?? new Uint8Array([0, 255, 128, 13, 10, 65, 0, 42]),
  forbiddenRoots: [],
  source: SOURCE,
  beforePublish: () => {},
  assertCurrent: () => {},
  ...overrides,
});

/** Real RuntimeStore/exportBackup fixture: the unmodified 64 MiB store admits
 * this blob, while its canonical base64 backup exceeds the raw 32 MiB profile. */
function assetBackupFixture() {
  const MAX = 256 * 1024 * 1024;
  const blobBytes = new Uint8Array(25 * 1024 * 1024);
  for (let index = 0; index < blobBytes.byteLength; index += 4096) blobBytes[index] = index & 0xff;
  const head = { epoch: "epoch-1", seq: 7, hash: "d".repeat(64) };
  const store = new RuntimeStore(join(tempDir(), "source"));
  let raw: string, backupHash: string;
  try {
    store.transaction(() => {
      store.set("meta", "head", head);
      store.set("meta", "title", { text: "asset-bearing" });
      store.blobPut("scope-1", hash(blobBytes), blobBytes);
    });
    const backup = exportBackup(store);
    backupHash = backup.hash;
    raw = canonical(backup, MAX);
    expect(validateRuntimeBackup(JSON.parse(raw)).hash).toBe(backupHash);
  } finally { store.close(); }
  const rawBytes = Buffer.from(raw, "utf8");
  expect(rawBytes.byteLength).toBeGreaterThan(32 * 1024 * 1024);
  expect(rawBytes.byteLength).toBeLessThan(WINDOWS_BACKUP_ARTIFACT_MAX_BYTES);
  return { raw, head, hash: backupHash, bytes: rawBytes };
}

describe("windows shared-backup artifact (contract-only, NOT_RUN on Windows)", () => {
  it("publishes an exact payload over two binary wire calls", async () => {
    const bytes = new Uint8Array(1024 * 1024);
    for (let index = 0; index < bytes.byteLength; index += 4096) bytes[index] = index & 0xff;
    const { io, calls, journal } = fixture();
    const receipt = await io.publishNew(publish({}, bytes));
    expect(receipt.state).toBe("PUBLISHED");
    if (receipt.state !== "PUBLISHED") throw new Error("unreachable");
    expect(receipt.contractVersion).toBe(1);
    expect(receipt.profile).toBe(WINDOWS_BACKUP_ARTIFACT_PROFILE);
    expect(receipt.byteLength).toBe(bytes.byteLength);
    expect(receipt.sha256).toBe(hash(bytes));
    expect(Buffer.from(receipt.readback).equals(bytes)).toBe(true);
    expect(receipt.stagingDisposition).toBe("RENAMED_TO_FINAL");
    expect(receipt.namespace).toBe("EXCLUSIVE_NO_REPLACE");
    expect(receipt.contentFlushed).toBe(true);
    expect(receipt.durability.profile).toBe("WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1");
    expect(calls.map((call) => call.phase)).toEqual(["prepare", "commit-prepared"]);
  });

  it("archives original, both full-payload wires, captures and terminal", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { io, calls, journal } = fixture();
    await io.publishNew(publish({}, bytes));
    expect(Buffer.from(journal.readBlob(ATTEMPT, "original")!).equals(bytes)).toBe(true);
    const prepareWire = decode(journal.readBlob(ATTEMPT, "wire:prepare")!);
    expect(prepareWire.header.profile).toBe(WINDOWS_BACKUP_ARTIFACT_PROFILE);
    expect(prepareWire.header.contractVersion).toBe(1);
    expect(prepareWire.payload.byteLength).toBe(bytes.byteLength);
    const commitWire = decode(journal.readBlob(ATTEMPT, "wire:commit-prepared")!);
    expect(commitWire.payload.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(commitWire.payload).equals(bytes)).toBe(true);
    expect(journal.readBlob(ATTEMPT, "capture:prepare:stdout")!.byteLength).toBeGreaterThan(4);
    expect(journal.readBlob(ATTEMPT, "capture:commit-prepared:stdout")!.byteLength).toBeGreaterThan(4);
    expect(journal.readBlob(ATTEMPT, "capture:prepare:stderr")!.byteLength).toBe(0);
    expect(journal.readBlob(ATTEMPT, "evidence:prepared")).toBeDefined();
    expect(journal.readBlob(ATTEMPT, "evidence:callback")).toBeDefined();
    expect(journal.terminalReceipt(ATTEMPT)).toContain('"PUBLISHED"');
    expect(calls.map((call) => call.phase)).toEqual(["prepare", "commit-prepared"]);
  });

  it("exports a canonical >32 MiB asset-bearing backup through the artifact port", async () => {
    const value = assetBackupFixture();
    const { io, journal } = fixture();
    let revalidated = 0;
    const result = await exportSharedBackup({
      download: async () => ({ raw: value.raw, head: { ...value.head }, hash: value.hash }),
      pick: async () => TARGET,
      isAuthorized: () => true,
      forbiddenRoots: ["C:\\Private\\data"],
      nativeBackup: io,
      revalidateSource: async (backup) => {
        revalidated++;
        expect(backup.raw).toBe(value.raw);
        expect(backup.hash).toBe(value.hash);
      },
    });
    expect(result).toEqual({
      state: "EXPORTED",
      path: TARGET,
      head: value.head,
      hash: value.hash,
    });
    expect(revalidated).toBe(1);
  });

  it("keeps exact bytes and journal evidence for the asset-bearing export", async () => {
    const value = assetBackupFixture();
    const { io, journal, published, calls } = fixture();
    await exportSharedBackup({
      download: async () => ({ raw: value.raw, head: { ...value.head }, hash: value.hash }),
      pick: async () => TARGET,
      isAuthorized: () => true,
      forbiddenRoots: [],
      nativeBackup: io,
      revalidateSource: async () => {},
    });
    const stored = published.get(TARGET)!;
    expect(Buffer.from(stored.bytes).equals(value.bytes)).toBe(true);
    const attemptId = String(calls[0].wire.attemptId);
    expect(Buffer.from(journal.readBlob(attemptId, "original")!).equals(value.bytes)).toBe(true);
    expect(decode(journal.readBlob(attemptId, "wire:prepare")!).payload.byteLength).toBe(value.bytes.byteLength);
    expect(decode(journal.readBlob(attemptId, "wire:commit-prepared")!).payload.byteLength).toBe(value.bytes.byteLength);
    expect(journal.terminalReceipt(attemptId)).toContain('"PUBLISHED"');
    const parsed = validateRuntimeBackup(JSON.parse(Buffer.from(stored.bytes).toString("utf8")));
    const restored = new RuntimeStore(join(tempDir(), "restored"));
    try {
      const result = restoreBackup(parsed, restored, "restored-epoch");
      expect(result.oldCut).toEqual(value.head);
      expect(result.hash).toBe(value.hash);
      const blob = parsed.blobs[0];
      expect(hash(restored.blobGet(blob.scope, blob.hash)!)).toBe(blob.hash);
      expect(restored.get("meta", "title")).toEqual({ text: "asset-bearing" });
    } finally { restored.close(); }
  });

  it("rejects a typed array declaring max+1 bytes before copying or dispatch", async () => {
    const { io, calls } = fixture();
    const oversized = new Uint8Array(1);
    Object.defineProperty(oversized, "byteLength", { value: WINDOWS_BACKUP_ARTIFACT_MAX_BYTES + 1 });
    const outcome = await io.publishNew(publish({}, oversized));
    expect(outcome.state).toBe("REJECTED");
    expect(calls).toHaveLength(0);
  });

  it("keeps the whole wire inside the bound", () => {
    expect(WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES).toBe(4 + 8192 + WINDOWS_BACKUP_ARTIFACT_MAX_BYTES);
    expect(WINDOWS_BACKUP_ARTIFACT_JOURNAL_MAX_BYTES).toBe(3 * 1024 * 1024 * 1024);
  });

  it("maps a native target collision to EXISTS, preserving the stage", async () => {
    const { io } = fixture({ exec: { exists: "commit-prepared" } });
    const outcome = await io.publishNew(publish());
    expect(outcome.state).toBe("EXISTS");
    if (outcome.state === "PUBLISHED") throw new Error("expected collision");
    expect(outcome.preserve).toBe(true);
  });

  it("UNKNOWN on a throwing approval callback; commit is never dispatched", async () => {
    const { io, calls, journal } = fixture();
    const outcome = await io.publishNew(publish({ beforePublish: () => { throw new Error("deny"); } }));
    expect(outcome.state).toBe("UNKNOWN");
    expect(calls.map((call) => call.phase)).toEqual(["prepare"]);
    expect(journal.readBlob(ATTEMPT, "original")).toBeDefined();
    expect(journal.terminalReceipt(ATTEMPT)).toContain('"UNKNOWN"');
  });

  it("UNKNOWN on an approval callback resolving a defined value", async () => {
    const { io, calls } = fixture();
    const outcome = await io.publishNew(publish({
      beforePublish: () => Promise.resolve("yes" as unknown as void),
    }));
    expect(outcome.state).toBe("UNKNOWN");
    expect(calls.map((call) => call.phase)).toEqual(["prepare"]);
  });

  it("UNKNOWN on a rejected asynchronous approval callback", async () => {
    const { io, calls } = fixture();
    const outcome = await io.publishNew(publish({
      beforePublish: () => Promise.reject(new Error("revoked")),
    }));
    expect(outcome.state).toBe("UNKNOWN");
    expect(calls.map((call) => call.phase)).toEqual(["prepare"]);
  });

  it("UNKNOWN on request assertCurrent revoked before commit", async () => {
    const flag = { current: false };
    const { io, calls } = fixture({ failCurrent: flag });
    const outcome = await io.publishNew(publish({
      beforePublish: () => { flag.current = true; },
    }));
    expect(outcome.state).toBe("UNKNOWN");
    expect(calls.map((call) => call.phase)).toEqual(["prepare"]);
  });

  it("blocks reentrant publish while the callback await is in flight", async () => {
    const { io } = fixture();
    let inner: unknown;
    const outcome = await io.publishNew(publish({
      beforePublish: async () => {
        inner = await io.publishNew(publish({ attemptId: "b".repeat(32) }));
      },
    }));
    expect((inner as { state: string }).state).toBe("REJECTED");
    expect(outcome.state).toBe("PUBLISHED");
  });

  it("UNKNOWN on prepare readback that differs from the original bytes", async () => {
    const { io, calls } = fixture({ exec: { tamper: "prepare" } });
    const outcome = await io.publishNew(publish());
    expect(outcome.state).toBe("UNKNOWN");
    expect(calls.map((call) => call.phase)).toEqual(["prepare"]);
  });

  it("UNKNOWN on final readback that differs from the original bytes", async () => {
    const { io } = fixture({ exec: { tamper: "commit-prepared" } });
    const outcome = await io.publishNew(publish());
    expect(outcome.state).toBe("UNKNOWN");
  });

  it.each(["dup-keys", "truncated", "binary-junk", "bad-header"] as const)("UNKNOWN on malformed binary response: %s", async (malformed) => {
    const { io, journal } = fixture({ exec: { malformed, once: true } });
    const outcome = await io.publishNew(publish());
    expect(outcome.state).toBe("UNKNOWN");
    expect(journal.terminalReceipt(ATTEMPT)).toContain('"UNKNOWN"');
  });

  it("UNKNOWN on directory identity drift before commit; commit never dispatched", async () => {
    let n = 0;
    const { io, calls } = fixture({ directoryId: () => (++n === 1 ? ROOT_ID : "3".repeat(32)) });
    const outcome = await io.publishNew(publish());
    expect(outcome.state).toBe("UNKNOWN");
    expect(calls.map((call) => call.phase)).toEqual(["prepare"]);
  });

  it("a lost commit ack preserves original/wires and stays pending on reopen", async () => {
    const dir = tempDir();
    const first = new WindowsBackupArtifactJournal(dir, testingPlatform(), "binding:test", []);
    journals.push(first);
    const calls: string[] = [];
    const fsPort = {
      lstat: (_path: string): WindowsRuntimeFileStat => ({
        isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        nlink: 1, dev: 1, ino: 1, size: EXE_BYTES.byteLength, mtimeMs: 1,
      }),
      readFile: (_path: string) => EXE_BYTES,
    };
    const exec = (request: WindowsBackupArtifactExecRequest): WindowsBackupArtifactExecResult => {
      const parsed = decode(request.input);
      calls.push(String(parsed.header.operation));
      if (parsed.header.operation === "commit-prepared") throw new Error("commit ack lost");
      return {
        status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({
          contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE, operation: "prepare",
          path: parsed.header.path, root: parsed.header.root,
          attemptId: parsed.header.attemptId, stagingPath: parsed.header.stagingPath,
          state: "PREPARED",
          file: proof(String(parsed.header.stagingPath), String(parsed.header.root), STAGE_ID, String(parsed.header.rootFileId), String(parsed.header.rootVolumeId)),
          directory: proof(ROOT, ROOT, ROOT_ID, String(parsed.header.rootFileId), String(parsed.header.rootVolumeId)),
          byteLength: parsed.payload.byteLength, sha256: hash(parsed.payload),
          contentFlushed: true, filesystem: "NTFS",
        }, parsed.payload),
      };
    };
    const io = createWindowsBackupArtifactForTesting({
      root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
      journal: first,
      directoryIdentity: () => ({ fileId: ROOT_ID, volumeId: VOLUME }),
      assertCurrent: () => {},
    }, { fs: fsPort, exec });
    const original = new Uint8Array([1, 2, 3]);
    expect((await io.publishNew(publish({}, original))).state).toBe("UNKNOWN");
    expect(calls).toEqual(["prepare", "commit-prepared"]);
    first.close();
    journals.splice(journals.indexOf(first), 1);
    const reopened = new WindowsBackupArtifactJournal(dir, testingPlatform(), "binding:test", []);
    journals.push(reopened);
    expect(Buffer.from(reopened.readBlob(ATTEMPT, "original")!).equals(original)).toBe(true);
    expect(reopened.readBlob(ATTEMPT, "wire:commit-prepared")).toBeDefined();
    expect(reopened.pendingAttempts(TARGET)).toContain(ATTEMPT);
    // Reopen keeps every record but grants no dispatch rights.
    expect(() => reopened.record(ATTEMPT, "evidence:callback", new Uint8Array(4))).toThrow();
    expect(() => reopened.recordTerminal(ATTEMPT, '{"outcome":"PUBLISHED"}')).toThrow();
    const restarted = createWindowsBackupArtifactForTesting({
      root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME }, journal: reopened,
      directoryIdentity: () => ({ fileId: ROOT_ID, volumeId: VOLUME }),
      assertCurrent: () => {},
    }, { fs: fsPort, exec });
    expect((await restarted.publishNew(publish({ attemptId: "b".repeat(32) }))).state).toBe("UNKNOWN");
    expect(calls).toEqual(["prepare", "commit-prepared"]);
  });

  it("a second factory cannot dispatch the same durable target", async () => {
    const dir = tempDir();
    const journal = new WindowsBackupArtifactJournal(dir, testingPlatform(), "binding:test", []);
    journals.push(journal);
    const fsPort = {
      lstat: (_path: string): WindowsRuntimeFileStat => ({
        isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        nlink: 1, dev: 1, ino: 1, size: EXE_BYTES.byteLength, mtimeMs: 1,
      }),
      readFile: (_path: string) => EXE_BYTES,
    };
    const options: WindowsBackupArtifactOptions = {
      root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
      journal,
      directoryIdentity: () => ({ fileId: ROOT_ID, volumeId: VOLUME }),
      assertCurrent: () => {},
    };
    const first = createWindowsBackupArtifactForTesting(options, {
      fs: fsPort,
      exec: () => { throw new Error("helper gone"); },
    });
    expect((await first.publishNew(publish())).state).toBe("UNKNOWN");
    // The durable reservation forbids attempt AND target reuse: a new factory
    // (even with a fresh attempt id and a healthy helper) cannot dispatch.
    const secondCalls: string[] = [];
    const second = createWindowsBackupArtifactForTesting(options, {
      fs: fsPort,
      exec: (request) => { secondCalls.push("dispatch"); void request; throw new Error("unreachable"); },
    });
    const outcome = await second.publishNew(publish({ attemptId: "c".repeat(32) }));
    expect(outcome.state).toBe("UNKNOWN");
    expect(secondCalls).toHaveLength(0);
  });

  it("journal capacity failure lands before any helper dispatch", async () => {
    const journal = newJournal();
    // One pending reservation leaves too little for another lifecycle: each
    // reserves slightly more than 1.5 GiB, even for a small original.
    for (const id of ["d".repeat(32)])
      journal.reserve({
        attemptId: id,
        targetKey: `target:${id}`,
        metadata: { attemptId: id, path: `C:\\Out\\${id.slice(0, 4)}.bin` },
        original: new Uint8Array(4),
      });
    let dispatched = 0;
    const ioWithJournal = createWindowsBackupArtifactForTesting({
      root: ROOT, probeExecutable: EXE, expectedHash: hash(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
      journal,
      directoryIdentity: () => ({ fileId: ROOT_ID, volumeId: VOLUME }),
      assertCurrent: () => {},
    }, { fs: { lstat: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1, dev: 1, ino: 1, size: EXE_BYTES.byteLength, mtimeMs: 1 }), readFile: () => EXE_BYTES }, exec: () => { dispatched++; throw new Error("unreachable"); } });
    const outcome = await ioWithJournal.publishNew(publish());
    expect(outcome.state).toBe("UNKNOWN");
    expect(dispatched).toBe(0);
  });

  it("releases only unused virtual capacity after PUBLISHED and retains both complete exports", async () => {
    const { io, journal, calls } = fixture();
    const firstBytes = new Uint8Array([1, 2, 3]);
    expect((await io.publishNew(publish({}, firstBytes))).state).toBe("PUBLISHED");
    const original = journal.readBlob(ATTEMPT, "original")!;
    const originalWire = journal.readBlob(ATTEMPT, "wire:prepare")!;
    const next = "b".repeat(32);
    const second = await io.publishNew(publish({
      path: `${ROOT}\\second.json`,
      stagingPath: `${ROOT}\\.folio-backup-${next}.tmp`,
      attemptId: next,
    }, new Uint8Array([4, 5, 6])));
    expect(second.state).toBe("PUBLISHED");
    expect(calls.map(call => call.phase)).toEqual(["prepare", "commit-prepared", "prepare", "commit-prepared"]);
    expect(Buffer.from(journal.readBlob(ATTEMPT, "original")!).equals(original)).toBe(true);
    expect(Buffer.from(journal.readBlob(ATTEMPT, "wire:prepare")!).equals(originalWire)).toBe(true);
    expect(journal.terminalReceipt(ATTEMPT)).toContain('"PUBLISHED"');
    expect(journal.terminalReceipt(next)).toContain('"PUBLISHED"');
    expect(() => journal.record(ATTEMPT, "evidence:callback", new Uint8Array())).toThrow();
  });

  it("archives the full commit wire before asking for current source approval", async () => {
    const { io, journal, calls } = fixture();
    const outcome = await io.publishNew(publish({
      beforePublish: () => {
        expect(journal.readBlob(ATTEMPT, "wire:commit-prepared")).toBeDefined();
        expect(calls.map(call => call.phase)).toEqual(["prepare"]);
      },
    }));
    expect(outcome.state).toBe("PUBLISHED");
  });

  it("blocks reentry from the synchronous current-authority check before reservation", async () => {
    const { io, calls } = fixture();
    let nested: ReturnType<typeof io.publishNew> | undefined;
    const outcome = await io.publishNew(publish({
      assertCurrent: () => {
        nested ??= io.publishNew(publish({ attemptId: "b".repeat(32) }));
      },
    }));
    expect((await nested)?.state).toBe("REJECTED");
    expect(outcome.state).toBe("PUBLISHED");
    expect(calls.map(call => call.phase)).toEqual(["prepare", "commit-prepared"]);
  });

  it("keeps publication and exact binary stderr when the commit acknowledgement is lost", async () => {
    const { io, journal, published, calls } = fixture({ exec: { loseCommitAck: true } });
    expect((await io.publishNew(publish())).state).toBe("UNKNOWN");
    expect(published.has(TARGET)).toBe(true);
    expect(journal.pendingAttempts(TARGET)).toContain(ATTEMPT);
    expect(journal.readBlob(ATTEMPT, "capture:commit-prepared:stderr")).toEqual(
      new Uint8Array([0xff, 0x00, 0x80]),
    );
    const before = calls.length;
    expect((await io.publishNew(publish({ attemptId: "f".repeat(32) }))).state).toBe("REJECTED");
    expect(calls).toHaveLength(before);
    expect(() => journal.reserve({
      attemptId: "e".repeat(32), targetKey: "changed-directory-file-id",
      metadata: { path: TARGET }, original: new Uint8Array(4),
    })).toThrow();
  });

  it.each(["sid", "rootFileId", "fileId"] as const)("retains UNKNOWN for a mismatched final %s", async proofField => {
    const { io, journal } = fixture({ exec: { proofField } });
    expect((await io.publishNew(publish())).state).toBe("UNKNOWN");
    expect(journal.readBlob(ATTEMPT, "capture:commit-prepared:stdout")).toBeDefined();
    expect(journal.pendingAttempts(TARGET)).toContain(ATTEMPT);
  });

  it.each(["success", "stale-cut", "revoked-session", "changed-selection"] as const)(
    "uses the actual SharedRuntimeService option and source callback: %s",
    async scenario => {
      const { io, calls, journal } = fixture();
      const auth = { userId: "user-1", deviceId: "device-1", writerId: "writer-1", sessionId: "session-1" };
      const head = { epoch: "epoch-1", seq: 3, hash: "b".repeat(64) };
      const body = { format: "folio-shared-runtime-backup/1", head, records: [], blobs: [] };
      const backupHash = createHash("sha256").update(canonical(body)).digest("hex");
      const download = { raw: canonical({ ...body, hash: backupHash }), head, hash: backupHash };
      const downloadSpy = vi.spyOn(SharedBackupProvider.prototype, "download")
        .mockResolvedValueOnce(download)
        .mockImplementationOnce(async () => {
          if (scenario === "changed-selection")
            Object.assign(service, { generation: 1 });
          return scenario === "stale-cut"
            ? { ...download, head: { ...head, seq: 4 } }
            : download;
        });
      const session = vi.fn(async () =>
        scenario === "revoked-session" ? { ...auth, sessionId: "session-2" } : auth,
      );
      const service = new SharedRuntimeService("C:\\Source\\shared-runtime", undefined, {
        nativeBackup: io, pickBackup: async () => TARGET,
      });
      // Inject only the connection fixture; the public handle/backupExport
      // path, source callback and concrete artifact orchestrator are real.
      // No fetch/socket/native process is used by this contract test.
      Object.assign(service, {
        connection: {
          url: "http://127.0.0.1:1", orgId: "org-1", token: "test-token",
          auth, provider: { session, close: () => {} },
        },
      });
      try {
        const result = await service.handle({ type: "backupExport", orgId: "org-1" }) as { state: string };
        expect(result.state).toBe(scenario === "success" ? "EXPORTED" : "UNKNOWN");
        expect(session).toHaveBeenCalledWith("org-1");
        expect(downloadSpy).toHaveBeenCalledTimes(scenario === "revoked-session" ? 1 : 2);
        expect(calls.map(call => call.phase)).toEqual(
          scenario === "success" ? ["prepare", "commit-prepared"] : ["prepare"],
        );
        if (scenario !== "success")
          expect(journal.pendingAttempts(TARGET)).toHaveLength(1);
      } finally {
        service.close();
        downloadSpy.mockRestore();
      }
    },
  );

  it("forbids a target overlapping a forbidden root before any dispatch", async () => {
    const { io, calls } = fixture();
    const outcome = await io.publishNew(publish({ forbiddenRoots: ["C:\\Out"] }));
    expect(outcome.state).toBe("REJECTED");
    expect(calls).toHaveLength(0);
  });

  it("keeps production and test trust separated", async () => {
    const { options } = fixture();
    // Non-Windows: only the explicit untrusted-test factory may be built.
    expect(() => createWindowsBackupArtifact(options)).toThrow();
    const port = createWindowsBackupArtifactForTesting(options, {
      fs: { lstat: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, nlink: 1, dev: 1, ino: 1, size: EXE_BYTES.byteLength, mtimeMs: 1 }), readFile: () => EXE_BYTES },
      exec: () => { throw new Error("unreachable"); },
    });
    expect(port.trust).toBe("untrusted-test");
    expect(port.profile).toBe(WINDOWS_BACKUP_ARTIFACT_PROFILE);
  });
});
