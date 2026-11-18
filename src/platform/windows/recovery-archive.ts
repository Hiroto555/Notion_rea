import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types as utilTypes } from "node:util";
import { CollaborationError, wellFormed } from "../../collaboration/runtime/contract";
import { canonical } from "../../collaboration/runtime/canonical";
import { preflightExistingJournal } from "../../sync/journal-preflight";
import { SqliteConnectionOwner, closeSqlitePlatform } from "../../sync/sqlite-connection-owner";
import {
  synchronousPrivatePlatform,
  type HotJournalSnapshot,
  type PrivatePlatform,
} from "../../sync/private-platform";
import { SyncSqliteGuard } from "../../sync/sqlite-guard";
import { asciiCaseFold, assertWindowsProbe, validateWindowsPath } from "./path-policy";
import { isAuthorityLeasePlatform } from "./authority-lease";
import type { NativePrivateFile } from "../private-persistence";
import type { WindowsPrivateMaintenanceContext } from "./private-persistence-journal";
import type { WindowsRecoveryMissingReceipt } from "./private-recovery-io";
import { recordCheckpointCapacityRefusal, recordCheckpointPriorPending } from "../private-mutation-diagnostic";
import {
  WINDOWS_RECOVERY_MAX_BYTES,
  WINDOWS_RECOVERY_MAX_CAPTURE_BYTES,
  WINDOWS_RECOVERY_MAX_WIRE_BYTES,
} from "./private-recovery-io";

