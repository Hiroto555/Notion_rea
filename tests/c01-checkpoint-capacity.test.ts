import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWindowsPrivateRecoveryIoForTesting,
  type WindowsRecoveryIo,
  type WindowsRecoveryIoExecRequest,
  type WindowsRecoveryIoExecResult,
  type WindowsRecoveryIoPublishRequest,
} from "../src/platform/windows/private-recovery-io";
import { WindowsRecoveryArchive, type RecoveryBlobKind } from "../src/platform/windows/recovery-archive";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import type { WindowsRuntimeFileStat } from "../src/platform/windows/runtime-platform";
import { createWindowsRecoveryFilePort } from "../src/platform/windows/recovery-file-port";
import { CrashRecoveryFile } from "../src/persistence/crash-recovery-file";
import { emptyCrashRecoverySnapshot, type CrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { canonicalOperation } from "../src/shared/save-contract";
import { RecoveryCheckpoint, type RecoveryWriteRequest } from "../src/renderer/recovery-checkpoint";
import { EditSessionCoordinator } from "../src/renderer/edit-session-coordinator";
import { DatabaseSessionCoordinator } from "../src/renderer/database-session-coordinator";
import type { SaveTransport } from "../src/renderer/reliable-save";
import { Store } from "../src/persistence/store";
import { RecordRepository } from "../src/persistence/record-repository";
import { readDatabaseSnapshot } from "../src/persistence/database-operations";
import type { Request } from "../src/shared/types";

const ROOT = "C:\\Folio";
const PARENT = `${ROOT}\\recovery`;
const LOGICAL = `${PARENT}\\crash-recovery.json`;
const WORKSPACE = "ws-1";
const EXE = "C:\\Trusted\\PrivateRootProbe.exe";
const EXE_BYTES = Buffer.from("in-memory pinned v3 executable fixture");
const ROOT_ID = "1".repeat(32);
const DIRECTORY_ID = "2".repeat(32);
const STAGE_ID = "5".repeat(32);
const VOLUME = "4".repeat(16);
const SID = "S-1-5-21-1000";
const KEEP_TEMP = process.env.FOLIO_C01_KEEP_TEMP === "1";
const BLOB_KINDS: readonly RecoveryBlobKind[] = [
  "evidence:maintenance-cas", "evidence:maintenance", "original",
  "wire:prepare", "wire:commit-prepared",
  "capture:prepare:stdout", "capture:prepare:stderr", "capture:prepare:metadata",
  "capture:commit-prepared:stdout", "capture:commit-prepared:stderr", "capture:commit-prepared:metadata",
  "evidence:prepared",
];

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const roots: string[] = [];
const archives: WindowsRecoveryArchive[] = [];
afterEach(() => {
  for (const archive of archives.splice(0)) { try { archive.close(); } catch {} }
  if (!KEEP_TEMP) for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  else roots.splice(0);
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-c01-capacity-")));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function testingPlatform(): PrivatePlatform {
  const inner = new PosixPrivatePlatform();
  return {
    kind: "windows",
    bind: (directory: string) => inner.bind(directory),
    assertRoot: () => inner.assertRoot(),
    assertFile: (path: string) => {
      inner.assertRoot();
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid()))
        throw new Error("untrusted-file-proof");
    },
    assertSidecars: (path: string) => inner.assertSidecars(path),
    createExclusive: (path: string) => inner.createExclusive(path),
    assertEmptyFile: (path: string) => inner.assertEmptyFile(path),
    close: () => inner.close(),
  };
}

