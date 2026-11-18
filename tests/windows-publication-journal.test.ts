import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Json } from "../src/collaboration/runtime/contract";
import { canonical } from "../src/collaboration/runtime/canonical";
import { asciiCaseFold } from "../src/platform/windows/path-policy";
import {
  WINDOWS_PUBLICATION_MAX_BYTES,
  WINDOWS_PUBLICATION_MAX_WIRE_BYTES,
  type PublicationReservation,
} from "../src/platform/windows/publication-contract";
import {
  WindowsPublicationJournal,
  WINDOWS_PUBLICATION_JOURNAL_DATABASE,
} from "../src/platform/windows/publication-journal";
import type { PublicationSourceIdentity } from "../src/platform/windows/publication-resolution";
import { PrivateLedger } from "../src/sync/private-ledger";
import {
  PosixPrivatePlatform,
  type PrivatePlatform,
} from "../src/sync/private-platform";
import { SyncError } from "../src/sync/protocol";
import { SyncSqliteGuard } from "../src/sync/sqlite-guard";

// Real disposable SQLite plus a PosixPrivatePlatform relabelled "windows":
// contract-only posix-testing coverage, never Windows OS/filesystem proof.
const JOURNAL_ROLE = "windows-publication-v2";
const CHUNK_BYTES = 24 * 1024;

const roots: string[] = [];
const journals: WindowsPublicationJournal[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const journal of journals.splice(0)) {
    try {
      journal.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "folio-pub-journal-")));
  chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

/**
 * Fresh adapter per journal: PosixPrivatePlatform can only bind once, so each
 * construction needs a new instance tagged kind:"windows". This delegation is
 * the labelled posix-testing seam and must not be read as native acceptance.
 */
function testingPlatform(): {
  port: PrivatePlatform;
  failRoot(): void;
  heal(): void;
} {
  const inner = new PosixPrivatePlatform();
  let failRoot = false;
  const port: PrivatePlatform = {
    kind: "windows",
    bind: vi.fn((directory: string) => inner.bind(directory)),
    assertRoot: vi.fn(() => {
      if (failRoot)
        throw new SyncError("windows-private-root-unproven", 409);
      inner.assertRoot();
    }),
    assertFile: vi.fn((path: string) => inner.assertFile(path)),
    assertSidecars: vi.fn((path: string) => inner.assertSidecars(path)),
    createExclusive: vi.fn((path: string) => inner.createExclusive(path)),
    assertEmptyFile: vi.fn((path: string) => inner.assertEmptyFile(path)),
    close: vi.fn(() => inner.close()),
  };
  return {
    port,
    failRoot: () => {
      failRoot = true;
    },
    heal: () => {
      failRoot = false;
    },
  };
}

function openJournal(
  directory: string,
  forbiddenRoots: readonly string[] = [],
): WindowsPublicationJournal {
  const journal = new WindowsPublicationJournal(
    directory,
    testingPlatform().port,
    forbiddenRoots,
  );
  journals.push(journal);
  return journal;
}

