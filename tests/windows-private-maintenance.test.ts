import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PosixPrivatePlatform } from "../src/sync/private-platform";
import { WindowsPrivatePersistenceJournal, type WindowsPrivateMaintenanceContext,
  type WindowsPrivatePersistenceMaintenanceProof } from "../src/platform/windows/private-persistence-journal";
import { executePrivateMaintenance, filesystemMaintenancePort, parsePrivateMaintenanceArguments, runPrivateMaintenanceCli,
  type PrivateMaintenanceSession } from "../src/platform/windows/private-maintenance-cli";

const ROOT = "C:\\Folio", WORKSPACE = ROOT + "\\workspace", FILE = WORKSPACE + "\\target.bin";
const RID = "1".repeat(32), DID = "2".repeat(32), FID = "3".repeat(32), VOLUME = "4".repeat(16), ID = "a".repeat(32);
const SID = "S-1-5-21-1000";
const hash = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const directories: string[] = [], journals: WindowsPrivatePersistenceJournal[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});
function frame(header: object, payload: Uint8Array = new Uint8Array()) {
  const json = Buffer.from(JSON.stringify(header), "ascii"), bytes = Buffer.alloc(4 + json.length + payload.length);
  bytes.writeUInt32LE(json.length); json.copy(bytes, 4); bytes.set(payload, 4 + json.length); return bytes;
}
function native(path: string, fileId: string) {
  return {platform: "win32", sid: SID, ownerSid: SID, daclPrivate: true, reparsePoint: false, linkCount: 1,
    localFilesystem: true, fileId, volumeId: VOLUME, rootFileId: RID, rootVolumeId: VOLUME, canonicalPath: path, canonicalRoot: ROOT};
}
function fixture(operation = "write-new", captured = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "folio-maintenance-contract-")));
  chmodSync(directory, 0o700); directories.push(directory);
  const open = () => {
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(),
      "immutable-original-native-binding", () => {}, [join(directory, "..", "unrelated-workspace")]);
    journals.push(journal); return journal;
  };
  let journal = open();
  const original = operation === "write-new" ? Buffer.from([0, 255, 128, 13, 10, 65]) : Buffer.alloc(0);
  const sourceBytes = Buffer.from([0, 255, 128, 13, 10, 65]);
  const source = WORKSPACE + "\\source.bin";
  const isRename = operation === "rename-new" || operation === "rename-directory-new";
  const transfer = isRename || operation === "copy-new";
  const header = {contractVersion: 4, operation, attemptId: ID, path: transfer ? source : FILE, root: ROOT,
    rootFileId: RID, rootVolumeId: VOLUME, directoryFileId: DID, directoryVolumeId: VOLUME,
    byteLength: sourceBytes.length, maxBytes: 1024,
    ...(transfer ? {destination: FILE, destinationDirectoryFileId: DID, destinationDirectoryVolumeId: VOLUME,
      sourceFileId: FID, sourceVolumeId: VOLUME, sourceSha256: hash(sourceBytes),
      ...(operation === "rename-directory-new" ? {entries: 2} : {})} :
      operation === "write-new" ? {sha256: hash(original)} : {fileId: FID, volumeId: VOLUME, expectedSha256: hash(sourceBytes)})};
  const wire = frame(header, original);
  journal.reserve({attemptId: ID, targetKey: "target:immutable", wire, payload: original, maxCaptureBytes: 8192});
  const stdout = captured ? frame({contractVersion: 4, operation, attemptId: ID, path: header.path, root: ROOT,
    state: "APPLIED", filesystem: "NTFS", byteLength: sourceBytes.length,
    file: native(FILE, FID), directory: native(WORKSPACE, DID), sha256: hash(sourceBytes),
    ...(transfer ? {sourceDirectory: native(WORKSPACE, DID), destination: FILE} : {}),
    ...(operation === "unlink-exact" ? {unlinked: true} :
      {contentFlushed: true, durability: {profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH"}})},
  operation === "write-new" ? original : new Uint8Array()) : Buffer.alloc(0);
  journal.capture(ID, {stdout, stderr: Buffer.alloc(0), status: 0, signal: null});
  const terminal = '{"state":"UNKNOWN","reason":"after-native-ack-cut"}';
  journal.terminal(ID, "UNKNOWN", terminal);
  const context: WindowsPrivateMaintenanceContext = {workspace: WORKSPACE, workspaceId: "workspace-1",
    workspaceFingerprint: "5".repeat(64), writerId: "writer-current", sessionId: "session-current", osSid: SID};
  let fileId = FID, absent = true, current = true;
  const calls: string[] = [];
  const proof: WindowsPrivatePersistenceMaintenanceProof = {
    assertCurrent(actual) { calls.push("current"); expect(actual).toEqual(context); if (!current) throw new Error("authority/session/cut changed"); },
    directory(path) { calls.push("directory"); return {path, fileId: path === ROOT ? RID : DID, volumeId: VOLUME}; },
    file(path) { calls.push("file"); return {path, fileId, volumeId: VOLUME, bytes: sourceBytes.length, sha256: hash(sourceBytes)}; },
    tree(path) { calls.push("tree"); return {path, fileId, volumeId: VOLUME, bytes: sourceBytes.length, sha256: hash(sourceBytes), entries: 2}; },
    missing(path, parent) {
      calls.push("native-ABSENT");
      if (!absent) throw new Error("native-EXISTS");
      return {contractVersion: 3, state: "ABSENT", path, directory: parent};
    },
  };
  return {get journal() {return journal;}, context, proof, wire, original, stdout, terminal, calls,
    reopen() {journal.close(); journal = open(); return journal;},
    staleId() {fileId = "f".repeat(32);}, sourcePresent() {absent = false;}, changeCurrent() {current = false;}};
}
describe("private maintenance — real SQLite with labelled synthetic native contract driver", () => {
  it("inspects and explicitly resolves across restart, retaining exact original wire/captures and UNKNOWN terminal", () => {
    const f = fixture(); f.reopen();
    const before = f.journal.inspect(ID);
    const result = f.journal.investigate({attemptId: ID, fingerprint: before.fingerprint, context: f.context}, f.proof);
    expect(JSON.parse(result.resolution!).state).toBe("APPLIED_OBSERVED");
    expect(result.terminal).toEqual({state: "UNKNOWN", receipt: f.terminal});
    f.reopen();
    const after = f.journal.inspect(ID);
    expect(Buffer.from(after.original)).toEqual(f.original);
    expect(Buffer.from(after.wire)).toEqual(f.wire);
    expect(Buffer.from(after.captures.stdout!)).toEqual(f.stdout);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.resolution).toBe(result.resolution);
    expect(() => f.journal.capture(ID, {stdout: new Uint8Array(), stderr: new Uint8Array(), status: 0, signal: null})).toThrow(/NOT_OWNER/);
    expect(() => f.journal.investigate({attemptId: ID, fingerprint: before.fingerprint, context: f.context}, f.proof)).toThrow(/CONFLICT/);
  });
  it("keeps lost empty captures UNKNOWN even when current output bytes match, blocking ancestor overlap after restart", () => {
    const f = fixture("write-new", false); f.reopen();
    const before = f.journal.inspect(ID);
    expect(() => f.journal.investigate({attemptId: ID, fingerprint: before.fingerprint, context: f.context}, f.proof)).toThrow(/UNKNOWN_UNRESOLVABLE/);
    expect(f.journal.inspect(ID).resolution).toBeNull();
    const id = "b".repeat(32), wire = frame({contractVersion: 4, attemptId: id, path: WORKSPACE, operation: "write-new"});
    expect(() => f.journal.reserve({attemptId: id, targetKey: "ancestor", wire, payload: new Uint8Array(), maxCaptureBytes: 8192})).toThrow(/UNRESOLVED/);
    f.reopen();
    expect(Buffer.from(f.journal.inspect(ID).wire)).toEqual(f.wire);
  });
  it.each(["rename-new", "rename-directory-new"])("resolves %s from immutable source ID/hash plus destination proof and genuine native ABSENT", operation => {
    const f = fixture(operation, false); f.reopen();
    const before = f.journal.inspect(ID);
    const result = f.journal.investigate({attemptId: ID, fingerprint: before.fingerprint, context: f.context}, f.proof);
    expect(result.resolution).toContain("APPLIED_OBSERVED");
    expect(f.calls.filter(call => call === "native-ABSENT")).toHaveLength(2);
  });
  it("does not resolve a rename whose source still exists", () => {
    const f = fixture("rename-new", false); f.sourcePresent();
    expect(() => f.journal.investigate({attemptId: ID, fingerprint: f.journal.inspect(ID).fingerprint, context: f.context}, f.proof)).toThrow(/native-EXISTS/);
    expect(f.journal.inspect(ID).resolution).toBeNull();
  });
  it.each(["unlink-exact", "prove-sync"])("%s cannot be inferred from absence or a current matching hash without original ACK", operation => {
    const f = fixture(operation, false);
    expect(() => f.journal.investigate({attemptId: ID, fingerprint: f.journal.inspect(ID).fingerprint, context: f.context}, f.proof)).toThrow(/UNKNOWN_UNRESOLVABLE/);
    expect(f.journal.inspect(ID).resolution).toBeNull();
  });
  it.each(["copy-new", "prove-sync", "unlink-exact"])("resolves %s with an original valid native ACK and matching current evidence", operation => {
    const f = fixture(operation); f.reopen();
    const result = f.journal.investigate({attemptId: ID, fingerprint: f.journal.inspect(ID).fingerprint, context: f.context}, f.proof);
    expect(result.resolution).toContain("APPLIED_OBSERVED");
    expect(result.terminal?.state).toBe("UNKNOWN");
  });
  it("rejects stale output native ID despite equal bytes and preserves the original evidence", () => {
    const f = fixture(); f.staleId();
    const before = f.journal.inspect(ID);
    expect(() => f.journal.investigate({attemptId: ID, fingerprint: before.fingerprint, context: f.context}, f.proof)).toThrow(/UNKNOWN_UNRESOLVABLE/);
    expect(f.journal.inspect(ID)).toEqual(before);
  });
  it("rejects async authorization before append and does not invoke it", () => {
    const f = fixture();
    let calls = 0;
    const callback = async () => {calls++;};
    expect(() => f.journal.investigate({attemptId: ID, fingerprint: f.journal.inspect(ID).fingerprint, context: f.context},
      {...f.proof, assertCurrent: callback})).toThrow(/ASYNC/);
    expect(calls).toBe(0);
    expect(f.journal.inspect(ID).resolution).toBeNull();
  });
  it.each(["session", "cut", "workspace", "authority"])("rechecks %s inside the CAS and rolls back the append on change", label => {
    const f = fixture(), before = f.journal.inspect(ID);
    let calls = 0;
    const proof = {...f.proof, assertCurrent(c: WindowsPrivateMaintenanceContext) {
      calls++; if (calls === 3) throw new Error(label + "-changed"); f.proof.assertCurrent(c);
    }};
    expect(() => f.journal.investigate({attemptId: ID, fingerprint: before.fingerprint, context: f.context}, proof)).toThrow(label + "-changed");
    f.reopen();
    expect(f.journal.inspect(ID).resolution).toBeNull();
    expect(f.journal.inspect(ID).fingerprint).toBe(before.fingerprint);
  });
  it("rejects stale immutable fingerprint before native inspection", () => {
    const f = fixture();
    expect(() => f.journal.investigate({attemptId: ID, fingerprint: "0".repeat(64), context: f.context}, f.proof)).toThrow(/CONFLICT/);
    expect(f.calls).toEqual(["current"]);
    expect(f.journal.inspect(ID).resolution).toBeNull();
  });
  it("has a normal inspect/resolve CLI path using the actual persistent K journal", () => {
    const f = fixture(); f.reopen();
    const authority = {...f.context, assertCurrent() {f.proof.assertCurrent(f.context);}};
    const session: PrivateMaintenanceSession = {context: f.context, assertCurrent: authority.assertCurrent,
      maintenance: filesystemMaintenancePort(f.journal, f.proof, authority), snapshot() {throw new Error("not requested");}, close() {}};
    const inspected = executePrivateMaintenance("inspect", {family: "filesystem", attemptId: ID}, session) as {result: {fingerprint: string}};
    const resolved = executePrivateMaintenance("resolve", {family: "filesystem", attemptId: ID, fingerprint: inspected.result.fingerprint}, session);
    expect(JSON.stringify(resolved)).toContain("APPLIED_OBSERVED");
  });
  it("parses four bounded commands and help without native activation; refuses liveness declarations", () => {
    for (const command of ["inspect", "resolve", "snapshot-inspect", "snapshot-release"])
      expect(parsePrivateMaintenanceArguments([command, "--workspace", WORKSPACE, "--request", "request.json"])).toEqual({
        command, workspace: WORKSPACE, requestFile: "request.json"});
    const out = vi.fn(), err = vi.fn();
    expect(runPrivateMaintenanceCli(["--help"], {out, err}, {})).toBe(0);
    expect(out).toHaveBeenCalled(); expect(err).not.toHaveBeenCalled();
    expect(() => parsePrivateMaintenanceArguments(["inspect", "--workspace-closed", "yes", "--request", "request.json"])).toThrow();
  });
  it.each(["applied", "root-id", "workspace-id", "parent-id", "authority"] as const)(
    "resolves an external endpoint only with unchanged origin proof inside CAS: %s", fault => {
    const EXT = ROOT + "\\External", DEST = EXT + "\\out.bin";
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "folio-maintenance-external-")));
    chmodSync(directory, 0o700); directories.push(directory);
    const sourceBytes = Buffer.from([0, 255, 128, 13, 10, 65]);
    const header = {contractVersion: 4, operation: "write-new", attemptId: ID, path: DEST, root: ROOT,
      rootFileId: RID, rootVolumeId: VOLUME, directoryFileId: DID, directoryVolumeId: VOLUME,
      byteLength: sourceBytes.length, maxBytes: 1024, sha256: hash(sourceBytes)};
    const wire = frame(header, sourceBytes);
    const scope = () => Object.freeze({version: 1 as const, family: "filesystem" as const, attemptId: ID,
      requestSha256: hash(wire), root: Object.freeze({path: ROOT, fileId: RID, volumeId: VOLUME}),
      stateRoot: "C:\\FolioState",
      workspace: Object.freeze({path: WORKSPACE, fileId: DID, volumeId: VOLUME, workspaceId: "workspace-1"}),
      osSid: SID, writerId: null, sessionId: null,
      endpoints: Object.freeze([Object.freeze({path: DEST,
        parent: Object.freeze({path: EXT, fileId: DID, volumeId: VOLUME})})])});
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(),
      "immutable-original-native-binding", () => {}, [join(directory, "..", "unrelated-workspace")], scope);
    journals.push(journal);
    journal.reserve({attemptId: ID, targetKey: "target:external", wire, payload: sourceBytes, maxCaptureBytes: 8192});
    journal.capture(ID, {stdout: frame({contractVersion: 4, operation: "write-new", attemptId: ID, path: DEST,
      root: ROOT, state: "APPLIED", filesystem: "NTFS", byteLength: sourceBytes.length,
      file: native(DEST, FID), directory: native(EXT, DID), sha256: hash(sourceBytes),
      contentFlushed: true, durability: {profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH"}},
      sourceBytes), stderr: Buffer.alloc(0), status: 0, signal: null});
    journal.terminal(ID, "UNKNOWN", '{"state":"UNKNOWN","reason":"after-native-ack-cut"}');
    const context: WindowsPrivateMaintenanceContext = {workspace: WORKSPACE, workspaceId: "workspace-1",
      workspaceFingerprint: "5".repeat(64), writerId: "writer-current", sessionId: "session-current", osSid: SID};
    let currentCalls = 0;
    const proof: WindowsPrivatePersistenceMaintenanceProof = {
      assertCurrent(actual) {
        expect(actual).toEqual(context);
        currentCalls++;
        if (currentCalls >= 3 && fault === "authority") throw new Error("authority-changed-inside-CAS");
      },
      directory(path) {
        const changed = currentCalls >= 3 &&
          ((fault === "root-id" && path === ROOT) || (fault === "workspace-id" && path === WORKSPACE) ||
           (fault === "parent-id" && path === EXT));
        return {path, fileId: changed ? "9".repeat(32) : path === ROOT ? RID : DID, volumeId: VOLUME};
      },
      file(path) { return {path, fileId: FID, volumeId: VOLUME, bytes: sourceBytes.length, sha256: hash(sourceBytes)}; },
      tree(path) { return {path, fileId: FID, volumeId: VOLUME, bytes: sourceBytes.length, sha256: hash(sourceBytes), entries: 1}; },
      missing() { throw new Error("not requested"); },
    };
    journal.close();
    const reopened = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(),
      "immutable-original-native-binding", () => {}, [join(directory, "..", "unrelated-workspace")], scope);
    journals.push(reopened);
    const before = reopened.inspect(ID);
    expect(before.origin).toBeInstanceOf(Uint8Array);
    if (fault === "applied") {
      const result = reopened.investigate({attemptId: ID, fingerprint: before.fingerprint, context}, proof);
      expect(JSON.parse(result.resolution!).state).toBe("APPLIED_OBSERVED");
      expect(Buffer.from(result.wire)).toEqual(wire);
      expect(result.terminal!.state).toBe("UNKNOWN");
    } else {
      expect(() => reopened.investigate({attemptId: ID, fingerprint: before.fingerprint, context}, proof))
        .toThrow(fault === "authority" ? /authority-changed-inside-CAS/ : /WINDOWS_MAINTENANCE_SCOPE/);
      reopened.close();
      const retained = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(),
        "immutable-original-native-binding", () => {}, [join(directory, "..", "unrelated-workspace")], scope);
      journals.push(retained);
      const after = retained.inspect(ID);
      expect(after.fingerprint).toBe(before.fingerprint);
      expect(after.wire).toEqual(before.wire);
      expect(after.origin).toEqual(before.origin);
      expect(after.terminal).toEqual(before.terminal);
      expect(after.resolution).toBeNull();
    }
  });
  it("keeps an external legacy record UNKNOWN_UNRESOLVABLE and blocks provider drift atomically", () => {
    const EXT = ROOT + "\\External", DEST = EXT + "\\out.bin";
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "folio-maintenance-legacy-")));
    chmodSync(directory, 0o700); directories.push(directory);
    const sourceBytes = Buffer.from([0, 255, 128, 13, 10, 65]);
    const wire = frame({contractVersion: 4, operation: "write-new", attemptId: ID, path: DEST, root: ROOT,
      rootFileId: RID, rootVolumeId: VOLUME, directoryFileId: DID, directoryVolumeId: VOLUME,
      byteLength: sourceBytes.length, maxBytes: 1024, sha256: hash(sourceBytes)}, sourceBytes);
    const scope = (sid: string) => Object.freeze({version: 1 as const, family: "filesystem" as const, attemptId: ID,
      requestSha256: hash(wire), root: Object.freeze({path: ROOT, fileId: RID, volumeId: VOLUME}),
      stateRoot: "C:\\FolioState",
      workspace: Object.freeze({path: WORKSPACE, fileId: DID, volumeId: VOLUME, workspaceId: "workspace-1"}),
      osSid: sid, writerId: null, sessionId: null,
      endpoints: Object.freeze([Object.freeze({path: DEST,
        parent: Object.freeze({path: EXT, fileId: DID, volumeId: VOLUME})})])});
    // A provider whose second (in-transaction) answer differs from the first
    // fails the reservation before any row lands — no origin legacy fallback.
    let samples = 0;
    const drifting = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(),
      "immutable-original-native-binding", () => {}, [join(directory, "..", "unrelated-workspace")],
      () => scope(samples++ === 0 ? SID : "S-1-5-21-2000"));
    expect(() => drifting.reserve({attemptId: ID, targetKey: "target:external", wire,
      payload: sourceBytes, maxCaptureBytes: 8192})).toThrow(/PROVIDER_DRIFT/);
    drifting.close();
    // The failed reservation left no row behind: a clean journal on the same
    // directory sees no attempts and no origin blob.
    const clean = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(),
      "immutable-original-native-binding", () => {}, [join(directory, "..", "unrelated-workspace")]);
    expect(clean.listAttempts()).toEqual([]);
    clean.close();
    const journal = new WindowsPrivatePersistenceJournal(directory, new PosixPrivatePlatform(),
      "immutable-original-native-binding", () => {}, [join(directory, "..", "unrelated-workspace")]);
    journals.push(journal);
    journal.reserve({attemptId: ID, targetKey: "target:external", wire, payload: sourceBytes, maxCaptureBytes: 8192});
    journal.capture(ID, {stdout: frame({contractVersion: 4, operation: "write-new", attemptId: ID, path: DEST,
      root: ROOT, state: "APPLIED", filesystem: "NTFS", byteLength: sourceBytes.length,
      file: native(DEST, FID), directory: native(EXT, DID), sha256: hash(sourceBytes),
      contentFlushed: true, durability: {profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH"}},
      sourceBytes), stderr: Buffer.alloc(0), status: 0, signal: null});
    journal.terminal(ID, "UNKNOWN", '{"state":"UNKNOWN","reason":"after-native-ack-cut"}');
    const context: WindowsPrivateMaintenanceContext = {workspace: WORKSPACE, workspaceId: "workspace-1",
      workspaceFingerprint: "5".repeat(64), writerId: "writer-current", sessionId: "session-current", osSid: SID};
    const proof: WindowsPrivatePersistenceMaintenanceProof = {
      assertCurrent() {}, directory(path) { return {path, fileId: path === ROOT ? RID : DID, volumeId: VOLUME}; },
      file(path) { return {path, fileId: FID, volumeId: VOLUME, bytes: sourceBytes.length, sha256: hash(sourceBytes)}; },
      tree(path) { return {path, fileId: FID, volumeId: VOLUME, bytes: sourceBytes.length, sha256: hash(sourceBytes), entries: 1}; },
      missing() { throw new Error("not requested"); },
    };
    expect(journal.inspect(ID).origin).toBeUndefined();
    expect(() => journal.investigate({attemptId: ID, fingerprint: journal.inspect(ID).fingerprint, context}, proof))
      .toThrow(/UNKNOWN_UNRESOLVABLE/);
    expect(journal.inspect(ID).resolution).toBeNull();
  });
  it("executes both explicit snapshot commands through their bounded lifecycle port", () => {
    const f = fixture(), snapshot = vi.fn(() => ({state: "REVALIDATED"}));
    const session: PrivateMaintenanceSession = {context: f.context, assertCurrent() {},
      maintenance: {inspect() {throw new Error("wrong port");}, resolve() {throw new Error("wrong port");}}, snapshot, close() {}};
    const request = {path: win32.join(WORKSPACE, "workspace.sqlite"), profile: "recovery-archive",
      reference: {attemptId: ID, slot: 0, slotFileId: FID, slotVolumeId: VOLUME}};
    executePrivateMaintenance("snapshot-inspect", request, session);
    executePrivateMaintenance("snapshot-release", {...request, fingerprint: "f".repeat(64)}, session);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});
