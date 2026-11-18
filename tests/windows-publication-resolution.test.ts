import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonical } from "../src/collaboration/runtime/canonical";
import type { Cut } from "../src/collaboration/runtime/contract";
import type { PublicationReservation } from "../src/platform/windows/publication-contract";
import {
  WindowsPublicationJournal,
  WINDOWS_PUBLICATION_JOURNAL_DATABASE,
} from "../src/platform/windows/publication-journal";
import {
  createPublicationResolutionPort,
  type PublicationAuthorization,
  type PublicationNativeObservation,
  type PublicationNativeReadRequest,
  type PublicationResolutionPort,
  type PublicationSourceIdentity,
} from "../src/platform/windows/publication-resolution";
import type { WindowsPrivateIoV2Failure } from "../src/platform/windows/private-publication-v2";
import {
  PosixPrivatePlatform,
  type PrivatePlatform,
} from "../src/sync/private-platform";

// Real disposable SQLite plus a PosixPrivatePlatform relabelled "windows":
// contract-only posix-testing coverage, never Windows OS/filesystem proof.
const roots: string[] = [];
const journals: WindowsPublicationJournal[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) {
    try {
      journal.close();
    } catch {}
  }
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-pub-resolve-")));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

function testingPlatform(): PrivatePlatform {
  const inner = new PosixPrivatePlatform();
  return {
    kind: "windows",
    bind: vi.fn((directory: string) => inner.bind(directory)),
    assertRoot: vi.fn(() => inner.assertRoot()),
    assertFile: vi.fn((path: string) => inner.assertFile(path)),
    assertSidecars: vi.fn((path: string) => inner.assertSidecars(path)),
    createExclusive: vi.fn((path: string) => inner.createExclusive(path)),
    assertEmptyFile: vi.fn((path: string) => inner.assertEmptyFile(path)),
    close: vi.fn(() => inner.close()),
  };
}

function openJournal(
  directory: string,
  sourceIdentity?: () => PublicationSourceIdentity,
): WindowsPublicationJournal {
  const journal = new WindowsPublicationJournal(
    directory,
    testingPlatform(),
    [],
    sourceIdentity,
  );
  journals.push(journal);
  return journal;
}

const ROOT_PATH = "C:\\Folio";
const PRIVATE_DIR = "C:\\Folio\\Private";
const SOURCE_ROOT = "C:\\Folio\\Shared";
const DB_PATH = `${SOURCE_ROOT}\\shared-runtime.sqlite`;
const VOLUME = "4".repeat(16);
const ROOT_ID = "1".repeat(32);
const DIR_ID = "2".repeat(32);
const SOURCE_DIR_ID = "3".repeat(32);
const DB_ID = "5".repeat(32);
const STAGE_ID = "6".repeat(32);
const SID_VALUE = "S-1-5-21-1000-2000-3000-500";
const ORG = "org";
const GENESIS_HASH = "7".repeat(64);
const CUT: Cut = { epoch: "epoch-1", seq: 7, hash: "8".repeat(64) };
const ATTEMPT_A = "a".repeat(32);
const ATTEMPT_B = "b".repeat(32);
const ATTEMPT_C = "c".repeat(32);
const ATTEMPT_D = "d".repeat(32);
const ATTEMPT_E = "e".repeat(32);
const ATTEMPT_F = "f".repeat(32);
const ATTEMPT_G = "0".repeat(32);
const PAYLOAD = Buffer.from("published payload こんにちは");
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function makeReservation(
  overrides: {
    attemptId?: string;
    payload?: Uint8Array;
    file?: string;
  } = {},
): PublicationReservation {
  const attemptId = overrides.attemptId ?? ATTEMPT_A;
  const payload = overrides.payload ?? PAYLOAD;
  return {
    contractVersion: 2,
    attemptId,
    path: `${PRIVATE_DIR}\\${overrides.file ?? "new.bin"}`,
    stagingPath: `${PRIVATE_DIR}\\.folio-private-${attemptId}.tmp`,
    root: {
      canonicalPath: ROOT_PATH,
      fileId: ROOT_ID,
      volumeId: VOLUME,
    },
    directory: {
      canonicalPath: PRIVATE_DIR,
      fileId: DIR_ID,
      volumeId: VOLUME,
    },
    byteLength: payload.byteLength,
    sha256: digest(payload),
  };
}