const ROOT_PATH = "C:\\Folio";
const DIR_PATH = "C:\\Folio\\Private";
const VOLUME = "4".repeat(16);
const ROOT_ID = "1".repeat(32);
const DIR_ID = "2".repeat(32);
const ATTEMPT_A = "a".repeat(32);
const ATTEMPT_B = "b".repeat(32);
const ATTEMPT_C = "c".repeat(32);
const ATTEMPT_D = "d".repeat(32);
const ATTEMPT_E = "e".repeat(32);
const DEFAULT_PAYLOAD = Buffer.from("folio publication payload v2 こんにちは");
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function makeReservation(
  overrides: {
    attemptId?: string;
    payload?: Uint8Array;
    path?: string;
    file?: string;
    directory?: string;
    root?: string;
    rootFileId?: string;
    rootVolumeId?: string;
    directoryFileId?: string;
    directoryVolumeId?: string;
    stagingPath?: string;
  } = {},
): PublicationReservation {
  const attemptId = overrides.attemptId ?? ATTEMPT_A;
  const payload = overrides.payload ?? DEFAULT_PAYLOAD;
  const directory = overrides.directory ?? DIR_PATH;
  const path = overrides.path ?? `${directory}\\${overrides.file ?? "new.bin"}`;
  return {
    contractVersion: 2,
    attemptId,
    path,
    stagingPath:
      overrides.stagingPath ??
      `${directory}\\.folio-private-${attemptId}.tmp`,
    root: {
      canonicalPath: overrides.root ?? ROOT_PATH,
      fileId: overrides.rootFileId ?? ROOT_ID,
      volumeId: overrides.rootVolumeId ?? VOLUME,
    },
    directory: {
      canonicalPath: directory,
      fileId: overrides.directoryFileId ?? DIR_ID,
      volumeId: overrides.directoryVolumeId ?? VOLUME,
    },
    byteLength: payload.byteLength,
    sha256: digest(payload),
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
function prepareWire(
  r: PublicationReservation,
  payload: Uint8Array = DEFAULT_PAYLOAD,
  patch: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ...wireFields(r),
    operation: "prepare",
    bytesBase64: Buffer.from(payload).toString("base64"),
    ...patch,
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
    for (const row of rows)
      map.set(String(row.key), String(row.value));
    return map;
  } finally {
    db.close();
  }
}

function reconstructWire(
  rows: Map<string, string>,
  attemptId: string,
  phase: "prepare" | "commit-prepared",
): string {
  const manifest = JSON.parse(
    rows.get(`attempt:${attemptId}:dispatch:${phase}`)!,
  ) as { chunkCount: number };
  const parts: Buffer[] = [];
  for (let index = 0; index < manifest.chunkCount; index++)
    parts.push(
      Buffer.from(
        rows.get(
          `attempt:${attemptId}:wire:${phase}:${String(index).padStart(4, "0")}`,
        )!,
        "base64",
      ),
    );
  return Buffer.concat(parts).toString("utf8");
}

describe.skipIf(process.platform === "win32")(
  "windows publication journal v2 — posix-testing seam, not Windows proof",
  () => {
    it("persists the canonical reservation and target index atomically, never mutating originals", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const r = makeReservation();
      journal.reserve(r);
      const expectedBody = canonical(r);
      const identity = canonical([
        asciiCaseFold(VOLUME),
        asciiCaseFold(ROOT_ID),
        asciiCaseFold(VOLUME),
        asciiCaseFold(DIR_ID),
        asciiCaseFold("new.bin"),
      ]);
      const expectedIndex = canonical({
        attemptId: r.attemptId,
        identity,
      });
      const rows = rawRows(dir);
      const reservationRow = rows.get(
        `attempt:${r.attemptId}:reservation`,
      );
      expect(
        typeof reservationRow === "string" &&
          reservationRow === expectedBody,
      ).toBe(true);
      const indexRow = rows.get(`target:${digest(identity)}`);
      expect(
        typeof indexRow === "string" && indexRow === expectedIndex,
      ).toBe(true);
      journal.recordDispatch(
        r.attemptId,
        "prepare",
        prepareWire(r, DEFAULT_PAYLOAD),
      );
      journal.recordPrepared(r.attemptId, {
        operation: "prepare",
        state: "PREPARED",
      });
      journal.recordDispatch(
        r.attemptId,
        "commit-prepared",
        commitWire(r),
      );
      journal.recordTerminal(r.attemptId, "PUBLISHED", {
        operation: "commit-prepared",
        state: "PUBLISHED",
      });
      const after = rawRows(dir);
      expect(
        after.get(`attempt:${r.attemptId}:reservation`) === expectedBody,
      ).toBe(true);
      expect(
        after.get(`target:${digest(identity)}`) === expectedIndex,
      ).toBe(true);
      expect(journal.inspect(r.attemptId)?.state).toBe("PUBLISHED");
    });

    it("retains consumed attempts and case-aliased targets across a simulated pre-dispatch loss and reopen", () => {
      const dir = tempDir();
      const first = openJournal(dir);
      const r = makeReservation();
      first.reserve(r);
      // Simulated timeout before stage creation: no further call at all.
      first.close();
      const reopened = openJournal(dir);
      expect(() => reopened.reserve(r)).toThrow(/ATTEMPT_CONSUMED/);
      const sameTarget = makeReservation({ attemptId: ATTEMPT_B });
      expect(() => reopened.reserve(sameTarget)).toThrow(
        /TARGET_CONSUMED/,
      );
      const aliasDir = "C:\\Folio\\PRIVATE";
      const alias = makeReservation({
        attemptId: ATTEMPT_B,
        directory: aliasDir,
        path: `${aliasDir}\\NEW.BIN`,
        stagingPath: `${aliasDir}\\.folio-private-${ATTEMPT_B}.tmp`,
      });
      expect(() => reopened.reserve(alias)).toThrow(/TARGET_CONSUMED/);
      expect(() =>
        reopened.reserve({ ...r, byteLength: r.byteLength + 1 }),
      ).toThrow(/ATTEMPT_REUSED/);
      const parallel = openJournal(dir);
      expect(() => parallel.reserve(sameTarget)).toThrow(
        /TARGET_CONSUMED/,
      );
      expect(() =>
        reopened.recordDispatch(
          r.attemptId,
          "prepare",
          prepareWire(r, DEFAULT_PAYLOAD),
        ),
      ).toThrow(/DISPATCH_AUTHORITY/);
      expect(reopened.inspect(r.attemptId)?.state).toBe("RESERVED");
    });

    it("records a full lifecycle, preserves raw wire bytes and returns metadata-only inspection", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const payload = Buffer.from(
        "binary payload with unicode こんにちは \u00ff\u0000",
      );
      const r = makeReservation({
        payload,
        path: `${DIR_PATH}\\report.bin`,
      });
      journal.reserve(r);
      const marker = "SECRET-MARKER-かな";
      const wire =
        `{\n  "contractVersion":2,\n  "operation":"prepare",\n` +
        `  "attemptId":"${r.attemptId}",\n` +
        `  "path":${JSON.stringify(r.path)},\n` +
        `  "root":${JSON.stringify(r.root.canonicalPath)},\n` +
        `  "rootFileId":"${r.root.fileId}",\n` +
        `  "rootVolumeId":"${r.root.volumeId}",\n` +
        `  "directoryFileId":"${r.directory.fileId}",\n` +
        `  "directoryVolumeId":"${r.directory.volumeId}",\n` +
        `  "stagingPath":${JSON.stringify(r.stagingPath)},\n` +
        `  "byteLength":${r.byteLength},\n` +
        `  "sha256":"${r.sha256}",\n` +
        `  "bytesBase64":"${payload.toString("base64")}",\n` +
        `  "memo":${JSON.stringify(marker)},\n` +
        `  "unicod\\u0065":"escaped key spelling"\n}`;
      journal.recordDispatch(r.attemptId, "prepare", wire);
      const rows = rawRows(dir);
      const manifestBody = rows.get(
        `attempt:${r.attemptId}:dispatch:prepare`,
      );
      const manifest = JSON.parse(manifestBody!) as {
        byteLength: number;
        sha256: string;
        chunkCount: number;
        chunkBytes: number;
      };
      const wireBytes = Buffer.from(wire, "utf8");
      expect(manifest.byteLength === wireBytes.byteLength).toBe(true);
      expect(manifest.sha256 === digest(wireBytes)).toBe(true);
      expect(
        manifest.chunkCount ===
          Math.ceil(wireBytes.byteLength / CHUNK_BYTES),
      ).toBe(true);
      expect(manifest.chunkBytes === CHUNK_BYTES).toBe(true);
      const reconstructed = reconstructWire(
        rows,
        r.attemptId,
        "prepare",
      );
      expect(reconstructed === wire).toBe(true);
      journal.recordPrepared(r.attemptId, {
        operation: "prepare",
        state: "PREPARED",
        note: marker,
      });
      journal.recordDispatch(r.attemptId, "commit-prepared", commitWire(r));
      journal.recordTerminal(r.attemptId, "PUBLISHED", {
        operation: "commit-prepared",
        state: "PUBLISHED",
        note: marker,
      });
      const inspection = journal.inspect(r.attemptId);
      expect(inspection?.state).toBe("PUBLISHED");
      expect(
        inspection?.dispatches.map((d) => d.phase),
      ).toEqual(["prepare", "commit-prepared"]);
      expect(
        inspection?.dispatches[0].sha256 === digest(wireBytes),
      ).toBe(true);
      expect(inspection?.prepared).not.toBeNull();
      expect(inspection?.terminal?.outcome).toBe("PUBLISHED");
      const metadata = JSON.stringify(inspection);
      expect(metadata.includes(marker)).toBe(false);
      expect(metadata.includes("bytesBase64")).toBe(false);
      expect(metadata.includes("evidence")).toBe(false);
      const expectedBody = canonical(r);
      expect(
        rawRows(dir).get(`attempt:${r.attemptId}:reservation`) ===
          expectedBody,
      ).toBe(true);
    });

    it("accepts the payload-derived wire budget across chunks and refuses an over-global-bound wire", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const payload = Buffer.alloc(WINDOWS_PUBLICATION_MAX_BYTES, 0x61);
      const r = makeReservation({ payload });
      journal.reserve(r);
      const memo = "日本語メモ".repeat(400);
      const base = prepareWire(r, payload, { memo });
      const nativeProfileBound = 4 * Math.ceil(payload.length / 3) + 8192;
      const pad =
        nativeProfileBound -
        Buffer.byteLength(base, "utf8");
      expect(pad >= 0).toBe(true);
      const wire = base + " ".repeat(pad);
      expect(
        Buffer.byteLength(wire, "utf8") ===
          nativeProfileBound,
      ).toBe(true);
      journal.recordDispatch(r.attemptId, "prepare", wire);
      const rows = rawRows(dir);
      const manifest = JSON.parse(
        rows.get(`attempt:${r.attemptId}:dispatch:prepare`)!,
      ) as { chunkCount: number };
      expect(
        manifest.chunkCount ===
          Math.ceil(nativeProfileBound / CHUNK_BYTES),
      ).toBe(true);
      expect(reconstructWire(rows, r.attemptId, "prepare") === wire).toBe(
        true,
      );
      const oversized = makeReservation({
        attemptId: ATTEMPT_B,
        payload,
        file: "big.bin",
      });
      const oversizeJournal = openJournal(tempDir());
      oversizeJournal.reserve(oversized);
      const over =
        prepareWire(oversized, payload) +
        " ".repeat(
          WINDOWS_PUBLICATION_MAX_WIRE_BYTES +
            1 -
            Buffer.byteLength(prepareWire(oversized, payload), "utf8"),
        );
      expect(() =>
        oversizeJournal.recordDispatch(oversized.attemptId, "prepare", over),
      ).toThrow(/WIRE_BOUNDS/);
    });

    it("enforces the dispatch/prepared/terminal order and single-fire transitions", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const r = makeReservation();
      journal.reserve(r);
      expect(() => journal.recordPrepared(r.attemptId, {})).toThrow(
        /DISPATCH_AUTHORITY/,
      );
      expect(() =>
        journal.recordDispatch(
          r.attemptId,
          "commit-prepared",
          commitWire(r),
        ),
      ).toThrow(/DISPATCH_AUTHORITY/);
      journal.recordDispatch(
        r.attemptId,
        "prepare",
        prepareWire(r, DEFAULT_PAYLOAD),
      );
      expect(() =>
        journal.recordDispatch(
          r.attemptId,
          "prepare",
          prepareWire(r, DEFAULT_PAYLOAD),
        ),
      ).toThrow(/DISPATCH_AUTHORITY/);
      expect(() =>
        journal.recordDispatch(
          r.attemptId,
          "commit-prepared",
          commitWire(r),
        ),
      ).toThrow(/DISPATCH_AUTHORITY/);
      journal.recordPrepared(r.attemptId, {
        operation: "prepare",
        state: "PREPARED",
      });
      expect(() => journal.recordPrepared(r.attemptId, {})).toThrow(
        /DISPATCH_AUTHORITY/,
      );
      expect(() =>
        journal.recordTerminal(r.attemptId, "PUBLISHED", {}),
      ).toThrow(/TERMINAL_STATE/);
      journal.recordDispatch(r.attemptId, "commit-prepared", commitWire(r));
      expect(() =>
        journal.recordDispatch(
          r.attemptId,
          "commit-prepared",
          commitWire(r),
        ),
      ).toThrow(/DISPATCH_AUTHORITY/);
      journal.recordTerminal(r.attemptId, "PUBLISHED", {
        operation: "commit-prepared",
        state: "PUBLISHED",
      });
      expect(() =>
        journal.recordTerminal(r.attemptId, "UNKNOWN", {}),
      ).toThrow(/TERMINAL/);
      expect(() =>
        journal.recordDispatch(
          r.attemptId,
          "prepare",
          prepareWire(r, DEFAULT_PAYLOAD),
        ),
      ).toThrow(/DISPATCH_AUTHORITY/);
      expect(() => journal.recordPrepared(r.attemptId, {})).toThrow(
        /DISPATCH_AUTHORITY/,
      );

      const unknown = makeReservation({ attemptId: ATTEMPT_B, file: "b.bin" });
      journal.reserve(unknown);
      journal.recordTerminal(unknown.attemptId, "UNKNOWN", {});
      const rejected = makeReservation({ attemptId: ATTEMPT_C, file: "c.bin" });
      journal.reserve(rejected);
      journal.recordDispatch(
        rejected.attemptId,
        "prepare",
        prepareWire(rejected, DEFAULT_PAYLOAD),
      );
      journal.recordTerminal(rejected.attemptId, "REJECTED", {
        operation: "prepare",
        state: "REJECTED",
      });
      const precommit = makeReservation({ attemptId: ATTEMPT_D, file: "d.bin" });
      journal.reserve(precommit);
      journal.recordDispatch(
        precommit.attemptId,
        "prepare",
        prepareWire(precommit, DEFAULT_PAYLOAD),
      );
      journal.recordPrepared(precommit.attemptId, {});
      expect(() =>
        journal.recordTerminal(precommit.attemptId, "PUBLISHED", {}),
      ).toThrow(/TERMINAL_STATE/);

      const envelope = makeReservation({ attemptId: ATTEMPT_E, file: "e.bin" });
      journal.reserve(envelope);
      const wrongFields: Record<string, unknown>[] = [
        { attemptId: ATTEMPT_B },
        { path: `${DIR_PATH}\\other.bin` },
        { stagingPath: `${DIR_PATH}\\other.tmp` },
        { sha256: "0".repeat(64) },
        { rootFileId: "9".repeat(32) },
        { rootVolumeId: "9".repeat(16) },
        { directoryFileId: "9".repeat(32) },
        { directoryVolumeId: "9".repeat(16) },
        { byteLength: envelope.byteLength + 1 },
        { operation: "commit-prepared" },
        { contractVersion: 1 },
      ];
      for (const patch of wrongFields)
        expect(() =>
          journal.recordDispatch(
            envelope.attemptId,
            "prepare",
            prepareWire(envelope, DEFAULT_PAYLOAD, patch),
          ),
        ).toThrow(/WIRE_ENVELOPE/);
    });

    it("rejects malformed reservations, identities, wires and overlapping roots", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const good = makeReservation();
      const accessor = { ...good };
      Object.defineProperty(accessor, "path", {
        get: () => good.path,
        enumerable: true,
      });
      const badReservations: unknown[] = [
        { ...good, contractVersion: 1 },
        { ...good, attemptId: "A".repeat(32) },
        { ...good, attemptId: "g".repeat(32) },
        { ...good, path: "c:\\Folio\\Private\\new.bin" },
        { ...good, path: "C:\\Folio\\Private\\trail " },
        { ...good, path: "C:\\Folio\\Private\\..\\x.bin" },
        { ...good, path: "\\\\server\\share\\x.bin" },
        { ...good, path: "C:/Folio/Private/new.bin" },
        { ...good, path: `C:\\Folio\\Private\\${"x".repeat(300)}` },
        { ...good, byteLength: -0 },
        { ...good, byteLength: Number.MAX_SAFE_INTEGER + 1 },
        { ...good, byteLength: WINDOWS_PUBLICATION_MAX_BYTES + 1 },
        { ...good, sha256: "f".repeat(63) },
        {
          ...good,
          root: {
            canonicalPath: ROOT_PATH,
            fileId: "z".repeat(32),
            volumeId: VOLUME,
          },
        },
        {
          ...good,
          directory: {
            canonicalPath: "C:\\Elsewhere",
            fileId: DIR_ID,
            volumeId: VOLUME,
          },
        },
        { ...good, stagingPath: `${DIR_PATH}\\other.tmp` },
        { ...good, extra: "field" },
        { ...good, [Symbol("symbol")]: 1 },
        accessor,
      ];
      for (const bad of badReservations)
        expect(() =>
          journal.reserve(bad as PublicationReservation),
        ).toThrow(/WINDOWS_PUBLICATION_JOURNAL_/);

      journal.reserve(makeReservation());
      const zeroIdentity = makeReservation({
        attemptId: ATTEMPT_B,
        file: "zeros.bin",
        rootFileId: "0".repeat(32),
        rootVolumeId: "0".repeat(16),
        directoryFileId: "0".repeat(32),
        directoryVolumeId: "0".repeat(16),
      });
      journal.reserve(zeroIdentity);
      expect(journal.inspect(zeroIdentity.attemptId)?.state).toBe(
        "RESERVED",
      );

      // Explicitly conclude the preceding metadata-only attempts; their
      // immutable reservations/targets stay consumed while capacity is released.
      journal.recordTerminal(ATTEMPT_A, "UNKNOWN", {});
      journal.recordTerminal(ATTEMPT_B, "UNKNOWN", {});
      const staged = makeReservation({ attemptId: ATTEMPT_C, file: "staged.bin" });
      journal.reserve(staged);
      journal.recordDispatch(
        staged.attemptId,
        "prepare",
        prepareWire(staged, DEFAULT_PAYLOAD),
      );
      journal.recordPrepared(staged.attemptId, {
        stagingFileId: "5".repeat(32),
      });
      expect(() =>
        journal.recordDispatch(
          staged.attemptId,
          "commit-prepared",
          commitWire(staged, { stagingFileId: "6".repeat(32) }),
        ),
      ).toThrow(/WIRE_ENVELOPE/);
      expect(() =>
        journal.recordDispatch(
          staged.attemptId,
          "commit-prepared",
          commitWire(staged),
        ),
      ).toThrow(/WIRE_ENVELOPE/);
      journal.recordDispatch(
        staged.attemptId,
        "commit-prepared",
        commitWire(staged, { stagingFileId: "5".repeat(32) }),
      );
      journal.recordTerminal(staged.attemptId, "PUBLISHED", {});

      const strict = makeReservation({ attemptId: ATTEMPT_D, file: "strict.bin" });
      journal.reserve(strict);
      const validWire = prepareWire(strict, DEFAULT_PAYLOAD);
      const badWires: string[] = [
        "",
        "not json",
        "[]",
        "{} {}",
        '{"contractVersion":2,"vers\\u0069on":3}',
        '{"memo":"\\ud800"}',
        '{"memo":"\\x41"}',
        '{"contractVersion":2.0}',
        '{"contractVersion":2e0}',
        '{"byteLength":9007199254740993}',
        '{"byteLength":-0}',
        `{"memo":"${"﻿"}"}`,
        validWire.slice(0, -1) + ",}",
        validWire + " {}",
        prepareWire(strict, DEFAULT_PAYLOAD, {
          bytesBase64: "!!not-base64!!",
        }),
        prepareWire(strict, DEFAULT_PAYLOAD, {
          bytesBase64: Buffer.from("different payload").toString("base64"),
        }),
      ];
      for (const wire of badWires)
        expect(() =>
          journal.recordDispatch(strict.attemptId, "prepare", wire),
        ).toThrow(/WINDOWS_PUBLICATION_JOURNAL_/);

      journal.recordDispatch(strict.attemptId, "prepare", validWire);
      journal.recordPrepared(strict.attemptId, {});
      expect(() =>
        journal.recordDispatch(
          strict.attemptId,
          "commit-prepared",
          commitWire(strict, { bytesBase64: "QUJD" }),
        ),
      ).toThrow(/WIRE_ENVELOPE/);

      expect(
        () =>
          new WindowsPublicationJournal(
            dir,
            testingPlatform().port,
            [dir],
          ),
      ).toThrow(/FORBIDDEN_ROOT/);
      expect(
        () =>
          new WindowsPublicationJournal(
            join(dir, "journal-sub"),
            testingPlatform().port,
            [dir],
          ),
      ).toThrow(/FORBIDDEN_ROOT/);
      expect(
        () =>
          new WindowsPublicationJournal(
            dir,
            testingPlatform().port,
            ["relative\\path"],
          ),
      ).toThrow(/FORBIDDEN_ROOT/);
      expect(
        () =>
          new WindowsPublicationJournal(
            dir,
            testingPlatform().port,
            ["/nonexistent/../etc"],
          ),
      ).toThrow(/FORBIDDEN_ROOT/);
      expect(
        () =>
          new WindowsPublicationJournal(
            dir,
            new PosixPrivatePlatform() as PrivatePlatform,
          ),
      ).toThrow(/PLATFORM/);
      expect(
        () =>
          new WindowsPublicationJournal(
            dir,
            undefined as unknown as PrivatePlatform,
          ),
      ).toThrow(/PLATFORM/);
      expect(
        () =>
          new WindowsPublicationJournal(
            join(dir, "missing-directory"),
            testingPlatform().port,
          ),
      ).toThrow(/m3-private-root-unsafe/);
    });

    it("blocks the instance and retains the reservation after a postCOMMIT proof failure", () => {
      const dir = tempDir();
      const platform = testingPlatform();
      const journal = new WindowsPublicationJournal(dir, platform.port);
      journals.push(journal);
      const r = makeReservation();
      const transaction = SyncSqliteGuard.prototype.transaction;
      const spy = vi
        .spyOn(SyncSqliteGuard.prototype, "transaction")
        .mockImplementation(function (this: SyncSqliteGuard, work) {
          const result = transaction.call(this, work);
          platform.failRoot();
          return result;
        });
      expect(() => journal.reserve(r)).toThrow(
        /windows-private-root-unproven/,
      );
      spy.mockRestore();
      platform.heal();
      expect(() => journal.inspect(r.attemptId)).toThrow();
      expect(() =>
        journal.recordDispatch(
          r.attemptId,
          "prepare",
          prepareWire(r, DEFAULT_PAYLOAD),
        ),
      ).toThrow();
      journal.close();
      const reopened = openJournal(dir);
      expect(() => reopened.reserve(r)).toThrow(/ATTEMPT_CONSUMED/);
      expect(() =>
        reopened.reserve(makeReservation({ attemptId: ATTEMPT_B })),
      ).toThrow(/TARGET_CONSUMED/);
      expect(() =>
        reopened.recordDispatch(
          r.attemptId,
          "prepare",
          prepareWire(r, DEFAULT_PAYLOAD),
        ),
      ).toThrow(/DISPATCH_AUTHORITY/);
      expect(reopened.inspect(r.attemptId)?.state).toBe("RESERVED");
    });

    it("retains committed chunks after a postCOMMIT dispatch proof failure and grants no replay authority", () => {
      const dir = tempDir();
      const platform = testingPlatform();
      const journal = new WindowsPublicationJournal(dir, platform.port);
      journals.push(journal);
      const r = makeReservation();
      journal.reserve(r);
      const transaction = SyncSqliteGuard.prototype.transaction;
      const spy = vi
        .spyOn(SyncSqliteGuard.prototype, "transaction")
        .mockImplementation(function (this: SyncSqliteGuard, work) {
          const result = transaction.call(this, work);
          platform.failRoot();
          return result;
        });
      expect(() =>
        journal.recordDispatch(
          r.attemptId,
          "prepare",
          prepareWire(r, DEFAULT_PAYLOAD),
        ),
      ).toThrow(/windows-private-root-unproven/);
      spy.mockRestore();
      platform.heal();
      expect(() => journal.recordPrepared(r.attemptId, {})).toThrow();
      journal.close();
      const reopened = openJournal(dir);
      const inspection = reopened.inspect(r.attemptId);
      expect(inspection?.state).toBe("PREPARE_DISPATCHED");
      expect(inspection?.dispatches.length).toBe(1);
      expect(
        reconstructWire(rawRows(dir), r.attemptId, "prepare") ===
          prepareWire(r, DEFAULT_PAYLOAD),
      ).toBe(true);
      expect(() => reopened.recordPrepared(r.attemptId, {})).toThrow(
        /DISPATCH_AUTHORITY/,
      );
    });

    it("retains committed rows when the COMMIT outcome itself is uncertain", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const r = makeReservation();
      const exec = DatabaseSync.prototype.exec;
      let armed = true;
      const spy = vi
        .spyOn(DatabaseSync.prototype, "exec")
        .mockImplementation(function (this: DatabaseSync, sql: string) {
          const result = exec.call(this, sql);
          if (armed && sql === "COMMIT") {
            armed = false;
            throw new SyncError("windows-private-commit-unknown", 503);
          }
          return result;
        });
      expect(() => journal.reserve(r)).toThrow();
      spy.mockRestore();
      expect(() => journal.inspect(r.attemptId)).toThrow();
      journal.close();
      const reopened = openJournal(dir);
      expect(() => reopened.reserve(r)).toThrow(/ATTEMPT_CONSUMED/);
      expect(reopened.inspect(r.attemptId)?.state).toBe("RESERVED");
    });

    it("refuses a complete lifecycle before dispatch without evicting prior records", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const payload = Buffer.from("quota baseline payload");
      const baseline = makeReservation({ payload });
      journal.reserve(baseline);
      journal.recordDispatch(
        baseline.attemptId,
        "prepare",
        prepareWire(baseline, payload),
      );
      journal.recordTerminal(baseline.attemptId, "UNKNOWN", {
        state: "UNKNOWN",
      });
      const before = rawRows(dir);
      const filler = new PrivateLedger(
        dir,
        WINDOWS_PUBLICATION_JOURNAL_DATABASE,
        JOURNAL_ROLE,
        [],
        testingPlatform().port,
      );
      try {
        filler.transaction(() => {
          for (let index = 0; index < 138; index++)
            filler.write(
              `fill:${String(index).padStart(4, "0")}`,
              "y".repeat(60_000),
            );
        });
      } finally {
        filler.close();
      }
      const bigPayload = Buffer.alloc(600_000, 0x62);
      const large = makeReservation({
        attemptId: ATTEMPT_B,
        payload: bigPayload,
        file: "big.bin",
      });
      expect(() => journal.reserve(large)).toThrow("WINDOWS_PUBLICATION_JOURNAL_CAPACITY");
      const after = rawRows(dir);
      for (const [key, value] of before)
        expect(after.get(key) === value).toBe(true);
      expect(
        after.has(`attempt:${large.attemptId}:dispatch:prepare`),
      ).toBe(false);
      expect(
        [...after.keys()].some((key) =>
          key.startsWith(`attempt:${large.attemptId}:wire:`),
        ),
      ).toBe(false);
      expect(journal.inspect(large.attemptId)).toBeNull();
      expect(journal.inspect(baseline.attemptId)?.state).toBe("UNKNOWN");
    });

    it("rolls back both reservation and index when the row quota fits only one", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const filler = new PrivateLedger(
        dir,
        WINDOWS_PUBLICATION_JOURNAL_DATABASE,
        JOURNAL_ROLE,
        [],
        testingPlatform().port,
      );
      try {
        filler.transaction(() => {
          for (let index = 0; index < 4095; index++)
            filler.write(
              `fill:${String(index).padStart(4, "0")}`,
              "x",
            );
        });
      } finally {
        filler.close();
      }
      const r = makeReservation();
      expect(() => journal.reserve(r)).toThrow("WINDOWS_PUBLICATION_JOURNAL_CAPACITY");
      const rows = rawRows(dir);
      expect(rows.has(`attempt:${r.attemptId}:reservation`)).toBe(false);
      expect(
        [...rows.keys()].some((key) => key.startsWith("target:")),
      ).toBe(false);
      expect(journal.inspect(r.attemptId)).toBeNull();
    });

    it("validates evidence consistency without interpreting it and never returns evidence or wire via inspection", () => {
      const dir = tempDir();
      const journal = openJournal(dir);
      const r = makeReservation();
      journal.reserve(r);
      journal.recordDispatch(
        r.attemptId,
        "prepare",
        prepareWire(r, DEFAULT_PAYLOAD),
      );
      expect(() =>
        journal.recordPrepared(r.attemptId, {
          callback: () => 0,
        } as unknown as Json),
      ).toThrow(/EVIDENCE/);
      expect(() =>
        journal.recordPrepared(
          r.attemptId,
          "x".repeat(4_500_000) as Json,
        ),
      ).toThrow(/EVIDENCE/);
      expect(() =>
        journal.recordPrepared(r.attemptId, {
          operation: "commit-prepared",
        }),
      ).toThrow(/EVIDENCE/);
      expect(() =>
        journal.recordPrepared(r.attemptId, { state: "UNKNOWN" }),
      ).toThrow(/EVIDENCE/);
      const marker = "SECRET-MARKER-9";
      journal.recordPrepared(r.attemptId, {
        operation: "prepare",
        state: "PREPARED",
        note: marker,
      });
      journal.recordDispatch(r.attemptId, "commit-prepared", commitWire(r));
      expect(() =>
        journal.recordTerminal(r.attemptId, "PUBLISHED", {
          operation: "prepare",
        }),
      ).toThrow(/EVIDENCE/);
      expect(() =>
        journal.recordTerminal(r.attemptId, "PUBLISHED", {
          state: "UNKNOWN",
        }),
      ).toThrow(/EVIDENCE/);
      expect(() =>
        journal.recordTerminal(r.attemptId, "PUBLISHED", {
          attemptId: ATTEMPT_B,
        }),
      ).toThrow(/EVIDENCE/);
      expect(() =>
        journal.recordTerminal(r.attemptId, "PUBLISHED", {
          root: "C:\\Elsewhere",
        }),
      ).toThrow(/EVIDENCE/);
      journal.recordTerminal(r.attemptId, "PUBLISHED", {
        operation: "commit-prepared",
        state: "PUBLISHED",
        note: marker,
      });
      const metadata = JSON.stringify(journal.inspect(r.attemptId));
      expect(metadata.includes(marker)).toBe(false);
      expect(metadata.includes("bytesBase64")).toBe(false);
      expect(journal.inspect(r.attemptId)?.state).toBe("PUBLISHED");
    });

    it("orders unresolved database and platform close failures and retries only their remaining owners", () => {
      const dir = tempDir();
      const platform = testingPlatform();
      const journal = new WindowsPublicationJournal(dir, platform.port);
      journals.push(journal);
      const r = makeReservation();
      journal.reserve(r);
      const dbError = new Error("database close incomplete");
      const nativeError = new Error("native close incomplete");
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementationOnce(() => {
          throw dbError;
        });
      vi.mocked(platform.port.close).mockImplementationOnce(() => {
        throw nativeError;
      });
      let failure: unknown;
      try {
        journal.close();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(dbError);
      expect(platform.port.close).not.toHaveBeenCalled();
      expect(() => journal.inspect(r.attemptId)).toThrow(/CLOSED/);
      expect(() =>
        journal.recordDispatch(
          r.attemptId,
          "prepare",
          prepareWire(r, DEFAULT_PAYLOAD),
        ),
      ).toThrow(/CLOSED/);
      expect(() => journal.close()).toThrow(nativeError);
      journal.close();
      journal.close();
      expect(closeSpy).toHaveBeenCalledTimes(2);
      expect(platform.port.close).toHaveBeenCalledTimes(2);
    });
  },
);

