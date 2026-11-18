import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WindowsRecoveryArchive,
  WINDOWS_RECOVERY_ARCHIVE_DATABASE,
} from "../src/platform/windows/recovery-archive";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import { getCheckpointCapacityRefusal } from "../src/platform/private-mutation-diagnostic";

// Real disposable SQLite; the "windows"-kind adapter delegates to
// PosixPrivatePlatform and is explicitly an untrusted contract check, never
// Windows OS/filesystem acceptance.
const ATTEMPT = "a".repeat(32);
const ATTEMPT_B = "b".repeat(32);
const ATTEMPT_C = "c".repeat(32);
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const ROOT_ID = "1".repeat(32), DIR_ID = "2".repeat(32), FILE_ID = "3".repeat(32), VOLUME = "4".repeat(16);
const proofs = {assertCurrent() {}, assertPrior() {}};

const roots: string[] = [];
const archives: WindowsRecoveryArchive[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const archive of archives.splice(0)) { try { archive.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-recovery-archive-")));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function testingPlatform(state?: { failRoot: boolean }): PrivatePlatform {
  const inner = new PosixPrivatePlatform();
  return {
    kind: "windows",
    bind: (d: string) => inner.bind(d),
    assertRoot: () => {
      if (state?.failRoot) throw new Error("untrusted-root-failure");
      inner.assertRoot();
    },
    assertFile: (p: string) => {
      // Contract-only: drops the POSIX 16 MiB ledger bound since recovery
      // originals reach 32 MiB; keeps private file shape and ownership.
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

function newArchive(dir = tempDir(), binding = "binding:test", platform = testingPlatform()): WindowsRecoveryArchive {
  const archive = new WindowsRecoveryArchive(dir, platform, binding, []);
  archives.push(archive);
  return archive;
}

const reserve = (attemptId = ATTEMPT, original = new Uint8Array([1, 2, 3]), logicalPath = "C:\\Folio\\ws\\crash-recovery.json") => {
  const name = `.generation-${attemptId}.json`, parent = "C:\\Folio\\ws";
  return {attemptId, targetKey: `target:${hash([VOLUME, ROOT_ID, VOLUME, DIR_ID, name].join("|"))}`,
    metadata: {kind: "checkpoint", attemptId, logicalPath, workspaceId: "ws-1",
      path: `${parent}\\${name}`, stagingPath: `${parent}\\stage-${attemptId}.tmp`,
      root: {fileId: ROOT_ID, volumeId: VOLUME},
      directory: {canonicalPath: parent, fileId: DIR_ID, volumeId: VOLUME},
      generation: 1, expectedHead: null,
      byteLength: original.byteLength, sha256: hash(original)}, original};
};

function published(archive: WindowsRecoveryArchive, request: ReturnType<typeof reserve>) {
  const m = request.metadata;
  const proof = (path: string, fileId: string) => ({platform: "win32", sid: "S-1-5-21-1000", ownerSid: "S-1-5-21-1000",
    daclPrivate: true, reparsePoint: false, linkCount: 1, localFilesystem: true, canonicalPath: path,
    canonicalRoot: "C:\\Folio", fileId, volumeId: VOLUME, rootFileId: ROOT_ID, rootVolumeId: VOLUME});
  archive.record(request.attemptId, "evidence:prepared", Buffer.from(JSON.stringify({status: 0, header: {
    contractVersion: 3, operation: "prepare", state: "PREPARED", attemptId: request.attemptId,
    path: m.path, stagingPath: m.stagingPath, root: "C:\\Folio", byteLength: m.byteLength, sha256: m.sha256,
    contentFlushed: true, filesystem: "NTFS", file: proof(m.stagingPath, FILE_ID), directory: proof(m.directory.canonicalPath, DIR_ID),
  }})));
  archive.recordTerminal(request.attemptId, JSON.stringify({attemptId: request.attemptId, outcome: "PUBLISHED", evidence: {
    path: m.path, byteLength: m.byteLength, sha256: m.sha256, stagingDisposition: "RENAMED_TO_FINAL",
    identity: {canonicalPath: m.path, fileId: FILE_ID, volumeId: VOLUME},
  }}));
}

describe("windows recovery archive (contract-only, NOT_RUN on Windows)", () => {
  it("reserves, reads back, closes and reopens the exact 32 MiB original", () => {
    const dir = tempDir();
    const bytes = new Uint8Array(32 * 1024 * 1024);
    for (let index = 0; index < bytes.byteLength; index += 8192) bytes[index] = index & 0xff;
    const first = newArchive(dir);
    first.reserve(reserve(ATTEMPT, bytes));
    first.close();
    archives.splice(archives.indexOf(first), 1);
    const reopened = newArchive(dir);
    const readback = reopened.readBlob(ATTEMPT, "original")!;
    expect(readback.byteLength).toBe(bytes.byteLength);
    expect(Buffer.from(readback).equals(bytes)).toBe(true);
  });

  it("enforces the lifecycle budget without purging retained records", () => {
    const archive = newArchive();
    const big = new Uint8Array(32 * 1024 * 1024);
    archive.reserve(reserve(ATTEMPT, big));
    archive.reserve(reserve(ATTEMPT_B, big, "C:\\Folio\\ws\\other.json"));
    // A third full-lifecycle reservation exceeds 512 MiB of durable budget.
    let caught: unknown;
    try { archive.reserve(reserve(ATTEMPT_C, big, "C:\\Folio\\ws\\third.json")); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    expect(getCheckpointCapacityRefusal(caught)).toMatchObject({
      kind: "PRE_DISPATCH_CAPACITY", family: "CHECKPOINT", stage: "RESERVE",
      failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "LOCAL_ADMISSION_GUARD", attemptId: ATTEMPT_C,
      sourceCauseCodes: ["WINDOWS_RECOVERY_ARCHIVE_CAPACITY"],
    });
    expect(archive.readBlob(ATTEMPT, "original")).toBeDefined();
    expect(archive.readBlob(ATTEMPT_B, "original")).toBeDefined();
  });

  it("rejects a duplicate attempt and a duplicate target deterministically", () => {
    const archive = newArchive();
    archive.reserve(reserve());
    expect(() => archive.reserve(reserve())).toThrow();
    expect(() => archive.reserve({ ...reserve(ATTEMPT_B), targetKey: `target:${ATTEMPT}` })).toThrow();
  });

  it("rejects a foreign binding at preflight before mutable pragmas", () => {
    const dir = tempDir();
    newArchive(dir);
    expect(() => newArchive(dir, "binding:foreign")).toThrow();
    expect(() => new WindowsRecoveryArchive(dir, testingPlatform({ failRoot: true }), "binding:test", [])).toThrow();
  });

  it("fails blob readback on a corrupted stored original", () => {
    const dir = tempDir();
    const archive = newArchive(dir);
    archive.reserve(reserve());
    archive.close();
    archives.splice(archives.indexOf(archive), 1);
    const db = new DatabaseSync(join(dir, WINDOWS_RECOVERY_ARCHIVE_DATABASE));
    db.prepare("UPDATE recovery_blobs SET bytes=? WHERE attempt_id=? AND kind=?")
      .run(new Uint8Array([9, 9, 9]), ATTEMPT, "original");
    db.close();
    const reopened = newArchive(dir);
    expect(() => reopened.readBlob(ATTEMPT, "original")).toThrow();
  });

  it("keeps immutable blobs: a second record of the same kind is a conflict, bytes never change", () => {
    const archive = newArchive();
    archive.reserve(reserve());
    const wire = new Uint8Array([7, 7, 7]);
    archive.record(ATTEMPT, "wire:prepare", wire);
    expect(() => archive.record(ATTEMPT, "wire:prepare", new Uint8Array([8]))).toThrow();
    expect(Buffer.from(archive.readBlob(ATTEMPT, "wire:prepare")!).equals(wire)).toBe(true);
  });

  it("blocks CAS and new logical writes while an attempt is unresolved, including after restart", () => {
    const dir = tempDir();
    const first = newArchive(dir);
    first.reserve(reserve());
    first.close();
    archives.splice(archives.indexOf(first), 1);
    const reopened = newArchive(dir);
    // The pending attempt durably blocks this logical path.
    expect(reopened.pendingAttempts("C:\\Folio\\ws\\crash-recovery.json", "ws-1"))
      .toEqual([ATTEMPT]);
    expect(() =>
      reopened.compareAndSwapHead("C:\\Folio\\ws\\crash-recovery.json", "ws-1", null, ATTEMPT_B, proofs),
    ).toThrow();
  });

  it("moves the CAS pointer only to a terminated PUBLISHED attempt at generation+1", () => {
    const archive = newArchive();
    const one = new Uint8Array([1]);
    archive.reserve(reserve(ATTEMPT, one));
    archive.record(ATTEMPT, "wire:prepare", new Uint8Array([2]));
    expect(() =>
      archive.compareAndSwapHead("C:\\Folio\\ws\\crash-recovery.json", "ws-1", null, ATTEMPT, proofs),
    ).toThrow(); // still unresolved: no terminal
    expect(() => archive.recordTerminal(ATTEMPT, JSON.stringify({ attemptId: ATTEMPT, outcome: "PUBLISHED", evidence: { sha256: hash(one) } }))).toThrow();
    published(archive, reserve(ATTEMPT, one));
    archive.compareAndSwapHead("C:\\Folio\\ws\\crash-recovery.json", "ws-1", null, ATTEMPT, proofs);
    const head = archive.readHead("C:\\Folio\\ws\\crash-recovery.json", "ws-1")!;
    expect(head.pointer.generation).toBe(1);
    expect(head.pointer.attemptId).toBe(ATTEMPT);
    // A wrong expected pointer is a deterministic conflict.
    expect(() =>
      archive.compareAndSwapHead("C:\\Folio\\ws\\crash-recovery.json", "ws-1",
        { generation: 7, attemptId: ATTEMPT_B, sha256: hash(one) }, ATTEMPT_B, proofs),
    ).toThrow();
    // A foreign workspace cannot read or occupy the same logical path.
    expect(() => archive.readHead("C:\\Folio\\ws\\crash-recovery.json", "ws-2")).toThrow();
    expect(() =>
      archive.compareAndSwapHead("C:\\Folio\\ws\\crash-recovery.json", "ws-2", null, ATTEMPT_B, proofs),
    ).toThrow();
  });

  it("fails closed when the current fence proof fails", () => {
    const state = { failRoot: false };
    const archive = newArchive(tempDir(), "binding:test", testingPlatform(state));
    archive.reserve(reserve());
    state.failRoot = true;
    expect(() => archive.readBlob(ATTEMPT, "original")).toThrow();
  });

  it("archive records survive an unrelated outer rollback", () => {
    const archive = newArchive();
    archive.reserve(reserve());
    const other = new DatabaseSync(":memory:");
    try {
      other.exec("BEGIN IMMEDIATE; CREATE TABLE scratch(x); INSERT INTO scratch VALUES(1); ROLLBACK;");
    } catch {}
    other.close();
    expect(archive.readBlob(ATTEMPT, "original")).toBeDefined();
  });

  it("claims case aliases atomically across owners and rejects foreign workspaces before a head exists", () => {
    const directory = tempDir(), a = newArchive(directory), b = newArchive(directory);
    a.reserve(reserve());
    expect(() => b.readHead("C:\\FOLIO\\WS\\CRASH-RECOVERY.JSON", "ws-1")).toThrow(/PENDING/);
    expect(() => b.reserve(reserve(ATTEMPT_B, new Uint8Array([8]), "C:\\FOLIO\\WS\\CRASH-RECOVERY.JSON"))).toThrow();
    expect(() => b.readHead("C:\\Folio\\ws\\crash-recovery.json", "foreign")).toThrow(/WORKSPACE/);
    expect(a.readBlob(ATTEMPT, "original")).toBeDefined();
  });

  it("keeps a native PUBLISHED without pointer completion pending after reopen", () => {
    const directory = tempDir(), a = newArchive(directory), request = reserve();
    a.reserve(request); published(a, request); a.close();
    const b = newArchive(directory);
    expect(() => b.compareAndSwapHead(request.metadata.logicalPath, "ws-1", null, ATTEMPT, proofs)).toThrow(/DISPATCH_RIGHTS/);
    expect(() => b.reserve(reserve(ATTEMPT_B))).toThrow(/PENDING/);
    expect(b.readBlob(ATTEMPT, "original")).toEqual(request.original);
  });

  it("rejects a valid published attempt applied under a different path or workspace", () => {
    const a = newArchive(), request = reserve();
    a.reserve(request); published(a, request);
    expect(() => a.compareAndSwapHead("C:\\Folio\\ws\\other.json", "ws-1", null, ATTEMPT, proofs)).toThrow();
    expect(() => a.compareAndSwapHead(request.metadata.logicalPath, "foreign", null, ATTEMPT, proofs)).toThrow();
    expect(a.pendingAttempts(request.metadata.logicalPath, "ws-1")).toEqual([ATTEMPT]);
  });

  it("keeps the refusal behavior but grants no origin for unsafe attempt counts", () => {
    for (const [count, chargeCalls] of [
      [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0], [65, 0], [2.5, 1], [-1, 1],
    ] as const) {
      const archive = newArchive();
      const chargeSpy = vi.spyOn(archive as unknown as { effectiveCharge(db: DatabaseSync): number }, "effectiveCharge")
        .mockReturnValue(512 * 1024 * 1024);
      const db = (archive as unknown as { guard: { db: DatabaseSync } }).guard.db;
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, "prepare").mockImplementation((((sql: string) =>
        sql.includes("COUNT(*) AS n FROM recovery_attempts")
          ? { get: () => ({ n: count }) }
          : prepare(sql)) as unknown as typeof db.prepare));
      let caught: unknown;
      try { archive.reserve(reserve()); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
      expect(chargeSpy).toHaveBeenCalledTimes(chargeCalls);
      expect(getCheckpointCapacityRefusal(caught)).toBeUndefined();
      spy.mockRestore();
    }
  });

  it("grants no origin when effectiveCharge independently throws CAPACITY", () => {
    const archive = newArchive();
    const original = new Error("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
    vi.spyOn(archive as unknown as { effectiveCharge(db: DatabaseSync): number }, "effectiveCharge")
      .mockImplementation(() => { throw original; });
    let caught: unknown;
    try { archive.reserve(reserve()); } catch (error) { caught = error; }
    expect(caught).toBe(original);
    expect(getCheckpointCapacityRefusal(caught)).toBeUndefined();
  });
});
