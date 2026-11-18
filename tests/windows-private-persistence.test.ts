import {withNativeSqliteReader} from "../src/persistence/native-sqlite-reader";
import {startupRetainsNativeLease} from "../src/persistence/startup-connection-owner";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowsPrivatePersistenceForTesting, type WindowsPrivatePersistenceTestPort,
  type NativePrivatePersistenceAuthority, NativePrivatePersistenceError } from "../src/platform/windows/private-persistence";
import { WindowsPrivatePersistenceJournal } from "../src/platform/windows/private-persistence-journal";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import { privatePersistencePort, type NativePrivateFilesystemPort } from "../src/platform/private-persistence";

const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ROOT = "C:\\private", DIR = ROOT + "\\files", VOLUME = "1".repeat(16), RID = "2".repeat(32), DID = "3".repeat(32);
const profile = { profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH" };
function frame(header: object, payload: Uint8Array = new Uint8Array()): Buffer {
  const json = Buffer.from(JSON.stringify(header), "ascii"), bytes = Buffer.alloc(4 + json.length + payload.length);
  bytes.writeUInt32LE(json.length); json.copy(bytes, 4); bytes.set(payload, 4 + json.length); return bytes;
}
function proof(path: string, id: string) {
  return { platform: "win32", sid: "S-1-5-21-123", ownerSid: "S-1-5-21-123", daclPrivate: true,
    reparsePoint: false, linkCount: 1, localFilesystem: true, fileId: id, volumeId: VOLUME,
    rootFileId: RID, rootVolumeId: VOLUME, canonicalRoot: ROOT, canonicalPath: path };
}

/** In-memory transport only: explicitly NOT a Windows OS filesystem test. */
function transportFixture(
  durable?: NativePrivatePersistenceAuthority,
  controls?: {
    mutatePinAfterReserve?: boolean;
    execImpl?: WindowsPrivatePersistenceTestPort["exec"];
  },
) {
  const files = new Map<string, { id: string; bytes: Uint8Array }>();
  const trees = new Map<string, { id: string; entries: number; bytes: number; sha256: string }>();
  const events: string[] = [], captures: Uint8Array[] = [];
  let malformed = false, stale = false;
  let pinMutated = false;
  let badTree: "id" | "hash" | "count" | "bytes" | undefined;
  const authority: NativePrivatePersistenceAuthority = {
    version: 1, independent: true,
    assertCurrent() { durable?.assertCurrent(); },
    reserve(intent) {
      events.push("reserve");
      durable?.reserve(intent);
      if (controls?.mutatePinAfterReserve) pinMutated = true;
    },
    capture(id, capture) { events.push("capture"); captures.push(Uint8Array.from(capture.stdout)); return durable?.capture(id, capture) as void; },
    terminal(id, state, receipt) { events.push(state); return durable?.terminal(id, state, receipt) as void; },
  };
  const executable = Buffer.from("synthetic trusted helper");
  const testPort: WindowsPrivatePersistenceTestPort = {
    fs: {
      lstat: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
        nlink: 1, dev: 1, ino: 1, size: executable.length, mtimeMs: pinMutated ? 2 : 1 }),
      readFile: () => executable,
    },
    exec(request) {
      events.push("exec");
      if (controls?.execImpl) return controls.execImpl(request);
      const input = Buffer.from(request.input), n = input.readUInt32LE();
      const h = JSON.parse(input.subarray(4, 4 + n).toString("ascii")), payload = input.subarray(4 + n);
      const base = { contractVersion: 4, operation: h.operation, path: h.path, root: ROOT,
        ...(h.attemptId ? { attemptId: h.attemptId } : {}) };
      const output = (header: object, bytes: Uint8Array = new Uint8Array(), status = 0) =>
        ({ status, signal: null, stdout: malformed ? Buffer.from([1, 2, 3]) : frame(header, bytes), stderr: Buffer.alloc(0) });
      const parent = proof(win32.dirname(h.path), win32.dirname(h.path) === ROOT ? RID : DID);
      if (h.operation === "inspect-directory")
        return output({ ...base, state: "OK", file: proof(h.path, DID), directory: parent });
      if (h.operation === "inspect-tree" || h.operation === "rename-directory-new") {
        const tree = trees.get(h.path), moving = h.operation === "rename-directory-new";
        if (!tree || moving && (tree.id !== h.sourceFileId || tree.sha256 !== h.sourceSha256 ||
          tree.entries !== h.entries || tree.bytes !== h.byteLength || h.sourceVolumeId !== VOLUME))
          return output({ ...base, state: "REJECTED", reason: "PRIVATE_PERSISTENCE_REJECTED" }, undefined, 1);
        if (moving && trees.has(h.destination))
          return output({ ...base, state: "EXISTS", reason: "PRIVATE_PERSISTENCE_EXISTS" }, undefined, 2);
        const target = moving ? h.destination : h.path;
        if (moving) { trees.set(target, tree); trees.delete(h.path); }
        return output({ ...base, state: moving ? "APPLIED" : "OK",
          file: proof(target, badTree === "id" ? "f".repeat(32) : tree.id),
          directory: proof(win32.dirname(target), win32.dirname(target) === ROOT ? RID : DID),
          entries: tree.entries + (badTree === "count" ? 1 : 0),
          byteLength: tree.bytes + (badTree === "bytes" ? 1 : 0),
          sha256: badTree === "hash" ? "0".repeat(64) : tree.sha256, filesystem: "NTFS",
          ...(moving ? { destination: target, sourceDirectory: parent,
            durability: { profile: "WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1", scope: "PROCESS_CRASH" } } : {}) });
      }
      if (h.operation === "write-new") {
        if (files.has(h.path)) return output({ ...base, state: "EXISTS", reason: "PRIVATE_PERSISTENCE_EXISTS" }, undefined, 2);
        files.set(h.path, { id: "4".repeat(32), bytes: Uint8Array.from(payload) });
      }
      const file = files.get(h.path);
      if (!file) return output({ ...base, state: "REJECTED", reason: "PRIVATE_PERSISTENCE_REJECTED" }, undefined, 1);
      if (h.operation === "inspect-file-identity")
        return output({ ...base, state: "OK", file: proof(h.path, stale ? "f".repeat(32) : file.id), directory: parent });
      if (h.sourceFileId && h.sourceFileId !== file.id || h.fileId && h.fileId !== file.id)
        return output({ ...base, state: "REJECTED", reason: "PRIVATE_PERSISTENCE_REJECTED" }, undefined, 1);
      let target = h.path, targetFile = file;
      if (h.operation === "copy-new" || h.operation === "rename-new") {
        if (files.has(h.destination)) return output({ ...base, state: "EXISTS", reason: "PRIVATE_PERSISTENCE_EXISTS" }, undefined, 2);
        target = h.destination;
        targetFile = { id: h.operation === "copy-new" ? "5".repeat(32) : file.id, bytes: Uint8Array.from(file.bytes) };
        files.set(target, targetFile);
        if (h.operation === "rename-new") files.delete(h.path);
      }
      const mutating = ["write-new", "copy-new", "rename-new", "unlink-exact", "prove-sync"].includes(h.operation);
      const reply = { ...base, state: mutating ? "APPLIED" : "OK",
        file: proof(target, stale ? "f".repeat(32) : targetFile.id),
        directory: proof(win32.dirname(target), DID), byteLength: file.bytes.length, sha256: hash(file.bytes),
        filesystem: "NTFS", ...(mutating && h.operation !== "unlink-exact" ? { contentFlushed: true, durability: profile } : {}),
        ...(h.destination ? { destination: h.destination, sourceDirectory: parent } : {}),
        ...(h.operation === "unlink-exact" ? { unlinked: true } : {}),
      };
      if (h.operation === "unlink-exact") files.delete(h.path);
      return output(reply, ["read", "write-new"].includes(h.operation) ? file.bytes : undefined);
    },
  };
  const port = createWindowsPrivatePersistenceForTesting({
    root: ROOT, probeExecutable: "C:\\tools\\probe.exe", expectedHash: hash(executable), systemRoot: "C:\\Windows",
    expectedRoot: { rootFileId: RID, volumeId: VOLUME }, authority,
    directoryIdentity: path => ({ fileId: path === ROOT ? RID : DID, volumeId: VOLUME }),
    createDirectory: () => ({ fileId: DID, volumeId: VOLUME }),
    acquireSqliteLease: () => ({ trust: "untrusted-test", assertHeld() {}, close() {} }),
    assertCurrent() {},
  }, testPort);
  return { port, files, trees, events, captures, malformed() { malformed = true; }, stale() { stale = true; },
    badTree(kind: typeof badTree) { badTree = kind; } };
}