it("retains lifecycle reservations across separate owners and refuses a reconstructed terminal release", () => {
  const directory = tempDir(), owner = openJournal(directory), other = openJournal(directory);
  const large = makeReservation({payload: Buffer.alloc(WINDOWS_PUBLICATION_MAX_BYTES)}), next = makeReservation({attemptId: ATTEMPT_B, file: "next.bin"});
  owner.reserve(large);
  expect(() => other.reserve(next)).toThrow("CAPACITY");
  expect(() => other.recordTerminal(large.attemptId, "UNKNOWN", {})).toThrow("TERMINAL_AUTHORITY");
  expect(() => other.reserve(next)).toThrow("CAPACITY");
  expect(owner.inspect(large.attemptId)?.state).toBe("RESERVED");
  owner.recordTerminal(large.attemptId, "UNKNOWN", {});
  other.reserve(next); expect(other.inspect(next.attemptId)?.state).toBe("RESERVED");
  expect(() => other.reserve(large)).toThrow("ATTEMPT_CONSUMED");
});

it("does not let oversized prepared evidence or padded commit wire borrow terminal reservations", () => {
  const journal = openJournal(tempDir()), r = makeReservation(); journal.reserve(r);
  journal.recordDispatch(r.attemptId, "prepare", prepareWire(r, DEFAULT_PAYLOAD));
  expect(() => journal.recordPrepared(r.attemptId, {captured: {stdout: "x".repeat(20 * 1024), stderr: "", captureEncoding: "latin1"}})).toThrow("EVIDENCE");
  expect(journal.inspect(r.attemptId)?.state).toBe("PREPARE_DISPATCHED"); journal.recordPrepared(r.attemptId, {});
  const wire = commitWire(r), padded = wire + " ".repeat(8193 - Buffer.byteLength(wire));
  expect(() => journal.recordDispatch(r.attemptId, "commit-prepared", padded)).toThrow("WIRE_CAPABILITY");
  expect(journal.inspect(r.attemptId)?.state).toBe("PREPARED");
  journal.recordDispatch(r.attemptId, "commit-prepared", wire); journal.recordTerminal(r.attemptId, "PUBLISHED", {});
  expect(journal.inspect(r.attemptId)?.state).toBe("PUBLISHED");
});