function newArchive(directory: string): WindowsRecoveryArchive {
  const archive = new WindowsRecoveryArchive(directory, testingPlatform(), "binding:c01", []);
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

type IoObservation = { state: string; reason?: string; attemptId?: string };
function observe(io: WindowsRecoveryIo): {
  io: WindowsRecoveryIo;
  publishes: IoObservation[];
  reads: { state: string }[];
} {
  const publishes: IoObservation[] = [], reads: { state: string }[] = [];
  const wrapped: WindowsRecoveryIo = {
    contractVersion: 3,
    platform: "win32",
    trust: io.trust,
    publishNew(request) {
      const outcome = io.publishNew(request);
      publishes.push({
        state: outcome.state,
        ...(outcome.state === "PUBLISHED" ? {} : { reason: outcome.reason }),
        ...(typeof outcome.attemptId === "string" ? { attemptId: outcome.attemptId } : {}),
      });
      return outcome;
    },
    readPrivate(request) {
      const outcome = io.readPrivate(request);
      reads.push({ state: outcome.state });
      return outcome;
    },
    readMissing(request) {
      return io.readMissing(request);
    },
  };
  return { io: wrapped, publishes, reads };
}

function fixture(directory: string) {
  const calls: { phase: string; wire: Wire; payload: Uint8Array }[] = [];
  let staged: { id: string; bytes: Uint8Array } | undefined;
  const published = new Map<string, { fileId: string; bytes: Uint8Array }>();
  let identities = 0;
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
    const base = {
      contractVersion: 3, operation: wire.operation, path: wire.path, root: wire.root,
      ...(wire.attemptId !== undefined ? { attemptId: wire.attemptId, stagingPath: wire.stagingPath } : {}),
    };
    const dir = proof(String(wire.path).slice(0, String(wire.path).lastIndexOf("\\")),
      String(wire.root), String(wire.directoryFileId), String(wire.rootFileId), String(wire.rootVolumeId));
    if (wire.operation === "prepare") {
      staged = { id: ++identities === 1 ? STAGE_ID : identities.toString(16).padStart(32, "0"), bytes: parsed.payload };
      return {
        status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({
          ...base, state: "PREPARED",
          file: proof(String(wire.stagingPath), String(wire.root), staged.id, String(wire.rootFileId), String(wire.rootVolumeId)),
          directory: dir, byteLength: parsed.payload.byteLength, sha256: sha(parsed.payload),
          contentFlushed: true, filesystem: "NTFS",
        }, parsed.payload),
      };
    }
    if (wire.operation === "commit-prepared") {
      published.set(String(wire.path), { fileId: staged!.id, bytes: staged!.bytes });
      return {
        status: 0, signal: null, stderr: new Uint8Array(0),
        stdout: encode({
          ...base, state: "PUBLISHED",
          file: proof(String(wire.path), String(wire.root), staged!.id, String(wire.rootFileId), String(wire.rootVolumeId)),
          directory: dir, byteLength: staged!.bytes.byteLength, sha256: sha(staged!.bytes),
          contentFlushed: true, filesystem: "NTFS", stagingDisposition: "RENAMED_TO_FINAL",
          namespace: "EXCLUSIVE_NO_REPLACE",
          durability: { profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1", scope: "PROCESS_CRASH" },
        }, staged!.bytes),
      };
    }
    const file = published.get(String(wire.path))!;
    return {
      status: 0, signal: null, stderr: new Uint8Array(0),
      stdout: encode({
        ...base, state: "READ",
        file: proof(String(wire.path), String(wire.root), file.fileId, String(wire.rootFileId), String(wire.rootVolumeId)),
        directory: dir, byteLength: file.bytes.byteLength, sha256: sha(file.bytes), filesystem: "NTFS",
      }, file.bytes),
    };
  };
  const open = () => {
    const archive = newArchive(directory);
    const raw = createWindowsPrivateRecoveryIoForTesting({
      root: ROOT, probeExecutable: EXE, expectedHash: sha(EXE_BYTES), systemRoot: "C:\\Windows",
      expectedRoot: { rootFileId: ROOT_ID, volumeId: VOLUME },
      archive,
      directoryIdentity: () => ({ fileId: DIRECTORY_ID, volumeId: VOLUME }),
      assertCurrent: () => {},
    }, { fs: fsPort, exec });
    const observed = observe(raw);
    const port = createWindowsRecoveryFilePort({
      archive, io: observed.io, assertCurrent: () => {},
      parentIdentityFor: () => ({ fileId: DIRECTORY_ID, volumeId: VOLUME }),
      assertLegacyAbsent() {},
    });
    const file = new CrashRecoveryFile(LOGICAL, WORKSPACE, { platform: "win32", nativePort: port });
    return { archive, io: observed.io, publishes: observed.publishes, reads: observed.reads, port, file };
  };
  return { ...open(), open, calls, published };
}

function workspaceFixture(directory: string) {
  const store = new Store(join(directory, "workspace.sqlite"));
  try {
    const page = store.create(null, "page", "Ordinary");
    let owner = store.create(null, "database", "Tasks");
    owner = store.update(owner.id, owner.revision, {
      database: {
        ...owner.database!,
        properties: [
          { id: "note", name: "Note", type: "text" },
          { id: "count", name: "Count", type: "number" },
          { id: "done", name: "Done", type: "checkbox" },
        ],
      },
    });
    const repo = new RecordRepository(store);
    store.transaction(() => { repo.createSchema(); repo.registerDatabase(owner.id); });
    const record = repo.create(owner.id, "Task", { note: "before", count: 1, done: false });
    return { store, page, owner, repo, record };
  } catch (error) {
    try { store.close(); } catch {}
    throw error;
  }
}

type RetainedRecord = {
  attemptId: string;
  metadata: string;
  blobs: Record<string, string | null>;
  terminal: string | null;
};
type RetainedSnapshot = {
  count: number;
  digest: string;
  records: RetainedRecord[];
  pointer: Record<string, unknown> | null;
};

function retainedSnapshot(archive: WindowsRecoveryArchive): RetainedSnapshot {
  const records: RetainedRecord[] = [...archive.listAttempts()].map((attemptId) => {
    const metadata = archive.readMetadata(attemptId);
    if (metadata === undefined) throw new Error(`missing metadata for ${attemptId}`);
    const blobs: Record<string, string | null> = {};
    for (const kind of BLOB_KINDS) {
      const bytes = archive.readBlob(attemptId, kind);
      blobs[kind] = bytes === undefined ? null : sha(bytes);
    }
    return {
      attemptId,
      metadata: JSON.stringify(metadata),
      blobs,
      terminal: archive.terminalReceipt(attemptId) ?? null,
    };
  });
  const head = archive.readHead(LOGICAL, WORKSPACE);
  const pointer = head === undefined ? null : {
    generation: head.pointer.generation,
    attemptId: head.pointer.attemptId,
    sha256: head.pointer.sha256,
    originalSha256: sha(head.original),
    receiptSha256: sha(head.receipt),
    appliedSha256: sha(head.applied),
  };
  return {
    count: records.length,
    digest: sha(JSON.stringify({ records, pointer })),
    records,
    pointer,
  };
}

type ArchiveRowSnapshot = {
  counts: Record<string, number>;
  digest: string;
  tables: Record<string, Record<string, unknown>[]>;
};

const ARCHIVE_TABLE_SPECS = [
  { name: "recovery_identity", primaryKey: ["singleton"] },
  { name: "recovery_attempts", primaryKey: ["attempt_id"] },
  { name: "recovery_blobs", primaryKey: ["attempt_id", "kind"] },
  { name: "recovery_terminals", primaryKey: ["attempt_id"] },
  { name: "recovery_heads", primaryKey: ["logical_path"] },
  { name: "recovery_logical_targets", primaryKey: ["logical_key"] },
  { name: "recovery_pointer_intents", primaryKey: ["attempt_id"] },
  { name: "recovery_pointer_results", primaryKey: ["attempt_id"] },
] as const;

function encodeArchiveRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (!(value instanceof Uint8Array)) return [key, value];
    const bytes = Uint8Array.from(value);
    return [key, { base64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength, sha256: sha(bytes) }];
  }));
}