describe("Windows private persistence transport simulation (NOT OS acceptance)", () => {
  it("accepts directory child identity and normal 20MB write/read/copy/no-replace rename/exact unlink", () => {
    const f = transportFixture(), bytes = Buffer.alloc(20_000_000, 7), path = DIR + "\\asset";
    expect(f.port.inspectDirectory(DIR).fileId).toBe(DID);
    const written = f.port.writeNew(path, bytes, bytes.length);
    expect(Buffer.from(f.port.read(path, written.identity, bytes.length)).equals(bytes)).toBe(true);
    const copied = f.port.copyNew(path, DIR + "\\copy", written.identity, bytes.length);
    const moved = f.port.renameNew(DIR + "\\copy", DIR + "\\moved", copied.identity, bytes.length);
    f.port.unlinkExact(DIR + "\\moved", moved.identity, bytes.length);
    expect(f.files.has(path)).toBe(true);
    expect(f.files.has(DIR + "\\moved")).toBe(false);
    expect(f.events.slice(1, 5)).toEqual(["reserve", "exec", "capture", "APPLIED"]);
  });
  it("retains a created file and exact malformed capture as UNKNOWN", () => {
    const f = transportFixture(); f.malformed();
    expect(() => f.port.writeNew(DIR + "\\unknown", Buffer.from("preserve"), 100)).toThrow("UNKNOWN");
    expect(Buffer.from(f.files.get(DIR + "\\unknown")!.bytes)).toEqual(Buffer.from("preserve"));
    expect(f.captures).toEqual([Uint8Array.from([1, 2, 3])]);
    expect(f.events).toEqual(["reserve", "exec", "capture", "UNKNOWN"]);
  });
  it("rejects stale identities and collision without replacing bytes", () => {
    const f = transportFixture(), path = DIR + "\\original";
    const file = f.port.writeNew(path, Buffer.from("original"), 100).identity;
    expect(() => f.port.writeNew(path, Buffer.from("replacement"), 100)).toThrow();
    expect(hash(f.files.get(path)!.bytes)).toBe(file.sha256);
    f.stale();
    expect(() => f.port.read(path, file, 100)).toThrow();
  });
  it("rejects async native methods before dispatch", () => {
    const f = transportFixture();
    const bad = { ...f.port, writeNew: async () => undefined } as unknown as NativePrivateFilesystemPort;
    expect(() => privatePersistencePort({ nativePrivateFilesystem: bad })).toThrow();
    expect(f.events).toEqual([]);
  });
  it("inspects and renames a directory with archived receipt and local phases, permitting read-only proofs", () => {
    const f = transportFixture(), source = DIR + "\\tree", destination = DIR + "\\moved";
    f.trees.set(source, { id: "6".repeat(32), entries: 3, bytes: 7, sha256: hash(Buffer.from("tree records")) });
    const tree = f.port.inspectTree!(source), phases: string[] = [];
    const moved = f.port.renameDirectoryNew!(source, destination, tree, phase => {
      phases.push(phase); f.port.inspectDirectory(DIR);
    });
    expect(phases).toEqual(["reserve", "dispatch", "success"]);
    expect(moved).toEqual({ profile: "WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1", scope: "PROCESS_CRASH",
      identity: { ...tree, path: destination } });
    expect(f.trees.has(source)).toBe(false); expect(f.captures).toHaveLength(1);
    expect(f.events.filter(x => ["reserve", "capture", "APPLIED"].includes(x))).toEqual(["reserve", "capture", "APPLIED"]);
  });
  it.each(["id", "hash", "count", "bytes", "stdout"] as const)("captures directory %s ambiguity as UNKNOWN without redispatch", failure => {
    const f = transportFixture(), source = DIR + "\\tree", destination = DIR + "\\moved";
    f.trees.set(source, { id: "6".repeat(32), entries: 3, bytes: 7, sha256: hash(Buffer.from("tree")) });
    const tree = f.port.inspectTree!(source);
    f.events.length = 0;
    if (failure === "stdout") f.malformed(); else f.badTree(failure);
    expect(() => f.port.renameDirectoryNew!(source, destination, tree)).toThrow("UNKNOWN");
    expect(f.events).toEqual(["reserve", "exec", "capture", "UNKNOWN"]);
    expect(f.captures).toHaveLength(1); expect(f.trees.has(destination)).toBe(true);
  });
  it("archives stale tree refusals and destination collision without replacement", () => {
    const f = transportFixture(), source = DIR + "\\tree", destination = DIR + "\\existing";
    const original = { id: "6".repeat(32), entries: 3, bytes: 7, sha256: hash(Buffer.from("tree")) };
    f.trees.set(source, original); f.trees.set(destination, { ...original, id: "7".repeat(32) });
    const tree = f.port.inspectTree!(source);
    expect(() => f.port.renameDirectoryNew!(source, destination, tree)).toThrow("EXISTS");
    expect(f.trees.get(destination)?.id).toBe("7".repeat(32));
    for (const stale of [{ fileId: "8".repeat(32) }, { sha256: "0".repeat(64) }, { entries: 4 }])
      expect(() => f.port.renameDirectoryNew!(source, DIR + "\\fresh", { ...tree, ...stale })).toThrow("REJECTED");
    expect(f.captures).toHaveLength(4);
    expect(f.events.filter(x => x === "UNKNOWN")).toHaveLength(4);
  });
  it.each(["reserve", "dispatch", "success"] as const)("honors synchronous operation-local %s refusal", refused => {
    const f = transportFixture(), source = DIR + "\\tree", destination = DIR + "\\fresh";
    f.trees.set(source, { id: "6".repeat(32), entries: 1, bytes: 0, sha256: hash(Buffer.from("root")) });
    const tree = f.port.inspectTree!(source); f.events.length = 0;
    expect(() => f.port.renameDirectoryNew!(source, destination, tree, phase => {
      if (phase === refused) throw new Error("stale cut");
    })).toThrow();
    expect(f.events.filter(x => x === "exec")).toHaveLength(refused === "success" ? 1 : 0);
    expect(f.trees.has(destination)).toBe(refused === "success");
  });
  it("keeps original required file-only adapters valid and rejects async optional capabilities/leases", () => {
    const f = transportFixture();
    const fileOnly = { ...f.port };
    delete fileOnly.inspectTree; delete fileOnly.renameDirectoryNew; delete fileOnly.acquireSqliteLease;
    const port = privatePersistencePort({ nativePrivateFilesystem: fileOnly })!;
    expect(port.inspectTree).toBeUndefined();
    expect(port.writeNew(DIR + "\\file", Buffer.from("a"), 1).identity.bytes).toBe(1);
    for (const name of ["inspectTree", "renameDirectoryNew", "acquireSqliteLease"] as const) {
      expect(() => privatePersistencePort({ nativePrivateFilesystem: {
        ...fileOnly, [name]: async () => undefined,
      } as unknown as NativePrivateFilesystemPort })).toThrow();
    }
    const identity = { path: DIR + "\\file", fileId: "4".repeat(32), volumeId: VOLUME };
    for (const lease of [
      { assertHeld: async () => {}, close() {} },
      { assertHeld() {}, close: function* () {} },
      { assertHeld() { return 1; }, close() {} },
      { assertHeld() {}, close() { return Promise.resolve(); } },
    ]) {
      const facade = privatePersistencePort({ nativePrivateFilesystem: {
        ...fileOnly, acquireSqliteLease: () => lease,
      } as unknown as NativePrivateFilesystemPort })!;
      expect(() => {
        const result = facade.acquireSqliteLease!(identity.path, identity); result.assertHeld(); result.close();
      }).toThrow();
    }
  });
  it("acquires a metadata-only SQLite lease and rejects changed identity without hashing a live file", () => {
    const f = transportFixture(), path = DIR + "\\database";
    f.files.set(path, { id: "4".repeat(32), bytes: new Uint8Array() });
    const id = f.port.inspectFileIdentity(path);
    const lease = f.port.acquireSqliteLease!(path, id);
    lease.assertHeld();
    f.stale(); expect(() => lease.assertHeld()).toThrow();
    lease.close();
    expect(f.captures).toHaveLength(0);
  });
  it("rejects promise and malformed optional tree results, not just async declarations", () => {
    const f = transportFixture(), identity = { path: DIR + "\\tree", fileId: DID, volumeId: VOLUME,
      bytes: 0, entries: 1, sha256: hash(Buffer.from("root")) };
    for (const result of [Promise.resolve(identity), { ...identity, entries: 4097 },
      { ...identity, bytes: 256 * 1024 * 1024 + 1 }, { ...identity, sha256: "bad" }]) {
      const facade = privatePersistencePort({ nativePrivateFilesystem: {
        ...f.port, inspectTree: () => result,
      } as unknown as NativePrivateFilesystemPort })!;
      expect(() => facade.inspectTree!(identity.path)).toThrow();
    }
    const facade = privatePersistencePort({ nativePrivateFilesystem: {
      ...f.port, acquireSqliteLease: () => Promise.resolve({ assertHeld() {}, close() {} }),
    } as unknown as NativePrivateFilesystemPort })!;
    expect(() => facade.acquireSqliteLease!(identity.path, identity)).toThrow();
  });
});