it.each(["bytes", "rows"] as const)("charges the new target index before admitting lifecycle capacity at the exact %s boundary", kind => {
  const probeRoot = tempDir(), probe = openJournal(probeRoot), a = makeReservation(), b = makeReservation({attemptId: ATTEMPT_B, file: "next.bin"});
  probe.reserve(a); const sample = rawRows(probeRoot), budget = JSON.parse(sample.get(`attempt:${a.attemptId}:budget`)!);
  const indexBytes = Buffer.byteLength([...sample].find(([key]) => key.startsWith("target:"))![1]); probe.close();
  const directory = tempDir(), journal = openJournal(directory);
  const filler = new PrivateLedger(directory, WINDOWS_PUBLICATION_JOURNAL_DATABASE, JOURNAL_ROLE, [], testingPlatform().port);
  try {
    filler.transaction(() => {
      if (kind === "bytes") {
        let amount = 8 * 1024 * 1024 - 2 * budget.bytes - indexBytes - 2, i = 0;
        expect(amount).toBeGreaterThan(0);
        while (amount > 0) {const n = Math.min(60_000, amount); filler.write(`fill:${i++}`, "x".repeat(n)); amount -= n;}
      } else {
        for (let i = 0; i < 4096 - 2 * budget.rows - 1; i++) filler.write(`fill:${i}`, "x");
      }
    });
  } finally {filler.close();}
  journal.reserve(a); const before = rawRows(directory);
  expect(() => journal.reserve(b)).toThrow("CAPACITY");
  expect(rawRows(directory)).toEqual(before); expect(journal.inspect(b.attemptId)).toBeNull();
  expect(journal.inspect(a.attemptId)?.state).toBe("RESERVED");
});