const SOURCE: PublicationSourceIdentity = Object.freeze({
  sourceRoot: SOURCE_ROOT,
  orgId: ORG,
  genesisHash: GENESIS_HASH,
  root: Object.freeze({
    canonicalPath: ROOT_PATH,
    fileId: ROOT_ID,
    volumeId: VOLUME,
  }),
  directory: Object.freeze({
    canonicalPath: SOURCE_ROOT,
    fileId: SOURCE_DIR_ID,
    volumeId: VOLUME,
  }),
  database: Object.freeze({
    canonicalPath: DB_PATH,
    fileId: DB_ID,
    volumeId: VOLUME,
  }),
});
const sourceIdentity = (): PublicationSourceIdentity => SOURCE;

function authorization(
  patch: {
    sourceRoot?: string;
    orgId?: string;
    genesisHash?: string;
    sessionId?: string;
    cut?: Cut;
  } = {},
): PublicationAuthorization {
  return Object.freeze({
    sourceRoot: patch.sourceRoot ?? SOURCE_ROOT,
    orgId: patch.orgId ?? ORG,
    genesisHash: patch.genesisHash ?? GENESIS_HASH,
    auth: Object.freeze({
      userId: "user-1",
      deviceId: "device-1",
      writerId: "writer-1",
      sessionId: patch.sessionId ?? "session-1",
    }),
    cut: Object.freeze({ ...(patch.cut ?? CUT) }),
  });
}
const currentAuthorization = () => authorization();

/** Full 13-key probe evidence matching assertWindowsProbe contract fields. */
function probe(canonicalPath: string, fileId: string) {
  return {
    platform: "win32",
    sid: SID_VALUE,
    ownerSid: SID_VALUE,
    daclPrivate: true,
    reparsePoint: false,
    linkCount: 1,
    localFilesystem: true,
    fileId,
    rootFileId: ROOT_ID,
    volumeId: VOLUME,
    rootVolumeId: VOLUME,
    canonicalPath,
    canonicalRoot: ROOT_PATH,
  };
}

/** Full native PREPARED receipt as captured raw stdout, exact contract keys. */
function preparedReceipt(
  r: PublicationReservation,
  payload: Uint8Array,
) {
  return {
    contractVersion: 2,
    operation: "prepare",
    state: "PREPARED",
    attemptId: r.attemptId,
    path: r.path,
    stagingPath: r.stagingPath,
    root: r.root.canonicalPath,
    byteLength: payload.byteLength,
    sha256: digest(payload),
    bytesBase64: Buffer.from(payload).toString("base64"),
    contentFlushed: true,
    filesystem: "NTFS",
    file: probe(r.stagingPath, STAGE_ID),
    directory: probe(r.directory.canonicalPath, r.directory.fileId),
  };
}

function preparedEvidence(r: PublicationReservation, payload: Uint8Array) {
  return {
    phase: "prepare",
    status: 0,
    reply: { state: "PREPARED", attemptId: r.attemptId },
    captured: {
      status: 0,
      signal: null,
      stdout: JSON.stringify(preparedReceipt(r, payload)),
      stderr: "",
      captureEncoding: "latin1",
    },
  };
}

function wireFields(r: PublicationReservation): Record<string, unknown> {
  return {
    contractVersion: 2,
    attemptId: r.attemptId,
    path: r.path,
    root: r.root.canonicalPath,
    rootFileId: r.root.fileId,
    rootVolumeId: r.root.volumeId,
    directoryFileId: r.directory.fileId,
    directoryVolumeId: r.directory.volumeId,
    stagingPath: r.stagingPath,
    byteLength: r.byteLength,
    sha256: r.sha256,
  };
}
function prepareWire(r: PublicationReservation, payload: Uint8Array): string {
  return JSON.stringify({
    ...wireFields(r),
    operation: "prepare",
    bytesBase64: Buffer.from(payload).toString("base64"),
  });
}
function commitWire(
  r: PublicationReservation,
  patch: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ...wireFields(r),
    operation: "commit-prepared",
    expectedSha256: r.sha256,
    // Production sends the staged identity as fileId/volumeId.
    fileId: STAGE_ID,
    volumeId: VOLUME,
    ...patch,
  });
}

function rawRows(directory: string): Map<string, string> {
  const db = new DatabaseSync(
    join(directory, WINDOWS_PUBLICATION_JOURNAL_DATABASE),
    { readOnly: true },
  );
  try {
    const rows = db
      .prepare("SELECT key,value FROM m3_private_records")
      .all();
    const map = new Map<string, string>();
    for (const row of rows) map.set(String(row.key), String(row.value));
    return map;
  } finally {
    db.close();
  }
}