const roots: string[] = [], journals: WindowsPrivatePersistenceJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
import { getKCapacityRefusal, getKMutationFailure, getKReserveFailure } from "../src/platform/private-mutation-diagnostic";
describe("independent journal using disposable POSIX SQLite adapter", () => {
  it("keeps a prior real data-capacity refusal separate from a fresh reserve boundary", () => {
    const oldFixture = dataCancellationFixture();
    const baselineIds = new Set(oldFixture.baseline.attempts.map(row => String(row.id)));
    let oldId = "e".repeat(32);
    for (let n = 0; baselineIds.has(oldId); n += 1) oldId = n.toString(16).padStart(32, "0");
    expect(oldId).toMatch(/^[0-9a-f]{32}$/);
    expect(baselineIds.has(oldId)).toBe(false);
    const oldPath = DIR + "\\data-capacity-proof-old";
    const oldPayload = Buffer.from("tiny-old-capacity");
    const oldWire = frame({ attemptId: oldId, path: oldPath }, oldPayload);
    let oldError: unknown;
    try {
      oldFixture.journal.reserve({
        attemptId: oldId,
        targetKey: oldId,
        wire: oldWire,
        payload: oldPayload,
        maxCaptureBytes: 34 * 1024 * 1024,
      });
    } catch (error) {
      oldError = error;
    }
    expect(oldError).toBeInstanceOf(Error);
    expect(oldError).not.toBeInstanceOf(NativePrivatePersistenceError);
    expect((oldError as Error).message).toBe("PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    const rawRef = getKCapacityRefusal(oldError);
    expect(rawRef).toBeDefined();
    expect(Object.isFrozen(rawRef)).toBe(true);
    expect(Object.isFrozen(rawRef!.sourceCauseCodes)).toBe(true);
    expect(rawRef).toEqual({
      kind: "PRE_DISPATCH_CAPACITY",
      family: "K",
      stage: "RESERVE",
      failureSubject: "CURRENT_ATTEMPT",
      mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "LOCAL_ADMISSION_GUARD",
      attemptId: oldId,
      sourceCauseCodes: ["PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY"],
    });
    expect(oldFixture.readSnapshot()).toEqual(oldFixture.baseline);
    expect(() => oldFixture.journal.assertCurrent()).toThrow(/UNAVAILABLE/i);
    const oldExecCount = oldFixture.nativeExecCount();

    const fresh = reserveBoundaryFixture(() => { throw oldError; });
    const freshPath = DIR + "\\data-capacity-proof-fresh";
    const freshBytes = new Uint8Array([9, 8, 7]);
    let freshError: unknown;
    try {
      fresh.port.writeNew(freshPath, freshBytes, freshBytes.byteLength);
    } catch (error) {
      freshError = error;
    }
    expect(freshError).toBeInstanceOf(NativePrivatePersistenceError);
    const newError = freshError as NativePrivatePersistenceError;
    expect(newError.state).toBe("UNKNOWN");
    expect(newError.preserve).toBe(true);
    expect(newError.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
    expect((newError as Error & { cause?: unknown }).cause).toBe(oldError);
    expect(fresh.attemptIds).toHaveLength(1);
    const newId = fresh.attemptIds[0];
    expect(newId).not.toBe(oldId);
    const reserveFailure = getKReserveFailure(newError);
    expect(reserveFailure).toBeDefined();
    expect(Object.isFrozen(reserveFailure)).toBe(true);
    expect(Object.isFrozen(reserveFailure!.sourceOutcome)).toBe(true);
    expect(reserveFailure).toEqual({
      attemptId: newId,
      sourceOutcome: { source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" },
      capacityRefusal: undefined,
    });
    expect(getKCapacityRefusal(newError)).toBeUndefined();
    expect(getKCapacityRefusal(oldError)).toBe(rawRef);
    expect(getKCapacityRefusal(oldError)!.attemptId).toBe(oldId);
    expect(fresh.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });

    let secondFreshError: unknown;
    try {
      fresh.port.writeNew(DIR + "\\data-capacity-proof-fresh-second", freshBytes, freshBytes.byteLength);
    } catch (error) {
      secondFreshError = error;
    }
    expect(secondFreshError).toBeInstanceOf(NativePrivatePersistenceError);
    const secondFresh = secondFreshError as NativePrivatePersistenceError;
    expect(secondFresh.state).toBe("REJECTED");
    expect(secondFresh.preserve).toBe(true);
    expect(secondFresh.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
    expect((secondFresh as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(getKReserveFailure(secondFresh)).toBeUndefined();
    expect(getKCapacityRefusal(secondFresh)).toBeUndefined();
    expect(fresh.attemptIds).toHaveLength(1);
    expect(fresh.attemptIds[0]).toBe(newId);
    expect(fresh.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });

    expect(oldFixture.readSnapshot()).toEqual(oldFixture.baseline);
    expect(oldFixture.nativeExecCount()).toBe(oldExecCount);
  });
  function reserveBoundaryFixture(
    onReserve: (intent: Parameters<NativePrivatePersistenceAuthority["reserve"]>[0]) => unknown,
  ) {
    const attemptIds: string[] = [];
    const calls = { reserve: 0, exec: 0, capture: 0, terminal: 0 };
    const executable = Buffer.from("synthetic trusted helper");
    const authority = {
      version: 1,
      independent: true,
      assertCurrent() {},
      reserve(intent: Parameters<NativePrivatePersistenceAuthority["reserve"]>[0]) {
        calls.reserve += 1;
        attemptIds.push(intent.attemptId);
        return onReserve(intent);
      },
      capture() { calls.capture += 1; throw new Error("CAPTURE_UNEXPECTED"); },
      terminal() { calls.terminal += 1; throw new Error("TERMINAL_UNEXPECTED"); },
    } as NativePrivatePersistenceAuthority;
    const testPort: WindowsPrivatePersistenceTestPort = {
      fs: {
        lstat: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false,
          nlink: 1, dev: 1, ino: 1, size: executable.length, mtimeMs: 1 }),
        readFile: () => executable,
      },
      exec() {
        calls.exec += 1;
        throw new Error("EXEC_UNEXPECTED");
      },
    };
    const port = createWindowsPrivatePersistenceForTesting({
      root: ROOT, probeExecutable: "C:\\tools\\probe.exe", expectedHash: hash(executable), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: RID, volumeId: VOLUME }, authority,
      directoryIdentity: path => ({ fileId: path === ROOT ? RID : DID, volumeId: VOLUME }),
      createDirectory: () => ({ fileId: DID, volumeId: VOLUME }),
      acquireSqliteLease: () => ({ trust: "untrusted-test", assertHeld() {}, close() {} }),
      assertCurrent() {},
    }, testPort);
    return { port, attemptIds, calls };
  }

  describe("reserve authorisation boundary", () => {
    it("classifies a thrown reserve error as UNKNOWN/RESERVE with its exact cause", () => {
      const raw = new Error("PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
      const fixture = reserveBoundaryFixture(() => { throw raw; });
      const bytes = new Uint8Array([1, 2, 3]);
      let thrown: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-throw.bin", bytes, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      const first = thrown as NativePrivatePersistenceError;
      expect(first.state).toBe("UNKNOWN");
      expect(first.preserve).toBe(true);
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      expect(fixture.attemptIds).toHaveLength(1);
      const failure = getKReserveFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.attemptId).toBe(fixture.attemptIds[0]);
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.capacityRefusal).toBeUndefined();
      expect(Object.isFrozen(failure)).toBe(true);
      expect(Object.isFrozen(failure!.sourceOutcome)).toBe(true);
      expect(getKCapacityRefusal(first)).toBeUndefined();
      expect((first as Error & { cause?: unknown }).cause).toBe(raw);
      expect(getKCapacityRefusal(raw)).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });

      let second: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-throw-second.bin", bytes, bytes.byteLength);
      } catch (error) {
        second = error;
      }
      expect(second).toBeInstanceOf(NativePrivatePersistenceError);
      const secondError = second as NativePrivatePersistenceError;
      expect(secondError.state).toBe("REJECTED");
      expect(secondError.preserve).toBe(true);
      expect(secondError.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKReserveFailure(second)).toBeUndefined();
      expect(getKCapacityRefusal(secondError)).toBeUndefined();
      expect((secondError as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });
    });

    it("classifies a non-void reserve acknowledgement as UNKNOWN/RESERVE without a cause", () => {
      const fixture = reserveBoundaryFixture(() => 42);
      const bytes = new Uint8Array([4, 5, 6]);
      let thrown: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-nonvoid.bin", bytes, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      const first = thrown as NativePrivatePersistenceError;
      expect(first.state).toBe("UNKNOWN");
      expect(first.preserve).toBe(true);
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      expect(fixture.attemptIds).toHaveLength(1);
      const failure = getKReserveFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.attemptId).toBe(fixture.attemptIds[0]);
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.capacityRefusal).toBeUndefined();
      expect(Object.isFrozen(failure)).toBe(true);
      expect(Object.isFrozen(failure!.sourceOutcome)).toBe(true);
      expect(getKCapacityRefusal(first)).toBeUndefined();
      expect((first as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });

      let second: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-nonvoid-second.bin", bytes, bytes.byteLength);
      } catch (error) {
        second = error;
      }
      expect(second).toBeInstanceOf(NativePrivatePersistenceError);
      const secondError = second as NativePrivatePersistenceError;
      expect(secondError.state).toBe("REJECTED");
      expect(secondError.preserve).toBe(true);
      expect(secondError.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKReserveFailure(second)).toBeUndefined();
      expect(getKCapacityRefusal(secondError)).toBeUndefined();
      expect((secondError as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });
    });

    it.each([
      ["plain error", (): unknown => new Error("PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY")],
      ["forged code", (): unknown => Object.assign(new Error("forged"), { code: "PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY" })],
      ["aggregate", (): unknown => new AggregateError([new Error("inner")], "aggregate reserve fault")],
      ["primitive undefined", (): unknown => undefined],
    ] as const)("keeps the current fact clean for a %s reserve throw", (_label, make) => {
      const cause = make();
      const fixture = reserveBoundaryFixture(() => { throw cause; });
      const bytes = new Uint8Array([7, 7, 7]);
      let thrown: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-clean.bin", bytes, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      const first = thrown as NativePrivatePersistenceError;
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      expect((first as Error & { cause?: unknown }).cause).toBe(cause);
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.attemptId).toBe(fixture.attemptIds[0]);
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.capacityRefusal).toBeUndefined();
      expect(failure!.uncertainty).toBeUndefined();
      expect(Object.isFrozen(failure)).toBe(true);
      expect(getKReserveFailure(first)).toEqual({
        attemptId: fixture.attemptIds[0],
        sourceOutcome: { source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" },
        capacityRefusal: undefined,
      });
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });
    });

    it("never traverses hostile reserve error accessors when recording current facts", () => {
      let getterCalls = 0;
      const hostile = Object.defineProperties(new Error("hostile reserve"), {
        cause: { get() { getterCalls += 1; throw new Error("cause getter"); } },
        errors: { get() { getterCalls += 1; throw new Error("errors getter"); } },
      });
      const fixture = reserveBoundaryFixture(() => { throw hostile; });
      const bytes = new Uint8Array([8, 8, 8]);
      let thrown: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-hostile.bin", bytes, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(getterCalls).toBe(0);
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      const first = thrown as NativePrivatePersistenceError;
      expect((first as Error & { cause?: unknown }).cause).toBe(hostile);
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.capacityRefusal).toBeUndefined();
      expect(failure!.uncertainty).toBeUndefined();
      expect(getterCalls).toBe(0);
    });

    const f01Acknowledgement = (mode: "ordinary" | "constructor" | "species") => {
      const marker = new Error("hostile " + mode + " acknowledgement");
      const getterCounts = { constructor: 0, species: 0 };
      const acknowledgement = Promise.resolve();
      if (mode === "constructor") {
        Object.defineProperty(acknowledgement, "constructor", {
          get() { getterCounts.constructor += 1; throw marker; },
        });
      } else if (mode === "species") {
        const speciesCtor: object = {};
        Object.defineProperty(speciesCtor, Symbol.species, {
          get() { getterCounts.species += 1; throw marker; },
        });
        Object.defineProperty(acknowledgement, "constructor", {
          get() { getterCounts.constructor += 1; return speciesCtor; },
        });
      }
      return { acknowledgement, marker, getterCounts };
    };

    it.each(["ordinary", "constructor", "species"] as const)("F-01 keeps a fulfilled %s reserve acknowledgement as RESERVE/NON_VOID_ACK", mode => {
      const { acknowledgement, marker, getterCounts } = f01Acknowledgement(mode);
      const fixture = reserveBoundaryFixture(() => acknowledgement);
      const bytes = new Uint8Array([4, 4, 4]);
      let thrown: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-f01-" + mode + ".bin", bytes, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      const first = thrown as NativePrivatePersistenceError;
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      if (mode === "ordinary") {
        expect((first as Error & { cause?: unknown }).cause).toBeUndefined();
      } else {
        expect((first as Error & { cause?: unknown }).cause).toBe(marker);
      }
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.attemptId).toBe(fixture.attemptIds[0]);
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.capacityRefusal).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });
      const expectedCounts = mode === "ordinary" ? { constructor: 0, species: 0 }
        : mode === "constructor" ? { constructor: 1, species: 0 }
        : { constructor: 1, species: 1 };
      expect(getterCounts).toEqual(expectedCounts);
      let secondThrown: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-f01-second-" + mode + ".bin", bytes, bytes.byteLength);
      } catch (error) {
        secondThrown = error;
      }
      expect((secondThrown as NativePrivatePersistenceError).message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKMutationFailure(secondThrown)).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });
      expect(getterCounts).toEqual(expectedCounts);
      expect(failure!.uncertainty).toEqual({ stage: "RESERVE", origin: "NON_VOID_ACK" });
    });

    it("does not traverse a cyclic reserve error structure for current facts", () => {
      const cycle: Error & { cause?: unknown } = new Error("self-referential reserve fault");
      cycle.cause = cycle;
      const fixture = reserveBoundaryFixture(() => { throw cycle; });
      const bytes = new Uint8Array([6, 6, 6]);
      let thrown: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-cycle.bin", bytes, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      const first = thrown as NativePrivatePersistenceError;
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      expect((first as Error & { cause?: unknown }).cause).toBe(cycle);
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.capacityRefusal).toBeUndefined();
      expect(failure!.uncertainty).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });
    });

    it.each([
      ["42", () => 42 as unknown as void],
      ["promise", () => Promise.resolve() as unknown as void],
      ["thenable", () => ({ then() {} }) as unknown as void],
    ] as const)("marks a non-void %s reserve acknowledgement as RESERVE/NON_VOID_ACK", (_label, make) => {
      const fixture = reserveBoundaryFixture(() => make());
      const bytes = new Uint8Array([9, 9, 9]);
      let thrown: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-nonvoid-facts.bin", bytes, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      const first = thrown as NativePrivatePersistenceError;
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      expect((first as Error & { cause?: unknown }).cause).toBeUndefined();
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.attemptId).toBe(fixture.attemptIds[0]);
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.capacityRefusal).toBeUndefined();
      expect(failure!.uncertainty).toEqual({ stage: "RESERVE", origin: "NON_VOID_ACK" });
      expect(getKReserveFailure(first)!.capacityRefusal).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });

      let second: unknown;
      try {
        fixture.port.writeNew(DIR + "\\reserve-nonvoid-facts-second.bin", bytes, bytes.byteLength);
      } catch (error) {
        second = error;
      }
      expect(second).toBeInstanceOf(NativePrivatePersistenceError);
      const secondError = second as NativePrivatePersistenceError;
      expect(secondError.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKMutationFailure(secondError)).toBeUndefined();
      expect(getKReserveFailure(secondError)).toBeUndefined();
      expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });
    });
  });

  it("rejects a direct reserve when real APPLIED data is inconsistent with an unsafe raw budget", () => {
    const fixture = dataCancellationFixture();
    const maxCaptureBytes = 34 * 1024 * 1024;
    const candidateId = "c04c3b04".repeat(4);
    const candidatePath = win32.join(DIR, "data-cancellation-direct-candidate");
    const candidateOriginal = Buffer.from("tiny-data-cancellation-direct-candidate");
    const candidateWire = frame({ attemptId: candidateId, path: candidatePath }, candidateOriginal);
    const candidateBudget = candidateWire.length + candidateOriginal.length + 2 * maxCaptureBytes + 4096;
    const priorRows = fixture.baseline.attempts.filter(row => row.id !== fixture.appliedId);
    expect(priorRows).toHaveLength(7);
    const cancellationContribution = 2 ** 53 - Number.MAX_SAFE_INTEGER;
    expect(cancellationContribution).toBe(1);
    expect(Number.isSafeInteger(cancellationContribution)).toBe(true);
    expect(Number.isSafeInteger(2 ** 53)).toBe(false);
    const prior = priorRows.reduce((total, row) => total + Number(row.budget), 0) + cancellationContribution;
    expect(Number.isSafeInteger(prior)).toBe(true);
    expect(prior).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(Number.isSafeInteger(prior + candidateBudget)).toBe(true);
    expect(prior + candidateBudget).toBeGreaterThan(512 * 1024 * 1024);
    expect(fixture.baseline.attempts.some(row => row.id === candidateId)).toBe(false);
    type SqlInput = null | number | bigint | string | NodeJS.ArrayBufferView;
    type SqlRow = Record<string, null | number | bigint | string | NodeJS.NonSharedUint8Array>;
    const guard = (fixture.journal as unknown as { guard: { readonly db: DatabaseSync } }).guard;
    const db = guard.db;
    const boundPrepare = db.prepare.bind(db);
    const reserveSelect = "SELECT a.*,t.state,t.receipt,r.unused,r.receipt_sha,s.receipt AS resolution FROM attempts a LEFT JOIN terminals t ON t.id=a.id LEFT JOIN reservation_releases r ON r.id=a.id LEFT JOIN resolutions s ON s.id=a.id";
    const retainedSelect = "SELECT coalesce(sum(length(bytes)),0) AS n FROM blobs WHERE id=?";
    let rowsAll: { mockRestore(): void } | undefined;
    let retainedGet: { mockRestore(): void } | undefined;
    let rowFaults = 0;
    let retainedFaults = 0;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = boundPrepare(sql);
      if (sql === reserveSelect) {
        const boundAll = statement.all.bind(statement) as unknown as (...args: SqlInput[]) => SqlRow[];
        rowsAll = vi.spyOn(statement, "all").mockImplementation((() => {
          const rows = boundAll();
          return rows.map(row => {
            if (String(row.id) !== fixture.appliedId) return row;
            rowFaults += 1;
            return { ...row, budget: 2 ** 53, unused: Number.MAX_SAFE_INTEGER };
          });
        }) as unknown as typeof statement.all);
      }
      if (sql === retainedSelect) {
        const boundGet = statement.get.bind(statement) as unknown as (id: SqlInput) => SqlRow | undefined;
        retainedGet = vi.spyOn(statement, "get").mockImplementation(((id: SqlInput) => {
          const row = boundGet(id);
          if (row === undefined || id !== fixture.appliedId) return row;
          retainedFaults += 1;
          return { ...row, n: 1 };
        }) as unknown as typeof statement.get);
      }
      return statement;
    }) as typeof db.prepare);
    let error: unknown;
    const nativeBefore = fixture.nativeExecCount();
    try {
      try {
        fixture.journal.reserve({ attemptId: candidateId, targetKey: candidateId, wire: candidateWire,
          payload: candidateOriginal, maxCaptureBytes });
      } catch (caught) { error = caught; }
    } finally {
      rowsAll?.mockRestore();
      retainedGet?.mockRestore();
      prepareSpy.mockRestore();
    }
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toBe("PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    expect(Object.keys(failure)).toEqual([]);
    expect(getKCapacityRefusal(failure)).toBeUndefined();
    expect(rowFaults).toBe(1);
    expect(retainedFaults).toBe(1);
    expect(rowsAll).toBeDefined();
    expect(retainedGet).toBeDefined();
    expect(() => fixture.journal.assertCurrent()).toThrow("PRIVATE_PERSISTENCE_JOURNAL_UNAVAILABLE");
    const after = fixture.readSnapshot();
    expect(after).toEqual(fixture.baseline);
    expect(after.attempts).toHaveLength(8);
    expect(after.attempts.some(row => row.id === candidateId)).toBe(false);
    expect(after.blobs.some(row => row.id === candidateId)).toBe(false);
    expect(fixture.nativeExecCount()).toBe(nativeBefore);
  });
  function dataCancellationFixture() {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-data-cancellation-")));
    roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(data, { mode: 0o700 });
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
    journals.push(journal);
    const transport = transportFixture(journal);
    const appliedPath = DIR + "\\data-cancellation-applied";
    const tiny = Buffer.from("tiny-applied");
    transport.port.writeNew(appliedPath, tiny, tiny.length);
    let appliedId = "";
    const appliedDb = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
    try {
      const row = appliedDb.prepare("SELECT id FROM attempts").get();
      if (!row || typeof row.id !== "string") throw new Error("APPLIED_ATTEMPT_ID");
      appliedId = row.id;
      expect(appliedDb.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(1);
      expect(appliedDb.prepare("SELECT count(*) AS n FROM terminals WHERE id=? AND state='APPLIED'").get(appliedId)?.n).toBe(1);
    } finally { appliedDb.close(); }
    for (let i = 0; i < 7; i++) {
      const id = "d".repeat(31) + i.toString(16);
      const path = DIR + "\\data-cancellation-reserve-" + i;
      const original = Buffer.from("tiny-original-" + i);
      const wire = frame({ attemptId: id, path }, original);
      journal.reserve({ attemptId: id, targetKey: id, wire, payload: original, maxCaptureBytes: 34 * 1024 * 1024 });
    }
    function readSnapshot() {
      const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
      try {
        const rows = (sql: string) => db.prepare(sql).all().map(row => {
          const detached: Record<string, null | number | bigint | string | Buffer> = {};
          for (const [key, value] of Object.entries(row)) {
            detached[key] = value instanceof Uint8Array ? Buffer.from(value) : value;
          }
          return detached;
        });
        return {
          identity: rows("SELECT * FROM identity ORDER BY binding"),
          attempts: rows("SELECT * FROM attempts ORDER BY id"),
          blobs: rows("SELECT * FROM blobs ORDER BY id, kind"),
          terminals: rows("SELECT * FROM terminals ORDER BY id"),
          reservation_releases: rows("SELECT * FROM reservation_releases ORDER BY id"),
          resolutions: rows("SELECT * FROM resolutions ORDER BY id"),
        };
      } finally { db.close(); }
    }
    const baseline = readSnapshot();
    return {
      journal, directory, appliedId, baseline, readSnapshot,
      nativeExecCount: () => transport.events.filter(event => event === "exec").length,
    };
  }

  it("captures a healthy byte-exact data cancellation baseline", () => {
    const fixture = dataCancellationFixture();
    expect(() => fixture.journal.assertCurrent()).not.toThrow();
    const baseline = fixture.baseline;
    expect(baseline.attempts).toHaveLength(8);
    expect(baseline.terminals.map(row => ({ id: row.id, state: row.state }))).toEqual([{ id: fixture.appliedId, state: "APPLIED" }]);
    expect(baseline.reservation_releases.map(row => row.id)).toEqual([fixture.appliedId]);
    expect(baseline.resolutions).toEqual([]);
    expect(baseline).toEqual(fixture.readSnapshot());
    expect(fixture.nativeExecCount()).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["MAX_DATA plus one", 512 * 1024 * 1024 + 1],
    ["nonfinite", Number.POSITIVE_INFINITY],
  ] as const)("rejects a candidate when an injected real reserve row has a %s prior budget", (_label, injectedBudget) => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-injected-data-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
    journals.push(journal);
    const priorId = "5".repeat(32), candidateId = "6".repeat(32);
    const priorPath = win32.join(DIR, "injected-data-prior"), candidatePath = win32.join(DIR, "injected-data-candidate");
    const priorOriginal = Buffer.from("tiny-injected-data-prior"), candidateOriginal = Buffer.from("tiny-injected-data-candidate");
    const priorWire = frame({ attemptId: priorId, path: priorPath }, priorOriginal);
    const candidateWire = frame({ attemptId: candidateId, path: candidatePath }, candidateOriginal);
    journal.reserve({ attemptId: priorId, targetKey: priorId, wire: priorWire, payload: priorOriginal, maxCaptureBytes: 0 });
    const checker = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
    let priorBudget: unknown;
    try {
      priorBudget = checker.prepare("SELECT budget FROM attempts WHERE id=?").get(priorId)?.budget;
      const priorRow = checker.prepare("SELECT t.state,t.receipt,r.unused,s.receipt AS resolution FROM attempts a LEFT JOIN terminals t ON t.id=a.id LEFT JOIN reservation_releases r ON r.id=a.id LEFT JOIN resolutions s ON s.id=a.id WHERE a.id=?").get(priorId);
      expect(priorRow).toEqual({ state: null, receipt: null, unused: null, resolution: null });
      expect(Buffer.from(checker.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='original'").get(priorId)!.bytes as Uint8Array)).toEqual(priorOriginal);
      expect(Buffer.from(checker.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='wire'").get(priorId)!.bytes as Uint8Array)).toEqual(priorWire);
    } finally { checker.close(); }
    const guard = (journal as unknown as { guard: { readonly db: DatabaseSync } }).guard;
    const db = guard.db;
    const boundPrepare = db.prepare.bind(db);
    const reserveSelect = "SELECT a.*,t.state,t.receipt,r.unused,r.receipt_sha,s.receipt AS resolution FROM attempts a LEFT JOIN terminals t ON t.id=a.id LEFT JOIN reservation_releases r ON r.id=a.id LEFT JOIN resolutions s ON s.id=a.id";
    let rowsAll: { mockRestore(): void } | undefined;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = boundPrepare(sql);
      if (sql === reserveSelect) {
        const boundAll = statement.all.bind(statement);
        rowsAll = vi.spyOn(statement, "all").mockImplementation((() => {
          const rows = boundAll();
          return rows.map(row => String(row.id) === priorId ? { ...row, budget: injectedBudget } : row);
        }) as unknown as typeof statement.all);
      }
      return statement;
    }) as typeof db.prepare);
    let error: unknown;
    try {
      try {
        journal.reserve({ attemptId: candidateId, targetKey: candidateId, wire: candidateWire, payload: candidateOriginal, maxCaptureBytes: 0 });
      } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      const failure = error as Error;
      expect(failure.message).toBe("PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
      expect(Object.keys(failure)).toEqual([]);
      expect(getKCapacityRefusal(failure)).toBeUndefined();
      expect(rowsAll).toBeDefined();
      expect(rowsAll).toHaveBeenCalledTimes(1);
      expect(() => journal.assertCurrent()).toThrow("PRIVATE_PERSISTENCE_JOURNAL_UNAVAILABLE");
      const postFault = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
      try {
        expect(postFault.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(1);
        expect(postFault.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(candidateId)?.n).toBe(0);
        expect(postFault.prepare("SELECT count(*) AS n FROM blobs WHERE id=?").get(candidateId)?.n).toBe(0);
        expect(postFault.prepare("SELECT budget FROM attempts WHERE id=?").get(priorId)?.budget).toBe(priorBudget);
        expect(Buffer.from(postFault.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='original'").get(priorId)!.bytes as Uint8Array)).toEqual(priorOriginal);
        expect(Buffer.from(postFault.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='wire'").get(priorId)!.bytes as Uint8Array)).toEqual(priorWire);
      } finally { postFault.close(); }
    } finally {
      rowsAll?.mockRestore();
      prepareSpy.mockRestore();
    }
  });
  it("guards the data capacity with a real POSIX SQLite producer and a frozen exact-identity K refusal", () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-data-refusal-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
    journals.push(journal);
    const expected: Array<{ id: string; original: Buffer; wire: Buffer }> = [];
    const maxCaptureBytes = 34 * 1024 * 1024;
    for (let i = 0; i < 7; i++) {
      const id = (i + 1).toString(16).padStart(32, "0");
      const path = DIR + "\\data-capacity-" + i;
      const original = Buffer.from("tiny-original-" + i);
      const wire = frame({ attemptId: id, path }, original);
      expected.push({ id, original, wire });
      journal.reserve({ attemptId: id, targetKey: id, wire, payload: original, maxCaptureBytes });
    }
    const candidateId = (8).toString(16).padStart(32, "0");
    const candidatePath = DIR + "\\data-capacity-7", candidateOriginal = Buffer.from("tiny-original-candidate");
    const candidateWire = frame({ attemptId: candidateId, path: candidatePath }, candidateOriginal);
    let error: unknown;
    try {
      journal.reserve({ attemptId: candidateId, targetKey: candidateId, wire: candidateWire, payload: candidateOriginal, maxCaptureBytes });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toBe("PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY");
    expect(Object.keys(failure)).toEqual([]);
    const refusal = getKCapacityRefusal(failure);
    expect(refusal).toBeDefined();
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(refusal).toEqual({
      kind: "PRE_DISPATCH_CAPACITY", family: "K", stage: "RESERVE",
      failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "LOCAL_ADMISSION_GUARD", attemptId: candidateId,
      sourceCauseCodes: ["PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY"],
    });
    expect(getKCapacityRefusal(new Error(failure.message))).toBeUndefined();
    expect(() => journal.assertCurrent()).toThrow("PRIVATE_PERSISTENCE_JOURNAL_UNAVAILABLE");
    const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(7);
      expect(db.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(candidateId)?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM blobs WHERE id=?").get(candidateId)?.n).toBe(0);
      for (const { id, original, wire } of expected) {
        expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='original'").get(id)!.bytes as Uint8Array)).toEqual(original);
        expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='wire'").get(id)!.bytes as Uint8Array)).toEqual(wire);
      }
    } finally { db.close(); }
  });
  it("short-circuits an injected 64-row reserve result without calling originBlobBytes", () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-injected64-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
    journals.push(journal);
    const id = (4).toString(16).padStart(32, "0"), path = win32.join(DIR, "injected-64-shortcircuit");
    const payload = Buffer.from("tiny-injected-64"), wire = frame({ attemptId: id, path }, payload);
    const guard = (journal as unknown as { guard: { readonly db: DatabaseSync } }).guard;
    const db = guard.db;
    const boundPrepare = db.prepare.bind(db);
    const reserveSelect = "SELECT a.*,t.state,t.receipt,r.unused,r.receipt_sha,s.receipt AS resolution FROM attempts a LEFT JOIN terminals t ON t.id=a.id LEFT JOIN reservation_releases r ON r.id=a.id LEFT JOIN resolutions s ON s.id=a.id";
    let rowsAll: { mockRestore(): void } | undefined;
    const prepareSpy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      const statement = boundPrepare(sql);
      if (sql === reserveSelect) {
        rowsAll = vi.spyOn(statement, "all").mockReturnValue(Array.from({ length: 64 }, () => ({})));
      }
      return statement;
    }) as typeof db.prepare);
    let originCalls = 0;
    const originSpy = vi.spyOn(journal as unknown as { originBlobBytes(): number }, "originBlobBytes")
      .mockImplementation(() => { originCalls++; throw new Error("originBlobBytes must not be reached after injected64 rows"); });
    let error: unknown;
    try {
      journal.reserve({ attemptId: id, targetKey: id, wire, payload, maxCaptureBytes: 0 });
    } catch (caught) { error = caught; }
    try {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("METADATA_CAPACITY");
      expect(getKCapacityRefusal(error as Error)).toBeUndefined();
      expect(rowsAll).toBeDefined();
      expect(rowsAll).toHaveBeenCalledTimes(1);
      expect(originCalls).toBe(0);
      expect(originSpy).toHaveBeenCalledTimes(0);
      expect(() => journal.assertCurrent()).toThrow("PRIVATE_PERSISTENCE_JOURNAL_UNAVAILABLE");
      const checker = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
      try {
        expect(checker.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(0);
        expect(checker.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(id)?.n).toBe(0);
        expect(checker.prepare("SELECT count(*) AS n FROM blobs WHERE id=?").get(id)?.n).toBe(0);
      } finally { checker.close(); }
    } finally {
      originSpy.mockRestore();
      rowsAll?.mockRestore();
      prepareSpy.mockRestore();
    }
  });
  it("rethrows the exact originBlobBytes failure without a K origin and poisons the journal", () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-neg-origin-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
    journals.push(journal);
    const id = (1).toString(16).padStart(32, "0"), path = win32.join(DIR, "negative-origin");
    const original = Buffer.from("tiny-negative-origin"), wire = frame({ attemptId: id, path }, original);
    const thrown = new Error("PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    const spy = vi.spyOn(journal as unknown as { originBlobBytes(): number }, "originBlobBytes")
      .mockImplementationOnce(() => { throw thrown; });
    let error: unknown;
    try {
      journal.reserve({ attemptId: id, targetKey: id, wire, payload: original, maxCaptureBytes: 0 });
    } catch (caught) { error = caught; }
    expect(error).toBe(thrown);
    expect(getKCapacityRefusal(error as Error)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => journal.assertCurrent()).toThrow("PRIVATE_PERSISTENCE_JOURNAL_UNAVAILABLE");
    const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(id)?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM blobs WHERE id=?").get(id)?.n).toBe(0);
    } finally { db.close(); }
  });
  it.each([
    ["NaN", Number.NaN, 0],
    ["-1", -1, 40],
    ["8MiB+1", 8 * 1024 * 1024 + 1, 0],
    ["Number.MAX_SAFE_INTEGER+1", Number.MAX_SAFE_INTEGER + 1, 0],
  ] as Array<[string, number, number]>)("withholds an invalid or over-budget origin charge (%s) without admitting the candidate", (_label, charge, seed) => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-neg-charge-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
    journals.push(journal);
    const expected: Array<{ id: string; original: Buffer; wire: Buffer }> = [];
    for (let i = 0; i < seed; i++) {
      const id = (i + 1).toString(16).padStart(32, "0"), path = win32.join(DIR, "negative-charge-prior-" + i);
      const original = Buffer.from("tiny-negative-charge-prior-" + i);
      const wire = frame({ attemptId: id, path }, original);
      expected.push({ id, original, wire });
      journal.reserve({ attemptId: id, targetKey: id, wire, payload: original, maxCaptureBytes: 0 });
    }
    const candidateId = (seed + 1).toString(16).padStart(32, "0"), candidatePath = win32.join(DIR, "negative-charge-candidate");
    const candidateOriginal = Buffer.from("tiny-negative-charge-candidate");
    const candidateWire = frame({ attemptId: candidateId, path: candidatePath }, candidateOriginal);
    const spy = vi.spyOn(journal as unknown as { originBlobBytes(): number }, "originBlobBytes")
      .mockImplementationOnce(() => charge);
    let error: unknown;
    try {
      journal.reserve({ attemptId: candidateId, targetKey: candidateId, wire: candidateWire, payload: candidateOriginal, maxCaptureBytes: 0 });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    expect(getKCapacityRefusal(error as Error)).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(() => journal.assertCurrent()).toThrow("PRIVATE_PERSISTENCE_JOURNAL_UNAVAILABLE");
    const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(seed);
      expect(db.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(candidateId)?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM blobs WHERE id=?").get(candidateId)?.n).toBe(0);
      for (const { id, original, wire } of expected) {
        expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='original'").get(id)!.bytes as Uint8Array)).toEqual(original);
        expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='wire'").get(id)!.bytes as Uint8Array)).toEqual(wire);
      }
    } finally { db.close(); }
  });
  it("guards the 41st metadata candidate with a frozen exact-identity K capacity refusal", () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-k-refusal-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
    journals.push(journal);
    const expected: Array<{ id: string; original: Buffer; wire: Buffer }> = [];
    for (let i = 0; i < 40; i++) {
      const id = (i + 1).toString(16).padStart(32, "0");
      const path = DIR + "\\capacity-" + i;
      const original = Buffer.from("tiny-original-" + i);
      const wire = frame({ attemptId: id, path }, original);
      expected.push({ id, original, wire });
      journal.reserve({ attemptId: id, targetKey: id, wire, payload: original, maxCaptureBytes: 0 });
    }
    const candidateId = (41).toString(16).padStart(32, "0");
    const candidatePath = DIR + "\\capacity-40", candidateOriginal = Buffer.from("tiny-original-candidate");
    const candidateWire = frame({ attemptId: candidateId, path: candidatePath }, candidateOriginal);
    let error: unknown;
    try {
      journal.reserve({ attemptId: candidateId, targetKey: candidateId, wire: candidateWire, payload: candidateOriginal, maxCaptureBytes: 0 });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    expect(failure.message).toBe("PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY");
    expect(Object.keys(failure)).toEqual([]);
    const refusal = getKCapacityRefusal(failure);
    expect(refusal).toBeDefined();
    expect(Object.isFrozen(refusal)).toBe(true);
    expect(refusal).toEqual({
      kind: "PRE_DISPATCH_CAPACITY", family: "K", stage: "RESERVE",
      failureSubject: "CURRENT_ATTEMPT", mutationDispatch: "NOT_DISPATCHED_PROVEN",
      proofOrigin: "LOCAL_ADMISSION_GUARD", attemptId: candidateId,
      sourceCauseCodes: ["PRIVATE_PERSISTENCE_JOURNAL_METADATA_CAPACITY"],
    });
    expect(getKCapacityRefusal(new Error(failure.message))).toBeUndefined();
    expect(() => journal.assertCurrent()).toThrow("PRIVATE_PERSISTENCE_JOURNAL_UNAVAILABLE");
    const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(40);
      expect(db.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(candidateId)?.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM blobs WHERE id=?").get(candidateId)?.n).toBe(0);
      for (const { id, original, wire } of expected) {
        expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='original'").get(id)!.bytes as Uint8Array)).toEqual(original);
        expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='wire'").get(id)!.bytes as Uint8Array)).toEqual(wire);
      }
    } finally { db.close(); }
  });
  it("composes a 20MB publication with independent SQLite original/raw/terminal persistence", () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-large-contract-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
    const inner = new PosixPrivatePlatform();
    let pinned: { dev: number; ino: number } | undefined;
    // Archive-only contract adapter. Production PrivateLedger's 16MiB file
    // guard is untouched; this disposable data archive admits up to 1GiB.
    const platform: PrivatePlatform = {
      kind: "posix", bind: p => inner.bind(p), assertRoot: () => inner.assertRoot(),
      assertFile(path) {
        inner.assertRoot(); const stat = fs.lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024 * 1024 ||
          (pinned && (stat.dev !== pinned.dev || stat.ino !== pinned.ino))) throw new Error("test archive identity");
        pinned ??= { dev: stat.dev, ino: stat.ino };
      },
      assertSidecars: p => inner.assertSidecars(p), createExclusive: p => inner.createExclusive(p),
      assertEmptyFile: p => inner.assertEmptyFile(p), close: () => inner.close(),
    };
    const journal = new WindowsPrivatePersistenceJournal(directory, platform, "large-fixture", () => {}, [data]);
    journals.push(journal);
    const f = transportFixture(journal), bytes = Buffer.alloc(20_000_000, 42);
    const receipt = f.port.writeNew(DIR + "\\large", bytes, bytes.length);
    expect(receipt.identity.sha256).toBe(hash(bytes));
    const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT state FROM terminals").get()?.state).toBe("APPLIED");
      expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE kind='original'").get()!.bytes as Uint8Array).equals(bytes)).toBe(true);
      expect(Number(db.prepare("SELECT length(bytes) AS n FROM blobs WHERE kind='stdout'").get()?.n)).toBeGreaterThan(bytes.length);
    } finally { db.close(); }
  });
  it("retains exact original/capture and blocks unresolved target after reopen without giving old dispatch rights", () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-contract-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
    const open = () => new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
    const id = "a".repeat(32), path = DIR + "\\unknown", original = Buffer.from("immutable original");
    const first = open();
    first.reserve({ attemptId: id, targetKey: "test", wire: frame({ attemptId: id, path }, original),
      payload: original, maxCaptureBytes: 1024 });
    first.capture(id, { stdout: Buffer.from([0, 255, 1]), stderr: Buffer.from("exact error"), status: null, signal: null });
    first.terminal(id, "UNKNOWN", "receipt missing");
    first.close();
    const reopened = open(); journals.push(reopened);
    expect(() => reopened.capture(id, { stdout: original, stderr: original, status: 0, signal: null })).toThrow("NOT_OWNER");
    expect(() => reopened.reserve({ attemptId: "b".repeat(32), targetKey: "another",
      wire: frame({ attemptId: "b".repeat(32), path }, original), payload: original, maxCaptureBytes: 1024 })).toThrow("UNRESOLVED");
    // Observe retained evidence with a separate readonly connection; never
    // infer nonapplication from absent terminal data.
    const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(1);
      expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='original'").get(id)!.bytes as Uint8Array)).toEqual(original);
      expect(Buffer.from(db.prepare("SELECT bytes FROM blobs WHERE id=? AND kind='stdout'").get(id)!.bytes as Uint8Array)).toEqual(Buffer.from([0, 255, 1]));
    } finally { db.close(); }
  });
  it("blocks unresolved directory descendants and ancestors across restart while allowing unrelated siblings", () => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-tree-claim-"))); roots.push(root);
    const directory = join(root, "authority"), data = join(root, "data");
    fs.mkdirSync(directory, {mode:0o700});fs.mkdirSync(data, {mode:0o700});
    const open = () => new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "tree-claim", () => {}, [data]);
    const first = open(), id = "a".repeat(32), source = DIR + "\\tree", destination = DIR + "\\moved";
    first.reserve({attemptId:id,targetKey:"tree",wire:frame({attemptId:id,operation:"rename-directory-new",path:source,destination}),payload:new Uint8Array(),maxCaptureBytes:1024});
    first.capture(id,{stdout:Buffer.from("lost acknowledgment"),stderr:Buffer.from("exact"),status:null,signal:null});
    first.terminal(id,"UNKNOWN","retained");first.close();
    for (const path of [source+"\\child", destination+"\\child", DIR, source.toUpperCase()]) {
      const candidate=open();
      expect(()=>candidate.reserve({attemptId:"b".repeat(32),targetKey:"other",wire:frame({attemptId:"b".repeat(32),path}),payload:new Uint8Array(),maxCaptureBytes:1024})).toThrow("UNRESOLVED");
      candidate.close();
    }
    const unrelated=open();journals.push(unrelated);
    expect(()=>unrelated.reserve({attemptId:"c".repeat(32),targetKey:"sibling",wire:frame({attemptId:"c".repeat(32),path:DIR+"\\tree-sibling"}),payload:new Uint8Array(),maxCaptureBytes:1024})).not.toThrow();
  });
  it("releases only unused capture reservation after exact APPLIED evidence and retains all twelve originals", () => {
    const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"folio-private-reservation-release-")));roots.push(root);
    const directory=join(root,"authority"),data=join(root,"data");fs.mkdirSync(directory,{mode:0o700});fs.mkdirSync(data,{mode:0o700});
    const journal=new WindowsPrivatePersistenceJournal(directory,new PosixPrivatePlatform(),"release",()=>{},[data]);journals.push(journal);
    const authority:NativePrivatePersistenceAuthority={version:1,independent:true,
      reserve(intent){journal.reserve({...intent,maxCaptureBytes:34*1024*1024});},
      capture:(...args)=>journal.capture(...args),terminal:(...args)=>journal.terminal(...args),assertCurrent:()=>journal.assertCurrent()};
    const f=transportFixture(authority);
    for(let i=0;i<12;i++)expect(f.port.writeNew(DIR+"\\file-"+i,Buffer.from([i]),1).identity.sha256).toBe(hash(Buffer.from([i])));
    const db=new DatabaseSync(join(directory,"private-persistence-v1.sqlite"),{readOnly:true});
    try {
      expect(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(12);
      expect(db.prepare("SELECT count(*) AS n FROM reservation_releases WHERE unused>0").get()?.n).toBe(12);
      expect(db.prepare("SELECT sum(length(bytes)) AS n FROM blobs WHERE kind='original'").get()?.n).toBe(12);
      expect(db.prepare("SELECT count(*) AS n FROM terminals WHERE state='APPLIED'").get()?.n).toBe(12);
    } finally {db.close();}
  });

  it("ignores a stale real capacity refusal thrown as the reserve cause", () => {
    const oldFixture = dataCancellationFixture();
    const oldId = "e".repeat(32), oldPath = win32.join(DIR, "stale-capacity-source");
    const oldOriginal = Buffer.from("tiny-stale"), oldWire = frame({ attemptId: oldId, path: oldPath }, oldOriginal);
    let oldError: unknown;
    try {
      oldFixture.journal.reserve({ attemptId: oldId, targetKey: oldId, wire: oldWire, payload: oldOriginal, maxCaptureBytes: 34 * 1024 * 1024 });
    } catch (error) {
      oldError = error;
    }
    expect(oldError).toBeInstanceOf(Error);
    const staleRefusal = getKCapacityRefusal(oldError);
    expect(staleRefusal).toBeDefined();
    expect(staleRefusal!.attemptId).toBe(oldId);

    const fixture = reserveBoundaryFixture(() => { throw oldError; });
    const bytes = new Uint8Array([6, 6, 6]);
    let thrown: unknown;
    try {
      fixture.port.writeNew(DIR + "\\stale-capacity-fresh.bin", bytes, bytes.byteLength);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
    const first = thrown as NativePrivatePersistenceError;
    expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
    expect((first as Error & { cause?: unknown }).cause).toBe(oldError);
    const failure = getKMutationFailure(first);
    expect(failure).toBeDefined();
    expect(failure!.attemptId).toBe(fixture.attemptIds[0]);
    expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
    expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
    expect(failure!.capacityRefusal).toBeUndefined();
    expect(failure!.uncertainty).toBeUndefined();
    expect(getKReserveFailure(first)!.capacityRefusal).toBeUndefined();
    expect(getKCapacityRefusal(oldError)).toBe(staleRefusal);
    expect(fixture.calls).toEqual({ reserve: 1, exec: 0, capture: 0, terminal: 0 });
  });

  describe("current K mutation failure facts", () => {
    const journalFixture = (label: string, hooks?: { afterCommit?: () => never }) => {
      const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-private-journal-kfact-" + label + "-")));
      roots.push(root);
      const directory = join(root, "authority"), data = join(root, "data");
      fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
      const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(), "fixture", () => {}, [data]);
      journals.push(journal);
      if (hooks?.afterCommit !== undefined) {
        const guard = guardOf(journal);
        let committed = false;
        const boundExec = guard.db.exec.bind(guard.db);
        vi.spyOn(guard.db, "exec").mockImplementation(((sql: string) => {
          const result = boundExec(sql);
          if (sql === "COMMIT") committed = true;
          return result;
        }) as typeof guard.db.exec);
        const boundAssert = journal.assertCurrent.bind(journal);
        vi.spyOn(journal, "assertCurrent").mockImplementation(() => {
          if (committed) hooks.afterCommit!();
          boundAssert();
        });
      }
      return { journal, directory };
    };
    const guardOf = (journal: WindowsPrivatePersistenceJournal) =>
      (journal as unknown as { guard: { readonly db: DatabaseSync; isUncertainFailure(value: unknown): boolean } }).guard;
    const attemptSnapshot = (directory: string, id: string) => {
      const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
      try {
        const blobs = new Map<string, { bytes: Buffer; sha: string }>();
        for (const row of db.prepare("SELECT kind,bytes,sha FROM blobs WHERE id=?").all(id) as Array<{ kind: string; bytes: Uint8Array; sha: string }>) {
          blobs.set(row.kind, { bytes: Buffer.from(row.bytes), sha: String(row.sha) });
        }
        const terminalRow = db.prepare("SELECT state,receipt FROM terminals WHERE id=?").get(id) as { state: unknown; receipt: unknown } | undefined;
        return {
          attempts: db.prepare("SELECT count(*) AS n FROM attempts WHERE id=?").get(id)?.n,
          kinds: [...blobs.keys()].sort(),
          blobs,
          terminal: terminalRow === undefined ? undefined
            : { state: String(terminalRow.state), receipt: JSON.parse(String(terminalRow.receipt)) as Record<string, unknown> },
        };
      } finally { db.close(); }
    };
    const wirePayload = (wire: Buffer) => {
      const n = wire.readUInt32LE(0);
      return { header: JSON.parse(wire.subarray(4, 4 + n).toString("ascii")) as Record<string, unknown>, payload: wire.subarray(4 + n) };
    };
    const expectBlobs = (snapshot: ReturnType<typeof attemptSnapshot>, id: string, original: Buffer) => {
      const originalBlob = snapshot.blobs.get("original")!;
      const wireBlob = snapshot.blobs.get("wire")!;
      expect(originalBlob.bytes.equals(original)).toBe(true);
      expect(originalBlob.sha).toBe(hash(originalBlob.bytes));
      expect(wireBlob.sha).toBe(hash(wireBlob.bytes));
      const decoded = wirePayload(wireBlob.bytes);
      expect(decoded.header.attemptId).toBe(id);
      expect(Buffer.from(decoded.payload).equals(original)).toBe(true);
    };
    const writeFailure = (f: ReturnType<typeof transportFixture>, path: string, bytes: Uint8Array) => {
      let thrown: unknown;
      try {
        f.port.writeNew(path, bytes, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      return thrown as NativePrivatePersistenceError;
    };

    it("marks a real journal COMMIT ambiguity as RESERVE/JOURNAL_TRANSACTION without dispatch", () => {
      const { journal, directory } = journalFixture("commit");
      const guard = guardOf(journal);
      const commitFault = new Error("injected post-commit failure");
      const boundExec = guard.db.exec.bind(guard.db);
      const execSpy = vi.spyOn(guard.db, "exec").mockImplementation(((sql: string) => {
        const result = boundExec(sql);
        if (sql === "COMMIT") throw commitFault;
        return result;
      }) as typeof guard.db.exec);
      const f = transportFixture(journal);
      const bytes = Buffer.from("commit-ambiguous");
      const first = writeFailure(f, DIR + "\\commit-ambiguous", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.attemptId).toMatch(/^[0-9a-f]{32}$/);
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.uncertainty).toEqual({ stage: "RESERVE", origin: "JOURNAL_TRANSACTION" });
      expect(failure!.capacityRefusal).toBeUndefined();
      const cause = (first as Error & { cause?: unknown }).cause;
      expect(guard.isUncertainFailure(cause)).toBe(true);
      expect(guard.isUncertainFailure(first)).toBe(false);
      expect(guard.isUncertainFailure({})).toBe(false);
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "wire"]);
      expectBlobs(snapshot, failure!.attemptId, bytes);
      expect(snapshot.terminal).toBeUndefined();
      expect(f.events).toEqual(["reserve"]);
      execSpy.mockRestore();
      const second = writeFailure(f, DIR + "\\commit-ambiguous-second", bytes);
      expect(second.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKMutationFailure(second)).toBeUndefined();
      expect(f.events).toEqual(["reserve"]);
    });

    it("keeps a rollback ambiguity JOURNAL_TRANSACTION instead of a clean capacity refusal", () => {
      const { journal, directory } = journalFixture("rollback");
      const seeds: Array<{ id: string; original: Buffer; wire: Buffer }> = [];
      for (let i = 0; i < 40; i++) {
        const id = (i + 1).toString(16).padStart(32, "0"), path = DIR + "\\capacity-rollback-prior-" + i;
        const original = Buffer.from("tiny-prior-" + i), wire = frame({ attemptId: id, path }, original);
        journal.reserve({ attemptId: id, targetKey: id, wire, payload: original, maxCaptureBytes: 0 });
        seeds.push({ id, original, wire });
      }
      const guard = guardOf(journal);
      const rollbackFault = new Error("injected rollback failure");
      const boundExec = guard.db.exec.bind(guard.db);
      const execSpy = vi.spyOn(guard.db, "exec").mockImplementation(((sql: string) => {
        if (sql === "ROLLBACK") throw rollbackFault;
        return boundExec(sql);
      }) as typeof guard.db.exec);
      const f = transportFixture(journal);
      const first = writeFailure(f, DIR + "\\capacity-rollback-candidate", Buffer.from("candidate"));
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.uncertainty).toEqual({ stage: "RESERVE", origin: "JOURNAL_TRANSACTION" });
      expect(failure!.capacityRefusal).toBeUndefined();
      const cause = (first as Error & { cause?: unknown }).cause;
      expect(guard.isUncertainFailure(cause)).toBe(true);
      expect(guard.isUncertainFailure(rollbackFault)).toBe(false);
      expect(getKReserveFailure(first)!.capacityRefusal).toBeUndefined();
      expect(f.events).toEqual(["reserve"]);
      execSpy.mockRestore();
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(0);
      expect(snapshot.kinds).toEqual([]);
      const db = new DatabaseSync(join(directory, "private-persistence-v1.sqlite"), { readOnly: true });
      try {
        for (const seed of seeds) {
          for (const kind of ["original", "wire"] as const) {
            const row = db.prepare("SELECT bytes,sha FROM blobs WHERE id=? AND kind=?").get(seed.id, kind) as { bytes: Uint8Array; sha: unknown } | undefined;
            expect(row).toBeDefined();
            expect(Buffer.from(row!.bytes).equals(kind === "original" ? seed.original : seed.wire)).toBe(true);
            expect(String(row!.sha)).toBe(hash(row!.bytes as Uint8Array));
          }
        }
      } finally { db.close(); }
    });

    it("marks a post-commit journal readback fault as RESERVE/JOURNAL_READBACK", () => {
      const { journal, directory } = journalFixture("readback");
      const readFault = new Error("injected readback failure");
      const readSpy = vi.spyOn(journal as unknown as { read(id: string, kind: string): Buffer }, "read")
        .mockImplementation(() => { throw readFault; });
      const f = transportFixture(journal);
      const bytes = Buffer.from("readback-ambiguous");
      const first = writeFailure(f, DIR + "\\readback-ambiguous", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.uncertainty).toEqual({ stage: "RESERVE", origin: "JOURNAL_READBACK" });
      expect(failure!.capacityRefusal).toBeUndefined();
      const cause = (first as Error & { cause?: unknown }).cause;
      expect(cause).toBe(readFault);
      expect(guardOf(journal).isUncertainFailure(cause)).toBe(false);
      readSpy.mockRestore();
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "wire"]);
      expectBlobs(snapshot, failure!.attemptId, bytes);
      expect(snapshot.terminal).toBeUndefined();
      expect(f.events).toEqual(["reserve"]);
    });

    it("marks a local association fault as RESERVE/JOURNAL_ASSOCIATION", () => {
      const { journal, directory } = journalFixture("association");
      const assocFault = new Error("injected association failure");
      const local = (journal as unknown as { local: Set<string> }).local;
      const addSpy = vi.spyOn(local, "add").mockImplementation(() => { throw assocFault; });
      const f = transportFixture(journal);
      const bytes = Buffer.from("association-ambiguous");
      const first = writeFailure(f, DIR + "\\association-ambiguous", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.uncertainty).toEqual({ stage: "RESERVE", origin: "JOURNAL_ASSOCIATION" });
      expect(failure!.capacityRefusal).toBeUndefined();
      const cause = (first as Error & { cause?: unknown }).cause;
      expect(cause).toBe(assocFault);
      expect(guardOf(journal).isUncertainFailure(cause)).toBe(false);
      addSpy.mockRestore();
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "wire"]);
      expectBlobs(snapshot, failure!.attemptId, bytes);
      expect(f.events).toEqual(["reserve"]);
    });

    it("proves no dispatch when the helper pin breaks after reserve", () => {
      const f = transportFixture(undefined, { mutatePinAfterReserve: true });
      const first = writeFailure(f, DIR + "\\pin-broken", Buffer.from("pin"));
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:DISPATCH");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "DISPATCH" });
      expect(failure!.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure!.uncertainty).toBeUndefined();
      expect(failure!.capacityRefusal).toBeUndefined();
      expect(f.events).toEqual(["reserve", "capture", "UNKNOWN"]);
      expect(f.events.filter(event => event === "exec")).toEqual([]);
    });

    it("does not mint mutation facts for a read-path helper failure", () => {
      const f = transportFixture();
      const bytes = Buffer.from("read-negative");
      const written = f.port.writeNew(DIR + "\\read-neg", bytes, bytes.byteLength).identity;
      f.malformed();
      let thrown: unknown;
      try {
        f.port.read(DIR + "\\read-neg", written, bytes.byteLength);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(NativePrivatePersistenceError);
      expect(getKMutationFailure(thrown)).toBeUndefined();
      expect(getKReserveFailure(thrown)).toBeUndefined();
    });

    it("marks malformed dispatch evidence as DISPATCHED/MUTATION_EXEC with retained capture", () => {
      const { journal, directory } = journalFixture("dispatch-malformed");
      const f = transportFixture(journal);
      f.malformed();
      const bytes = Buffer.from("malformed-dispatch");
      const first = writeFailure(f, DIR + "\\dispatch-malformed", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:FRAME");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "FRAME" });
      expect(failure!.mutationDispatch).toBe("DISPATCHED");
      expect(failure!.uncertainty).toEqual({ stage: "DISPATCH", origin: "MUTATION_EXEC" });
      expect(failure!.capacityRefusal).toBeUndefined();
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "status", "stderr", "stdout", "wire"]);
      expectBlobs(snapshot, failure!.attemptId, bytes);
      expect(Buffer.from(snapshot.blobs.get("stdout")!.bytes).equals(Buffer.from(f.captures[0]))).toBe(true);
      expect(snapshot.blobs.get("stderr")!.bytes.byteLength).toBe(0);
      for (const kind of ["stdout", "stderr", "status"] as const)
        expect(snapshot.blobs.get(kind)!.sha).toBe(hash(snapshot.blobs.get(kind)!.bytes));
      expect(snapshot.terminal?.state).toBe("UNKNOWN");
      expect(snapshot.terminal!.receipt).toEqual({
        attemptId: failure!.attemptId, state: "UNKNOWN", phase: "write-new", malformed: true,
      });
      expect(f.events).toEqual(["reserve", "exec", "capture", "UNKNOWN"]);
    });

    it("marks an exec-level fault as DISPATCHED/MUTATION_EXEC", () => {
      const execFault = new Error("injected exec fault");
      const { journal, directory } = journalFixture("exec-fault");
      const f = transportFixture(journal, { execImpl: () => { throw execFault; } });
      const bytes = Buffer.from("exec-fault");
      const first = writeFailure(f, DIR + "\\exec-fault", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:DISPATCH");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "DISPATCH" });
      expect(failure!.mutationDispatch).toBe("DISPATCHED");
      expect(failure!.uncertainty).toEqual({ stage: "DISPATCH", origin: "MUTATION_EXEC" });
      expect(failure!.capacityRefusal).toBeUndefined();
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "status", "stderr", "stdout", "wire"]);
      expectBlobs(snapshot, failure!.attemptId, bytes);
      for (const kind of ["stdout", "stderr", "status"] as const) {
        expect(snapshot.blobs.get(kind)!.bytes.byteLength).toBeGreaterThanOrEqual(0);
        expect(snapshot.blobs.get(kind)!.sha).toBe(hash(snapshot.blobs.get(kind)!.bytes));
      }
      expect(snapshot.terminal?.state).toBe("UNKNOWN");
      expect(snapshot.terminal!.receipt).toEqual({
        attemptId: failure!.attemptId, state: "UNKNOWN", phase: "dispatch", malformed: true,
      });
      expect(f.events).toEqual(["reserve", "exec", "capture", "UNKNOWN"]);
    });

    it("retains typed REJECTED and EXISTS outcomes as DISPATCHED without capacity", () => {
      const { journal, directory } = journalFixture("dispatch-typed");
      const f = transportFixture(journal);
      const bytes = Buffer.from("typed-exists");
      f.port.writeNew(DIR + "\\typed", bytes, bytes.byteLength);
      const existsError = writeFailure(f, DIR + "\\typed", bytes);
      expect(existsError.state).toBe("EXISTS");
      const existsFailure = getKMutationFailure(existsError);
      expect(existsFailure).toBeDefined();
      expect(existsFailure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "EXISTS", reason: "PRIVATE_PERSISTENCE_EXISTS" });
      expect(existsFailure!.mutationDispatch).toBe("DISPATCHED");
      expect(existsFailure!.capacityRefusal).toBeUndefined();
      const missing = { path: DIR + "\\typed-missing", fileId: "6".repeat(32), volumeId: VOLUME,
        bytes: 0, sha256: hash(new Uint8Array()) };
      let rejectedThrown: unknown;
      try {
        f.port.unlinkExact(DIR + "\\typed-missing", missing, 4);
      } catch (error) {
        rejectedThrown = error;
      }
      expect(rejectedThrown).toBeInstanceOf(NativePrivatePersistenceError);
      const rejectedError = rejectedThrown as NativePrivatePersistenceError;
      expect(rejectedError.state).toBe("REJECTED");
      const rejectedFailure = getKMutationFailure(rejectedError);
      expect(rejectedFailure).toBeDefined();
      expect(rejectedFailure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "REJECTED", reason: "PRIVATE_PERSISTENCE_REJECTED" });
      expect(rejectedFailure!.mutationDispatch).toBe("DISPATCHED");
      expect(rejectedFailure!.capacityRefusal).toBeUndefined();
      const existsSnapshot = attemptSnapshot(directory, existsFailure!.attemptId);
      expect(existsSnapshot.terminal?.state).toBe("UNKNOWN");
      expect(existsSnapshot.terminal!.receipt.state).toBe("UNKNOWN");
      expect((existsSnapshot.terminal!.receipt.reply as { state: string; reason: string; attemptId: string }).state).toBe("EXISTS");
      expect((existsSnapshot.terminal!.receipt.reply as { state: string; reason: string; attemptId: string }).reason).toBe("PRIVATE_PERSISTENCE_EXISTS");
      expect((existsSnapshot.terminal!.receipt.reply as { state: string; reason: string; attemptId: string }).attemptId).toBe(existsFailure!.attemptId);
      const rejectedSnapshot = attemptSnapshot(directory, rejectedFailure!.attemptId);
      expect(rejectedSnapshot.terminal?.state).toBe("UNKNOWN");
      expect((rejectedSnapshot.terminal!.receipt.reply as { state: string; reason: string }).state).toBe("REJECTED");
      expect((rejectedSnapshot.terminal!.receipt.reply as { state: string; reason: string }).reason).toBe("PRIVATE_PERSISTENCE_REJECTED");
    });

    it("marks a non-void capture acknowledgement as CAPTURE/NON_VOID_ACK with retained evidence", () => {
      const { journal, directory } = journalFixture("capture-nonvoid");
      const authority: NativePrivatePersistenceAuthority = {
        version: 1, independent: true,
        assertCurrent() { journal.assertCurrent(); },
        reserve(intent) { journal.reserve(intent); },
        capture(id, capture) { journal.capture(id, capture); return 42 as unknown as void; },
        terminal(id, state, receipt) { journal.terminal(id, state, receipt); },
      };
      const f = transportFixture(authority);
      const bytes = Buffer.from("capture-nonvoid");
      const first = writeFailure(f, DIR + "\\capture-nonvoid", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:CAPTURE");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "CAPTURE" });
      expect(failure!.mutationDispatch).toBe("DISPATCHED");
      expect(failure!.uncertainty).toEqual({ stage: "CAPTURE", origin: "NON_VOID_ACK" });
      expect(failure!.capacityRefusal).toBeUndefined();
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "status", "stderr", "stdout", "wire"]);
      expect(snapshot.terminal).toBeUndefined();
      const second = writeFailure(f, DIR + "\\capture-nonvoid-second", bytes);
      expect(second.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKMutationFailure(second)).toBeUndefined();
    });

    it("marks a capture acknowledgement throw as DISPATCHED/MUTATION_EXEC with the exact cause", () => {
      const { journal, directory } = journalFixture("capture-throw");
      const captureFault = new Error("injected capture acknowledgement fault");
      const authority: NativePrivatePersistenceAuthority = {
        version: 1, independent: true,
        assertCurrent() { journal.assertCurrent(); },
        reserve(intent) { journal.reserve(intent); },
        capture(id, capture) { journal.capture(id, capture); throw captureFault; },
        terminal(id, state, receipt) { journal.terminal(id, state, receipt); },
      };
      const f = transportFixture(authority);
      const bytes = Buffer.from("capture-throw");
      const first = writeFailure(f, DIR + "\\capture-throw", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:CAPTURE");
      expect((first as Error & { cause?: unknown }).cause).toBe(captureFault);
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.mutationDispatch).toBe("DISPATCHED");
      expect(failure!.uncertainty).toEqual({ stage: "DISPATCH", origin: "MUTATION_EXEC" });
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "status", "stderr", "stdout", "wire"]);
      const second = writeFailure(f, DIR + "\\capture-throw-second", bytes);
      expect(second.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
    });

    it("marks a non-void terminal acknowledgement as TERMINAL/NON_VOID_ACK with the APPLIED terminal retained", () => {
      const { journal, directory } = journalFixture("terminal-nonvoid");
      const authority: NativePrivatePersistenceAuthority = {
        version: 1, independent: true,
        assertCurrent() { journal.assertCurrent(); },
        reserve(intent) { journal.reserve(intent); },
        capture(id, capture) { journal.capture(id, capture); },
        terminal(id, state, receipt) { journal.terminal(id, state, receipt); return 42 as unknown as void; },
      };
      const f = transportFixture(authority);
      const bytes = Buffer.from("terminal-nonvoid");
      const first = writeFailure(f, DIR + "\\terminal-nonvoid", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:TERMINAL");
      const failure = getKMutationFailure(first);
      expect(failure).toBeDefined();
      expect(failure!.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "TERMINAL" });
      expect(failure!.mutationDispatch).toBe("DISPATCHED");
      expect(failure!.uncertainty).toEqual({ stage: "TERMINAL", origin: "NON_VOID_ACK" });
      expect(failure!.capacityRefusal).toBeUndefined();
      const snapshot = attemptSnapshot(directory, failure!.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.terminal?.state).toBe("APPLIED");
      const second = writeFailure(f, DIR + "\\terminal-nonvoid-second", bytes);
      expect(second.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKMutationFailure(second)).toBeUndefined();
    });

    it("marks a non-void UNKNOWN terminal as TERMINAL/NON_VOID_ACK when the pin blocks dispatch", () => {
      const { journal, directory } = journalFixture("terminal-nonvoid-pin");
      const authority: NativePrivatePersistenceAuthority = {
        version: 1, independent: true,
        assertCurrent() { journal.assertCurrent(); },
        reserve(intent) { journal.reserve(intent); },
        capture(id, capture) { journal.capture(id, capture); },
        terminal(id, state, receipt) { journal.terminal(id, state, receipt); return 42 as unknown as void; },
      };
      const f = transportFixture(authority, { mutatePinAfterReserve: true });
      const bytes = Buffer.from("pin-nonvoid-terminal");
      const first = writeFailure(f, DIR + "\\pin-nonvoid-terminal", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:DISPATCH");
      const failure = getKMutationFailure(first)!;
      expect(failure.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "DISPATCH" });
      expect(failure.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure.uncertainty).toEqual({ stage: "TERMINAL", origin: "NON_VOID_ACK" });
      expect(failure.capacityRefusal).toBeUndefined();
      const snapshot = attemptSnapshot(directory, failure.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "status", "stderr", "stdout", "wire"]);
      expectBlobs(snapshot, failure.attemptId, bytes);
      expect(snapshot.blobs.get("stdout")!.bytes.byteLength).toBe(0);
      expect(snapshot.terminal?.state).toBe("UNKNOWN");
      expect(snapshot.terminal!.receipt).toEqual({
        attemptId: failure.attemptId, state: "UNKNOWN", phase: "dispatch", malformed: true,
      });
      const second = writeFailure(f, DIR + "\\pin-nonvoid-terminal-second", bytes);
      expect(second.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKMutationFailure(second)).toBeUndefined();
      expect(f.events.filter(event => event === "exec")).toEqual([]);
    });

    it("marks a non-void UNKNOWN terminal as TERMINAL/NON_VOID_ACK when a dispatch phase refusal stops exec", () => {
      const { journal, directory } = journalFixture("terminal-nonvoid-dispatch-phase");
      const authority: NativePrivatePersistenceAuthority = {
        version: 1, independent: true,
        assertCurrent() { journal.assertCurrent(); },
        reserve(intent) { journal.reserve(intent); },
        capture(id, capture) { journal.capture(id, capture); },
        terminal(id, state, receipt) { journal.terminal(id, state, receipt); return 42 as unknown as void; },
      };
      const f = transportFixture(authority);
      const source = DIR + "\\terminal-nonvoid-src", destination = DIR + "\\terminal-nonvoid-dst";
      f.trees.set(source, { id: "6".repeat(32), entries: 1, bytes: 0, sha256: hash(Buffer.from("root")) });
      const tree = f.port.inspectTree!(source);
      f.events.length = 0;
      const refusal = new Error("dispatch phase refusal");
      let first: unknown;
      try {
        f.port.renameDirectoryNew!(source, destination, tree, phase => {
          if (phase === "dispatch") throw refusal;
        });
      } catch (error) {
        first = error;
      }
      const firstError = first as NativePrivatePersistenceError;
      expect(firstError.state).toBe("UNKNOWN");
      expect(firstError.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:REVALIDATE");
      const cause = (firstError as Error & { cause?: unknown }).cause;
      expect(cause).toBeDefined();
      expect((cause as Error).message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REVALIDATE");
      expect((cause as Error & { cause?: unknown }).cause).toBe(refusal);
      const failure = getKMutationFailure(firstError)!;
      expect(failure.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "REVALIDATE" });
      expect(failure.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(failure.uncertainty).toEqual({ stage: "TERMINAL", origin: "NON_VOID_ACK" });
      expect(failure.capacityRefusal).toBeUndefined();
      expect(f.events).toEqual(["reserve", "UNKNOWN"]);
      const snapshot = attemptSnapshot(directory, failure.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "wire"]);
      expectBlobs(snapshot, failure.attemptId, Buffer.alloc(0));
      expect(snapshot.terminal?.state).toBe("UNKNOWN");
      expect(snapshot.terminal!.receipt).toEqual({
        attemptId: failure.attemptId, state: "UNKNOWN", phase: "pre-dispatch",
      });
    });

    it("records a real DATA_CAPACITY refusal as current factory evidence without uncertainty or dispatch", () => {
      const fixture = dataCancellationFixture();
      const f = transportFixture(fixture.journal);
      const payload = Buffer.alloc(20_000_000);
      const first = writeFailure(f, DIR + "\\capacity-current-candidate", payload);
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      const cause = (first as Error & { cause?: unknown }).cause;
      const refusal = getKCapacityRefusal(cause);
      expect(refusal).toBeDefined();
      expect(refusal!.sourceCauseCodes).toEqual(["PRIVATE_PERSISTENCE_JOURNAL_DATA_CAPACITY"]);
      const failure = getKMutationFailure(first)!;
      expect(failure.attemptId).toMatch(/^[0-9a-f]{32}$/);
      expect(failure.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure.capacityRefusal).toBe(refusal);
      expect(failure.uncertainty).toBeUndefined();
      expect(failure.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(getKReserveFailure(first)!.capacityRefusal).toBe(refusal);
      expect(fixture.readSnapshot()).toEqual(fixture.baseline);
      const candidate = attemptSnapshot(fixture.directory, failure.attemptId);
      expect(candidate.attempts).toBe(0);
      expect(candidate.kinds).toEqual([]);
      expect(f.events).toEqual(["reserve"]);
    });

    it("rejects a reused old guard uncertainty error thrown from a different healthy journal", () => {
      const { journal: journalA } = journalFixture("old-guard-source");
      const guardA = guardOf(journalA);
      const boundExecA = guardA.db.exec.bind(guardA.db);
      vi.spyOn(guardA.db, "exec").mockImplementation(((sql: string) => {
        const result = boundExecA(sql);
        if (sql === "COMMIT") throw new Error("old journal commit fault");
        return result;
      }) as typeof guardA.db.exec);
      let oldCause: unknown;
      const oldId = "a".repeat(32), oldBytes = Buffer.from("old-source");
      try {
        journalA.reserve({
          attemptId: oldId, targetKey: oldId,
          wire: frame({ attemptId: oldId, path: DIR + "\\old-src" }, oldBytes),
          payload: oldBytes, maxCaptureBytes: 0,
        });
      } catch (error) {
        oldCause = error;
      }
      expect(oldCause).toBeDefined();
      expect(guardA.isUncertainFailure(oldCause)).toBe(true);

      const { journal: journalB, directory: directoryB } = journalFixture("old-guard-healthy");
      const guardB = guardOf(journalB);
      vi.spyOn(journalB as unknown as { put(id: string, kind: string, bytes: Uint8Array): void }, "put")
        .mockImplementationOnce(() => { throw oldCause; });
      const f = transportFixture(journalB);
      const bytes = Buffer.from("old-guard-candidate");
      const first = writeFailure(f, DIR + "\\old-guard-candidate", bytes);
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      expect((first as Error & { cause?: unknown }).cause).toBe(oldCause);
      const failure = getKMutationFailure(first)!;
      expect(failure.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure.uncertainty).toBeUndefined();
      expect(failure.capacityRefusal).toBeUndefined();
      expect(failure.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(guardB.isUncertainFailure(oldCause)).toBe(false);
      expect(f.events).toEqual(["reserve"]);
      const snapshot = attemptSnapshot(directoryB, failure.attemptId);
      expect(snapshot.attempts).toBe(0);
      expect(snapshot.kinds).toEqual([]);
    });

    it("marks a post-commit current-check failure as RESERVE/JOURNAL_READBACK", () => {
      const readbackFault = new Error("post-commit current fault");
      const { journal, directory } = journalFixture("committed-readback", {
        afterCommit: () => { throw readbackFault; },
      });
      const guard = guardOf(journal);
      const f = transportFixture(journal);
      const bytes = Buffer.from("committed-readback");
      const first = writeFailure(f, DIR + "\\committed-readback", bytes);
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      const cause = (first as Error & { cause?: unknown }).cause;
      expect(cause).toBe(readbackFault);
      const failure = getKMutationFailure(first)!;
      expect(failure.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure.uncertainty).toEqual({ stage: "RESERVE", origin: "JOURNAL_READBACK" });
      expect(failure.capacityRefusal).toBeUndefined();
      expect(failure.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(guard.isUncertainFailure(cause)).toBe(false);
      expect(f.events).toEqual(["reserve"]);
      const snapshot = attemptSnapshot(directory, failure.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "wire"]);
      expectBlobs(snapshot, failure.attemptId, bytes);
      expect(snapshot.terminal).toBeUndefined();
    });

    it("does not mint current facts when a real intent is replayed through the same request", () => {
      const { journal } = journalFixture("replay-intent");
      for (let i = 0; i < 40; i++) {
        const id = (i + 1).toString(16).padStart(32, "0"), path = DIR + "\\replay-prior-" + i;
        const original = Buffer.from("replay-prior-" + i);
        journal.reserve({ attemptId: id, targetKey: id, wire: frame({ attemptId: id, path }, original), payload: original, maxCaptureBytes: 0 });
      }
      let firstThrow: unknown;
      const authority: NativePrivatePersistenceAuthority = {
        version: 1, independent: true,
        assertCurrent() { journal.assertCurrent(); },
        reserve(intent) {
          try {
            journal.reserve(intent);
          } catch (error) {
            firstThrow = error;
            try { journal.reserve(intent); } catch { }
            throw error;
          }
        },
        capture(id, capture) { journal.capture(id, capture); },
        terminal(id, state, receipt) { journal.terminal(id, state, receipt); },
      };
      const f = transportFixture(authority);
      const first = writeFailure(f, DIR + "\\replay-candidate", Buffer.from("candidate"));
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:RESERVE");
      const cause = (first as Error & { cause?: unknown }).cause;
      expect(cause).toBe(firstThrow);
      const refusal = getKCapacityRefusal(firstThrow);
      expect(refusal).toBeDefined();
      const failure = getKMutationFailure(first)!;
      expect(failure.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "RESERVE" });
      expect(failure.capacityRefusal).toBeUndefined();
      expect(failure.uncertainty).toBeUndefined();
      expect(failure.mutationDispatch).toBe("NOT_DISPATCHED_PROVEN");
      expect(getKReserveFailure(first)!.capacityRefusal).toBe(refusal);
    });

    it("marks a malformed non-void exec result as DISPATCHED/MUTATION_EXEC", () => {
      const { journal, directory } = journalFixture("exec-nonvoid-malformed");
      const f = transportFixture(journal, {
        execImpl: (() => 42) as unknown as WindowsPrivatePersistenceTestPort["exec"],
      });
      const bytes = Buffer.from("exec-nonvoid");
      const first = writeFailure(f, DIR + "\\exec-nonvoid", bytes);
      expect(first.state).toBe("UNKNOWN");
      expect(first.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:DISPATCH");
      const failure = getKMutationFailure(first)!;
      expect(failure.sourceOutcome).toEqual({ source: "K_EXCEPTION", state: "UNKNOWN", reason: "DISPATCH" });
      expect(failure.mutationDispatch).toBe("DISPATCHED");
      expect(failure.uncertainty).toEqual({ stage: "DISPATCH", origin: "MUTATION_EXEC" });
      expect(failure.capacityRefusal).toBeUndefined();
      const snapshot = attemptSnapshot(directory, failure.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "status", "stderr", "stdout", "wire"]);
      expectBlobs(snapshot, failure.attemptId, bytes);
      expect(snapshot.blobs.get("stdout")!.bytes.byteLength).toBe(0);
      expect(snapshot.terminal?.state).toBe("UNKNOWN");
      expect(snapshot.terminal!.receipt).toEqual({
        attemptId: failure.attemptId, state: "UNKNOWN", phase: "dispatch", malformed: true,
      });
      expect(f.events).toEqual(["reserve", "exec", "capture", "UNKNOWN"]);
    });

    it.each(["capture", "applied-terminal", "unknown-terminal"] as const)("F-01 keeps a hostile fulfilled %s acknowledgement observed before Promise monitoring throws", phase => {
      const marker = new Error("hostile " + phase + " acknowledgement");
      const getterCounts = { constructor: 0 };
      const hostile = (): unknown => {
        const acknowledgement = Promise.resolve();
        Object.defineProperty(acknowledgement, "constructor", {
          get() { getterCounts.constructor += 1; throw marker; },
        });
        return acknowledgement;
      };
      const { journal, directory } = journalFixture("f01-" + phase);
      const authority: NativePrivatePersistenceAuthority = {
        version: 1, independent: true,
        assertCurrent() { journal.assertCurrent(); },
        reserve(intent) { journal.reserve(intent); },
        capture(id, capture) { journal.capture(id, capture); if (phase === "capture") return hostile() as void; },
        terminal(id, state, receipt) {
          journal.terminal(id, state, receipt);
          if ((phase === "applied-terminal" && state === "APPLIED") ||
              (phase === "unknown-terminal" && state === "UNKNOWN")) return hostile() as void;
        },
      };
      const f = transportFixture(authority, phase === "unknown-terminal" ? { mutatePinAfterReserve: true } : undefined);
      const bytes = Buffer.from("f01-" + phase);
      const first = writeFailure(f, DIR + "\\f01-" + phase, bytes);
      expect(first.state).toBe("UNKNOWN");
      expect((first as Error & { cause?: unknown }).cause).toBe(marker);
      const failure = getKMutationFailure(first)!;
      expect(failure.sourceOutcome).toEqual({
        source: "K_EXCEPTION", state: "UNKNOWN",
        reason: phase === "capture" ? "CAPTURE" : phase === "applied-terminal" ? "TERMINAL" : "DISPATCH",
      });
      expect(failure.mutationDispatch).toBe(phase === "unknown-terminal" ? "NOT_DISPATCHED_PROVEN" : "DISPATCHED");
      expect(failure.capacityRefusal).toBeUndefined();
      const snapshot = attemptSnapshot(directory, failure.attemptId);
      expect(snapshot.attempts).toBe(1);
      expect(snapshot.kinds).toEqual(["original", "status", "stderr", "stdout", "wire"]);
      expectBlobs(snapshot, failure.attemptId, bytes);
      for (const kind of ["stdout", "stderr", "status"] as const)
        expect(snapshot.blobs.get(kind)!.sha).toBe(hash(snapshot.blobs.get(kind)!.bytes));
      if (phase === "capture") {
        expect(snapshot.blobs.get("stdout")!.bytes.byteLength).toBeGreaterThan(0);
        expect(snapshot.terminal).toBeUndefined();
        expect(f.events).toEqual(["reserve", "exec", "capture"]);
      } else if (phase === "applied-terminal") {
        expect(snapshot.terminal?.state).toBe("APPLIED");
        expect(snapshot.terminal!.receipt.attemptId).toBe(failure.attemptId);
        expect(snapshot.terminal!.receipt.status).toBe(0);
        expect(f.events).toEqual(["reserve", "exec", "capture", "APPLIED"]);
      } else {
        expect(snapshot.blobs.get("stdout")!.bytes.byteLength).toBe(0);
        expect(snapshot.terminal?.state).toBe("UNKNOWN");
        expect(snapshot.terminal!.receipt).toEqual({
          attemptId: failure.attemptId, state: "UNKNOWN", phase: "dispatch", malformed: true,
        });
        expect(f.events).toEqual(["reserve", "capture", "UNKNOWN"]);
      }
      expect(getterCounts).toEqual({ constructor: 1 });
      const second = writeFailure(f, DIR + "\\f01-" + phase + "-second", bytes);
      expect(second.message).toBe("WINDOWS_PRIVATE_PERSISTENCE_REJECTED:BUSY");
      expect(getKMutationFailure(second)).toBeUndefined();
      expect(getterCounts).toEqual({ constructor: 1 });
      if (phase === "capture") expect(f.events).toEqual(["reserve", "exec", "capture"]);
      else if (phase === "applied-terminal") expect(f.events).toEqual(["reserve", "exec", "capture", "APPLIED"]);
      else expect(f.events).toEqual(["reserve", "capture", "UNKNOWN"]);
      expect(failure.uncertainty).toEqual({
        stage: phase === "capture" ? "CAPTURE" : "TERMINAL", origin: "NON_VOID_ACK",
      });
    });
  });

});