it("rejects the reviewer's ordinary two-owner near-boundary reservations before overbooking", () => {
  const directory = tempDir(), first = openJournal(directory), second = openJournal(directory);
  const a = makeReservation({payload: Buffer.alloc(0), file: "a.bin"}), b = makeReservation({attemptId: ATTEMPT_B, payload: Buffer.alloc(17_079), file: "b.bin"});
  first.reserve(a); const before = rawRows(directory);
  expect(() => second.reserve(b)).toThrow("CAPACITY"); expect(rawRows(directory)).toEqual(before);
  expect(first.inspect(a.attemptId)?.state).toBe("RESERVED"); expect(second.inspect(b.attemptId)).toBeNull();
});

// Contract-only source binding: the factory callback is trusted producer
// wiring, never CLI input. PosixTesting seam; not Windows OS proof.
const SOURCE_PATH = "C:\\Folio\\Shared";
const SOURCE_ID = "3".repeat(32);
const DATABASE_ID = "5".repeat(32);
const boundSource = (): PublicationSourceIdentity => ({
  sourceRoot: SOURCE_PATH,
  orgId: "org",
  genesisHash: "7".repeat(64),
  root: { canonicalPath: ROOT_PATH, fileId: ROOT_ID, volumeId: VOLUME },
  directory: {
    canonicalPath: SOURCE_PATH,
    fileId: SOURCE_ID,
    volumeId: VOLUME,
  },
  database: {
    canonicalPath: `${SOURCE_PATH}\\shared-runtime.sqlite`,
    fileId: DATABASE_ID,
    volumeId: VOLUME,
  },
});

