import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { types as utilTypes } from "node:util";
import {
  CollaborationError,
  wellFormed,
  type Cut,
} from "../../collaboration/runtime/contract";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";
import { WINDOWS_PROBE_TIMEOUT_MS } from "./private-root";
import type {
  WindowsRuntimeDirectoryIdentity,
  WindowsRuntimeFileIdentity,
  WindowsRuntimeRootIdentity,
} from "./runtime-platform";
import type {
  BackupArtifactBlobKind,
  WindowsBackupArtifactJournal,
} from "./backup-artifact-journal";
import { WINDOWS_PRIVATE_DURABILITY_PROFILE_V1 } from "./private-publication-v2";

export const WINDOWS_BACKUP_ARTIFACT_PROFILE = "FOLIO_SHARED_BACKUP_ARTIFACT_V1" as const;
export const WINDOWS_BACKUP_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
export const WINDOWS_BACKUP_ARTIFACT_HEADER_MAX_BYTES = 8192;
export const WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES =
  4 + WINDOWS_BACKUP_ARTIFACT_HEADER_MAX_BYTES + WINDOWS_BACKUP_ARTIFACT_MAX_BYTES;
// spawnSync can return the final pipe read that crossed maxBuffer. Keep a
// separate finite capture allowance; it does not enlarge accepted wire frames.
export const WINDOWS_BACKUP_ARTIFACT_MAX_CAPTURE_BYTES =
  WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES + 1024 * 1024;

export interface WindowsBackupArtifactPort {
  readonly contractVersion: 1;
  readonly profile: typeof WINDOWS_BACKUP_ARTIFACT_PROFILE;
  readonly platform: "win32";
  readonly trust: "native-helper" | "untrusted-test";
  publishNew(request: WindowsBackupArtifactRequest): Promise<WindowsBackupArtifactReceipt | WindowsBackupArtifactFailure>;
}

export type WindowsBackupArtifactRequest = Readonly<{
  path: string;
  stagingPath: string;
  attemptId: string;
  bytes: Uint8Array;
  forbiddenRoots: readonly string[];
  source: Readonly<{ head: Cut; hash: string }>;
  beforePublish(readback: Uint8Array): void | Promise<void>;
  assertCurrent(): void;
}>;

export type WindowsBackupArtifactReceipt = Readonly<{
  contractVersion: 1;
  profile: typeof WINDOWS_BACKUP_ARTIFACT_PROFILE;
  state: "PUBLISHED";
  path: string;
  stagingPath: string;
  attemptId: string;
  identity: WindowsRuntimeFileIdentity;
  byteLength: number;
  sha256: string;
  readback: Uint8Array;
  stagingDisposition: "RENAMED_TO_FINAL";
  contentFlushed: true;
  namespace: "EXCLUSIVE_NO_REPLACE";
  durability: Readonly<{
    profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1";
    scope: "PROCESS_CRASH";
  }>;
}>;

export type WindowsBackupArtifactFailure = Readonly<{
  contractVersion: 1;
  profile: typeof WINDOWS_BACKUP_ARTIFACT_PROFILE;
  state: "UNKNOWN" | "REJECTED" | "EXISTS";
  path: string;
  stagingPath?: string;
  attemptId?: string;
  reason: string;
  preserve: true;
}>;

export type WindowsBackupArtifactExecRequest = Readonly<{
  executable: string;
  args: readonly ["--private-backup-artifact"];
  cwd: string;
  env: Readonly<{ SystemRoot: string; windir: string; TEMP: string; TMP: string }>;
  input: Uint8Array;
  timeoutMs: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  stdio: "pipe";
  encoding: "buffer";
}>;

export type WindowsBackupArtifactExecResult = Readonly<{
  status: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  errorCode?: string;
}>;

export type WindowsBackupArtifactTestPort = Readonly<{
  fs: Pick<{ lstat(path: string): {
    isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
    nlink: number; dev: number; ino: number; size: number; mtimeMs: number;
  }; readFile(path: string): Uint8Array }, "lstat" | "readFile">;
  exec(request: WindowsBackupArtifactExecRequest): WindowsBackupArtifactExecResult;
}>;

export type WindowsBackupArtifactOptions = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  expectedRoot: WindowsRuntimeRootIdentity;
  journal: WindowsBackupArtifactJournal;
  /** Resolves the pinned parent-directory identity for a canonical path. */
  directoryIdentity(path: string): WindowsRuntimeDirectoryIdentity;
  /** Synchronous caller revalidation before each irreversible dispatch;
   * any defined return value is invalid. */
  assertCurrent(): void;
}>;

const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const ATTEMPT = /^[0-9a-f]{32}$/;
const SID = /^S-1-[0-9]+(?:-[0-9]+)+$/;
function fail(code: string): never { throw new CollaborationError(`WINDOWS_BACKUP_ARTIFACT_${code}`); }
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: string, b: string): boolean => asciiCaseFold(a) === asciiCaseFold(b);