/** Current native observation whose retained identity and bytes all match. */
function observation(
  r: PublicationReservation,
  payload: Uint8Array,
  patch: Record<string, unknown> = {},
): PublicationNativeObservation {
  return {
    root: { canonicalPath: ROOT_PATH, fileId: ROOT_ID, volumeId: VOLUME },
    directory: {
      canonicalPath: PRIVATE_DIR,
      fileId: DIR_ID,
      volumeId: VOLUME,
    },
    sourceDirectory: {
      canonicalPath: SOURCE_ROOT,
      fileId: SOURCE_DIR_ID,
      volumeId: VOLUME,
    },
    sourceDatabase: {
      canonicalPath: DB_PATH,
      fileId: DB_ID,
      volumeId: VOLUME,
    },
    receipt: {
      contractVersion: 2,
      state: "READ",
      identity: {
        canonicalPath: r.path,
        fileId: STAGE_ID,
        volumeId: VOLUME,
      },
      bytes: new Uint8Array(payload),
      byteLength: payload.byteLength,
      sha256: digest(payload),
    },
    ...patch,
  } as PublicationNativeObservation;
}

function missingObservation(
  r: PublicationReservation,
  payload: Uint8Array,
): PublicationNativeObservation {
  const failure: WindowsPrivateIoV2Failure = {
    contractVersion: 2,
    state: "REJECTED",
    path: r.path,
    attemptId: r.attemptId,
    reason: "missing",
    preserve: true,
  };
  return observation(r, payload, { receipt: failure });
}

function port(
  journal: WindowsPublicationJournal,
  readCurrent: (
    request: PublicationNativeReadRequest,
  ) => PublicationNativeObservation,
): PublicationResolutionPort {
  return createPublicationResolutionPort({ journal, readCurrent });
}

/**
 * Drives a source-bound attempt to UNKNOWN, closes the owning journal and
 * reopens a read-only observer (no source callback — binding is durable).
 * Returns the reopened journal, the snapshot of original rows taken before
 * the close and the observed-read counter.
 */
function retainedUnknown(
  payload: Uint8Array = PAYLOAD,
  attemptId: string = ATTEMPT_A,
): {
  directory: string;
  journal: WindowsPublicationJournal;
  reservation: PublicationReservation;
  payload: Uint8Array;
  before: Map<string, string>;
} {
  const directory = tempDir();
  const owner = openJournal(directory, sourceIdentity);
  const r = makeReservation({ attemptId, payload });
  owner.reserve(r);
  owner.recordDispatch(r.attemptId, "prepare", prepareWire(r, payload));
  owner.recordPrepared(r.attemptId, preparedEvidence(r, payload));
  owner.recordDispatch(
    r.attemptId,
    "commit-prepared",
    commitWire(r),
  );
  owner.recordTerminal(r.attemptId, "UNKNOWN", {
    operation: "commit-prepared",
    state: "UNKNOWN",
  });
  const before = rawRows(directory);
  owner.close();
  return {
    directory,
    journal: openJournal(directory),
    reservation: r,
    payload,
    before,
  };
}

function assertOriginalsPreserved(
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  for (const [key, value] of before) expect(after.get(key)).toBe(value);
}