function boundJournal(directory: string): WindowsPublicationJournal {
  const journal = new WindowsPublicationJournal(
    directory,
    testingPlatform().port,
    [],
    boundSource,
  );
  journals.push(journal);
  return journal;
}

it("keeps the investigation snapshot fingerprint stable across restart and never emits raw output", () => {
  const directory = tempDir();
  const owner = boundJournal(directory);
  const r = makeReservation();
  owner.reserve(r);
  owner.recordDispatch(r.attemptId, "prepare", prepareWire(r, DEFAULT_PAYLOAD));
  owner.recordPrepared(r.attemptId, { operation: "prepare", state: "PREPARED" });
  owner.recordDispatch(r.attemptId, "commit-prepared", commitWire(r));
  owner.recordTerminal(r.attemptId, "UNKNOWN", { state: "UNKNOWN" });
  owner.close();
  const first = openJournal(directory);
  const a = first.investigate(r.attemptId);
  first.close();
  const second = openJournal(directory);
  const b = second.investigate(r.attemptId);
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a!.snapshotFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(a!.snapshotFingerprint).toBe(b!.snapshotFingerprint);
  expect(a!.source?.sourceRoot).toBe(SOURCE_PATH);
  expect(a!.resolution).toBeNull();
  const serialized = JSON.stringify(a);
  expect(serialized.includes("bytesBase64")).toBe(false);
  expect(serialized.includes("stdout")).toBe(false);
  // No verified stage proof in this summary-only evidence: metadata stays
  // observable but preparedFile is refused rather than trusting the summary.
  expect(a!.preparedFile).toBeNull();
});