function record(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null) fail("SCHEMA");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("SCHEMA");
  const names = Reflect.ownKeys(value);
  if (keys.some((key) => !names.includes(key))) fail("SCHEMA");
  for (const key of names) {
    if (typeof key !== "string" || (!keys.includes(key) && !optional.includes(key))) fail("SCHEMA");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("SCHEMA");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) fail("SCHEMA");
  return value;
}

function canonical(value: unknown, root?: string): string {
  if (typeof value !== "string" || value.length > 240 || !/^[A-Z]:\\[\x20-\x7e]*$/.test(value)) fail("PATH");
  try {
    if (validateWindowsPath(value, root ?? `${value[0]}:\\`).canonical !== value) fail("PATH");
  } catch { fail("PATH"); }
  return value;
}

function parentOf(path: string): string {
  const end = path.lastIndexOf("\\");
  return end === 2 ? path.slice(0, 3) : path.slice(0, end);
}
function childOf(parent: string, name: string): string {
  return `${parent}${parent.endsWith("\\") ? "" : "\\"}${name}`;
}
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("\\") + 1);
}
function directoryIdentity(value: unknown, volume: string): WindowsRuntimeDirectoryIdentity {
  const r = record(value, ["fileId", "volumeId"]);
  const fileId = text(r.fileId, FILE_ID), volumeId = text(r.volumeId, VOLUME_ID);
  if (!same(volumeId, volume)) fail("IDENTITY");
  return Object.freeze({ fileId, volumeId });
}
function boundedSize(value: unknown, maximum = WINDOWS_BACKUP_ARTIFACT_MAX_BYTES): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail("SIZE");
  return value;
}
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try { return typeof (value as { then?: unknown }).then === "function"; }
  catch { return true; }
}
function isAsyncLike(value: unknown): boolean {
  return typeof value !== "function" || utilTypes.isAsyncFunction(value) || utilTypes.isGeneratorFunction(value);
}

/** Strict canonical Windows forbidden roots with ASCII-folded
 * ancestor/descendant checks in BOTH directions; invalid values fail closed. */
function forbiddenRootsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 64) fail("FORBIDDEN_ROOT");
  const out: string[] = [];
  for (const entry of value) out.push(canonical(entry));
  return Object.freeze(out);
}
function overlaps(forbidden: string, candidate: string): boolean {
  const parent = asciiCaseFold(forbidden), child = asciiCaseFold(candidate);
  const contains = (a: string, b: string): boolean =>
    b === a || (a.endsWith("\\") ? b.startsWith(a) : b.startsWith(a + "\\"));
  return contains(parent, child) || contains(child, parent);
}

// Deterministic header serialization: the fixed field order below is the
// canonical order of this protocol, and canonical JSON bodies are verified by
// byte equality on readback paths elsewhere.
function headerJson(fields: Record<string, unknown>, order: readonly string[]): string {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of order) if (key in fields) out[key] = fields[key];
  const json = JSON.stringify(out);
  if (Buffer.byteLength(json, "ascii") !== json.length || json.length > WINDOWS_BACKUP_ARTIFACT_HEADER_MAX_BYTES)
    fail("HEADER");
  return json;
}

const REQUEST_ORDER = [
  "attemptId", "byteLength", "contractVersion", "directoryFileId", "directoryVolumeId",
  "expectedSha256", "fileId", "operation", "path", "profile", "root", "rootFileId",
  "rootVolumeId", "sha256", "stagingPath", "volumeId",
] as const;

function encodeRequest(header: Record<string, unknown>, payload: Uint8Array): Buffer {
  const json = Buffer.from(headerJson(header, REQUEST_ORDER), "ascii");
  const frame = Buffer.alloc(4 + json.byteLength + payload.byteLength);
  frame.writeUInt32LE(json.byteLength, 0);
  json.copy(frame, 4);
  frame.set(payload, 4 + json.byteLength);
  return frame;
}