describe.skipIf(process.platform === "win32")(
  "windows publication resolution — posix-testing seam, not Windows proof",
  () => {
    it("resolves an UNKNOWN attempt from retained proof after reopen, preserving every original row", () => {
      const { journal, reservation, payload, before } = retainedUnknown();
      const reads: PublicationNativeReadRequest[] = [];
      const service = port(journal, (request) => {
        reads.push(request);
        return observation(reservation, payload);
      });
      const inspected = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.version).toBe(1);
      expect(inspected.state).toBe("UNKNOWN");
      expect(inspected.observation).toBe("MATCH");
      expect(inspected.resolvable).toBe(true);
      expect(inspected.preserve).toBe(true);
      expect(inspected.resolution).toBe(null);
      expect(inspected.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(inspected.snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/);
      const resolved = service.resolve(
        {
          attemptId: reservation.attemptId,
          expectedCut: CUT,
          fingerprint: inspected.fingerprint,
        },
        currentAuthorization,
      );
      expect(resolved.outcome).toBe("PUBLISHED_OBSERVED");
      expect(resolved.attemptId).toBe(reservation.attemptId);
      expect(resolved.fingerprint).toBe(inspected.fingerprint);
      expect(resolved.observed.file).toEqual({
        canonicalPath: reservation.path,
        fileId: STAGE_ID,
        volumeId: VOLUME,
      });
      expect(resolved.preserve).toBe(true);
      // Exactly one new row: the immutable resolution record.
      const afterRows = rawRows(journalDirectory(journal));
      assertOriginalsPreserved(before, afterRows);
      const resolutionKeys = [...afterRows.keys()].filter((key) =>
        key.endsWith(":resolution"),
      );
      expect(resolutionKeys).toEqual([
        `attempt:${reservation.attemptId}:resolution`,
      ]);
      // UNKNOWN terminal and state untouched; readCurrent is the only native
      // interaction — no publication dispatch or terminal was invoked.
      expect(reads).toHaveLength(2);
      expect(journal.inspect(reservation.attemptId)?.state).toBe("UNKNOWN");
      expect(() =>
        journal.reserve(makeReservation({ attemptId: ATTEMPT_B })),
      ).toThrow(/TARGET_CONSUMED|ATTEMPT_CONSUMED/);
      expect(() =>
        journal.recordDispatch(
          reservation.attemptId,
          "prepare",
          prepareWire(reservation, payload),
        ),
      ).toThrow(/AUTHORITY/);
      expect(() =>
        journal.recordTerminal(reservation.attemptId, "PUBLISHED", {}),
      ).toThrow(/AUTHORITY|TERMINAL/);
      // A repeated resolve returns the recorded observation without new rows.
      const again = service.resolve(
        {
          attemptId: reservation.attemptId,
          expectedCut: CUT,
          fingerprint: inspected.fingerprint,
        },
        currentAuthorization,
      );
      expect(canonical(again)).toBe(canonical(resolved));
      assertOriginalsPreserved(afterRows, rawRows(journalDirectory(journal)));
      expect(
        [...rawRows(journalDirectory(journal)).keys()].filter((key) =>
          key.endsWith(":resolution"),
        ),
      ).toHaveLength(1);
    });

    it("revalidates fresh authorization even when a resolution row already exists", () => {
      const { journal, reservation, payload } = retainedUnknown();
      let armDrift = false;
      let drifted = false;
      const service = port(journal, () => {
        // Authorization changes during the native read, before the journal
        // append — armed only after the first resolution is recorded.
        if (armDrift) drifted = true;
        return observation(reservation, payload);
      });
      const auth = () =>
        authorization(drifted ? { cut: { ...CUT, seq: CUT.seq + 1 } } : {});
      const inspected = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        auth,
      );
      const resolved = service.resolve(
        {
          attemptId: reservation.attemptId,
          expectedCut: CUT,
          fingerprint: inspected.fingerprint,
        },
        auth,
      );
      expect(resolved.outcome).toBe("PUBLISHED_OBSERVED");
      const storedBody = rawRows(journalDirectory(journal)).get(
        `attempt:${reservation.attemptId}:resolution`,
      );
      expect(typeof storedBody).toBe("string");
      // An existing record never skips fresh native read and authorization:
      // a drifted callback at append time still refuses and keeps the row.
      armDrift = true;
      const revisited = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        auth,
      );
      expect(revisited.resolution).not.toBe(null);
      drifted = false;
      expect(() =>
        service.resolve(
          {
            attemptId: reservation.attemptId,
            expectedCut: CUT,
            fingerprint: revisited.fingerprint,
          },
          auth,
        ),
      ).toThrow(/AUTHORIZATION/);
      expect(
        rawRows(journalDirectory(journal)).get(
          `attempt:${reservation.attemptId}:resolution`,
        ),
      ).toBe(storedBody);
    });

    it("resolves a COMMIT_DISPATCHED crash that never recorded a terminal", () => {
      const directory = tempDir();
      const owner = openJournal(directory, sourceIdentity);
      const r = makeReservation({ attemptId: ATTEMPT_B });
      owner.reserve(r);
      owner.recordDispatch(r.attemptId, "prepare", prepareWire(r, PAYLOAD));
      owner.recordPrepared(r.attemptId, preparedEvidence(r, PAYLOAD));
      owner.recordDispatch(r.attemptId, "commit-prepared", commitWire(r));
      owner.close();
      const journal = openJournal(directory);
      expect(journal.inspect(r.attemptId)?.state).toBe("COMMIT_DISPATCHED");
      const service = port(journal, () => observation(r, PAYLOAD));
      const inspected = service.inspect(
        { attemptId: r.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.observation).toBe("MATCH");
      expect(inspected.resolvable).toBe(true);
      const resolved = service.resolve(
        {
          attemptId: r.attemptId,
          expectedCut: CUT,
          fingerprint: inspected.fingerprint,
        },
        currentAuthorization,
      );
      expect(resolved.outcome).toBe("PUBLISHED_OBSERVED");
      // The terminal is still absent; resolution never fabricates outcomes.
      expect(journal.inspect(r.attemptId)?.state).toBe("COMMIT_DISPATCHED");
      expect(
        journal.inspect(r.attemptId)?.terminal,
      ).toBe(null);
    });

    it("resolves a zero-length retained payload", () => {
      const empty = new Uint8Array(0);
      const { journal, reservation, before } = retainedUnknown(
        empty,
        ATTEMPT_C,
      );
      const service = port(journal, () =>
        observation(reservation, empty),
      );
      const inspected = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.observation).toBe("MATCH");
      const resolved = service.resolve(
        {
          attemptId: reservation.attemptId,
          expectedCut: CUT,
          fingerprint: inspected.fingerprint,
        },
        currentAuthorization,
      );
      expect(resolved.observed.byteLength).toBe(0);
      assertOriginalsPreserved(before, rawRows(journalDirectory(journal)));
    });

    it("reports unconfirmed for changed root, directory, file or volume identities with identical content", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const variants: Record<string, unknown>[] = [
        {
          root: {
            canonicalPath: ROOT_PATH,
            fileId: "9".repeat(32),
            volumeId: VOLUME,
          },
        },
        {
          directory: {
            canonicalPath: PRIVATE_DIR,
            fileId: "9".repeat(32),
            volumeId: VOLUME,
          },
        },
        {
          root: {
            canonicalPath: ROOT_PATH,
            fileId: ROOT_ID,
            volumeId: "9".repeat(16),
          },
        },
        {
          receipt: {
            contractVersion: 2,
            state: "READ",
            identity: {
              canonicalPath: reservation.path,
              fileId: "9".repeat(32),
              volumeId: VOLUME,
            },
            bytes: new Uint8Array(payload),
            byteLength: payload.byteLength,
            sha256: digest(payload),
          },
        },
        {
          sourceDirectory: {
            canonicalPath: SOURCE_ROOT,
            fileId: "9".repeat(32),
            volumeId: VOLUME,
          },
        },
        {
          sourceDatabase: {
            canonicalPath: DB_PATH,
            fileId: "9".repeat(32),
            volumeId: VOLUME,
          },
        },
      ];
      for (const patch of variants) {
        const service = port(journal, () =>
          observation(reservation, payload, patch),
        );
        const inspected = service.inspect(
          { attemptId: reservation.attemptId, expectedCut: CUT },
          currentAuthorization,
        );
        expect(inspected.observation).toBe("UNCONFIRMED");
        expect(inspected.resolvable).toBe(false);
        expect(() =>
          service.resolve(
            {
              attemptId: reservation.attemptId,
              expectedCut: CUT,
              fingerprint: inspected.fingerprint,
            },
            currentAuthorization,
          ),
        ).toThrow(/UNCONFIRMED|FINGERPRINT/);
      }
      expect(
        rawRows(journalDirectory(journal)).has(
          `attempt:${reservation.attemptId}:resolution`,
        ),
      ).toBe(false);
    });

    it("reports unconfirmed for changed bytes even when the receipt claims the retained digest", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const different = Buffer.alloc(payload.byteLength, 0x41);
      const service = port(journal, () =>
        observation(reservation, payload, {
          receipt: {
            contractVersion: 2,
            state: "READ",
            identity: {
              canonicalPath: reservation.path,
              fileId: STAGE_ID,
              volumeId: VOLUME,
            },
            bytes: new Uint8Array(different),
            byteLength: payload.byteLength,
            sha256: digest(payload), // claimed, recomputation disagrees
          },
        }),
      );
      const inspected = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.observation).toBe("UNCONFIRMED");
      expect(inspected.resolvable).toBe(false);
    });

    it("reports unconfirmed when the current final file is missing", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const service = port(journal, () =>
        missingObservation(reservation, payload),
      );
      const inspected = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.observation).toBe("UNCONFIRMED");
      expect(inspected.resolvable).toBe(false);
      expect(() =>
        service.resolve(
          {
            attemptId: reservation.attemptId,
            expectedCut: CUT,
            fingerprint: inspected.fingerprint,
          },
          currentAuthorization,
        ),
      ).toThrow(/UNCONFIRMED|FINGERPRINT/);
    });

    it("refuses resolution without retained stage proof while retaining inspect metadata", () => {
      const directory = tempDir();
      const owner = openJournal(directory, sourceIdentity);
      const r = makeReservation({ attemptId: ATTEMPT_D });
      owner.reserve(r);
      owner.recordDispatch(r.attemptId, "prepare", prepareWire(r, PAYLOAD));
      // Stored prepared summary only — no retained raw native capture.
      owner.recordPrepared(r.attemptId, {
        operation: "prepare",
        state: "PREPARED",
      });
      owner.recordDispatch(r.attemptId, "commit-prepared", commitWire(r));
      owner.recordTerminal(r.attemptId, "UNKNOWN", {
        operation: "commit-prepared",
        state: "UNKNOWN",
      });
      owner.close();
      const journal = openJournal(directory);
      let calls = 0;
      const service = port(journal, () => {
        calls++;
        return observation(r, PAYLOAD);
      });
      const inspected = service.inspect(
        { attemptId: r.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.state).toBe("UNKNOWN");
      expect(inspected.observation).toBe("UNCONFIRMED");
      expect(inspected.resolvable).toBe(false);
      expect(calls).toBe(0);
      expect(() =>
        service.resolve(
          {
            attemptId: r.attemptId,
            expectedCut: CUT,
            fingerprint: inspected.fingerprint,
          },
          currentAuthorization,
        ),
      ).toThrow(/STAGE_PROOF_MISSING/);
      expect(calls).toBe(0);
    });

    it("refuses resolution for a preexisting source-unbound attempt and never backfills", () => {
      const directory = tempDir();
      const owner = openJournal(directory); // no source binding callback
      const r = makeReservation({ attemptId: ATTEMPT_E });
      owner.reserve(r);
      owner.recordDispatch(r.attemptId, "prepare", prepareWire(r, PAYLOAD));
      owner.recordPrepared(r.attemptId, preparedEvidence(r, PAYLOAD));
      owner.recordDispatch(r.attemptId, "commit-prepared", commitWire(r));
      owner.recordTerminal(r.attemptId, "UNKNOWN", {
        operation: "commit-prepared",
        state: "UNKNOWN",
      });
      owner.close();
      const journal = openJournal(directory, sourceIdentity);
      let calls = 0;
      const service = port(journal, () => {
        calls++;
        return observation(r, PAYLOAD);
      });
      const inspected = service.inspect(
        { attemptId: r.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.observation).toBe("UNCONFIRMED");
      expect(inspected.resolvable).toBe(false);
      expect(calls).toBe(0);
      expect(() =>
        service.resolve(
          {
            attemptId: r.attemptId,
            expectedCut: CUT,
            fingerprint: inspected.fingerprint,
          },
          currentAuthorization,
        ),
      ).toThrow(/SOURCE_MISSING/);
      expect(
        rawRows(journalDirectory(journal)).has(
          `attempt:${r.attemptId}:source`,
        ),
      ).toBe(false);
      expect(calls).toBe(0);
    });

    it("rejects foreign source root, org and genesis authorization", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const service = port(journal, () =>
        observation(reservation, payload),
      );
      for (const auth of [
        authorization({ sourceRoot: "C:\\Elsewhere" }),
        authorization({ orgId: "foreign-org" }),
        authorization({ genesisHash: "9".repeat(64) }),
      ]) {
        expect(() =>
          service.inspect(
            { attemptId: reservation.attemptId, expectedCut: CUT },
            () => auth,
          ),
        ).toThrow(/AUTHORIZATION/);
      }
    });

    it("rejects a stale or changed head cut", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const service = port(journal, () =>
        observation(reservation, payload),
      );
      const stale = { ...CUT, seq: CUT.seq + 1 };
      expect(() =>
        service.inspect(
          { attemptId: reservation.attemptId, expectedCut: stale },
          currentAuthorization,
        ),
      ).toThrow(/AUTHORIZATION_CUT/);
      expect(() =>
        service.inspect(
          { attemptId: reservation.attemptId, expectedCut: CUT },
          () => authorization({ cut: stale }),
        ),
      ).toThrow(/AUTHORIZATION_CUT/);
    });

    it("rejects a stale resolve fingerprint and leaves no record", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const service = port(journal, () =>
        observation(reservation, payload),
      );
      expect(() =>
        service.resolve(
          {
            attemptId: reservation.attemptId,
            expectedCut: CUT,
            fingerprint: "9".repeat(64),
          },
          currentAuthorization,
        ),
      ).toThrow(/FINGERPRINT/);
      expect(
        rawRows(journalDirectory(journal)).has(
          `attempt:${reservation.attemptId}:resolution`,
        ),
      ).toBe(false);
    });

    it("rejects asynchronous or thenable authorization and native callbacks", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const service = port(journal, () =>
        observation(reservation, payload),
      );
      expect(() =>
        service.inspect(
          { attemptId: reservation.attemptId, expectedCut: CUT },
          (async () => authorization()) as never,
        ),
      ).toThrow(/AUTHORIZATION/);
      const thenable = { then: () => authorization() };
      expect(() =>
        service.inspect(
          { attemptId: reservation.attemptId, expectedCut: CUT },
          (() => thenable) as never,
        ),
      ).toThrow(/AUTHORIZATION/);
      expect(() =>
        createPublicationResolutionPort({
          journal,
          readCurrent: (async () =>
            observation(reservation, payload)) as never,
        }),
      ).toThrow(/OPTIONS/);
      const thenableRead = port(journal, () =>
        ({ then: () => observation(reservation, payload) }) as never,
      );
      expect(() =>
        thenableRead.inspect(
          { attemptId: reservation.attemptId, expectedCut: CUT },
          currentAuthorization,
        ),
      ).toThrow(/OBSERVATION/);
    });

    it("refuses a then-getter without executing it and drains a rejected Promise", async () => {
      const { journal, reservation, payload } = retainedUnknown();
      const service = port(journal, () =>
        observation(reservation, payload),
      );
      let getterRan = false;
      const thenable = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(thenable, "then", {
        enumerable: true,
        get: () => {
          getterRan = true;
          return () => undefined;
        },
      });
      expect(() =>
        service.inspect(
          { attemptId: reservation.attemptId, expectedCut: CUT },
          (() => thenable) as never,
        ),
      ).toThrow(/AUTHORIZATION/);
      expect(getterRan).toBe(false);
      expect(() =>
        service.inspect(
          { attemptId: reservation.attemptId, expectedCut: CUT },
          (() =>
            Promise.reject(
              new Error("deferred authorization"),
            )) as never,
        ),
      ).toThrow(/AUTHORIZATION/);
      // The drained rejection handler settles silently; no unhandled
      // rejection escapes the refusal.
      await Promise.resolve();
      await Promise.resolve();
    });

    it("writes no record when authorization changes during the native read", () => {
      const { journal, reservation, payload } = retainedUnknown();
      let drifted = false;
      const service = port(journal, () => {
        drifted = true; // session/cut changes before the journal append
        return observation(reservation, payload);
      });
      const auth = () =>
        authorization(
          drifted
            ? { cut: { ...CUT, seq: CUT.seq + 1 } }
            : {},
        );
      const inspected = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        auth,
      );
      expect(inspected.observation).toBe("MATCH");
      drifted = false;
      expect(() =>
        service.resolve(
          {
            attemptId: reservation.attemptId,
            expectedCut: CUT,
            fingerprint: inspected.fingerprint,
          },
          auth,
        ),
      ).toThrow(/AUTHORIZATION/);
      expect(
        rawRows(journalDirectory(journal)).has(
          `attempt:${reservation.attemptId}:resolution`,
        ),
      ).toBe(false);
    });

    it("keeps retained identities authoritative when the reader mutates its supplied request", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const service = port(journal, (request) => {
        // Reader attempts to rewrite the retained snapshot; frozen.
        try {
          (request.source.directory as { fileId: string }).fileId =
            "9".repeat(32);
        } catch {}
        try {
          (request.preparedFile as { fileId: string }).fileId =
            "9".repeat(32);
        } catch {}
        return observation(reservation, payload);
      });
      const inspected = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.observation).toBe("MATCH");
      const resolved = service.resolve(
        {
          attemptId: reservation.attemptId,
          expectedCut: CUT,
          fingerprint: inspected.fingerprint,
        },
        currentAuthorization,
      );
      expect(resolved.observed.file.fileId).toBe(STAGE_ID);
      expect(resolved.observed.sourceDirectory.fileId).toBe(SOURCE_DIR_ID);
    });

    it("rejects a foreign session by refusing resolution of an unmatched fingerprint", () => {
      const { journal, reservation, payload } = retainedUnknown();
      const service = port(journal, () =>
        observation(reservation, payload),
      );
      const foreign = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        () => authorization({ sessionId: "session-foreign" }),
      );
      const own = service.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(foreign.fingerprint).not.toBe(own.fingerprint);
      expect(() =>
        service.resolve(
          {
            attemptId: reservation.attemptId,
            expectedCut: CUT,
            fingerprint: foreign.fingerprint,
          },
          currentAuthorization,
        ),
      ).toThrow(/FINGERPRINT|AUTHORIZATION/);
    });

    it("rejects a snapshot changed between inspect and resolve", () => {
      const { directory, journal, reservation, payload } =
        retainedUnknown();
      const first = port(journal, () => observation(reservation, payload));
      const inspected = first.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.observation).toBe("MATCH");
      journal.close();
      // Tamper with a retained free-form evidence row: the terminal record
      // stays valid UNKNOWN evidence but its bytes (and fingerprint) change.
      const db = new DatabaseSync(
        join(directory, WINDOWS_PUBLICATION_JOURNAL_DATABASE),
      );
      try {
        db.prepare(
          "UPDATE m3_private_records SET value = ? WHERE key = ?",
        ).run(
          canonical({
            version: 1,
            outcome: "UNKNOWN",
            evidence: { operation: "commit-prepared", state: "UNKNOWN", note: "tampered" },
          }),
          `attempt:${reservation.attemptId}:terminal`,
        );
      } finally {
        db.close();
      }
      const reopened = openJournal(directory);
      const second = port(reopened, () =>
        observation(reservation, payload),
      );
      const revisited = second.inspect(
        { attemptId: reservation.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(revisited.snapshotFingerprint).not.toBe(
        inspected.snapshotFingerprint,
      );
      expect(() =>
        second.resolve(
          {
            attemptId: reservation.attemptId,
            expectedCut: CUT,
            fingerprint: inspected.fingerprint,
          },
          currentAuthorization,
        ),
      ).toThrow(/FINGERPRINT/);
    });

    it("refuses observation for live-owned attempts and terminal states", () => {
      const directory = tempDir();
      const owner = openJournal(directory, sourceIdentity);
      const live = makeReservation({ attemptId: ATTEMPT_F });
      owner.reserve(live);
      owner.recordDispatch(
        live.attemptId,
        "prepare",
        prepareWire(live, PAYLOAD),
      );
      owner.recordPrepared(live.attemptId, preparedEvidence(live, PAYLOAD));
      owner.recordDispatch(
        live.attemptId,
        "commit-prepared",
        commitWire(live),
      );
      // Still owned: investigation never claims proof or reads natively.
      let calls = 0;
      const liveService = port(owner, () => {
        calls++;
        return observation(live, PAYLOAD);
      });
      const liveInspect = liveService.inspect(
        { attemptId: live.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(liveInspect.state).toBe("COMMIT_DISPATCHED");
      expect(liveInspect.observation).toBe("UNCONFIRMED");
      expect(liveInspect.resolvable).toBe(false);
      expect(calls).toBe(0);
      owner.recordTerminal(live.attemptId, "PUBLISHED", {
        operation: "commit-prepared",
        state: "PUBLISHED",
      });
      owner.close();
      const journal = openJournal(directory);
      const service = port(journal, () => {
        calls++;
        return observation(live, PAYLOAD);
      });
      const inspected = service.inspect(
        { attemptId: live.attemptId, expectedCut: CUT },
        currentAuthorization,
      );
      expect(inspected.state).toBe("PUBLISHED");
      expect(inspected.observation).toBe("UNCONFIRMED");
      expect(inspected.resolvable).toBe(false);
      expect(() =>
        service.resolve(
          {
            attemptId: live.attemptId,
            expectedCut: CUT,
            fingerprint: inspected.fingerprint,
          },
          currentAuthorization,
        ),
      ).toThrow(/RESOLUTION_STATE/);
      expect(calls).toBe(0);
    });

    it("reports missing attempts explicitly without raw output", () => {
      const { journal, reservation } = retainedUnknown();
      const service = port(journal, () => {
        throw new Error("must not be called");
      });
      expect(() =>
        service.inspect(
          { attemptId: ATTEMPT_G, expectedCut: CUT },
          currentAuthorization,
        ),
      ).toThrow(/ATTEMPT_MISSING/);
      expect(journal.inspect(reservation.attemptId)).not.toBe(null);
    });
  },
);

/** The ledger directory a journal is bound to, for raw row snapshots. */
function journalDirectory(journal: WindowsPublicationJournal): string {
  return (journal as unknown as { boundDirectory: string }).boundDirectory;
}