it("reflects any retained raw change in the snapshot fingerprint or rejects the corrupted state", () => {
  const directory = tempDir();
  const owner = boundJournal(directory);
  const r = makeReservation();
  owner.reserve(r);
  owner.recordDispatch(r.attemptId, "prepare", prepareWire(r, DEFAULT_PAYLOAD));
  owner.recordPrepared(r.attemptId, { operation: "prepare", state: "PREPARED" });
  owner.recordDispatch(r.attemptId, "commit-prepared", commitWire(r));
  owner.recordTerminal(r.attemptId, "UNKNOWN", { state: "UNKNOWN" });
  owner.close();
  const first = openJournal(directory);
  const fingerprint = first.investigate(r.attemptId)!.snapshotFingerprint;
  first.close();
  const db = new DatabaseSync(
    join(directory, WINDOWS_PUBLICATION_JOURNAL_DATABASE),
  );
  try {
    db.prepare("UPDATE m3_private_records SET value = ? WHERE key = ?").run(
      canonical({
        version: 1,
        outcome: "UNKNOWN",
        evidence: { state: "UNKNOWN", note: "tampered" },
      }),
      `attempt:${r.attemptId}:terminal`,
    );
  } finally {
    db.close();
  }
  const second = openJournal(directory);
  const changed = second.investigate(r.attemptId)!.snapshotFingerprint;
  expect(changed).not.toBe(fingerprint);
  expect(changed).toMatch(/^[a-f0-9]{64}$/);
  second.close();
  // A corrupted retained wire chunk is rejected outright, not fingerprinted.
  const db2 = new DatabaseSync(
    join(directory, WINDOWS_PUBLICATION_JOURNAL_DATABASE),
  );
  try {
    const key = [...rawRows(directory).keys()].find((name) =>
      name.startsWith(`attempt:${r.attemptId}:wire:prepare:`),
    )!;
    db2.prepare("UPDATE m3_private_records SET value = ? WHERE key = ?").run(
      Buffer.from("corrupted-chunk").toString("base64"),
      key,
    );
  } finally {
    db2.close();
  }
  const third = openJournal(directory);
  expect(() => third.investigate(r.attemptId)).toThrow(/STATE/);
});