export const WINDOWS_RECOVERY_ARCHIVE_DATABASE = "windows-recovery-v3.sqlite";
export const WINDOWS_RECOVERY_ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;
export const WINDOWS_RECOVERY_ARCHIVE_MAX_ATTEMPTS = 64;
export const WINDOWS_RECOVERY_ARCHIVE_MAX_BLOBS_PER_ATTEMPT = 12;
export const WINDOWS_RECOVERY_METADATA_MAX_BYTES = 48 * 1024;
const ROLE = "windows-recovery-v3";
const VERSION = 2;
const METADATA_OVERHEAD = 256 * 1024;
const RECORD_OVERHEAD = 256;
const SHA256 = /^[0-9a-f]{64}$/;
const ATTEMPT_ID = /^[0-9a-f]{32}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const WORKSPACE_ID = /^[a-zA-Z0-9-]{1,100}$/;

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_RECOVERY_ARCHIVE_${code}`);
}

const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Folded logical key: case aliases of the same canonical drive-absolute path
 * MUST converge to one logical target. Pure syntax, never filesystem proof.
 */
export function recoveryLogicalKey(path: string): string {
  if (typeof path !== "string" || path.length > 240 || !/^[A-Z]:\\[\x20-\x7e]*$/.test(path))
    fail("LOGICAL_PATH");
  let out: string;
  try {
    out = validateWindowsPath(path, `${path[0]}:\\`).canonical;
  } catch {
    fail("LOGICAL_PATH");
  }
  if (out !== path) fail("LOGICAL_PATH");
  return asciiCaseFold(path);
}

export type RecoveryExpectedHead = Readonly<{
  generation: number;
  attemptId: string;
  sha256: string;
}>;

/** Lexical separation only — identical syntax rules as the publication
 * journal, never filesystem evidence. */
type LexicalPath = Readonly<{ separator: "\\" | "/"; folded: string }>;
function lexicalPath(value: unknown): LexicalPath | null {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !wellFormed(value))
    return null;
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    let canonicalPath: string;
    try {
      canonicalPath = validateWindowsPath(value, `${value[0].toUpperCase()}:\\`).canonical;
    } catch {
      return null;
    }
    return { separator: "\\", folded: asciiCaseFold(canonicalPath) };
  }
  if (value.startsWith("/")) {
    let trimmed = value.replace(/\/+$/, "");
    if (trimmed === "") trimmed = "/";
    if (trimmed === "/") return { separator: "/", folded: "/" };
    const segments = trimmed.split("/");
    for (let index = 1; index < segments.length; index++) {
      const segment = segments[index];
      if (segment === "" || segment === "." || segment === "..") return null;
    }
    return { separator: "/", folded: trimmed };
  }
  return null;
}

function overlapsLexical(a: LexicalPath, b: LexicalPath): boolean {
  if (a.separator !== b.separator) return false;
  const contains = (parent: string, candidate: string): boolean =>
    candidate === parent ||
    (parent.endsWith(a.separator)
      ? candidate.startsWith(parent)
      : candidate.startsWith(parent + a.separator));
  return contains(a.folded, b.folded) || contains(b.folded, a.folded);
}

function parentOf(path: string): string {
  const end = path.lastIndexOf("\\");
  return end === 2 ? path.slice(0, 3) : path.slice(0, end);
}

/** Wraps the injected platform to prove kind, retain close causes, and carry
 * the optional native hot-journal snapshot capability through to preflight. */
class ArchivePlatformProxy implements PrivatePlatform {
  readonly kind = "windows" as const;
  readonly withHotJournalSnapshot?: HotJournalSnapshot;
  boundDirectory: string | undefined;
  readonly closeFailures: unknown[] = [];

  constructor(
    private readonly inner: PrivatePlatform,
    private readonly roots: readonly LexicalPath[],
  ) {
    // Capability passthrough only; never manufactured when absent.
    if (inner.withHotJournalSnapshot !== undefined) {
      const snapshot = inner.withHotJournalSnapshot;
      this.withHotJournalSnapshot = (path, callback) => snapshot.call(inner, path, callback);
    }
  }

  bind(directory: string): string {
    const bound = this.inner.bind(directory);
    const lex = lexicalPath(bound);
    if (lex === null) fail("PLATFORM");
    for (const root of this.roots)
      if (overlapsLexical(lex, root)) fail("FORBIDDEN_ROOT");
    this.boundDirectory = bound;
    return bound;
  }
  assertRoot(): void { this.inner.assertRoot(); }
  assertFile(path: string): void { this.inner.assertFile(path); }
  assertSidecars(path: string): void { this.inner.assertSidecars(path); }
  createExclusive(path: string): void { this.inner.createExclusive(path); }
  assertEmptyFile(path: string): void { this.inner.assertEmptyFile(path); }
  close(): void {
    try { this.inner.close(); }
    catch (error) { this.closeFailures.push(error); throw error; }
  }
}

export type RecoveryBlobKind =
  | "evidence:maintenance-cas"
  | "evidence:maintenance"
  | "original"
  | "wire:prepare"
  | "wire:commit-prepared"
  | "capture:prepare:stdout"
  | "capture:prepare:stderr"
  | "capture:prepare:metadata"
  | "capture:commit-prepared:stdout"
  | "capture:commit-prepared:stderr"
  | "capture:commit-prepared:metadata"
  | "evidence:prepared";

const BLOB_KINDS: ReadonlySet<string> = new Set<RecoveryBlobKind>([
  "evidence:maintenance-cas",
  "evidence:maintenance",
  "original",
  "wire:prepare",
  "wire:commit-prepared",
  "capture:prepare:stdout",
  "capture:prepare:stderr",
  "capture:prepare:metadata",
  "capture:commit-prepared:stdout",
  "capture:commit-prepared:stderr",
  "capture:commit-prepared:metadata",
  "evidence:prepared",
]);
export type WindowsRecoveryMaintenanceInspection = Readonly<{
  attemptId: string; fingerprint: string; binding: string; metadata: string;
  blobs: Readonly<Record<string, Uint8Array>>; terminal: string | null; resolution: string | null;
}>;
export type WindowsRecoveryPublicationObservation = Readonly<{
  originalSha256: string; preparedCaptureSha256: string;
  native: NativePrivateFile;
  parent: Readonly<{canonicalPath: string; fileId: string; volumeId: string}>;
  root: Readonly<{rootFileId: string; volumeId: string}>;
  staging: WindowsRecoveryMissingReceipt;
  prior: NativePrivateFile | null;
}>;

/** Pure restart validation. Neither a label nor a current hash substitutes for
 * the immutable prepare ACK's native ID and the original commit request. */
export function validateRecoveryObservation(item: WindowsRecoveryMaintenanceInspection): {
  context: WindowsPrivateMaintenanceContext; evidence: WindowsRecoveryPublicationObservation;
} {
  const bad = (): never => fail("MAINTENANCE_EVIDENCE");
  if (!item.resolution) bad();
  const previous = item.blobs["evidence:maintenance"];
  const r = exactKeys(JSON.parse(item.resolution!), ["state", "attemptId", "fingerprint", "context", "evidence",
    ...(previous ? ["previousObservationSha256"] : [])], "MAINTENANCE");
  if (canonical(r, WINDOWS_RECOVERY_METADATA_MAX_BYTES) !== item.resolution ||
      r.state !== "APPLIED_OBSERVED" || r.attemptId !== item.attemptId || r.fingerprint !== item.fingerprint) bad();
  if (previous && r.previousObservationSha256 !== sha(previous)) bad();
  const c = exactKeys(r.context, ["workspace", "workspaceId", "workspaceFingerprint", "writerId", "sessionId", "osSid"], "MAINTENANCE");
  canonical(c, 4096);
  if (!SHA256.test(String(c.workspaceFingerprint)) || !/^S-1-\d+(?:-\d+)+$/.test(String(c.osSid)) ||
      ![c.workspaceId, c.writerId, c.sessionId].every(v => typeof v === "string" && v.length > 0 && v.length <= 128)) bad();
  const m = JSON.parse(item.metadata);
  if (canonical(m, WINDOWS_RECOVERY_METADATA_MAX_BYTES) !== item.metadata ||
      !["checkpoint", "raw-export"].includes(m.kind) || m.attemptId !== item.attemptId ||
      !Number.isSafeInteger(m.byteLength) || m.byteLength < 0 || m.byteLength > WINDOWS_RECOVERY_MAX_BYTES ||
      !SHA256.test(m.sha256) || (m.workspaceId !== undefined && m.workspaceId !== c.workspaceId)) bad();
  if (m.kind === "checkpoint") validateMetadata(m);
  else exactKeys(m, ["attemptId", "byteLength", "directory", "kind", "path", "root", "sha256", "stagingPath"], "MAINTENANCE");
  const workspace = recoveryLogicalKey(String(c.workspace));
  if (!recoveryLogicalKey(m.path).startsWith(workspace.replace(/\\$/, "") + "\\") ||
      parentOf(m.path) !== m.directory.canonicalPath || parentOf(m.stagingPath) !== m.directory.canonicalPath ||
      recoveryLogicalKey(m.path) === recoveryLogicalKey(m.stagingPath)) bad();
  const blob = (name: string): Buffer => {
    const b = item.blobs[name]; if (!(b instanceof Uint8Array)) bad(); return Buffer.from(b);
  };
  const frame = (name: string) => {
    const b = blob(name);
    if (b.length < 4) bad();
    const n = b.readUInt32LE(0);
    if (n < 1 || n > 8192 || b.length < n + 4 || ![...b.subarray(4, n + 4)].every(v => v >= 32 && v <= 126)) bad();
    const text = b.subarray(4, n + 4).toString("ascii"), header = JSON.parse(text);
    if (JSON.stringify(header) !== text) bad();
    return {header, payload: b.subarray(n + 4)};
  };
  const original = blob("original"), prepare = frame("wire:prepare"), ack = frame("capture:prepare:stdout"),
    commit = frame("wire:commit-prepared");
  const status = JSON.parse(blob("capture:prepare:metadata").toString("utf8"));
  exactKeys(status, ["status", "signal", "errorCode", "captureTruncated", "stdoutLength", "stderrLength"], "MAINTENANCE");
  if (original.length !== m.byteLength || sha(original) !== m.sha256 || !prepare.payload.equals(original) ||
      !ack.payload.equals(original) || commit.payload.length !== 0 || blob("capture:prepare:stderr").length !== 0 ||
      status.status !== 0 || status.signal !== null || status.errorCode !== null || status.captureTruncated !== false ||
      status.stdoutLength !== blob("capture:prepare:stdout").length || status.stderrLength !== 0) bad();
  const p = ack.header, f = p.file, d = p.directory, root = prepare.header.root;
  const commonWire = ["contractVersion", "operation", "path", "root", "rootFileId", "rootVolumeId",
    "directoryFileId", "directoryVolumeId", "attemptId", "stagingPath", "byteLength"];
  exactKeys(prepare.header, [...commonWire, "sha256"], "MAINTENANCE");
  exactKeys(commit.header, [...commonWire, "fileId", "volumeId", "expectedSha256"], "MAINTENANCE");
  exactKeys(p, ["contractVersion", "operation", "path", "root", "state", "attemptId", "stagingPath",
    "file", "directory", "byteLength", "sha256", "contentFlushed", "filesystem"], "MAINTENANCE");
  for (const [h, operation] of [[prepare.header, "prepare"], [commit.header, "commit-prepared"]]) {
    if (h.contractVersion !== 3 || h.operation !== operation || h.attemptId !== item.attemptId ||
        h.root !== root || h.path !== m.path || h.stagingPath !== m.stagingPath ||
        h.rootFileId !== m.root.fileId || h.rootVolumeId !== m.root.volumeId ||
        h.directoryFileId !== m.directory.fileId || h.directoryVolumeId !== m.directory.volumeId ||
        h.byteLength !== m.byteLength) bad();
  }
  if (p.contractVersion !== 3 || p.operation !== "prepare" || p.state !== "PREPARED" ||
      p.attemptId !== item.attemptId || p.root !== root || p.path !== m.path || p.stagingPath !== m.stagingPath ||
      p.byteLength !== m.byteLength || p.sha256 !== m.sha256 || p.filesystem !== "NTFS" || p.contentFlushed !== true ||
      prepare.header.sha256 !== m.sha256 || commit.header.expectedSha256 !== m.sha256 ||
      commit.header.fileId !== f?.fileId || commit.header.volumeId !== f?.volumeId) bad();
  assertWindowsProbe(f, {canonicalPath: m.stagingPath, canonicalRoot: root});
  assertWindowsProbe(d, {canonicalPath: m.directory.canonicalPath, canonicalRoot: root});
  for (const native of [f, d]) if (native.rootFileId !== m.root.fileId || native.rootVolumeId !== m.root.volumeId ||
      native.volumeId !== m.root.volumeId || native.sid !== c.osSid) bad();
  if (d.fileId !== m.directory.fileId || d.volumeId !== m.directory.volumeId) bad();
  const prepared = JSON.parse(blob("evidence:prepared").toString("utf8"));
  if (prepared.status !== 0 || canonical(prepared.header) !== canonical(p)) bad();
  const evidence = r.evidence as Record<string, unknown>;
  // The source-only S1 raw observation had no logical-prior field. Its full
  // native/original proof is still checked; raw publications have no head.
  const legacyRaw = m.kind === "raw-export" && evidence && !Object.hasOwn(evidence, "prior");
  const e = {...exactKeys(evidence, ["originalSha256", "preparedCaptureSha256", "native", "parent", "root", "staging",
    ...(legacyRaw ? [] : ["prior"])], "MAINTENANCE"), ...(legacyRaw ? {prior: null} : {})} as unknown as WindowsRecoveryPublicationObservation;
  if (e.originalSha256 !== m.sha256 || e.preparedCaptureSha256 !== sha(blob("capture:prepare:stdout")) ||
      e.native.path !== m.path || e.native.fileId !== f.fileId || e.native.volumeId !== f.volumeId ||
      e.native.bytes !== m.byteLength || e.native.sha256 !== m.sha256 ||
      e.parent.canonicalPath !== m.directory.canonicalPath || e.parent.fileId !== d.fileId || e.parent.volumeId !== d.volumeId ||
      e.root.rootFileId !== m.root.fileId || e.root.volumeId !== m.root.volumeId ||
      e.staging.contractVersion !== 3 || e.staging.state !== "ABSENT" || e.staging.path !== m.stagingPath) bad();
  exactKeys(e.staging, ["contractVersion", "state", "path", "directory"], "MAINTENANCE");
  exactKeys(e.staging.directory, ["fileId", "volumeId"], "MAINTENANCE");
  if (e.staging.directory.fileId !== d.fileId || e.staging.directory.volumeId !== d.volumeId) bad();
  if (m.kind === "raw-export" && e.prior !== null) bad();
  return {context: c as unknown as WindowsPrivateMaintenanceContext, evidence: e};
}

export type RecoveryHeadPointer = Readonly<{
  logicalPath: string;
  logicalKey: string;
  workspaceId: string;
  generation: number;
  attemptId: string;
  sha256: string;
}>;

export type RecoveryHeadRead = Readonly<{
  pointer: RecoveryHeadPointer;
  original: Uint8Array;
  receipt: string;
  applied: string;
}>;

/** Consumer view of a head already fully validated by readHead. An observed
 * publication keeps its own outcome; it is never relabelled PUBLISHED. */
export function recoveryHeadPublication(head: RecoveryHeadRead): Readonly<{
  attemptId: string; outcome: "PUBLISHED" | "APPLIED_OBSERVED"; path: string; sha256: string;
  identity: Readonly<{canonicalPath: string; fileId: string; volumeId: string}>;
}> {
  const result = JSON.parse(head.applied), receipt = JSON.parse(head.receipt);
  const observed = result.state === "APPLIED_OBSERVED";
  const identity = observed ? {
    canonicalPath: receipt.evidence?.native?.path,
    fileId: receipt.evidence?.native?.fileId, volumeId: receipt.evidence?.native?.volumeId,
  } : receipt.evidence?.identity;
  const path = observed ? receipt.evidence?.native?.path : receipt.evidence?.path;
  const digest = observed ? receipt.evidence?.native?.sha256 : receipt.evidence?.sha256;
  if ((observed ? receipt.state !== "APPLIED_OBSERVED" : result.state !== "APPLIED" || receipt.outcome !== "PUBLISHED") ||
      receipt.attemptId !== head.pointer.attemptId || result.attemptId !== head.pointer.attemptId ||
      digest !== head.pointer.sha256 || sha(head.original) !== digest || result.sha256 !== digest ||
      result.generation !== head.pointer.generation || result.workspaceId !== head.pointer.workspaceId ||
      result.logicalKey !== head.pointer.logicalKey || path !== result.path ||
      canonical(identity) !== canonical(result.identity) || identity?.canonicalPath !== path ||
      !FILE_ID.test(identity?.fileId) || !VOLUME_ID.test(identity?.volumeId)) fail("STORED");
  requireCanonicalPath(path, "STORED");
  return {attemptId: head.pointer.attemptId, outcome: observed ? "APPLIED_OBSERVED" : "PUBLISHED",
    path, sha256: digest, identity};
}

export type RecoveryReserveMetadata = Readonly<{
  kind: "checkpoint";
  attemptId: string;
  path: string;
  stagingPath: string;
  logicalPath: string;
  workspaceId: string;
  root: Readonly<{ fileId: string; volumeId: string }>;
  directory: Readonly<{ canonicalPath: string; fileId: string; volumeId: string }>;
  generation: number;
  expectedHead: RecoveryExpectedHead | null;
  byteLength: number;
  sha256: string;
}>;

const HEAD_COLUMNS = ["logical_path", "workspace_id", "generation", "attempt_id", "sha256"] as const;
type HeadRow = { logical_path: string; workspace_id: string; generation: number; attempt_id: string; sha256: string };

function headRow(row: unknown): HeadRow {
  if (typeof row !== "object" || row === null) fail("STORED");
  const r = row as Record<string, unknown>;
  if (HEAD_COLUMNS.some((key) => !(key in r))) fail("STORED");
  return r as unknown as HeadRow;
}

function requireText(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value;
}

function requireCanonicalPath(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Z]:\\[\x20-\x7e]*$/.test(value)) fail(code);
  try {
    if (validateWindowsPath(value, `${value[0]}:\\`).canonical !== value) fail(code);
  } catch { fail(code); }
  return value;
}

function exactKeys(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const r = value as Record<string, unknown>;
  const names = Object.keys(r);
  if (names.length !== keys.length || names.some((name) => !keys.includes(name))) fail(code);
  return r;
}

function requireExpectedHead(value: unknown): RecoveryExpectedHead | null {
  if (value === null) return null;
  const r = exactKeys(value, ["generation", "attemptId", "sha256"], "EXPECTED");
  if (!Number.isSafeInteger(r.generation) || (r.generation as number) <= 0 ||
      typeof r.attemptId !== "string" || !ATTEMPT_ID.test(r.attemptId) ||
      typeof r.sha256 !== "string" || !SHA256.test(r.sha256))
    fail("EXPECTED");
  return Object.freeze({
    generation: r.generation as number,
    attemptId: r.attemptId,
    sha256: r.sha256,
  });
}

function requireIdentityRecord(value: unknown, code: string): { fileId: string; volumeId: string } {
  const r = exactKeys(value, ["fileId", "volumeId"], code);
  return {
    fileId: requireText(r.fileId, FILE_ID, code),
    volumeId: requireText(r.volumeId, VOLUME_ID, code),
  };
}

function validateMetadata(input: unknown): RecoveryReserveMetadata {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("METADATA");
  let body: string;
  try { body = canonical(input, WINDOWS_RECOVERY_METADATA_MAX_BYTES); } catch { fail("METADATA"); }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { fail("METADATA"); }
  const r = exactKeys(parsed, [
    "attemptId", "byteLength", "directory", "expectedHead", "generation", "kind",
    "logicalPath", "path", "root", "sha256", "stagingPath", "workspaceId",
  ], "METADATA");
  if (r.kind !== "checkpoint") fail("METADATA");
  const attemptId = requireText(r.attemptId, ATTEMPT_ID, "METADATA");
  const path = requireCanonicalPath(r.path, "METADATA");
  const stagingPath = requireCanonicalPath(r.stagingPath, "METADATA");
  const logicalPath = requireCanonicalPath(r.logicalPath, "METADATA");
  const workspaceId = requireText(r.workspaceId, WORKSPACE_ID, "METADATA");
  const root = requireIdentityRecord(r.root, "METADATA");
  const directory = exactKeys(r.directory, ["canonicalPath", "fileId", "volumeId"], "METADATA");
  const directoryIdentity = {
    canonicalPath: requireCanonicalPath(directory.canonicalPath, "METADATA"),
    ...requireIdentityRecord({fileId: directory.fileId, volumeId: directory.volumeId}, "METADATA"),
  };
  if (!Number.isSafeInteger(r.generation) || (r.generation as number) <= 0) fail("METADATA");
  const expectedHead = requireExpectedHead(r.expectedHead);
  if ((expectedHead?.generation ?? 0) + 1 !== r.generation) fail("METADATA");
  const sha256 = requireText(r.sha256, SHA256, "METADATA");
  if (typeof r.byteLength !== "number" || !Number.isSafeInteger(r.byteLength) ||
      r.byteLength < 0 || r.byteLength > WINDOWS_RECOVERY_MAX_BYTES) fail("METADATA");
  // Physical target/stage are siblings of the logical checkpoint name, never
  // the logical name itself; stage is a distinct sibling too.
  const parent = parentOf(logicalPath);
  if (parentOf(path) !== parent || parentOf(stagingPath) !== parent) fail("METADATA_LINK");
  if (asciiCaseFold(path) === asciiCaseFold(logicalPath) ||
      asciiCaseFold(stagingPath) === asciiCaseFold(logicalPath) ||
      asciiCaseFold(path) === asciiCaseFold(stagingPath)) fail("METADATA_LINK");
  if (directoryIdentity.canonicalPath !== parent) fail("METADATA_LINK");
  if (asciiCaseFold(root.volumeId) !== asciiCaseFold(directoryIdentity.volumeId)) fail("METADATA_LINK");
  return Object.freeze({
    kind: "checkpoint" as const, attemptId, path, stagingPath, logicalPath, workspaceId,
    root: Object.freeze(root), directory: Object.freeze(directoryIdentity),
    generation: r.generation as number, expectedHead,
    byteLength: r.byteLength, sha256,
  });
}

function expectedBody(expected: RecoveryExpectedHead | null): string {
  return canonical(expected);
}

type TerminalRecord = Readonly<{
  attemptId: string; outcome: string; evidence: Record<string, unknown>;
}>;

function parseTerminal(receipt: string): TerminalRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(receipt); } catch { fail("STORED"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("STORED");
  const r = parsed as Record<string, unknown>;
  if (typeof r.attemptId !== "string" || !ATTEMPT_ID.test(r.attemptId) ||
      typeof r.outcome !== "string" ||
      typeof r.evidence !== "object" || r.evidence === null || Array.isArray(r.evidence))
    fail("STORED");
  return { attemptId: r.attemptId, outcome: r.outcome, evidence: r.evidence as Record<string, unknown> };
}

/**
 * Independent private SQLite authority for the Windows recovery CAS. This is
 * NOT PrivateLedger (its 64 KiB value and 8 MiB caps cannot hold a 32 MiB raw
 * original): one own transaction per step over immutable attempt/blob/
 * terminal/intent/result records plus a single mutable CAS pointer row per
 * logical key. Schema identity is version 2; archives written by the earlier
 * version-1 schema fail closed read-only (no unsafe migration in scope). No
 * delete, purge or mutation replay; a reopened archive keeps every retained
 * record but holds no local dispatch rights. Explicit operator observation is
 * a separate CAS authority.
 */
export class WindowsRecoveryArchive {
  private readonly guard!: SyncSqliteGuard;
  private readonly owner: SqliteConnectionOwner;
  private readonly platform!: ArchivePlatformProxy;
  private readonly path!: string;
  /** Attempts this instance reserved durably — the only record/dispatch and
   * pointer-advance rights. Never populated from reopened state. */
  private readonly localAttempts = new Set<string>();
  private closed = false;
  private closing = false;
  private unavailable = false;
  private failure: unknown;

  constructor(
    directory: string,
    platform: PrivatePlatform,
    binding: string,
    forbiddenRoots: readonly string[] = [],
  ) {
    let kind: unknown;
    try {
      kind = typeof platform === "object" && platform !== null ? platform.kind : undefined;
    } catch {
      fail("PLATFORM");
    }
    if (kind !== "windows") fail("PLATFORM");
    if (process.platform === "win32" && !isAuthorityLeasePlatform(platform)) fail("NATIVE_LEASE_REQUIRED");
    const dirLex = lexicalPath(directory);
    if (dirLex === null) fail("DIRECTORY");
    if (typeof binding !== "string" || binding.length === 0 ||
        Buffer.byteLength(binding) > WINDOWS_RECOVERY_METADATA_MAX_BYTES || !wellFormed(binding))
      fail("BINDING");
    if (!Array.isArray(forbiddenRoots)) fail("FORBIDDEN_ROOT");
    const roots: LexicalPath[] = [];
    for (const root of forbiddenRoots) {
      const lex = lexicalPath(root);
      if (lex === null) fail("FORBIDDEN_ROOT");
      roots.push(lex);
    }
    for (const root of roots)
      if (overlapsLexical(dirLex, root)) fail("FORBIDDEN_ROOT");
    // The owner is reserved before the proxy/native wrap so a construction
    // failure at any later step still has one ordered cleanup path.
    let cleanupPlatform: PrivatePlatform = platform;
    this.owner = new SqliteConnectionOwner(() => closeSqlitePlatform(cleanupPlatform));
    try {
      this.platform = new ArchivePlatformProxy(synchronousPrivatePlatform(platform), roots);
      cleanupPlatform = this.platform;
      const bound = this.platform.bind(directory);
      const path = join(bound, WINDOWS_RECOVERY_ARCHIVE_DATABASE);
      const assertFilesystem = (): void => {
        this.platform.assertRoot();
        this.platform.assertFile(path);
        this.platform.assertSidecars(path);
      };
      this.platform.createExclusive(path);
      this.platform.assertFile(path);
      this.platform.assertSidecars(path);
      if (lstatSync(path).size > 0)
        preflightExistingJournal(path, assertFilesystem, (candidate) =>
          this.validateSchema(candidate, binding), this.platform, this.owner);
      const db = new DatabaseSync(path);
      this.owner.opened(db);
      const guard = this.owner.guarded(db);
      this.guard = guard;
      db.exec(
        "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
      );
      this.path = path;
      guard.transaction(() => {
        this.assertOwned();
        const schema = db
          .prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
          .all() as { name: string; type: string }[];
        if (schema.length === 0) {
          this.platform.assertEmptyFile(path);
          db.exec(
            "CREATE TABLE recovery_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), role TEXT NOT NULL, version INTEGER NOT NULL, binding TEXT NOT NULL);" +
              "CREATE TABLE recovery_attempts(attempt_id TEXT PRIMARY KEY, target_key TEXT NOT NULL UNIQUE, metadata TEXT NOT NULL, budget INTEGER NOT NULL);" +
              "CREATE TABLE recovery_blobs(attempt_id TEXT NOT NULL, kind TEXT NOT NULL, bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(attempt_id,kind));" +
              "CREATE TABLE recovery_terminals(attempt_id TEXT PRIMARY KEY, receipt TEXT NOT NULL);" +
              "CREATE TABLE recovery_heads(logical_path TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL, attempt_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL);" +
              "CREATE TABLE recovery_logical_targets(logical_key TEXT PRIMARY KEY, logical_path TEXT NOT NULL, workspace_id TEXT NOT NULL);" +
              "CREATE TABLE recovery_pointer_intents(attempt_id TEXT PRIMARY KEY, logical_key TEXT NOT NULL, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL, expected TEXT NOT NULL);" +
              "CREATE TABLE recovery_pointer_results(attempt_id TEXT PRIMARY KEY, result TEXT NOT NULL);",
          );
          db.prepare("INSERT INTO recovery_identity VALUES(1,?,?,?)").run(ROLE, VERSION, binding);
        } else {
          this.validateSchema(db, binding);
        }
        this.effectiveCharge(db);
        this.assertOwned();
      });
    } catch (error) {
      this.owner.fail(error);
    }
  }

  private validateSchema(db: DatabaseSync, binding: string): void {
    const schema = db
      .prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { name: string; type: string }[];
    const names = new Set(schema.filter((row) => row.type === "table").map((row) => String(row.name)));
    const expected = [
      "recovery_identity",
      "recovery_attempts",
      "recovery_blobs",
      "recovery_terminals",
      "recovery_heads",
      "recovery_logical_targets",
      "recovery_pointer_intents",
      "recovery_pointer_results",
    ];
    if (schema.length !== expected.length || !expected.every((name) => names.has(name)))
      fail("SCHEMA");
    const identity = db.prepare("SELECT * FROM recovery_identity").all() as Record<string, unknown>[];
    if (identity.length !== 1 || identity[0].singleton !== 1 || identity[0].role !== ROLE ||
        identity[0].version !== VERSION || identity[0].binding !== binding)
      fail("BINDING");
  }

  private assertOwned(): void {
    if (this.unavailable) throw this.failure;
    if (this.closing || this.closed) fail("CLOSED");
    this.platform.assertRoot();
    this.platform.assertFile(this.path);
    this.platform.assertSidecars(this.path);
    this.guard.assertUsable();
  }

  private transact<T>(work: () => T): T {
    let finished = false;
    try {
      const result = this.guard.transaction(() => {
        this.assertOwned();
        const value = work();
        finished = true;
        this.assertOwned();
        return value;
      });
      this.assertOwned();
      return result;
    } catch (error) {
      if (finished) {
        this.unavailable = true;
        this.failure = error;
        this.localAttempts.clear();
      }
      throw error;
    }
  }

  private storedBytes(row: unknown, expectedSha: string): Uint8Array {
    if (typeof row !== "object" || row === null) fail("STORED");
    const r = row as { bytes?: unknown; sha256?: unknown };
    const bytes = r.bytes;
    if (!(bytes instanceof Uint8Array) || typeof r.sha256 !== "string" ||
        r.sha256 !== expectedSha || sha(bytes) !== expectedSha)
      fail("STORED_HASH");
    return Uint8Array.from(bytes);
  }

  private blobRow(attemptId: string, kind: RecoveryBlobKind): Uint8Array | undefined {
    const row = this.guard.db
      .prepare("SELECT bytes,sha256 FROM recovery_blobs WHERE attempt_id=? AND kind=?")
      .get(attemptId, kind) as { bytes: Uint8Array; sha256: string } | undefined;
    if (row === undefined) return undefined;
    return this.storedBytes(row, row.sha256);
  }

  /** Effective capacity charge: an unresolved intent still owes its full
   * lifecycle reservation; an APPLIED intent releases only the unused virtual
   * reservation down to actual stored bytes plus bounded record overhead.
   * Nothing is ever deleted and budgets are never mutated. */
  private effectiveCharge(db: DatabaseSync): number {
    const rows = db
      .prepare(
        "SELECT a.attempt_id,a.budget,a.metadata," +
          "(SELECT receipt FROM recovery_terminals t WHERE t.attempt_id=a.attempt_id) AS receipt," +
          "(SELECT result FROM recovery_pointer_results r WHERE r.attempt_id=a.attempt_id) AS result," +
          "(SELECT expected FROM recovery_pointer_intents i WHERE i.attempt_id=a.attempt_id) AS intent," +
          "(SELECT COALESCE(SUM(length(bytes)),0) FROM recovery_blobs b WHERE b.attempt_id=a.attempt_id) AS blobBytes " +
          "FROM recovery_attempts a",
      )
      .all() as {
        attempt_id: string; budget: number; metadata: string;
        receipt: string | null; result: string | null; intent: string | null; blobBytes: number;
      }[];
    if (rows.length > WINDOWS_RECOVERY_ARCHIVE_MAX_ATTEMPTS) fail("STORED");
    let total = 0;
    for (const row of rows) {
      if (!Number.isSafeInteger(row.budget) || row.budget <= 0 ||
          !Number.isSafeInteger(row.blobBytes) || row.blobBytes < 0 || row.blobBytes > row.budget) fail("STORED");
      let applied = false;
      if (row.result !== null) { this.appliedFor(row.attempt_id); applied = true; }
      if (!applied) { total += row.budget; continue; }
      this.appliedFor(row.attempt_id);
      const recordBytes =
        Buffer.byteLength(row.metadata) +
        Buffer.byteLength(row.receipt ?? "") +
        Buffer.byteLength(row.result ?? "") +
        Buffer.byteLength(row.intent ?? "");
      total += row.blobBytes + recordBytes + RECORD_OVERHEAD;
    }
    if (!Number.isSafeInteger(total) || total > WINDOWS_RECOVERY_ARCHIVE_MAX_BYTES) fail("CAPACITY");
    return total;
  }

  /**
   * Reserve one attempt, its immutable original and its pointer intent in the
   * same BEGIN IMMEDIATE. The full lifecycle budget (declared original +
   * prepare wire bound + commit wire bound + four global maximum captures +
   * metadata overhead) is admitted against EFFECTIVE charge BEFORE any helper;
   * current head, expected head, generation, logical target workspace and any
   * unresolved intent are all validated atomically. Returns only after COMMIT
   * and a byte/record readback. Nothing is released, deleted or replayed.
   */
  reserve(request: {
    attemptId: string;
    targetKey: string;
    metadata: Record<string, unknown>;
    original: Uint8Array;
  }): void {
    const attemptId = requireText(request.attemptId, ATTEMPT_ID, "ATTEMPT");
    if (typeof request.targetKey !== "string" || request.targetKey.length === 0 ||
        request.targetKey.length > 200 || !wellFormed(request.targetKey))
      fail("TARGET");
    const metadata = validateMetadata(request.metadata);
    if (metadata.attemptId !== attemptId) fail("ATTEMPT");
    if (!(request.original instanceof Uint8Array) ||
        request.original.byteLength > WINDOWS_RECOVERY_MAX_BYTES ||
        request.original.byteLength !== metadata.byteLength ||
        sha(request.original) !== metadata.sha256)
      fail("ORIGINAL");
    const original = Uint8Array.from(request.original);
    const logicalKey = recoveryLogicalKey(metadata.logicalPath);
    const physicalKey = `target:${sha([
      metadata.root.volumeId, metadata.root.fileId,
      metadata.directory.volumeId, metadata.directory.fileId,
      metadata.path.slice(metadata.path.lastIndexOf("\\") + 1),
    ].map(asciiCaseFold).join("|"))}`;
    if (request.targetKey !== physicalKey) fail("TARGET");
    const body = canonical(request.metadata, WINDOWS_RECOVERY_METADATA_MAX_BYTES);
    const expected = expectedBody(metadata.expectedHead);
    const prepareWireBound = 4 + 8192 + original.byteLength;
    const commitWireBound = 4 + 8192;
    const budget =
      original.byteLength + prepareWireBound + commitWireBound +
      4 * WINDOWS_RECOVERY_MAX_CAPTURE_BYTES + METADATA_OVERHEAD;
    if (!Number.isSafeInteger(budget) || budget <= 0) fail("BUDGET");
    this.transact(() => {
      const db = this.guard.db;
      const attempts = db.prepare("SELECT COUNT(*) AS n FROM recovery_attempts").get() as { n: number };
      const count = attempts.n;
      let refused = false;
      let charge: number | undefined;
      if (!Number.isFinite(count)) {
        refused = true;
      } else if (count >= WINDOWS_RECOVERY_ARCHIVE_MAX_ATTEMPTS) {
        refused = true;
      } else {
        const currentCharge = this.effectiveCharge(db);
        charge = currentCharge;
        if (currentCharge + budget > WINDOWS_RECOVERY_ARCHIVE_MAX_BYTES) refused = true;
      }
      if (refused) {
        const error = new CollaborationError("WINDOWS_RECOVERY_ARCHIVE_CAPACITY");
        if (Number.isSafeInteger(count) && count >= 0 &&
            count <= WINDOWS_RECOVERY_ARCHIVE_MAX_ATTEMPTS &&
            (count === WINDOWS_RECOVERY_ARCHIVE_MAX_ATTEMPTS ||
              (typeof charge === "number" && Number.isSafeInteger(charge) && charge >= 0 &&
                charge <= WINDOWS_RECOVERY_ARCHIVE_MAX_BYTES &&
                Number.isSafeInteger(charge + budget) &&
                charge + budget > WINDOWS_RECOVERY_ARCHIVE_MAX_BYTES)))
          recordCheckpointCapacityRefusal(error, attemptId);
        throw error;
      }
      // Folded logical key: the target belongs to exactly one workspace; a
      // foreign workspace is rejected even when no head exists yet.
      const target = db
        .prepare("SELECT logical_path,workspace_id FROM recovery_logical_targets WHERE logical_key=?")
        .get(logicalKey) as { logical_path: string; workspace_id: string } | undefined;
      if (target !== undefined) {
        if (target.workspace_id !== metadata.workspaceId) fail("WORKSPACE");
        if (recoveryLogicalKey(target.logical_path) !== logicalKey) fail("TARGET");
      } else {
        db.prepare("INSERT INTO recovery_logical_targets(logical_key,logical_path,workspace_id) VALUES(?,?,?)")
          .run(logicalKey, metadata.logicalPath, metadata.workspaceId);
      }
      const head = db.prepare("SELECT * FROM recovery_heads WHERE logical_path=?").all(logicalKey);
      if (head.length > 1) fail("STORED");
      if (metadata.expectedHead === null) {
        if (head.length !== 0) fail("CONFLICT");
      } else {
        if (head.length !== 1) fail("CONFLICT");
        const row = headRow(head[0]);
        if (row.workspace_id !== metadata.workspaceId ||
            row.generation !== metadata.expectedHead.generation ||
            row.attempt_id !== metadata.expectedHead.attemptId ||
            row.sha256 !== metadata.expectedHead.sha256) fail("CONFLICT");
      }
      // ANY unresolved intent for this logical key blocks a new reservation —
      // regardless of which workspace or native terminal state it carries.
      const pending = db
        .prepare(
          "SELECT i.attempt_id FROM recovery_pointer_intents i LEFT JOIN recovery_pointer_results r ON r.attempt_id=i.attempt_id WHERE i.logical_key=? AND r.attempt_id IS NULL",
        )
        .all(logicalKey);
      if (pending.length !== 0) fail("PENDING");
      db.prepare("INSERT INTO recovery_attempts(attempt_id,target_key,metadata,budget) VALUES(?,?,?,?)")
        .run(attemptId, physicalKey, body, budget);
      db.prepare("INSERT INTO recovery_blobs(attempt_id,kind,bytes,sha256) VALUES(?,?,?,?)")
        .run(attemptId, "original", original, metadata.sha256);
      db.prepare("INSERT INTO recovery_pointer_intents(attempt_id,logical_key,workspace_id,generation,expected) VALUES(?,?,?,?,?)")
        .run(attemptId, logicalKey, metadata.workspaceId, metadata.generation, expected);
    });
    const verified = this.transact(() => {
      const originalRead = this.blobRow(attemptId, "original");
      if (originalRead === undefined || !Buffer.from(originalRead).equals(original)) fail("READBACK");
      const attemptRow = this.guard.db
        .prepare("SELECT metadata FROM recovery_attempts WHERE attempt_id=?")
        .get(attemptId) as { metadata: string } | undefined;
      const intentRow = this.guard.db
        .prepare("SELECT logical_key,workspace_id,generation,expected FROM recovery_pointer_intents WHERE attempt_id=?")
        .get(attemptId) as { logical_key: string; workspace_id: string; generation: number; expected: string } | undefined;
      if (attemptRow === undefined || attemptRow.metadata !== body ||
          intentRow === undefined || intentRow.logical_key !== logicalKey ||
          intentRow.workspace_id !== metadata.workspaceId ||
          intentRow.generation !== metadata.generation || intentRow.expected !== expected)
        fail("READBACK");
    });
    void verified;
    // Opaque instance-local rights only AFTER durable commit + readback.
    this.localAttempts.add(attemptId);
  }

  /** Insert one immutable wire/capture/evidence blob for an attempt this
   * instance reserved. The primary key makes a second write under the same
   * kind a deterministic conflict; per-attempt bytes stay within the durable
   * reservation budget; nothing may be recorded after the terminal. */
  record(attemptId: string, kind: RecoveryBlobKind, bytes: Uint8Array): void {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    if (!BLOB_KINDS.has(kind) || kind === "evidence:maintenance" || kind === "evidence:maintenance-cas") fail("KIND");
    const cap = kind.endsWith(":metadata") || kind === "evidence:prepared" ? WINDOWS_RECOVERY_METADATA_MAX_BYTES : kind.startsWith("capture:")
      ? WINDOWS_RECOVERY_MAX_CAPTURE_BYTES
      : WINDOWS_RECOVERY_MAX_WIRE_BYTES;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > cap) fail("BLOB");
    const copy = Uint8Array.from(bytes);
    const digest = sha(copy);
    this.transact(() => {
      if (!this.localAttempts.has(attemptId)) fail("DISPATCH_RIGHTS");
      const db = this.guard.db;
      const attempt = db.prepare("SELECT budget FROM recovery_attempts WHERE attempt_id=?").get(attemptId) as
        | { budget: number } | undefined;
      if (attempt === undefined || !Number.isSafeInteger(attempt.budget)) fail("ATTEMPT");
      const terminated = db.prepare("SELECT attempt_id FROM recovery_terminals WHERE attempt_id=?")
        .get(attemptId);
      if (terminated !== undefined) fail("TERMINATED");
      const stats = db
        .prepare("SELECT COUNT(*) AS rows,COALESCE(SUM(length(bytes)),0) AS bytes FROM recovery_blobs WHERE attempt_id=?")
        .get(attemptId) as { rows: number; bytes: number };
      const globalBytes = db.prepare("SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM recovery_blobs")
        .get() as { bytes: number };
      if (!Number.isFinite(stats.rows) || !Number.isFinite(stats.bytes) || !Number.isFinite(globalBytes.bytes) ||
          stats.rows >= WINDOWS_RECOVERY_ARCHIVE_MAX_BLOBS_PER_ATTEMPT ||
          stats.bytes + copy.byteLength > attempt.budget ||
          globalBytes.bytes + copy.byteLength > WINDOWS_RECOVERY_ARCHIVE_MAX_BYTES)
        fail("CAPACITY");
      db.prepare("INSERT INTO recovery_blobs(attempt_id,kind,bytes,sha256) VALUES(?,?,?,?)")
        .run(attemptId, kind, copy, digest);
    });
    const readback = this.transact(() => this.blobRow(attemptId, kind));
    if (readback === undefined || !Buffer.from(readback).equals(copy)) fail("READBACK");
  }

  /** Immutable terminal record, instance-local rights only. Only valid after
   * the final exact evidence was validated and raw captures archived by the
   * caller; a non-PUBLISHED terminal retains evidence but never releases the
   * pending claim on the logical path. */
  recordTerminal(attemptId: string, receipt: string): void {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    if (typeof receipt !== "string" || receipt.length === 0 || !wellFormed(receipt) ||
        Buffer.byteLength(receipt) > WINDOWS_RECOVERY_METADATA_MAX_BYTES)
      fail("RECEIPT");
    let parsed: unknown;
    try { parsed = JSON.parse(receipt); } catch { fail("RECEIPT"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("RECEIPT");
    this.transact(() => {
      if (!this.localAttempts.has(attemptId)) fail("DISPATCH_RIGHTS");
      this.guard.db.prepare("INSERT INTO recovery_terminals(attempt_id,receipt) VALUES(?,?)")
        .run(attemptId, receipt);
      const terminal = parseTerminal(receipt);
      if (terminal.attemptId !== attemptId ||
          !["PUBLISHED", "UNKNOWN", "REJECTED"].includes(terminal.outcome)) fail("RECEIPT");
      if (terminal.outcome === "PUBLISHED") this.validatePublishedTerminal(attemptId, this.metadataFor(attemptId));
    });
    const row = this.transact(
      () => this.guard.db.prepare("SELECT receipt FROM recovery_terminals WHERE attempt_id=?")
        .get(attemptId) as { receipt: string } | undefined,
    );
    if (row === undefined || row.receipt !== receipt) fail("READBACK");
  }

  /** Read back one stored blob with length/hash verification; allowed after
   * reopen since reads carry no dispatch authority. */
  readBlob(attemptId: string, kind: RecoveryBlobKind): Uint8Array | undefined {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    if (!BLOB_KINDS.has(kind)) fail("KIND");
    return this.transact(() => this.blobRow(attemptId, kind));
  }

  readMetadata(attemptId: string): Record<string, unknown> | undefined {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    return this.transact(() => {
      const row = this.guard.db.prepare("SELECT metadata FROM recovery_attempts WHERE attempt_id=?")
        .get(attemptId) as { metadata: string } | undefined;
      if (row === undefined) return undefined;
      let parsed: unknown;
      try { parsed = JSON.parse(row.metadata); } catch { fail("STORED"); }
      if (canonical(parsed) !== row.metadata) fail("STORED");
      return parsed as Record<string, unknown>;
    });
  }

  terminalReceipt(attemptId: string): string | undefined {
    requireText(attemptId, ATTEMPT_ID, "ATTEMPT");
    return this.transact(() => {
      const row = this.guard.db.prepare("SELECT receipt FROM recovery_terminals WHERE attempt_id=?")
        .get(attemptId) as { receipt: string } | undefined;
      return row?.receipt;
    });
  }

  private intentsPending(db: DatabaseSync, logicalKey: string, excludeAttemptId?: string): string[] {
    const rows = db
      .prepare(
        "SELECT i.attempt_id,i.workspace_id FROM recovery_pointer_intents i LEFT JOIN recovery_pointer_results r ON r.attempt_id=i.attempt_id WHERE i.logical_key=? AND r.attempt_id IS NULL",
      )
      .all(logicalKey) as { attempt_id: string; workspace_id: string }[];
    if (rows.length > WINDOWS_RECOVERY_ARCHIVE_MAX_ATTEMPTS) fail("STORED");
    return rows.filter((row) => row.attempt_id !== excludeAttemptId).map((row) => row.attempt_id);
  }

  /** Unresolved intents for this logical key under the CALLER's workspace.
   * A foreign workspace owning the folded key is a hard failure, never an
   * empty answer. */
  pendingAttempts(logicalPath: string, workspaceId: string): readonly string[] {
    const logicalKey = recoveryLogicalKey(logicalPath);
    requireText(workspaceId, WORKSPACE_ID, "WORKSPACE");
    return this.transact(() => {
      const db = this.guard.db;
      const target = db
        .prepare("SELECT workspace_id FROM recovery_logical_targets WHERE logical_key=?")
        .get(logicalKey) as { workspace_id: string } | undefined;
      if (target !== undefined && target.workspace_id !== workspaceId) fail("WORKSPACE");
      return this.intentsPending(db, logicalKey);
    });
  }

  /** Full terminal validation: parsed outcome PUBLISHED, bound attempt,
   * evidence path/sha256/byteLength matching the reservation metadata and a
   * strict native identity — never a hash-only acceptance. */
  private validatePublishedTerminal(attemptId: string, metadata: RecoveryReserveMetadata): { identity: { canonicalPath: string; fileId: string; volumeId: string }; receipt: string } {
    const row = this.guard.db.prepare("SELECT receipt FROM recovery_terminals WHERE attempt_id=?")
      .get(attemptId) as { receipt: string } | undefined;
    if (row === undefined) fail("NEXT_ATTEMPT");
    const terminal = parseTerminal(row.receipt);
    if (terminal.attemptId !== attemptId || terminal.outcome !== "PUBLISHED") fail("RECEIPT");
    const e = terminal.evidence;
    const identity = e.identity;
    if (e.path !== metadata.path || e.sha256 !== metadata.sha256 ||
        e.byteLength !== metadata.byteLength ||
        e.stagingDisposition !== "RENAMED_TO_FINAL" ||
        typeof identity !== "object" || identity === null)
      fail("RECEIPT");
    const id = identity as Record<string, unknown>;
    if (id.canonicalPath !== metadata.path ||
        typeof id.fileId !== "string" || !FILE_ID.test(id.fileId) ||
        typeof id.volumeId !== "string" || !VOLUME_ID.test(id.volumeId))
      fail("RECEIPT");
    // The stored prepared evidence must pin the SAME staged file identity.
    const prepared = this.blobRow(attemptId, "evidence:prepared");
    if (prepared === undefined) fail("RECEIPT");
    let prep: unknown;
    try { prep = JSON.parse(Buffer.from(prepared).toString("utf8")); } catch { fail("RECEIPT"); }
    if (!prep || typeof prep !== "object") fail("RECEIPT");
    const ph = (prep as Record<string, unknown>).header as Record<string, unknown> | undefined;
    const pfile = ph?.file as Record<string, unknown> | undefined;
    if (ph?.contractVersion !== 3 || ph.operation !== "prepare" || ph.state !== "PREPARED" ||
        ph.attemptId !== attemptId || ph.path !== metadata.path || ph.stagingPath !== metadata.stagingPath ||
        ph.byteLength !== metadata.byteLength || ph.sha256 !== metadata.sha256 ||
        ph.contentFlushed !== true || ph.filesystem !== "NTFS" ||
        typeof ph.root !== "string" ||
        typeof pfile?.fileId !== "string" || asciiCaseFold(pfile.fileId) !== asciiCaseFold(id.fileId) ||
        typeof pfile?.volumeId !== "string" || asciiCaseFold(pfile.volumeId) !== asciiCaseFold(id.volumeId))
      fail("RECEIPT");
    assertWindowsProbe(pfile, {canonicalPath: metadata.stagingPath, canonicalRoot: ph.root});
    assertWindowsProbe(ph.directory, {canonicalPath: metadata.directory.canonicalPath, canonicalRoot: ph.root});
    const directory = ph.directory as Record<string, unknown>;
    if (asciiCaseFold(String(pfile.rootFileId)) !== asciiCaseFold(metadata.root.fileId) ||
        asciiCaseFold(String(pfile.rootVolumeId)) !== asciiCaseFold(metadata.root.volumeId) ||
        asciiCaseFold(String(directory.fileId)) !== asciiCaseFold(metadata.directory.fileId) ||
        asciiCaseFold(String(directory.volumeId)) !== asciiCaseFold(metadata.directory.volumeId) ||
        pfile.sid !== directory.sid) fail("RECEIPT");
    return {
      identity: { canonicalPath: metadata.path, fileId: id.fileId, volumeId: id.volumeId },
      receipt: row.receipt,
    };
  }

  private metadataFor(attemptId: string): RecoveryReserveMetadata {
    const row = this.guard.db.prepare("SELECT metadata FROM recovery_attempts WHERE attempt_id=?")
      .get(attemptId) as {metadata: string} | undefined;
    if (!row) fail("STORED");
    const value: unknown = JSON.parse(row.metadata);
    if (canonical(value, WINDOWS_RECOVERY_METADATA_MAX_BYTES) !== row.metadata) fail("STORED");
    const metadata = validateMetadata(value);
    if (metadata.attemptId !== attemptId) fail("STORED");
    return metadata;
  }

  /** Validate the whole immutable chain, including the physical identity,
   * before a completed attempt releases virtual capacity or proves a head. */
  private appliedFor(attemptId: string, remaining = WINDOWS_RECOVERY_ARCHIVE_MAX_ATTEMPTS): {metadata: RecoveryReserveMetadata; original: Uint8Array; receipt: string; result: string} {
    if (remaining <= 0) fail("STORED");
    const metadata = this.metadataFor(attemptId);
    const logicalKey = recoveryLogicalKey(metadata.logicalPath);
    const intent = this.guard.db.prepare("SELECT * FROM recovery_pointer_intents WHERE attempt_id=?")
      .get(attemptId) as {logical_key: string; workspace_id: string; generation: number; expected: string} | undefined;
    if (!intent || intent.logical_key !== logicalKey || intent.workspace_id !== metadata.workspaceId ||
        intent.generation !== metadata.generation || intent.expected !== expectedBody(metadata.expectedHead)) fail("STORED");
    const original = this.blobRow(attemptId, "original");
    if (!original || original.byteLength !== metadata.byteLength || sha(original) !== metadata.sha256) fail("STORED");
    const row = this.guard.db.prepare("SELECT result FROM recovery_pointer_results WHERE attempt_id=?")
      .get(attemptId) as {result: string} | undefined;
    if (!row) fail("STORED");
    const result = JSON.parse(row.result);
    let identity: {canonicalPath: string; fileId: string; volumeId: string}, receipt: string;
    if (result.state === "APPLIED_OBSERVED") {
      const item = this.maintenanceInspection(attemptId), observed = validateRecoveryObservation(item);
      const native = observed.evidence.native;
      identity = {canonicalPath: native.path, fileId: native.fileId, volumeId: native.volumeId};
      receipt = item.resolution!;
      const expected = metadata.expectedHead;
      if (expected === null) {
        if (observed.evidence.prior !== null) fail("STORED");
      } else {
        const prior = this.appliedFor(expected.attemptId, remaining - 1), actual = observed.evidence.prior;
        const priorIdentity = JSON.parse(prior.result).identity;
        if (prior.metadata.generation !== expected.generation || expected.generation + 1 !== metadata.generation ||
            prior.metadata.workspaceId !== metadata.workspaceId || recoveryLogicalKey(prior.metadata.logicalPath) !== logicalKey ||
            prior.metadata.sha256 !== expected.sha256 || !actual || actual.path !== prior.metadata.path ||
            actual.sha256 !== expected.sha256 || actual.bytes !== prior.original.length ||
            actual.fileId !== priorIdentity.fileId || actual.volumeId !== priorIdentity.volumeId) fail("STORED");
      }
    } else {
      const terminal = this.validatePublishedTerminal(attemptId, metadata);
      identity = terminal.identity; receipt = terminal.receipt;
    }
    const wanted = {state: result.state === "APPLIED_OBSERVED" ? "APPLIED_OBSERVED" : "APPLIED", attemptId, logicalKey, workspaceId: metadata.workspaceId,
      generation: metadata.generation, sha256: metadata.sha256, path: metadata.path, identity};
    if (canonical(JSON.parse(row.result)) !== canonical(wanted)) fail("STORED");
    return {metadata, original, receipt, result: row.result};
  }

  /**
   * Current CAS pointer plus the immutable original bytes and terminal
   * receipt it references. A foreign workspace on the folded logical key
   * throws even when no pointer exists; an absent pointer with an unresolved
   * intent throws PENDING rather than reporting empty. A prior head stays
   * readable while pending intents exist — the raw remains available for
   * inspection while every write is blocked.
   */
  readHead(logicalPath: string, workspaceId: string): RecoveryHeadRead | undefined {
    const logicalKey = recoveryLogicalKey(logicalPath);
    requireText(workspaceId, WORKSPACE_ID, "WORKSPACE");
    return this.transact(() => {
      const db = this.guard.db;
      const target = db
        .prepare("SELECT logical_path,workspace_id FROM recovery_logical_targets WHERE logical_key=?")
        .get(logicalKey) as { logical_path: string; workspace_id: string } | undefined;
      if (target !== undefined && target.workspace_id !== workspaceId) fail("WORKSPACE");
      const rows = db.prepare("SELECT * FROM recovery_heads WHERE logical_path=?").all(logicalKey);
      if (rows.length > 1) fail("STORED");
      if (rows.length === 0) {
        const pending = this.intentsPending(db, logicalKey);
        if (pending.length !== 0) {
          const failure = new CollaborationError("WINDOWS_RECOVERY_ARCHIVE_PENDING");
          recordCheckpointPriorPending(failure, pending);
          throw failure;
        }
        return undefined;
      }
      const row = headRow(rows[0]);
      if (row.workspace_id !== workspaceId) fail("WORKSPACE");
      const proof = this.appliedFor(row.attempt_id);
      if (!target || proof.metadata.generation !== row.generation || proof.metadata.sha256 !== row.sha256 ||
          proof.metadata.workspaceId !== workspaceId || recoveryLogicalKey(proof.metadata.logicalPath) !== logicalKey) fail("STORED");
      const metadata = validateMetadata(
        JSON.parse(
          (db.prepare("SELECT metadata FROM recovery_attempts WHERE attempt_id=?")
            .get(row.attempt_id) as { metadata: string }).metadata,
        ),
      );
      if (metadata.workspaceId !== workspaceId || metadata.generation !== row.generation ||
          recoveryLogicalKey(metadata.logicalPath) !== logicalKey) fail("STORED");
      const result = db.prepare("SELECT result FROM recovery_pointer_results WHERE attempt_id=?")
        .get(row.attempt_id) as { result: string } | undefined;
      if (result === undefined) fail("STORED");
      let applied: unknown;
      try { applied = JSON.parse(result.result); } catch { fail("STORED"); }
      const a = applied as Record<string, unknown>;
      if (!["APPLIED", "APPLIED_OBSERVED"].includes(String(a.state)) || a.attemptId !== row.attempt_id ||
          a.generation !== row.generation || a.sha256 !== row.sha256) fail("STORED");
      const original = this.blobRow(row.attempt_id, "original");
      if (original === undefined || sha(original) !== row.sha256) fail("STORED");
      return Object.freeze({
        pointer: Object.freeze({
          logicalPath: target!.logical_path, logicalKey,
          workspaceId, generation: row.generation,
          attemptId: row.attempt_id, sha256: row.sha256,
        }),
        original,
        receipt: proof.receipt,
        applied: result.result,
      });
    });
  }

  /**
   * Logical replacement by immutable generation file, never overwrite: inside
   * one BEGIN IMMEDIATE, verify exact intent/workspace/generation/expected,
   * the exact current pointer + its immutable prior original + its APPLIED
   * result, the new original and its fully validated PUBLISHED terminal —
   * then run the caller's synchronous proofs (native IO + fence only, never
   * archive) and advance the head AND record the immutable APPLIED result in
   * the SAME transaction. COMMIT ack-loss poisons this instance, but a
   * reopened readHead proves the APPLIED outcome without any new publication.
   */
  compareAndSwapHead(
    logicalPath: string,
    workspaceId: string,
    expected: RecoveryExpectedHead | null,
    nextAttemptId: string,
    proofs: { assertCurrent(): void; assertPrior(): void },
  ): void {
    const logicalKey = recoveryLogicalKey(logicalPath);
    requireText(workspaceId, WORKSPACE_ID, "WORKSPACE");
    const next = requireText(nextAttemptId, ATTEMPT_ID, "NEXT_ATTEMPT");
    const wanted = requireExpectedHead(expected);
    if (!this.localAttempts.has(next)) fail("DISPATCH_RIGHTS");
    const assertCurrent = proofs?.assertCurrent;
    const assertPrior = proofs?.assertPrior;
    if (typeof assertCurrent !== "function" || typeof assertPrior !== "function" ||
        [assertCurrent, assertPrior].some(fn => utilTypes.isAsyncFunction(fn) || utilTypes.isGeneratorFunction(fn))) fail("PROOFS");
    this.transact(() => {
      const db = this.guard.db;
      const target = db
        .prepare("SELECT workspace_id FROM recovery_logical_targets WHERE logical_key=?")
        .get(logicalKey) as { workspace_id: string } | undefined;
      if (target === undefined || target.workspace_id !== workspaceId) fail("WORKSPACE");
      const rows = db.prepare("SELECT * FROM recovery_heads WHERE logical_path=?").all(logicalKey);
      if (rows.length > 1) fail("STORED");
      if (wanted === null) {
        if (rows.length !== 0) fail("CONFLICT");
      } else {
        if (rows.length !== 1) fail("CONFLICT");
        const row = headRow(rows[0]);
        if (row.workspace_id !== workspaceId || row.generation !== wanted.generation ||
            row.attempt_id !== wanted.attemptId || row.sha256 !== wanted.sha256)
          fail("CONFLICT");
        // Immutable prior original must still match the pinned hash, and the
        // prior intent must carry its immutable APPLIED proof.
        const original = this.blobRow(row.attempt_id, "original");
        if (original === undefined || sha(original) !== row.sha256) fail("STORED");
        const priorResult = db.prepare("SELECT result FROM recovery_pointer_results WHERE attempt_id=?")
          .get(row.attempt_id) as { result: string } | undefined;
        if (priorResult === undefined) fail("STORED");
        const prior = this.appliedFor(row.attempt_id);
        if (prior.metadata.generation !== row.generation || prior.metadata.workspaceId !== workspaceId ||
            recoveryLogicalKey(prior.metadata.logicalPath) !== logicalKey || prior.metadata.sha256 !== row.sha256) fail("STORED");
      }
      if (this.intentsPending(db, logicalKey, next).length !== 0) fail("PENDING");
      const intent = db
        .prepare("SELECT logical_key,workspace_id,generation,expected FROM recovery_pointer_intents WHERE attempt_id=?")
        .get(next) as { logical_key: string; workspace_id: string; generation: number; expected: string } | undefined;
      if (intent === undefined || intent.logical_key !== logicalKey ||
          intent.workspace_id !== workspaceId ||
          intent.generation !== (wanted?.generation ?? 0) + 1 ||
          intent.expected !== expectedBody(wanted)) fail("INTENT");
      const metadata = validateMetadata(
        JSON.parse(
          (db.prepare("SELECT metadata FROM recovery_attempts WHERE attempt_id=?")
            .get(next) as { metadata: string }).metadata,
        ),
      );
      if (metadata.logicalPath !== logicalPath && recoveryLogicalKey(metadata.logicalPath) !== logicalKey)
        fail("INTENT");
      if (metadata.workspaceId !== workspaceId || metadata.generation !== intent.generation ||
          expectedBody(metadata.expectedHead) !== intent.expected) fail("INTENT");
      const original = this.blobRow(next, "original");
      if (original === undefined || sha(original) !== metadata.sha256) fail("NEXT_ATTEMPT");
      const terminal = this.validatePublishedTerminal(next, metadata);
      // Synchronous caller proofs INSIDE the transaction, before advancing:
      // they perform only native IO and the caller fence, never reenter the
      // archive. A defined return or a thenable is invalid.
      for (const proof of [assertCurrent, assertPrior]) {
        const outcome: unknown = proof.call(proofs);
        if (utilTypes.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
        if (outcome !== undefined) fail("PROOF_RETURN");
      }
      const generation = (wanted?.generation ?? 0) + 1;
      const newSha = sha(original);
      const appliedResult = JSON.stringify({
        state: "APPLIED", attemptId: next, logicalKey, workspaceId,
        generation, sha256: newSha, path: metadata.path,
        identity: terminal.identity,
      });
      if (rows.length === 0)
        db.prepare("INSERT INTO recovery_heads(logical_path,workspace_id,generation,attempt_id,sha256) VALUES(?,?,?,?,?)")
          .run(logicalKey, workspaceId, generation, next, newSha);
      else
        db.prepare("UPDATE recovery_heads SET generation=?,attempt_id=?,sha256=? WHERE logical_path=?")
          .run(generation, next, newSha, logicalKey);
      db.prepare("INSERT INTO recovery_pointer_results(attempt_id,result) VALUES(?,?)")
        .run(next, appliedResult);
    });
    const head = this.transact(() => {
      const rows = this.guard.db.prepare("SELECT * FROM recovery_heads WHERE logical_path=?").all(logicalKey);
      if (rows.length !== 1) fail("READBACK");
      const row = headRow(rows[0]);
      const result = this.guard.db.prepare("SELECT result FROM recovery_pointer_results WHERE attempt_id=?")
        .get(next) as { result: string } | undefined;
      if (row.generation !== (wanted?.generation ?? 0) + 1 || row.attempt_id !== next ||
          result === undefined) fail("READBACK");
    });
    void head;
    this.localAttempts.delete(next);
  }

  listAttempts(): readonly string[] {
    return this.transact(() => {
      const rows = this.guard.db.prepare("SELECT attempt_id FROM recovery_attempts ORDER BY attempt_id LIMIT 65").all();
      if (rows.length > WINDOWS_RECOVERY_ARCHIVE_MAX_ATTEMPTS) fail("CAPACITY");
      return rows.map(r => String(r.attempt_id));
    });
  }
  private maintenanceInspection(id: string): WindowsRecoveryMaintenanceInspection {
    requireText(id, ATTEMPT_ID, "ATTEMPT");
    const db = this.guard.db, row = db.prepare("SELECT metadata FROM recovery_attempts WHERE attempt_id=?").get(id);
    if (!row) fail("ATTEMPT");
    const binding = String(db.prepare("SELECT binding FROM recovery_identity").get()?.binding);
    const rows = db.prepare("SELECT kind,bytes,sha256 FROM recovery_blobs WHERE attempt_id=? ORDER BY kind").all(id);
    if (rows.length > WINDOWS_RECOVERY_ARCHIVE_MAX_BLOBS_PER_ATTEMPT) fail("CAPACITY");
    const blobs: Record<string, Uint8Array> = {}, descriptors: unknown[] = [];
    let resolution: string | null = null;
    for (const b of rows) {
      if (!BLOB_KINDS.has(String(b.kind)) || !(b.bytes instanceof Uint8Array) || sha(b.bytes) !== b.sha256) fail("STORED");
      if (b.kind === "evidence:maintenance" || b.kind === "evidence:maintenance-cas") resolution = Buffer.from(b.bytes).toString("utf8");
      else { blobs[String(b.kind)] = Uint8Array.from(b.bytes); descriptors.push([b.kind, b.sha256, b.bytes.length]); }
    }
    const previous = rows.find(b => b.kind === "evidence:maintenance");
    if (rows.some(b => b.kind === "evidence:maintenance-cas")) {
      if (!previous || !(previous.bytes instanceof Uint8Array)) fail("STORED");
      blobs["evidence:maintenance"] = Uint8Array.from(previous.bytes);
    }
    const terminalRow = db.prepare("SELECT receipt FROM recovery_terminals WHERE attempt_id=?").get(id);
    const terminal = terminalRow ? String(terminalRow.receipt) : null;
    const metadata = String(row.metadata);
    const fingerprint = sha(canonical({id, binding, metadata, descriptors, terminal}, 256 * 1024));
    return {attemptId: id, fingerprint, binding, metadata, blobs, terminal, resolution};
  }
  inspectAttempt(id: string): WindowsRecoveryMaintenanceInspection {
    return this.transact(() => this.maintenanceInspection(id));
  }
  /** Operator-only recovery CAS. No process-local dispatch right is reused. */
  observeApplied(id: string, fingerprint: string, context: unknown,
    prove: (item: WindowsRecoveryMaintenanceInspection, prior?: WindowsRecoveryMaintenanceInspection) => WindowsRecoveryPublicationObservation,
    current: () => void): WindowsRecoveryMaintenanceInspection {
    if ([prove, current].some(fn => typeof fn !== "function" || utilTypes.isAsyncFunction(fn) || utilTypes.isGeneratorFunction(fn)))
      fail("PROOFS");
    requireText(fingerprint, SHA256, "FINGERPRINT");
    const contextBody = canonical(context, 4096);
    this.transact(() => {
      const item = this.maintenanceInspection(id);
      if (item.fingerprint !== fingerprint) fail("CONFLICT");
      const check = () => {
        const value: unknown = current();
        if (utilTypes.isPromise(value)) Promise.prototype.then.call(value, undefined, () => undefined);
        if (value !== undefined) fail("PROOF_RETURN");
      };
      check();
      if (item.resolution !== null && this.guard.db.prepare("SELECT result FROM recovery_pointer_results WHERE attempt_id=?").get(id)) {
        this.appliedFor(id); check(); return;
      }
      if (item.blobs["evidence:maintenance"]) fail("STORED");
      const metadata = this.metadataFor(id), wanted = metadata.expectedHead, logicalKey = recoveryLogicalKey(metadata.logicalPath);
      const db = this.guard.db;
      const target = db.prepare("SELECT workspace_id FROM recovery_logical_targets WHERE logical_key=?").get(logicalKey);
      const intent = db.prepare("SELECT * FROM recovery_pointer_intents WHERE attempt_id=?").get(id);
      const heads = db.prepare("SELECT * FROM recovery_heads WHERE logical_path=?").all(logicalKey);
      if (target?.workspace_id !== metadata.workspaceId || !intent || intent.logical_key !== logicalKey ||
          intent.workspace_id !== metadata.workspaceId || intent.generation !== metadata.generation ||
          intent.expected !== expectedBody(wanted) || this.intentsPending(db, logicalKey, id).length !== 0) fail("INTENT");
      let prior: WindowsRecoveryMaintenanceInspection | undefined;
      if (wanted === null) { if (heads.length !== 0) fail("CONFLICT"); }
      else {
        if (heads.length !== 1) fail("CONFLICT");
        const h = headRow(heads[0]);
        if (h.workspace_id !== metadata.workspaceId || h.generation !== wanted.generation ||
            h.attempt_id !== wanted.attemptId || h.sha256 !== wanted.sha256) fail("CONFLICT");
        this.appliedFor(h.attempt_id);
        prior = this.maintenanceInspection(h.attempt_id);
      }
      this.localAttempts.delete(id);
      const evidence = prove(item, prior);
      const body = canonical({state: "APPLIED_OBSERVED", attemptId: id, fingerprint,
        context: JSON.parse(contextBody), evidence,
        ...(item.resolution !== null ? {previousObservationSha256: sha(item.resolution)} : {})}, WINDOWS_RECOVERY_METADATA_MAX_BYTES);
      check();
      validateRecoveryObservation({...item, resolution: body, blobs: {...item.blobs,
        ...(item.resolution !== null ? {"evidence:maintenance": Buffer.from(item.resolution)} : {})}});
      const stats = db.prepare("SELECT count(*) AS n,sum(length(bytes)) AS bytes FROM recovery_blobs WHERE attempt_id=?").get(id)!;
      const budget = Number(db.prepare("SELECT budget FROM recovery_attempts WHERE attempt_id=?").get(id)?.budget);
      if (Number(stats.n) >= WINDOWS_RECOVERY_ARCHIVE_MAX_BLOBS_PER_ATTEMPT ||
          Number(stats.bytes) + Buffer.byteLength(body) > budget) fail("CAPACITY");
      db.prepare("INSERT INTO recovery_blobs VALUES(?,?,?,?)")
        .run(id, item.resolution === null ? "evidence:maintenance" : "evidence:maintenance-cas", Buffer.from(body), sha(body));
      const native = evidence.native;
      const result = canonical({state: "APPLIED_OBSERVED", attemptId: id, logicalKey, workspaceId: metadata.workspaceId,
        generation: metadata.generation, sha256: metadata.sha256, path: metadata.path,
        identity: {canonicalPath: native.path, fileId: native.fileId, volumeId: native.volumeId}});
      db.prepare("INSERT INTO recovery_pointer_results VALUES(?,?)").run(id, result);
      this.appliedFor(id);
      if (heads.length === 0) db.prepare("INSERT INTO recovery_heads VALUES(?,?,?,?,?)")
        .run(logicalKey, metadata.workspaceId, metadata.generation, id, metadata.sha256);
      else db.prepare("UPDATE recovery_heads SET generation=?,attempt_id=?,sha256=? WHERE logical_path=?")
        .run(metadata.generation, id, metadata.sha256, logicalKey);
      this.effectiveCharge(db);
      check();
    });
    return this.inspectAttempt(id);
  }

  /** One owned cleanup path: every registered connection must be provably
   * closed before the proxy/native lease is released. A failed close leaves
   * `closing` set (no reuse) but is retryable — only `closed` ends the loop. */
  close(): void {
    if (this.closed) return;
    this.closing = true;
    this.owner.close();
    this.closed = true;
    this.localAttempts.clear();
  }
}