// Strict small JSON reader: rejects duplicate keys (including escaped
// spellings), non-ASCII input, deep nesting and trailing bytes.
function parseHeader(bytes: Uint8Array): Record<string, unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > WINDOWS_BACKUP_ARTIFACT_HEADER_MAX_BYTES) fail("HEADER");
  for (const byte of bytes) if (byte > 0x7f) fail("HEADER");
  const source = Buffer.from(bytes).toString("latin1");
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(source)) fail("HEADER");
  let at = 0;
  const white = (): void => { while (at < source.length && /[ \t\r\n]/.test(source[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '"') return JSON.parse(source.slice(start, at)) as string;
      if (c === "\\") at++;
    }
    return fail("JSON");
  };
  const value = (depth: number): unknown => {
    if (depth > 8) fail("JSON");
    white();
    if (source[at] === '"') return string();
    if (source[at] === "{") {
      at++; white();
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (source[at] === "}") { at++; return result; }
      for (;;) {
        white();
        if (source[at] !== '"') fail("JSON");
        const key = string();
        if (keys.has(key) || keys.size >= 32) fail("JSON");
        keys.add(key); white();
        if (source[at++] !== ":") fail("JSON");
        result[key] = value(depth + 1); white();
        const delimiter = source[at++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") fail("JSON");
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(at));
    if (!token) fail("JSON");
    at += token[0].length;
    return JSON.parse(token[0]) as unknown;
  };
  const result = value(0); white();
  if (at !== source.length) fail("JSON");
  if (typeof result !== "object" || result === null || Array.isArray(result)) fail("JSON");
  return result as Record<string, unknown>;
}

type Framed = Readonly<{ header: Record<string, unknown>; payload: Uint8Array }>;
function decodeResponse(stdout: Uint8Array): Framed {
  if (!(stdout instanceof Uint8Array) || stdout.byteLength < 4 ||
      stdout.byteLength > WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES) fail("OUTPUT");
  const headerLength = stdout[0] | (stdout[1] << 8) | (stdout[2] << 16) | (stdout[3] << 24);
  if (headerLength <= 0 || headerLength > WINDOWS_BACKUP_ARTIFACT_HEADER_MAX_BYTES ||
      stdout.byteLength < 4 + headerLength) fail("OUTPUT");
  const header = parseHeader(stdout.subarray(4, 4 + headerLength));
  return Object.freeze({
    header,
    payload: Uint8Array.from(stdout.subarray(4 + headerLength)),
  });
}

type Pin = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number }>;
function samePin(a: Pin, b: Pin): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
function pinExecutable(fs: WindowsBackupArtifactTestPort["fs"], path: string, hash: string): Pin {
  const stat = (): Pin => {
    const s = fs.lstat(path);
    if (!s.isFile() || s.isDirectory() || s.isSymbolicLink() || s.nlink !== 1) fail("HELPER_UNTRUSTED");
    const pin = { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
    if (Object.values(pin).some((n) => !Number.isFinite(n) || n < 0) || !Number.isSafeInteger(pin.size)) fail("HELPER_UNTRUSTED");
    return Object.freeze(pin);
  };
  try {
    const before = stat(), bytes = fs.readFile(path), after = stat();
    if (bytes.byteLength !== before.size || digest(bytes) !== hash || !samePin(before, after)) fail("HELPER_UNTRUSTED");
    return after;
  } catch { return fail("HELPER_UNTRUSTED"); }
}

const nativePort: WindowsBackupArtifactTestPort = {
  fs: { lstat: lstatSync, readFile: readFileSync },
  exec(request) {
    const result = spawnSync(request.executable, [...request.args], {
      cwd: request.cwd, env: request.env, input: request.input,
      timeout: request.timeoutMs, maxBuffer: request.maxBuffer,
      shell: false, windowsHide: true, stdio: "pipe", encoding: "buffer",
    });
    // Captured bytes stay binary; no lossy text mapping ever reaches parsing.
    return {
      status: result.status, signal: result.signal,
      stdout: result.stdout ?? new Uint8Array(0), stderr: result.stderr ?? new Uint8Array(0),
      ...(result.error ? { errorCode: "EXEC_FAILED" } : {}),
    };
  },
};

/**
 * Two-phase shared-backup artifact publication (256 MiB) with a separate
 * durable journal authority under the FOLIO_SHARED_BACKUP_ARTIFACT_V1
 * profile — never confused with recovery v3 or publication v1/v2. The
 * journal records the reservation and the immutable original BEFORE the
 * helper runs, each exact wire (both carry the full original payload) BEFORE
 * its dispatch, and the raw captured pipes BEFORE parsing or approval. The
 * caller's beforePublish authority MAY be asynchronous and runs exactly once
 * between stage evidence and commit dispatch; both assertCurrent callbacks
 * and the executable pin are re-proven immediately before the synchronous
 * commit. An UNKNOWN never authorizes retry, overwrite, cleanup or implicit
 * reopening; the journal retains every record.
 */
export function createWindowsBackupArtifact(options: WindowsBackupArtifactOptions): WindowsBackupArtifactPort {
  if (arguments.length !== 1) fail("OPTIONS");
  if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  return create(options, nativePort, "native-helper");
}
/** Non-Windows contract-only fake ports, never native Windows proof. */
export function createWindowsBackupArtifactForTesting(
  options: WindowsBackupArtifactOptions, port: WindowsBackupArtifactTestPort,
): WindowsBackupArtifactPort {
  if (arguments.length !== 2) fail("OPTIONS");
  if (process.platform === "win32") fail("TEST_PORT_FORBIDDEN");
  return create(options, port, "untrusted-test");
}

function bindJournal(candidate: unknown): WindowsBackupArtifactJournal {
  if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) fail("JOURNAL");
  const bound: Record<string, unknown> = {};
  for (const name of ["reserve", "record", "recordTerminal", "readBlob", "readMetadata", "terminalReceipt", "pendingAttempts"] as const) {
    const method = (candidate as Record<string, unknown>)[name];
    if (isAsyncLike(method)) fail("JOURNAL");
    bound[name] = (method as (...args: unknown[]) => unknown).bind(candidate);
  }
  return bound as unknown as WindowsBackupArtifactJournal;
}

// A journal whose reservation or recording acknowledgement was ever
// uncertain is poisoned for every factory that shares it, not just the one
// that observed the failure.
const failedJournals = new WeakSet<object>();

function create(options: WindowsBackupArtifactOptions, port: WindowsBackupArtifactTestPort, trust: WindowsBackupArtifactPort["trust"]): WindowsBackupArtifactPort {
  let root: string, executable: string, systemRoot: string, expectedHash: string;
  let expectedRoot: WindowsRuntimeRootIdentity;
  let initialPin: Pin;
  let fs: WindowsBackupArtifactTestPort["fs"], exec: WindowsBackupArtifactTestPort["exec"];
  let journal: WindowsBackupArtifactJournal, journalObject: object;
  let directoryIdentityFor: (path: string) => WindowsRuntimeDirectoryIdentity;
  let revalidate: () => void;
  try {
    const o = record(options, ["root", "probeExecutable", "expectedHash", "systemRoot", "expectedRoot", "journal", "directoryIdentity", "assertCurrent"]);
    root = canonical(o.root); executable = canonical(o.probeExecutable); systemRoot = canonical(o.systemRoot);
    if (!/\.exe$/i.test(executable)) fail("OPTIONS");
    expectedHash = text(o.expectedHash, HASH);
    const r = record(o.expectedRoot, ["rootFileId", "volumeId"]);
    expectedRoot = Object.freeze({ rootFileId: text(r.rootFileId, FILE_ID), volumeId: text(r.volumeId, VOLUME_ID) });
    journal = bindJournal(o.journal);
    journalObject = o.journal as object;
    if (isAsyncLike(o.directoryIdentity) || isAsyncLike(o.assertCurrent)) fail("OPTIONS");
    directoryIdentityFor = o.directoryIdentity as WindowsBackupArtifactOptions["directoryIdentity"];
    revalidate = o.assertCurrent as WindowsBackupArtifactOptions["assertCurrent"];
    const p = record(port, ["fs", "exec"]);
    const f = record(p.fs, ["lstat", "readFile"]);
    if (typeof f.lstat !== "function" || typeof f.readFile !== "function" || typeof p.exec !== "function") fail("OPTIONS");
    fs = { lstat: port.fs.lstat.bind(port.fs), readFile: port.fs.readFile.bind(port.fs) };
    exec = port.exec.bind(port);
    initialPin = pinExecutable(fs, executable, expectedHash);
  } catch { return fail("OPTIONS_OR_HELPER_UNTRUSTED"); }

  const attempts = new Set<string>(), targets = new Set<string>();
  let pinnedSid: string | undefined;
  let journalFailed = false;
  let active = false;
  const poisoned = (): boolean => journalFailed || failedJournals.has(journalObject);
  const poison = (): void => { journalFailed = true; failedJournals.add(journalObject); };
  const assertPin = (): void => {
    if (!samePin(initialPin, pinExecutable(fs, executable, expectedHash))) fail("HELPER_CHANGED");
  };
  const checkSync = (fn: () => void): void => {
    let outcome: unknown;
    try { outcome = fn(); } catch { fail("REVALIDATE"); }
    if (utilTypes.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
    if (outcome !== undefined || isThenable(outcome)) fail("REVALIDATE");
  };
  const checkCurrent = (): void => checkSync(revalidate);
  const baseRequest = (pathValue: unknown) => {
    const path = canonical(pathValue, root), parent = parentOf(path);
    if (same(path, root)) fail("PATH");
    let raw: unknown;
    try { raw = directoryIdentityFor(parent); } catch { fail("IDENTITY"); }
    if (utilTypes.isPromise(raw) || isThenable(raw)) fail("IDENTITY");
    const expectedDirectory = directoryIdentity(raw, expectedRoot.volumeId);
    if (same(parent, root) && !same(expectedDirectory.fileId, expectedRoot.rootFileId)) fail("IDENTITY");
    return { path, parent, expectedDirectory };
  };
  // A journal call is only valid when it returns undefined synchronously.
  const ack = (call: () => unknown): boolean => {
    if (poisoned()) return false;
    try {
      const result = call();
      if (utilTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
      return result === undefined && !poisoned();
    } catch { return false; }
  };

  let lastCapture: { stdout: Uint8Array; stderr: Uint8Array } | null = null;
  const captureBytes = (raw: unknown, key: "stdout" | "stderr"): Uint8Array => {
    if (raw === null || typeof raw !== "object") return new Uint8Array(0);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !(descriptor.value instanceof Uint8Array))
      return new Uint8Array(0);
    if (descriptor.value.byteLength > WINDOWS_BACKUP_ARTIFACT_MAX_CAPTURE_BYTES)
      fail("CAPTURE_LIMIT");
    return Uint8Array.from(descriptor.value);
  };
  type ExecOutcome = Readonly<{ ok: true; status: number; framed: Framed }>
    | Readonly<{ ok: false; malformed: true }>;
  const invoke = (attemptId: string, phase: "prepare" | "commit-prepared", input: Uint8Array, requestCurrent: () => void): ExecOutcome => {
    if (poisoned()) return { ok: false, malformed: true };
    lastCapture = null;
    let raw: unknown;
    try {
      assertPin();
      if (poisoned()) fail("JOURNAL");
      checkCurrent();
      checkSync(requestCurrent);
      if (poisoned()) fail("JOURNAL");
      raw = exec(Object.freeze({
        executable, args: Object.freeze(["--private-backup-artifact"] as const), cwd: systemRoot,
        env: Object.freeze({ SystemRoot: systemRoot, windir: systemRoot, TEMP: childOf(systemRoot, "Temp"), TMP: childOf(systemRoot, "Temp") }),
        input, timeoutMs: WINDOWS_PROBE_TIMEOUT_MS, maxBuffer: WINDOWS_BACKUP_ARTIFACT_MAX_WIRE_BYTES,
        shell: false, windowsHide: true, stdio: "pipe", encoding: "buffer",
      }));
    } catch { return { ok: false, malformed: true }; }
    // Raw stdout/stderr reach the durable journal BEFORE any parsing or
    // approval. A failed recording poisons the journal for every factory.
    try {
      lastCapture = {
        stdout: captureBytes(raw, "stdout"), stderr: captureBytes(raw, "stderr"),
      };
    } catch {
      // An out-of-contract executor cannot be represented as empty evidence.
      poison();
      return { ok: false, malformed: true };
    }
    const prefix = phase === "prepare" ? "capture:prepare" : "capture:commit-prepared";
    if (!ack(() => journal.record(attemptId, `${prefix}:stdout` as BackupArtifactBlobKind, lastCapture!.stdout)) ||
        !ack(() => journal.record(attemptId, `${prefix}:stderr` as BackupArtifactBlobKind, lastCapture!.stderr))) {
      poison();
      return { ok: false, malformed: true };
    }
    try { assertPin(); } catch { return { ok: false, malformed: true }; }
    let result: Record<string, unknown>;
    try {
      result = record(raw, ["status", "signal", "stdout", "stderr"], ["errorCode"]);
    } catch { return { ok: false, malformed: true }; }
    if (result.signal !== null || "errorCode" in result ||
        !(result.stderr instanceof Uint8Array) || result.stderr.byteLength !== 0 ||
        !(result.stdout instanceof Uint8Array) ||
        !Number.isInteger(result.status))
      return { ok: false, malformed: true };
    try {
      return { ok: true, status: result.status as number, framed: decodeResponse(result.stdout as Uint8Array) };
    } catch { return { ok: false, malformed: true }; }
  };

  const evidence = (raw: unknown, path: string, fileId?: string): WindowsProbeEvidence => {
    assertWindowsProbe(raw, { canonicalPath: path, canonicalRoot: root });
    const p = raw as WindowsProbeEvidence;
    canonical(p.canonicalPath, root); canonical(p.canonicalRoot);
    if (!same(p.rootFileId, expectedRoot.rootFileId) || !same(p.rootVolumeId, expectedRoot.volumeId) ||
        !same(p.volumeId, expectedRoot.volumeId) || (fileId !== undefined && !same(p.fileId, fileId)) ||
        !SID.test(p.sid) || (pinnedSid !== undefined && p.sid !== pinnedSid)) fail("EVIDENCE");
    return p;
  };
  const proofs = (r: Record<string, unknown>, path: string, parent: string, directory: WindowsRuntimeDirectoryIdentity, fileId?: string) => {
    const file = evidence(r.file, path, fileId), dir = evidence(r.directory, parent, directory.fileId);
    if (file.sid !== dir.sid || !same(dir.volumeId, directory.volumeId)) fail("EVIDENCE");
    return { file, identity: Object.freeze({ canonicalPath: file.canonicalPath, fileId: file.fileId, volumeId: file.volumeId }) };
  };
  const baseKeys = ["contractVersion", "operation", "path", "profile", "root", "state"] as const;
  const checkEnvelope = (r: Record<string, unknown>, operation: string, path: string): void => {
    if (r.contractVersion !== 1 || r.profile !== WINDOWS_BACKUP_ARTIFACT_PROFILE ||
        r.operation !== operation || r.path !== path || r.root !== root) fail("ENVELOPE");
  };
  const reject = (path: string): WindowsBackupArtifactFailure =>
    Object.freeze({ contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE, state: "REJECTED", path, reason: "BACKUP_ARTIFACT_REJECTED", preserve: true });
  const unknown = (path: string, publish?: { attemptId: string; stagingPath: string }): WindowsBackupArtifactFailure =>
    Object.freeze({ contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE, state: "UNKNOWN", path, ...publish, reason: "BACKUP_ARTIFACT_UNCONFIRMED", preserve: true });
  const failure = (r: Record<string, unknown>, status: number | null, path: string, publish?: { attemptId: string; stagingPath: string }): WindowsBackupArtifactFailure => {
    record(r, [...baseKeys, ...(publish ? ["attemptId", "stagingPath"] : []), "reason"]);
    const state = r.state;
    if (!((state === "REJECTED" && status === 1 && r.reason === "BACKUP_ARTIFACT_REJECTED") ||
          (state === "UNKNOWN" && status === 3 && r.reason === "BACKUP_ARTIFACT_UNKNOWN") ||
          (publish && state === "EXISTS" && status === 2 && r.reason === "BACKUP_ARTIFACT_EXISTS"))) fail("FAILURE");
    return Object.freeze({ contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE, state: state as WindowsBackupArtifactFailure["state"], path, ...publish, reason: r.reason as string, preserve: true });
  };
  const requestPath = (request: unknown): string => {
    try {
      if (typeof request !== "object" || request === null) return "";
      const descriptor = Object.getOwnPropertyDescriptor(request, "path");
      return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : "";
    } catch { return ""; }
  };
  const terminal = (attemptId: string, outcome: "PUBLISHED" | "UNKNOWN" | "REJECTED", evidence: Record<string, unknown>): boolean => {
    let body: string;
    try {
      body = JSON.stringify({ attemptId, outcome, evidence });
      if (Buffer.byteLength(body) > 48 * 1024) body = JSON.stringify({ attemptId, outcome, evidenceOmitted: true });
    } catch { body = JSON.stringify({ attemptId, outcome, evidenceOmitted: true }); }
    if (ack(() => journal.recordTerminal(attemptId, body))) return true;
    poison();
    return false;
  };

  return Object.freeze({
    contractVersion: 1 as const,
    profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
    platform: "win32" as const,
    trust,
    async publishNew(request: WindowsBackupArtifactRequest): Promise<WindowsBackupArtifactReceipt | WindowsBackupArtifactFailure> {
      const pathEcho = requestPath(request);
      if (active || poisoned()) return reject(pathEcho);
      // Includes directory/current-authority callbacks during validation.
      active = true;
      let path: string, parent: string, expectedDirectory: WindowsRuntimeDirectoryIdentity;
      let attemptId: string, stagingPath: string, input: Uint8Array;
      let sha256: string, byteLength: number;
      let callback: (readback: Uint8Array) => void | Promise<void>;
      let requestCurrent: () => void;
      let bytes: Uint8Array, source: Readonly<{ head: Cut; hash: string }>;
      let forbidden: readonly string[];
      try {
        const r = record(request, ["path", "stagingPath", "attemptId", "bytes", "forbiddenRoots", "source", "beforePublish", "assertCurrent"]);
        path = canonical(r.path, root);
        parent = parentOf(path);
        if (same(path, root)) fail("PATH");
        stagingPath = canonical(r.stagingPath, root);
        if (!same(parentOf(stagingPath), parent) || same(stagingPath, path)) fail("PATH");
        attemptId = text(r.attemptId, ATTEMPT);
        forbidden = forbiddenRootsOf(r.forbiddenRoots);
        for (const f of forbidden)
          // The IO authority may contain disjoint workspace/output siblings.
          // The actual publication parent/final/stage remain disjoint from
          // forbidden data; a root inside forbidden data still rejects.
          if (asciiCaseFold(root) === asciiCaseFold(f) ||
              asciiCaseFold(root).startsWith(asciiCaseFold(f).replace(/\\$/, "") + "\\") ||
              overlaps(f, parent) || overlaps(f, path) || overlaps(f, stagingPath))
            fail("FORBIDDEN_ROOT");
        {
          const s = record(r.source, ["head", "hash"]);
          const h = record(s.head, ["epoch", "seq", "hash"]);
          if (typeof h.epoch !== "string" || h.epoch.length === 0 || h.epoch.length > 256 || !wellFormed(h.epoch) ||
              !Number.isSafeInteger(h.seq) || (h.seq as number) < 0 ||
              typeof h.hash !== "string" || !HASH.test(h.hash)) fail("SOURCE");
          source = Object.freeze({
            head: Object.freeze({ epoch: h.epoch as string, seq: h.seq as number, hash: h.hash as string }),
            hash: text(s.hash, HASH),
          });
        }
        if (typeof r.beforePublish !== "function") fail("CALLBACK");
        // beforePublish explicitly MAY be asynchronous (remote authority
        // revalidation); only generator functions are excluded.
        if (utilTypes.isGeneratorFunction(r.beforePublish)) fail("CALLBACK");
        callback = r.beforePublish as WindowsBackupArtifactRequest["beforePublish"];
        if (isAsyncLike(r.assertCurrent)) fail("CALLBACK");
        requestCurrent = r.assertCurrent as () => void;
        if (!(r.bytes instanceof Uint8Array)) fail("BYTES");
        byteLength = boundedSize(r.bytes.byteLength);
        // Immutable copy BEFORE any journal/native/callback step; the
        // reservation original and BOTH wire payloads derive only from it.
        bytes = Uint8Array.from(r.bytes);
        sha256 = digest(bytes);
        // Resolve filesystem proof only after all caller-owned data has been
        // copied; even an injected proof callback cannot rewrite this attempt.
        ({ expectedDirectory } = baseRequest(path));
        input = encodeRequest({
          contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
          operation: "prepare", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
          attemptId, stagingPath, byteLength, sha256,
        }, bytes);
        if (attempts.has(attemptId) || targets.has(asciiCaseFold(path))) fail("CONSUMED");
        assertPin();
        checkCurrent();
        checkSync(requestCurrent);
      } catch { active = false; return reject(pathEcho); }
      const metadata = { attemptId, stagingPath };
      // Held across the asynchronous beforePublish await: no concurrent or
      // reentrant publish may enter while an attempt is in flight.
      // Consume both BEFORE any journal or native call. No retry.
      attempts.add(attemptId); targets.add(asciiCaseFold(path));
      try {
        const targetKey = `target:${digest(Buffer.from(
          asciiCaseFold(expectedRoot.volumeId) + "|" + asciiCaseFold(expectedRoot.rootFileId) + "|" +
          asciiCaseFold(expectedDirectory.volumeId) + "|" + asciiCaseFold(expectedDirectory.fileId) + "|" +
          asciiCaseFold(basenameOf(path)), "utf8"))}`;
        // Reservation and the immutable original are durable BEFORE helper.
        if (!ack(() => journal.reserve({
          attemptId, targetKey,
          metadata: {
            attemptId, path, stagingPath,
            source: { head: { epoch: source.head.epoch, seq: source.head.seq, hash: source.head.hash }, hash: source.hash },
            forbiddenRoots: [...forbidden],
            root: { canonicalPath: root, fileId: expectedRoot.rootFileId, volumeId: expectedRoot.volumeId },
            directory: { canonicalPath: parent, fileId: expectedDirectory.fileId, volumeId: expectedDirectory.volumeId },
            byteLength, sha256,
          },
          original: bytes,
        }))) { poison(); return unknown(path, metadata); }
        if (!ack(() => journal.record(attemptId, "wire:prepare", input))) { poison(); return unknown(path, metadata); }

        const dispatched = invoke(attemptId, "prepare", input, requestCurrent);
        if (!dispatched.ok) {
          terminal(attemptId, "UNKNOWN", { phase: "prepare", malformed: true });
          return unknown(path, metadata);
        }
        const r = dispatched.framed.header, status = dispatched.status;
        try {
          checkEnvelope(r, "prepare", path);
          if (r.attemptId !== attemptId || r.stagingPath !== stagingPath) fail("ENVELOPE");
        } catch {
          terminal(attemptId, "UNKNOWN", { phase: "prepare", status, reply: { malformed: true } });
          return unknown(path, metadata);
        }
        if (r.state !== "PREPARED") {
          let typed: WindowsBackupArtifactFailure;
          try { typed = failure(r, status, path, metadata); }
          catch {
            terminal(attemptId, "UNKNOWN", { phase: "prepare", status, reply: { malformed: true } });
            return unknown(path, metadata);
          }
          if (!terminal(attemptId, typed.state === "UNKNOWN" ? "UNKNOWN" : "REJECTED", { phase: "prepare", status, reply: r }))
            return unknown(path, metadata);
          return typed;
        }
        let stageFileId: string, stageVolumeId: string, preparedReadback: Buffer;
        try {
          record(r, [...baseKeys, "attemptId", "stagingPath", "file", "directory", "byteLength", "sha256", "contentFlushed", "filesystem"]);
          const length = boundedSize(r.byteLength);
          if (status !== 0 || length !== byteLength || r.sha256 !== sha256 || r.contentFlushed !== true ||
              r.filesystem !== "NTFS" || dispatched.framed.payload.byteLength !== length) fail("RECEIPT");
          preparedReadback = Buffer.from(dispatched.framed.payload);
          // Exact staged readback against the frozen original — never hash only.
          if (!preparedReadback.equals(bytes)) fail("RECEIPT");
          const proof = proofs(r, stagingPath, parent, expectedDirectory);
          stageFileId = proof.file.fileId; stageVolumeId = proof.file.volumeId;
          pinnedSid = proof.file.sid;
        } catch {
          terminal(attemptId, "UNKNOWN", { phase: "prepare", status, reply: { malformed: true } });
          return unknown(path, metadata);
        }
        if (!ack(() => journal.record(attemptId, "evidence:prepared", Buffer.from(JSON.stringify({ status, header: r }), "utf8")))) {
          poison(); return unknown(path, metadata);
        }

        // Archive this potentially large wire BEFORE asking for current source
        // authority, so a 256 MiB SQLite write cannot age that approval.
        const commitInput = encodeRequest({
          contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
          operation: "commit-prepared", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
          attemptId, stagingPath, fileId: stageFileId, volumeId: stageVolumeId,
          expectedSha256: sha256, byteLength,
        }, bytes);
        if (!ack(() => journal.record(attemptId, "wire:commit-prepared", commitInput))) {
          poison(); return unknown(path, metadata);
        }

        // The caller authority callback runs exactly once on a copy of the
        // ACTUAL staged readback; it may await remote authority. A throw, a
        // rejection or any defined resolved value is UNKNOWN — no commit.
        {
          let approval: unknown;
          let called = false;
          try {
            approval = callback(Uint8Array.from(preparedReadback));
            called = true;
          } catch {
            if (!poisoned()) terminal(attemptId, "UNKNOWN", { phase: "callback", status });
            return unknown(path, metadata);
          }
          try {
            if (!called || (await approval) !== undefined) fail("CALLBACK");
          } catch {
            if (!poisoned()) terminal(attemptId, "UNKNOWN", { phase: "callback", status });
            return unknown(path, metadata);
          }
        }
        if (!ack(() => journal.record(attemptId, "evidence:callback", Buffer.from(JSON.stringify({ phase: "callback", approved: true }), "utf8")))) {
          poison(); return unknown(path, metadata);
        }

        // Immediately before the irreversible commit dispatch: directory
        // identity re-proven against the frozen pin, both assertCurrent
        // callbacks, and the executable pin.
        try {
          const again = directoryIdentityFor(parent);
          if (utilTypes.isPromise(again) || isThenable(again)) fail("IDENTITY");
          const rechecked = directoryIdentity(again, expectedRoot.volumeId);
          if (!same(rechecked.fileId, expectedDirectory.fileId) || !same(rechecked.volumeId, expectedDirectory.volumeId))
            fail("IDENTITY");
          checkCurrent();
          checkSync(requestCurrent);
          assertPin();
        } catch {
          terminal(attemptId, "UNKNOWN", { phase: "pre-commit", status });
          return unknown(path, metadata);
        }
        const committed = invoke(attemptId, "commit-prepared", commitInput, requestCurrent);
        if (!committed.ok) {
          terminal(attemptId, "UNKNOWN", { phase: "commit-prepared", malformed: true });
          return unknown(path, metadata);
        }
        const c = committed.framed.header, commitStatus = committed.status;
        try {
          checkEnvelope(c, "commit-prepared", path);
          if (c.attemptId !== attemptId || c.stagingPath !== stagingPath) fail("ENVELOPE");
        } catch {
          terminal(attemptId, "UNKNOWN", { phase: "commit-prepared", status: commitStatus, reply: { malformed: true } });
          return unknown(path, metadata);
        }
        if (c.state !== "PUBLISHED") {
          let typed: WindowsBackupArtifactFailure;
          try { typed = failure(c, commitStatus, path, metadata); }
          catch {
            terminal(attemptId, "UNKNOWN", { phase: "commit-prepared", status: commitStatus, reply: { malformed: true } });
            return unknown(path, metadata);
          }
          if (!terminal(attemptId, typed.state === "UNKNOWN" ? "UNKNOWN" : "REJECTED", { phase: "commit-prepared", status: commitStatus, reply: c }))
            return unknown(path, metadata);
          return typed;
        }
        let finalReadback: Buffer, identity: WindowsRuntimeFileIdentity;
        try {
          record(c, [...baseKeys, "attemptId", "stagingPath", "file", "directory", "byteLength", "sha256",
            "contentFlushed", "filesystem", "stagingDisposition", "namespace", "durability"]);
          const length = boundedSize(c.byteLength);
          const durability = record(c.durability, ["profile", "scope"]);
          if (commitStatus !== 0 || length !== byteLength || c.sha256 !== sha256 || c.contentFlushed !== true ||
              c.filesystem !== "NTFS" || c.stagingDisposition !== "RENAMED_TO_FINAL" ||
              c.namespace !== "EXCLUSIVE_NO_REPLACE" ||
              durability.profile !== WINDOWS_PRIVATE_DURABILITY_PROFILE_V1 || durability.scope !== "PROCESS_CRASH" ||
              committed.framed.payload.byteLength !== length) fail("RECEIPT");
          finalReadback = Buffer.from(committed.framed.payload);
          // Exact final readback against the frozen original — never hash only.
          if (!finalReadback.equals(bytes)) fail("RECEIPT");
          const proof = proofs(c, path, parent, expectedDirectory, stageFileId);
          if (!same(proof.file.volumeId, stageVolumeId)) fail("IDENTITY");
          identity = proof.identity;
          pinnedSid = proof.file.sid;
        } catch {
          terminal(attemptId, "UNKNOWN", { phase: "commit-prepared", status: commitStatus, reply: { malformed: true } });
          return unknown(path, metadata);
        }
        if (!terminal(attemptId, "PUBLISHED", {
          phase: "commit-prepared", status: commitStatus, path, sha256, byteLength,
          identity: { canonicalPath: identity.canonicalPath, fileId: identity.fileId, volumeId: identity.volumeId },
          stagingDisposition: "RENAMED_TO_FINAL",
        }))
          return unknown(path, metadata);
        return Object.freeze({
          contractVersion: 1, profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
          state: "PUBLISHED", path, ...metadata, identity,
          byteLength, sha256, readback: new Uint8Array(finalReadback),
          stagingDisposition: "RENAMED_TO_FINAL", contentFlushed: true,
          namespace: "EXCLUSIVE_NO_REPLACE",
          durability: Object.freeze({ profile: WINDOWS_PRIVATE_DURABILITY_PROFILE_V1, scope: "PROCESS_CRASH" }),
        }) as WindowsBackupArtifactReceipt;
      } catch {
        // An unexpected break (for example a helper pin change mid-sequence)
        // is always UNKNOWN; the stage is retained, never cleaned or replayed.
        if (!poisoned()) terminal(attemptId, "UNKNOWN", { phase: "dispatch", malformed: true });
        return unknown(path, metadata);
      } finally { active = false; }
    },
  });
}