const PROBE_SID = "S-1-5-21-1000-2000-3000-500";
const STAGE_ID = "6".repeat(32);
const probeEvidence = (canonicalPath: string, fileId: string) => ({
  platform: "win32",
  sid: PROBE_SID,
  ownerSid: PROBE_SID,
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
});
const nativePrepared = (r: PublicationReservation, payload: Uint8Array) => ({
  phase: "prepare",
  status: 0,
  reply: { state: "PREPARED", attemptId: r.attemptId },
  captured: {
    status: 0,
    signal: null,
    stdout: JSON.stringify({
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
      file: probeEvidence(r.stagingPath, STAGE_ID),
      directory: probeEvidence(
        r.directory.canonicalPath,
        r.directory.fileId,
      ),
    }),
    stderr: "",
    captureEncoding: "latin1",
  },
});
const stagedCommitWire = (r: PublicationReservation) =>
  commitWire(r, { stagingFileId: STAGE_ID, stagingVolumeId: VOLUME });

it("charges resolution observation rows against the independent global guards", () => {
  const directory = tempDir();
  const owner = boundJournal(directory);
  const r = makeReservation();
  owner.reserve(r);
  owner.recordDispatch(r.attemptId, "prepare", prepareWire(r, DEFAULT_PAYLOAD));
  owner.recordPrepared(r.attemptId, nativePrepared(r, DEFAULT_PAYLOAD));
  owner.recordDispatch(r.attemptId, "commit-prepared", stagedCommitWire(r));
  owner.recordTerminal(r.attemptId, "UNKNOWN", { state: "UNKNOWN" });
  // A second, still-unfinished lifecycle reservation is charged against the
  // global budget on every subsequent admission — including observations.
  const big = makeReservation({
    attemptId: ATTEMPT_B,
    payload: Buffer.alloc(600_000),
    file: "big.bin",
  });
  owner.reserve(big);
  const before = rawRows(directory);
  owner.close();
  const filler = new PrivateLedger(
    directory,
    WINDOWS_PUBLICATION_JOURNAL_DATABASE,
    JOURNAL_ROLE,
    [],
    testingPlatform().port,
  );
  try {
    filler.transaction(() => {
      for (let index = 0; index < 138; index++)
        filler.write(
          `fill:${String(index).padStart(4, "0")}`,
          "y".repeat(60_000),
        );
    });
  } finally {
    filler.close();
  }
  const journal = openJournal(directory);
  const investigated = journal.investigate(r.attemptId)!;
  expect(investigated.preparedFile).not.toBeNull();
  const authorization = {
    sourceRoot: SOURCE_PATH,
    orgId: "org",
    genesisHash: "7".repeat(64),
    auth: {
      userId: "user-1",
      deviceId: "device-1",
      writerId: "writer-1",
      sessionId: "session-1",
    },
    cut: { epoch: "epoch-1", seq: 7, hash: "8".repeat(64) },
  };
  const observed = {
    root: r.root,
    directory: r.directory,
    sourceDirectory: {
      canonicalPath: SOURCE_PATH,
      fileId: SOURCE_ID,
      volumeId: VOLUME,
    },
    sourceDatabase: {
      canonicalPath: `${SOURCE_PATH}\\shared-runtime.sqlite`,
      fileId: DATABASE_ID,
      volumeId: VOLUME,
    },
    file: { canonicalPath: r.path, fileId: STAGE_ID, volumeId: VOLUME },
    byteLength: r.byteLength,
    sha256: r.sha256,
  };
  const fingerprint = digest(
    canonical({
      snapshotFingerprint: investigated.snapshotFingerprint,
      authorization,
      observed,
    }),
  );
  const body = {
    version: 1,
    outcome: "PUBLISHED_OBSERVED",
    attemptId: r.attemptId,
    snapshotFingerprint: investigated.snapshotFingerprint,
    fingerprint,
    authorization,
    observed,
    preserve: true,
  } as const;
  // Every retained check passes; the append itself hits the unchanged global
  // capacity guard charged with all unfinished lifecycle reservations.
  expect(() =>
    journal.appendResolution(
      r.attemptId,
      investigated.snapshotFingerprint,
      body,
      () => authorization,
    ),
  ).toThrow("WINDOWS_PUBLICATION_JOURNAL_CAPACITY");
  const after = rawRows(directory);
  for (const [key, value] of before) expect(after.get(key)).toBe(value);
  expect(after.has(`attempt:${r.attemptId}:resolution`)).toBe(false);
  expect(journal.inspect(r.attemptId)?.state).toBe("UNKNOWN");
});