describe("K operation proof retains native reader failure identity (contract only)", () => {
  it.each((["reserve", "dispatch", "success"] as const).flatMap(refused => [false, true].map(closedFirst => ({refused, closedFirst}))))("preserves ownership through $refused proof mapping (closed first=$closedFirst)", ({refused, closedFirst}) => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "folio-K-reader-cause-"))); roots.push(root);
    const path = join(root, "proof.sqlite"), seed = new DatabaseSync(path); seed.exec("CREATE TABLE proof(value)"); seed.close();
    const f = transportFixture(), source = DIR + "\\source", destination = DIR + "\\destination";
    const tree = {path: source, fileId: "8".repeat(32), volumeId: VOLUME, entries: 1, bytes: 0, sha256: hash(Buffer.alloc(0))};
    f.trees.set(source, {id: tree.fileId, entries: 1, bytes: 0, sha256: tree.sha256});
    let captured: DatabaseSync | undefined, releases = 0;
    const native = {inspectFileIdentity: () => ({path, fileId: "9".repeat(32), volumeId: VOLUME}),
      acquireSqliteLease: () => ({assertHeld() {}, close() {expect(captured?.isOpen).toBe(false); releases++;}})} as unknown as NativePrivateFilesystemPort;
    const original = DatabaseSync.prototype.close, sentinel = new Error("phase reader close fault");
    const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(function(this: DatabaseSync) {
      captured = this; if (closedFirst) original.call(this); throw sentinel;
    });
    let failure: unknown;
    try {f.port.renameDirectoryNew!(source, destination, tree, phase => {if (phase === refused) withNativeSqliteReader(path, native, db => {db.prepare("SELECT * FROM proof").all();});});}
    catch (error) {failure = error;}
    try {
      if (refused === "reserve") expect((failure as {code: string}).code).toBe("WINDOWS_PRIVATE_PERSISTENCE_REVALIDATE");
      else expect((failure as Error).message).toContain("WINDOWS_PRIVATE_PERSISTENCE_UNKNOWN:");
      expect(startupRetainsNativeLease(failure)).toBe(!closedFirst);
      expect(releases).toBe(closedFirst ? 1 : 0); expect(closeSpy).toHaveBeenCalledOnce();
      expect(f.events.filter(e => e === "reserve")).toHaveLength(refused === "reserve" ? 0 : 1);
      expect(f.events.filter(e => e === "exec")).toHaveLength(refused === "success" ? 1 : 0);
      expect(captured?.isOpen).toBe(!closedFirst);
    } finally {closeSpy.mockRestore(); if (captured?.isOpen) original.call(captured);}
  });
});