function archiveRowSnapshot(archiveDir: string): ArchiveRowSnapshot {
  const connection = new DatabaseSync(join(archiveDir, "windows-recovery-v3.sqlite"), { readOnly: true });
  try {
    const counts: Record<string, number> = {};
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const spec of ARCHIVE_TABLE_SPECS) {
      const rows = (connection.prepare(`SELECT * FROM ${spec.name}`).all() as Record<string, unknown>[])
        .map(encodeArchiveRow)
        .sort((left, right) => {
          for (const key of spec.primaryKey) {
            const a = String(left[key]), b = String(right[key]);
            if (a !== b) return a < b ? -1 : 1;
          }
          return 0;
        });
      tables[spec.name] = rows;
      counts[spec.name] = rows.length;
    }
    return { counts, tables, digest: sha(JSON.stringify({ counts, tables })) };
  } finally {
    connection.close();
  }
}

type GoldenGeneration = {
  generation: number;
  attemptId: string;
  originalBase64: string;
  originalByteLength: number;
  originalSha256: string;
};

function goldenFromHead(generation: number, head: { pointer: { attemptId: string }; original: Uint8Array }): GoldenGeneration {
  const original = Uint8Array.from(head.original);
  return {
    generation, attemptId: head.pointer.attemptId,
    originalBase64: Buffer.from(original).toString("base64"),
    originalByteLength: original.byteLength, originalSha256: sha(original),
  };
}

type OriginalDescriptor = { base64: string; byteLength: number; sha256: string; columnSha256: string };

function originalBlobDescriptors(snapshot: ArchiveRowSnapshot): Map<string, OriginalDescriptor> {
  const descriptors = new Map<string, OriginalDescriptor>();
  for (const row of snapshot.tables.recovery_blobs ?? []) {
    if (row.kind !== "original") continue;
    const blob = row.bytes as { base64?: unknown; byteLength?: unknown; sha256?: unknown } | undefined;
    descriptors.set(String(row.attempt_id), {
      base64: String(blob?.base64), byteLength: Number(blob?.byteLength),
      sha256: String(blob?.sha256), columnSha256: String(row.sha256),
    });
  }
  return descriptors;
}

function describeError(error: unknown): Record<string, unknown> {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
}

function errorOutcome(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error) || !("result" in error) || !isRecord(error.result)) return null;
  const result = error.result;
  if (typeof result.state !== "string") return null;
  return {
    state: result.state,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    ...(typeof result.attemptId === "string" ? { attemptId: result.attemptId } : {}),
  };
}

function writeEvidence(result: Record<string, unknown>, trace: Record<string, unknown>[]): void {
  const directory = process.env.FOLIO_C01_EVIDENCE_DIR;
  if (!directory) return;
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("FOLIO_C01_EVIDENCE_DIR must be a fresh directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error("FOLIO_C01_EVIDENCE_DIR is not owned by the test user");
  const canonical = realpathSync(directory);
  writeFileSync(join(canonical, "result.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(canonical, "trace.jsonl"), trace.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

describe("C01 checkpoint capacity probe (contract-only, POSIX relabelled windows; NOT_RUN on Windows)", () => {
  it("rejects generation 65 at the real archive limit before mutation dispatch and retains 64 APPLIED generations", async () => {
    const trace: Record<string, unknown>[] = [];
    const evidence: Record<string, unknown> = {
      probe: "c01-checkpoint-capacity",
      contractOnly: true,
      platform: process.platform,
      boundary: "POSIX private platform relabelled windows; injected binary-v3 transport; not Windows OS acceptance",
    };
    const writeAttempts: Record<string, unknown>[] = [];
    const writeErrors: Record<string, unknown>[] = [];
    const offeredSnapshots: Record<string, unknown>[] = [];
    const applicationRequests: string[] = [];
    const appliedShas: string[] = [];
    const goldenGenerations: GoldenGeneration[] = [];
    const recordGolden = (generation: number, head: { pointer: { attemptId: string }; original: Uint8Array }): void => {
      const golden = goldenFromHead(generation, head);
      goldenGenerations.push(golden);
      appliedShas.push(golden.originalSha256);
    };
    evidence.trace = trace;
    evidence.writeAttempts = writeAttempts;
    evidence.errors = writeErrors;
    evidence.offeredSnapshots = offeredSnapshots;
    evidence.applicationRequests = applicationRequests;
    evidence.goldenGenerations = goldenGenerations;

    const root = tempDir();
    const archiveDir = join(root, "recovery");
    const workspaceDir = join(root, "workspace");
    let workspace: { store: Store } | undefined;
    let primaryError: unknown;
    let evidenceError: unknown;
    let completed = false;
    try {
      mkdirSync(archiveDir, { recursive: true }); chmodSync(archiveDir, 0o700);
      mkdirSync(workspaceDir, { recursive: true }); chmodSync(workspaceDir, 0o700);

      const f = fixture(archiveDir);
      const ws = workspaceFixture(workspaceDir);
      workspace = ws;

      let activeFile = f.file;
    let stage = "setup";
    const writeHandler = async (request: RecoveryWriteRequest): Promise<unknown> => {
      writeAttempts.push({
        stage,
        expectedGeneration: request.expectedGeneration,
        snapshotSha256: sha(canonicalOperation(request.snapshot)),
        records: request.snapshot.records.length,
        databases: request.snapshot.databases.length,
        recordOperations: request.snapshot.records.filter((entry) => entry.operation !== undefined).length,
        databaseOperations: request.snapshot.databases.filter((entry) => entry.operation !== undefined).length,
      });
      try {
        return activeFile.write(request.expectedGeneration, request.snapshot);
      } catch (error) {
        writeErrors.push({
          stage,
          expectedGeneration: request.expectedGeneration,
          ...describeError(error),
          nestedOutcome: errorOutcome(error),
        });
        throw error;
      }
    };

    let sessions!: EditSessionCoordinator;
    let databases!: DatabaseSessionCoordinator;
    const capture = (): CrashRecoverySnapshot => {
      const snapshot = emptyCrashRecoverySnapshot();
      snapshot.records = sessions.exportRecovery(true).filter((entry) => entry.intents.length > 0 || entry.operation !== undefined);
      snapshot.databases = databases.exportRecovery(true).filter((entry) => entry.intents.length > 0 || entry.operation !== undefined);
      return snapshot;
    };
    let queue = new RecoveryCheckpoint(writeHandler, 0);
    const barrier = async (): Promise<void> => {
      const snapshot = capture();
      offeredSnapshots.push({
        stage,
        records: snapshot.records.length,
        databases: snapshot.databases.length,
        recordOperations: snapshot.records.filter((entry) => entry.operation !== undefined).length,
        databaseOperations: snapshot.databases.filter((entry) => entry.operation !== undefined).length,
        snapshotSha256: sha(canonicalOperation(snapshot)),
      });
      queue.offer(snapshot);
      await queue.flush();
    };
    const transport: SaveTransport = async (request: Request) => {
      applicationRequests.push(request.type);
      return ws.store.handle(request);
    };
    sessions = new EditSessionCoordinator(transport, { beforeSend: barrier });
    databases = new DatabaseSessionCoordinator(transport, { beforeSend: barrier });

    const mutationCalls = () =>
      f.calls.filter((call) => call.phase === "prepare" || call.phase === "commit-prepared");
    const prepareCalls = () => f.calls.filter((call) => call.phase === "prepare");
    const commitCalls = () => f.calls.filter((call) => call.phase === "commit-prepared");
    const readCalls = () => f.calls.filter((call) => call.phase === "read-private");

      stage = "positive-control";
      const recordHandle = sessions.attach(ws.store.get(ws.record.pageId), ws.record);
      sessions.edit(recordHandle, { title: "Saved record" });
      await sessions.flush(recordHandle.pageId);
      expect(sessions.get(recordHandle.pageId)).toMatchObject({
        state: "saved", page: { revision: 1, title: "Saved record" },
      });
      expect(mutationCalls()).toHaveLength(2);
      expect(prepareCalls()).toHaveLength(1);
      expect(commitCalls()).toHaveLength(1);
      expect(applicationRequests).toEqual(["save:commit"]);

      const firstHead = f.archive.readHead(LOGICAL, WORKSPACE);
      expect(firstHead?.pointer.generation).toBe(1);
      recordGolden(1, firstHead!);
      trace.push({
        event: "generation-applied", generation: 1, attemptId: firstHead!.pointer.attemptId,
        originalSha256: appliedShas[0], prepareDispatches: 1, commitDispatches: 1,
      });

      const databaseRead = readDatabaseSnapshot(ws.store, ws.owner.id);
      const databaseHandle = databases.attach(databaseRead.page, databaseRead.database);
      databases.editPage(databaseHandle, { title: "Saved database" });
      await databases.flush(databaseHandle.pageId);
      expect(databases.get(databaseHandle.pageId)).toMatchObject({
        state: "saved", page: { revision: 2, title: "Saved database" },
      });
      expect(applicationRequests).toEqual(["save:commit", "database:commit"]);
      const positiveControlApplicationRequests = applicationRequests.length;
      expect(positiveControlApplicationRequests).toBe(2);
      expect(prepareCalls()).toHaveLength(2);
      expect(commitCalls()).toHaveLength(2);
      expect(queue.getStatus()).toMatchObject({ generation: 2, offeredSeq: 2, savedSeq: 2 });

      const secondHead = f.archive.readHead(LOGICAL, WORKSPACE);
      expect(secondHead?.pointer.generation).toBe(2);
      recordGolden(2, secondHead!);
      trace.push({
        event: "generation-applied", generation: 2, attemptId: secondHead!.pointer.attemptId,
        originalSha256: appliedShas[1], prepareDispatches: 2, commitDispatches: 2,
      });

      let lastSnapshot: CrashRecoverySnapshot = emptyCrashRecoverySnapshot();
      for (let generation = 3; generation <= 64; generation++) {
        const snapshot: CrashRecoverySnapshot = {
          ...emptyCrashRecoverySnapshot(),
          rawDrafts: [{ scope: "record", pageId: "record", key: "capacity", value: `generation-${generation}` }],
        };
        const beforeGeneration = queue.getStatus().generation;
        const beforeOffered = queue.getStatus().offeredSeq;
        expect(queue.offer(snapshot)).toBe(beforeOffered + 1);
        await queue.flush();
        expect(queue.getStatus().generation).toBe(beforeGeneration + 1);
        const head = f.archive.readHead(LOGICAL, WORKSPACE);
        expect(head?.pointer.generation).toBe(generation);
        expect((JSON.parse(head!.applied) as { state?: string }).state).toBe("APPLIED");
        recordGolden(generation, head!);
        lastSnapshot = snapshot;
        trace.push({
          event: "generation-applied", generation, attemptId: head!.pointer.attemptId,
          originalSha256: appliedShas[appliedShas.length - 1],
          prepareDispatches: prepareCalls().length, commitDispatches: commitCalls().length,
        });
      }
      expect(new Set(appliedShas).size).toBe(64);
      expect(goldenGenerations).toHaveLength(64);
      expect(queue.getStatus()).toMatchObject({ generation: 64, offeredSeq: 64, savedSeq: 64 });
      expect(f.archive.listAttempts()).toHaveLength(64);
      expect(prepareCalls()).toHaveLength(64);
      expect(commitCalls()).toHaveLength(64);
      expect(mutationCalls()).toHaveLength(128);
      expect(mutationCalls().every((call) => call.wire.operation === "prepare" || call.wire.operation === "commit-prepared")).toBe(true);

      const retainedBefore = retainedSnapshot(f.archive);
      expect(retainedBefore.count).toBe(64);
      expect(retainedBefore.pointer?.generation).toBe(64);
      const rowBefore = archiveRowSnapshot(archiveDir);
      expect(rowBefore.counts.recovery_attempts).toBe(64);
      expect(rowBefore.tables.recovery_attempts).toHaveLength(64);
      const originalDescriptors = originalBlobDescriptors(rowBefore);
      expect(originalDescriptors.size).toBe(64);
      for (const golden of goldenGenerations) {
        const descriptor = originalDescriptors.get(golden.attemptId);
        expect(descriptor).toBeDefined();
        expect(descriptor).toMatchObject({
          base64: golden.originalBase64, byteLength: golden.originalByteLength, sha256: golden.originalSha256,
        });
        expect(descriptor!.columnSha256).toBe(golden.originalSha256);
        expect(rowBefore.tables.recovery_attempts?.some((row) => row.attempt_id === golden.attemptId)).toBe(true);
      }
      const intentAttempts = (rowBefore.tables.recovery_pointer_intents ?? []).map((row) => String(row.attempt_id));
      const resultRows = rowBefore.tables.recovery_pointer_results ?? [];
      expect(intentAttempts).toHaveLength(64);
      expect(resultRows).toHaveLength(64);
      expect(resultRows.map((row) => (JSON.parse(String(row.result)) as { state?: string }).state)
        .every((state) => state === "APPLIED")).toBe(true);
      expect(intentAttempts.filter((id) => !resultRows.some((row) => row.attempt_id === id))).toEqual([]);
      evidence.baselineArchiveRows = rowBefore;
      const readsBeforeCapacity = readCalls().length;

      stage = "pre-reopen-capacity";
      const preSnapshot: CrashRecoverySnapshot = {
        ...emptyCrashRecoverySnapshot(),
        rawDrafts: [{ scope: "record", pageId: "record", key: "capacity", value: "generation-65-pre" }],
      };
      const publishesBeforePre = f.publishes.length;
      expect(queue.offer(preSnapshot)).toBe(65);
      const preError = await queue.flush().then(
        () => { throw new Error("generation 65 was unexpectedly acknowledged before reopen"); },
        (error: unknown) => error,
      );
      expect(preError).toBeInstanceOf(Error);
      expect((preError as Error).name).toBe("PrivateFilePublicationUnknownError");
      expect(errorOutcome(preError)).toMatchObject({ state: "REJECTED" });
      expect(queue.getStatus()).toMatchObject({ state: "error", generation: 64, savedSeq: 64 });
      expect(f.publishes).toHaveLength(publishesBeforePre + 1);
      const preOutcome = f.publishes[f.publishes.length - 1]!;
      expect(preOutcome.state).toBe("REJECTED");
      expect(mutationCalls()).toHaveLength(128);
      expect(readCalls().length).toBeGreaterThan(readsBeforeCapacity);
      const retainedAfterPre = retainedSnapshot(f.archive);
      expect(retainedAfterPre.count).toBe(64);
      expect(retainedAfterPre.digest).toBe(retainedBefore.digest);
      const rowAfterPre = archiveRowSnapshot(archiveDir);
      expect(rowAfterPre.digest).toBe(rowBefore.digest);
      expect(rowAfterPre.counts).toEqual(rowBefore.counts);
      const preWrite = writeAttempts.find((entry) => entry.stage === "pre-reopen-capacity");
      expect(preWrite?.expectedGeneration).toBe(64);
      const attemptedPre = Number(preWrite!.expectedGeneration) + 1;
      expect(attemptedPre).toBe(65);
      trace.push({
        event: "capacity-attempt", stage: "pre-reopen",
        expectedGeneration: Number(preWrite!.expectedGeneration), attemptedGeneration: attemptedPre,
        ioState: preOutcome.state, queueState: "error", queueGeneration: 64,
        prepareDispatches: prepareCalls().length, commitDispatches: commitCalls().length,
        retainedDigest: retainedAfterPre.digest, retainedRowDigest: rowAfterPre.digest,
      });

      f.archive.close();
      const reopened = f.open();
      activeFile = reopened.file;
      const reopenedRead = reopened.file.read();
      expect(reopenedRead.status).toBe("ready");
      expect(reopenedRead.generation).toBe(64);
      expect(canonicalOperation(reopenedRead.snapshot!)).toBe(canonicalOperation(lastSnapshot));
      expect(reopened.archive.listAttempts()).toHaveLength(64);
      expect(reopened.archive.readHead(LOGICAL, WORKSPACE)?.pointer.generation).toBe(64);
      const retainedAfterReopen = retainedSnapshot(reopened.archive);
      expect(retainedAfterReopen.count).toBe(64);
      expect(retainedAfterReopen.digest).toBe(retainedBefore.digest);
      const rowAfterReopen = archiveRowSnapshot(archiveDir);
      expect(rowAfterReopen.digest).toBe(rowBefore.digest);
      expect(rowAfterReopen.counts).toEqual(rowBefore.counts);
      expect(mutationCalls()).toHaveLength(128);
      trace.push({
        event: "archive-reopened", generation: reopenedRead.generation, attemptCount: retainedAfterReopen.count,
        retainedDigest: retainedAfterReopen.digest, prepareDispatches: prepareCalls().length,
        commitDispatches: commitCalls().length,
      });

      queue = new RecoveryCheckpoint(writeHandler, 64);
      stage = "post-reopen-record";
      const recordRevisionBefore = ws.store.get(ws.record.pageId).revision;
      const publishesBeforePost = reopened.publishes.length;
      const writeAttemptsBeforePostRecord = writeAttempts.length;
      const applicationRequestsBeforePost = applicationRequests.length;
      sessions.edit(recordHandle, { title: "Overflow record" });
      await sessions.flush(recordHandle.pageId);
      const recordView = sessions.get(recordHandle.pageId)!;
      expect(recordView.state).toBe("unknown");
      expect(recordView.operation).toBeDefined();
      expect(recordView.page.title).toBe("Overflow record");
      const recordRecovery = sessions.exportRecovery(true).find((entry) => entry.base.id === recordHandle.pageId)!;
      expect(recordRecovery.intents).toHaveLength(1);
      expect(recordRecovery.operation).toMatchObject({
        seq: 2, revision: recordRevisionBefore, patch: { title: "Overflow record" },
      });
      expect(ws.store.get(ws.record.pageId).revision).toBe(recordRevisionBefore);
      expect(ws.store.get(ws.record.pageId).title).toBe("Saved record");
      expect(reopened.publishes).toHaveLength(publishesBeforePost + 1);
      const postOutcome = reopened.publishes[reopened.publishes.length - 1]!;
      expect(postOutcome.state).toBe("REJECTED");
      expect(mutationCalls()).toHaveLength(128);
      expect(writeAttempts).toHaveLength(writeAttemptsBeforePostRecord + 1);
      expect(applicationRequests).toHaveLength(applicationRequestsBeforePost);
      expect(queue.getStatus()).toMatchObject({ state: "error", generation: 64, savedSeq: 0 });
      const postRecordWrite = writeAttempts.find((entry) => entry.stage === "post-reopen-record");
      expect(postRecordWrite?.expectedGeneration).toBe(64);
      const attemptedPost = Number(postRecordWrite!.expectedGeneration) + 1;
      expect(attemptedPost).toBe(65);
      expect(postRecordWrite).toMatchObject({
        records: 1, databases: 0, recordOperations: 1, databaseOperations: 0,
      });

      stage = "post-reopen-database";
      const databaseRevisionBefore = ws.store.get(ws.owner.id).revision;
      const writeAttemptsBeforeDatabase = writeAttempts.length;
      const publishesBeforeDatabase = reopened.publishes.length;
      const applicationRequestsBeforeDatabase = applicationRequests.length;
      const readsBeforeDatabase = readCalls().length;
      databases.editPage(databaseHandle, { title: "Overflow database" });
      await databases.flush(databaseHandle.pageId);
      const databaseView = databases.get(databaseHandle.pageId)!;
      expect(databaseView.state).toBe("unknown");
      expect(databaseView.operation).toBeDefined();
      expect(databaseView.page.title).toBe("Overflow database");
      const databaseRecovery = databases.exportRecovery(true).find((entry) => entry.base.id === databaseHandle.pageId)!;
      expect(databaseRecovery.intents).toHaveLength(1);
      expect(databaseRecovery.operation).toMatchObject({
        seq: 2,
        command: {
          kind: "updateDatabase", databasePageId: databaseHandle.pageId,
          revision: databaseRevisionBefore, patch: { title: "Overflow database" },
        },
      });
      expect(ws.store.get(ws.owner.id).revision).toBe(databaseRevisionBefore);
      expect(ws.store.get(ws.owner.id).title).toBe("Saved database");
      expect(reopened.publishes).toHaveLength(publishesBeforeDatabase);
      expect(writeAttempts).toHaveLength(writeAttemptsBeforeDatabase);
      expect(applicationRequests).toHaveLength(applicationRequestsBeforeDatabase);
      expect(readCalls()).toHaveLength(readsBeforeDatabase);
      expect(mutationCalls()).toHaveLength(128);
      expect(queue.getStatus()).toMatchObject({ state: "error", generation: 64, savedSeq: 0 });
      expect(applicationRequests.filter((type) => type === "save:commit" || type === "database:commit"))
        .toEqual(["save:commit", "database:commit"]);
      expect(applicationRequests.length).toBe(applicationRequestsBeforePost);
      expect(sessions.hasUnsaved()).toBe(true);
      expect(databases.hasUnsaved()).toBe(true);
      const lastOffered = offeredSnapshots[offeredSnapshots.length - 1]!;
      expect(lastOffered).toMatchObject({
        records: 1, databases: 1, recordOperations: 1, databaseOperations: 1,
      });

      stage = "post-reopen-resend";
      const writeAttemptsBeforeResend = writeAttempts.length;
      const publishesBeforeResend = reopened.publishes.length;
      const applicationRequestsBeforeResend = applicationRequests.length;
      queue.offer({
        ...emptyCrashRecoverySnapshot(),
        rawDrafts: [{ scope: "record", pageId: "record", key: "capacity", value: "generation-65-resend" }],
      });
      const resendError = await queue.flush().then(
        () => { throw new Error("a later offer was unexpectedly dispatched after capacity rejection"); },
        (error: unknown) => error,
      );
      expect(resendError).toBeInstanceOf(Error);
      expect(writeAttempts).toHaveLength(writeAttemptsBeforeResend);
      expect(reopened.publishes).toHaveLength(publishesBeforeResend);
      expect(applicationRequests).toHaveLength(applicationRequestsBeforeResend);
      expect(mutationCalls()).toHaveLength(128);
      expect(queue.getStatus()).toMatchObject({ generation: 64, savedSeq: 0 });

      const retainedAfterPost = retainedSnapshot(reopened.archive);
      expect(retainedAfterPost.count).toBe(64);
      expect(retainedAfterPost.digest).toBe(retainedBefore.digest);
      const rowAfterPost = archiveRowSnapshot(archiveDir);
      expect(rowAfterPost.digest).toBe(rowBefore.digest);
      expect(rowAfterPost.counts).toEqual(rowBefore.counts);
      const finalRead = reopened.file.read();
      expect(finalRead.status).toBe("ready");
      expect(finalRead.generation).toBe(64);
      trace.push({
        event: "capacity-attempt", stage: "post-reopen",
        expectedGeneration: Number(postRecordWrite!.expectedGeneration), attemptedGeneration: attemptedPost,
        ioState: postOutcome.state, queueState: "error", queueGeneration: 64,
        recordCoordinatorState: recordView.state, databaseCoordinatorState: databaseView.state,
        prepareDispatches: prepareCalls().length, commitDispatches: commitCalls().length,
        retainedDigest: retainedAfterPost.digest, retainedRowDigest: rowAfterPost.digest,
      });
      trace.push({
        event: "no-resend", stage: "post-reopen-resend",
        writeHandlerCalls: writeAttempts.length - writeAttemptsBeforeResend,
        prepareDispatches: prepareCalls().length, commitDispatches: commitCalls().length,
        retainedDigest: retainedAfterPost.digest, retainedRowDigest: rowAfterPost.digest,
      });

      evidence.measurements = {
        appliedGenerations: 64,
        prepareDispatches: prepareCalls().length,
        commitDispatches: commitCalls().length,
        readPrivateDispatches: readCalls().length,
        applicationRequests: [...applicationRequests],
        uniqueOriginalDigests: new Set(appliedShas).size,
        reopenedGeneration: reopenedRead.generation,
        finalGeneration: finalRead.generation,
        recordBaseRevision: ws.store.get(ws.record.pageId).revision,
        databaseBaseRevision: ws.store.get(ws.owner.id).revision,
        recordCoordinator: { state: recordView.state, operationId: recordView.operation?.operationId ?? null },
        databaseCoordinator: { state: databaseView.state, operationId: databaseView.operation?.operationId ?? null },
      };
      const observedQueueAfterPost = queue.getStatus();
      const recordPending = {
        state: recordView.state,
        operationId: recordView.operation?.operationId ?? null,
        intents: recordRecovery.intents.length,
        hasUnsaved: sessions.hasUnsaved(),
      };
      const databasePending = {
        state: databaseView.state,
        operationId: databaseView.operation?.operationId ?? null,
        intents: databaseRecovery.intents.length,
        hasUnsaved: databases.hasUnsaved(),
      };
      evidence.capacity = {
        preReopen: {
          expectedGeneration: Number(preWrite!.expectedGeneration),
          attemptedGeneration: attemptedPre,
          ioState: preOutcome.state, queueState: "error", queueGeneration: 64,
          fileError: describeError(preError), nestedOutcome: errorOutcome(preError),
          prepareDispatches: prepareCalls().length, commitDispatches: commitCalls().length,
        },
        postReopen: {
          expectedGeneration: Number(postRecordWrite!.expectedGeneration),
          attemptedGeneration: attemptedPost,
          ioState: postOutcome.state, queueState: observedQueueAfterPost.state,
          queueGeneration: observedQueueAfterPost.generation,
          fileError: writeErrors.find((entry) => entry.stage === "post-reopen-record") ?? null,
          recordBarrier: {
            ioState: postOutcome.state,
            queueState: observedQueueAfterPost.state,
            fileError: writeErrors.find((entry) => entry.stage === "post-reopen-record") ?? null,
          },
          databaseBarrier: {
            ioState: postOutcome.state,
            queueState: observedQueueAfterPost.state,
            sharedQueueError: true,
            writeHandlerCalls: writeAttempts.length - writeAttemptsBeforeDatabase,
            publishes: reopened.publishes.length - publishesBeforeDatabase,
          },
          recordPending, databasePending,
          recordCoordinatorState: recordView.state, databaseCoordinatorState: databaseView.state,
          recordBaseRevision: ws.store.get(ws.record.pageId).revision,
          databaseBaseRevision: ws.store.get(ws.owner.id).revision,
          positiveControlApplicationRequests,
          applicationMutationRequests: applicationRequests.filter((type) => type === "save:commit" || type === "database:commit").length,
          applicationMutationDelta: applicationRequests.length - applicationRequestsBeforePost,
          prepareDispatches: prepareCalls().length, commitDispatches: commitCalls().length,
        },
        resend: {
          writeHandlerCalls: writeAttempts.length - writeAttemptsBeforeResend,
          prepareDispatches: prepareCalls().length,
          commitDispatches: commitCalls().length, queueGeneration: queue.getStatus().generation,
        },
      };
      evidence.retainedDigests = {
        beforeCapacity: retainedBefore.digest,
        afterPreReopenRejection: retainedAfterPre.digest,
        afterReopen: retainedAfterReopen.digest,
        afterPostReopenRejection: retainedAfterPost.digest,
        attempts: retainedAfterPost.count,
        pointer: retainedAfterPost.pointer,
      };
      evidence.retainedRows = {
        before: { digest: rowBefore.digest, counts: rowBefore.counts },
        afterPreReopen: { digest: rowAfterPre.digest, counts: rowAfterPre.counts },
        afterReopen: { digest: rowAfterReopen.digest, counts: rowAfterReopen.counts },
        afterPostReopen: { digest: rowAfterPost.digest, counts: rowAfterPost.counts },
        baseline: evidence.baselineArchiveRows,
        goldenGenerations: goldenGenerations.length,
      };
      evidence.offeredSnapshots = offeredSnapshots;
      evidence.writeAttempts = writeAttempts;
      evidence.errors = writeErrors;
      evidence.outcome = "completed";
      completed = true;
    } catch (error) {
      primaryError = error;
      evidence.outcome = "threw";
      evidence.failure = describeError(error);
    } finally {
      let cleanupError: unknown;
      try {
        workspace?.store.close();
      } catch (error) {
        cleanupError = error;
      }
      if (cleanupError !== undefined) {
        completed = false;
        evidence.cleanupError = describeError(cleanupError);
      }
      evidence.completed = completed && cleanupError === undefined;
      evidence.temp = { kept: KEEP_TEMP, root: KEEP_TEMP ? root : null };
      try {
        writeEvidence(evidence, trace);
      } catch (error) {
        evidenceError = error;
      }
      const failures: unknown[] = [];
      if (evidence.outcome === "threw") failures.push(primaryError);
      if (cleanupError !== undefined) failures.push(cleanupError);
      if (evidenceError !== undefined) failures.push(evidenceError);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "C01 checkpoint capacity probe failed with multiple errors");
    }
  }, 60_000);
});
