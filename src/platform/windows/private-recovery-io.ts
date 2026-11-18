import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { types as utilTypes } from "node:util";
import { CollaborationError } from "../../collaboration/runtime/contract";
import { rememberRecoveryIoFailure } from "../private-mutation-diagnostic";
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
  RecoveryBlobKind,
  RecoveryExpectedHead,
  WindowsRecoveryArchive,
} from "./recovery-archive";
import { WINDOWS_PRIVATE_DURABILITY_PROFILE_V1 } from "./private-publication-v2";
import {
  PrivateFileNotPublishedError,
  PrivateFilePortUnsupportedError,
  PrivateFilePublicationUnknownError,
} from "../private-file-port";

export const WINDOWS_RECOVERY_MAX_BYTES = 32 * 1024 * 1024 + 4096;
export const WINDOWS_RECOVERY_HEADER_MAX_BYTES = 8192;
export const WINDOWS_RECOVERY_MAX_WIRE_BYTES =
  4 + WINDOWS_RECOVERY_HEADER_MAX_BYTES + WINDOWS_RECOVERY_MAX_BYTES;
/** Raw pipe captures may carry protocol-invalid bytes beyond the wire bound —
 * up to this fixed finite overrun. The native protocol max itself is NOT
 * raised; oversized captures are retained EXACTLY only within this bound. */
export const WINDOWS_RECOVERY_CAPTURE_OVERRUN_BYTES = 1024 * 1024;
export const WINDOWS_RECOVERY_MAX_CAPTURE_BYTES =
  WINDOWS_RECOVERY_MAX_WIRE_BYTES + WINDOWS_RECOVERY_CAPTURE_OVERRUN_BYTES;

export interface PrivateFileV3Port {
  readonly contractVersion: 3;
  readonly platform: "win32";
  publish(request: {
    path: string;
    stagingPath: string;
    attemptId: string;
    bytes: Uint8Array;
    beforePublish(readback: Uint8Array): void;
  }): WindowsRecoveryPublishReceipt;
}

export type WindowsRecoveryPublishReceipt = Readonly<{
  contractVersion: 3;
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

export type WindowsRecoveryReadReceipt = Readonly<{
  contractVersion: 3;
  state: "READ";
  identity: WindowsRuntimeFileIdentity;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
}>;

export type WindowsRecoveryIoFailure = Readonly<{
  contractVersion: 3;
  state: "UNKNOWN" | "REJECTED" | "EXISTS";
  path: string;
  stagingPath?: string;
  attemptId?: string;
  reason: string;
  preserve: true;
}>;

/** Caller-pinned parent directory identity for a publish request: the
 * canonical path plus the native IDs the caller most recently proved. */
export type WindowsRecoveryDirectoryPin = Readonly<{
  canonicalPath: string;
  fileId: string;
  volumeId: string;
}>;

export type WindowsRecoveryIoPublishRequest = Readonly<{
  path: string;
  stagingPath: string;
  attemptId: string;
  bytes: Uint8Array;
  logicalPath: string;
  workspaceId: string;
  /** Declared next generation and the exact head it replaces (null for the
   * first generation) — durably bound into the reserved pointer intent. */
  generation: number;
  expectedHead: RecoveryExpectedHead | null;
  /** Caller-pinned parent directory identity; exact-compared to the path and
   * native identity resolved here before any dispatch — a stale pin is never
   * dispatched. */
  expectedDirectory: WindowsRecoveryDirectoryPin;
  beforePublish(readback: Uint8Array): void;
}>;

/** Structural authority surface the v3 IO needs — satisfied by the durable
 * checkpoint archive AND by the product's independent raw-export archive. */
export type WindowsRecoveryIoAuthority = Pick<
  WindowsRecoveryArchive,
  "reserve" | "record" | "recordTerminal" | "readBlob" | "readMetadata" | "terminalReceipt" | "pendingAttempts"
>;

/** Raw-export publish: NO forged checkpoint intent — no logical path,
 * workspace, generation or expected head is accepted or archived. */
export type WindowsRawRecoveryPublishRequest = Omit<
  WindowsRecoveryIoPublishRequest,
  "logicalPath" | "workspaceId" | "generation" | "expectedHead"
>;

export type WindowsRecoveryMissingRequest = Readonly<{
  path: string;
  expectedDirectory: WindowsRuntimeDirectoryIdentity;
}>;

export type WindowsRecoveryMissingReceipt = Readonly<{
  contractVersion: 3;
  state: "ABSENT";
  path: string;
  directory: WindowsRuntimeDirectoryIdentity;
}>;

export type WindowsRecoveryIoReadRequest = Readonly<{
  path: string;
  expectedDirectory: WindowsRuntimeDirectoryIdentity;
  expectedFile: WindowsRuntimeFileIdentity;
  expectedSha256?: string;
  maxBytes: number;
}>;

export interface WindowsRecoveryIo {
  readonly contractVersion: 3;
  readonly platform: "win32";
  readonly trust: "native-helper" | "untrusted-test";
  publishNew(request: WindowsRecoveryIoPublishRequest | WindowsRawRecoveryPublishRequest): WindowsRecoveryPublishReceipt | WindowsRecoveryIoFailure;
  readPrivate(request: WindowsRecoveryIoReadRequest): WindowsRecoveryReadReceipt | WindowsRecoveryIoFailure;
  /** Native absence proof: ABSENT only when the held parent still proves and
   * the helper reports ERROR_FILE_NOT_FOUND; EXISTS is a typed outcome and
   * every other condition is UNKNOWN. Never a fallback for lstat/ENOENT. */
  readMissing(request: WindowsRecoveryMissingRequest): WindowsRecoveryMissingReceipt | WindowsRecoveryIoFailure;
}

export type WindowsRecoveryPublishDispatch = Readonly<{
  attemptId: string;
  stage: "PREPARE" | "COMMIT";
}>;

export type WindowsRecoveryPublishObservation =
  | Readonly<{
      terminal: "RETURNED";
      trusted: boolean;
      value: WindowsRecoveryPublishReceipt | WindowsRecoveryIoFailure;
      dispatch?: WindowsRecoveryPublishDispatch;
    }>
  | Readonly<{
      terminal: "THREW";
      trusted: boolean;
      value: unknown;
      dispatch?: WindowsRecoveryPublishDispatch;
    }>;

type WindowsRecoveryPublishDispatchSink = {
  attemptId?: string;
  stage?: "PREPARE" | "COMMIT";
};

type WindowsRecoveryPublishCore = (
  request: WindowsRecoveryIoPublishRequest | WindowsRawRecoveryPublishRequest,
  dispatchSink?: WindowsRecoveryPublishDispatchSink,
) => WindowsRecoveryPublishReceipt | WindowsRecoveryIoFailure;

const recoveryPublishDispatchSinks = new WeakSet<WindowsRecoveryPublishDispatchSink>();
const recoveryPublishObservers = new WeakMap<
  object,
  (request: WindowsRecoveryIoPublishRequest | WindowsRawRecoveryPublishRequest) => WindowsRecoveryPublishObservation
>();

/** One scoped observation call: factory-registered IOs expose only the local
 * dispatch boundary reached by this invocation; any other IO is invoked once
 * and can return/throw, but contributes no trusted source fact. */
export function observeWindowsRecoveryPublishNew(
  io: WindowsRecoveryIo,
  request: WindowsRecoveryIoPublishRequest | WindowsRawRecoveryPublishRequest,
): WindowsRecoveryPublishObservation {
  const publisher = recoveryPublishObservers.get(io);
  if (publisher === undefined) {
    try {
      return Object.freeze({
        terminal: "RETURNED" as const,
        trusted: false,
        value: io.publishNew(request),
      });
    } catch (value) {
      return Object.freeze({ terminal: "THREW" as const, trusted: false, value });
    }
  }
  return publisher(request);
}

export type WindowsRecoveryIoExecRequest = Readonly<{
  executable: string;
  args: readonly ["--private-recovery-io"];
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

export type WindowsRecoveryIoExecResult = Readonly<{
  status: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  errorCode?: string;
}>;

export type WindowsRecoveryIoTestPort = Readonly<{
  fs: Pick<{ lstat(path: string): {
    isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean;
    nlink: number; dev: number; ino: number; size: number; mtimeMs: number;
  }; readFile(path: string): Uint8Array }, "lstat" | "readFile">;
  exec(request: WindowsRecoveryIoExecRequest): WindowsRecoveryIoExecResult;
}>;

export type WindowsPrivateRecoveryIoOptions = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  expectedRoot: WindowsRuntimeRootIdentity;
  archive: WindowsRecoveryIoAuthority;
  /** Which immutable authority this factory serves. `checkpoint` (default)
   * requires the logical CAS metadata; `raw-export` archives only the raw
   * immutable-file lifecycle — never forged checkpoint intents. */
  publicationKind?: "checkpoint" | "raw-export";
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
function fail(code: string): never { throw new CollaborationError(`WINDOWS_RECOVERY_IO_${code}`); }
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
function boundedSize(value: unknown, maximum = WINDOWS_RECOVERY_MAX_BYTES): number {
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

// Deterministic header serialization: the fixed field order below is the
// canonical order of this protocol, and canonical JSON bodies are verified by
// byte equality on readback paths elsewhere.
function headerJson(fields: Record<string, unknown>, order: readonly string[]): string {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of order) if (key in fields) out[key] = fields[key];
  const json = JSON.stringify(out);
  if (Buffer.byteLength(json, "ascii") !== json.length || json.length > WINDOWS_RECOVERY_HEADER_MAX_BYTES)
    fail("HEADER");
  return json;
}

const REQUEST_ORDER = [
  "attemptId", "byteLength", "contractVersion", "directoryFileId", "directoryVolumeId",
  "expectedSha256", "fileId", "maxBytes", "operation", "path", "root", "rootFileId",
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
  if (bytes.byteLength === 0 || bytes.byteLength > WINDOWS_RECOVERY_HEADER_MAX_BYTES) fail("HEADER");
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
      stdout.byteLength > WINDOWS_RECOVERY_MAX_WIRE_BYTES) fail("OUTPUT");
  const headerLength = stdout[0] | (stdout[1] << 8) | (stdout[2] << 16) | (stdout[3] << 24);
  if (headerLength <= 0 || headerLength > WINDOWS_RECOVERY_HEADER_MAX_BYTES ||
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
function pinExecutable(fs: WindowsRecoveryIoTestPort["fs"], path: string, hash: string): Pin {
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

const nativePort: WindowsRecoveryIoTestPort = {
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
      ...(result.error ? { errorCode: (result.error as NodeJS.ErrnoException).code ?? "EXEC_FAILED" } : {}),
    };
  },
};

/**
 * Two-phase raw-bytes publication (32 MiB + envelope) with a separate durable
 * archive authority. The archive records the reservation and the immutable
 * original BEFORE the helper runs, each exact wire BEFORE its dispatch, and
 * the raw captured pipes BEFORE parsing or approval. A revalidation callback
 * runs before every irreversible dispatch. An UNKNOWN never authorizes retry,
 * overwrite, cleanup or implicit reopening; the archive retains every record.
 */
export function createWindowsPrivateRecoveryIo(options: WindowsPrivateRecoveryIoOptions): WindowsRecoveryIo {
  if (arguments.length !== 1) fail("OPTIONS");
  if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  return create(options, nativePort, "native-helper");
}
/** Non-Windows contract-only fake ports, never native Windows proof. */
export function createWindowsPrivateRecoveryIoForTesting(
  options: WindowsPrivateRecoveryIoOptions, port: WindowsRecoveryIoTestPort,
): WindowsRecoveryIo {
  if (process.platform === "win32") fail("TEST_PORT_FORBIDDEN");
  return create(options, port, "untrusted-test");
}

function bindArchive(candidate: unknown): WindowsRecoveryArchive {
  if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) fail("ARCHIVE");
  const bound: Record<string, unknown> = {};
  for (const name of ["reserve", "record", "recordTerminal", "readBlob", "readMetadata", "terminalReceipt", "pendingAttempts"] as const) {
    const method = (candidate as Record<string, unknown>)[name];
    if (isAsyncLike(method)) fail("ARCHIVE");
    bound[name] = (method as (...args: unknown[]) => unknown).bind(candidate);
  }
  return bound as unknown as WindowsRecoveryArchive;
}

// An archive whose reservation or recording acknowledgement was ever
// uncertain is poisoned for every factory that shares it, not just the one
// that observed the failure.
const failedArchives = new WeakSet<object>();

function create(options: WindowsPrivateRecoveryIoOptions, port: WindowsRecoveryIoTestPort, trust: WindowsRecoveryIo["trust"]): WindowsRecoveryIo {
  let root: string, executable: string, systemRoot: string, expectedHash: string;
  let expectedRoot: WindowsRuntimeRootIdentity;
  let initialPin: Pin;
  let fs: WindowsRecoveryIoTestPort["fs"], exec: WindowsRecoveryIoTestPort["exec"];
  let archive: WindowsRecoveryIoAuthority, archiveObject: object;
  let directoryIdentityFor: (path: string) => WindowsRuntimeDirectoryIdentity;
  let revalidate: () => void;
  let publicationKind: "checkpoint" | "raw-export";
  try {
    const o = record(options, ["root", "probeExecutable", "expectedHash", "systemRoot", "expectedRoot", "archive", "directoryIdentity", "assertCurrent"], ["publicationKind"]);
    publicationKind = o.publicationKind === undefined ? "checkpoint" : o.publicationKind as "checkpoint" | "raw-export";
    if (publicationKind !== "checkpoint" && publicationKind !== "raw-export") fail("OPTIONS");
    root = canonical(o.root); executable = canonical(o.probeExecutable); systemRoot = canonical(o.systemRoot);
    if (!/\.exe$/i.test(executable)) fail("OPTIONS");
    expectedHash = text(o.expectedHash, HASH);
    const r = record(o.expectedRoot, ["rootFileId", "volumeId"]);
    expectedRoot = Object.freeze({ rootFileId: text(r.rootFileId, FILE_ID), volumeId: text(r.volumeId, VOLUME_ID) });
    archive = bindArchive(o.archive);
    archiveObject = o.archive as object;
    if (isAsyncLike(o.directoryIdentity) || isAsyncLike(o.assertCurrent)) fail("OPTIONS");
    directoryIdentityFor = o.directoryIdentity as WindowsPrivateRecoveryIoOptions["directoryIdentity"];
    revalidate = o.assertCurrent as WindowsPrivateRecoveryIoOptions["assertCurrent"];
    const p = record(port, ["fs", "exec"]);
    const f = record(p.fs, ["lstat", "readFile"]);
    if (typeof f.lstat !== "function" || typeof f.readFile !== "function" || typeof p.exec !== "function") fail("OPTIONS");
    fs = { lstat: port.fs.lstat.bind(port.fs), readFile: port.fs.readFile.bind(port.fs) };
    exec = port.exec.bind(port);
    initialPin = pinExecutable(fs, executable, expectedHash);
  } catch { return fail("OPTIONS_OR_HELPER_UNTRUSTED"); }

  const attempts = new Set<string>(), targets = new Set<string>();
  const knownFiles = new Map<string, { fileId: string; volumeId: string }>();
  let pinnedSid: string | undefined;
  let archiveFailed = false;
  let active = false;
  const poisoned = (): boolean => archiveFailed || failedArchives.has(archiveObject);
  const poison = (): void => { archiveFailed = true; failedArchives.add(archiveObject); };
  const assertPin = (): void => {
    if (!samePin(initialPin, pinExecutable(fs, executable, expectedHash))) fail("HELPER_CHANGED");
  };
  const checkCurrent = (): void => {
    let outcome: unknown;
    try { outcome = revalidate(); } catch { fail("REVALIDATE"); }
    if (utilTypes.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
    if (outcome !== undefined || isThenable(outcome)) fail("REVALIDATE");
  };
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
  // An archive call is only valid when it returns undefined synchronously.
  const ack = (call: () => unknown): boolean => {
    if (poisoned()) return false;
    try {
      const result = call();
      if (utilTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
      return result === undefined && !poisoned();
    } catch { return false; }
  };

  // null means the buffer cannot be retained EXACTLY within the finite
  // capture bound — never substitute an empty array and call it exact.
  const captureBytes = (raw: unknown, key: "stdout" | "stderr"): Uint8Array | null => {
    if (raw === null || typeof raw !== "object") return new Uint8Array(0);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) return new Uint8Array(0);
    if (!(descriptor.value instanceof Uint8Array) ||
        descriptor.value.byteLength > WINDOWS_RECOVERY_MAX_CAPTURE_BYTES)
      return null;
    return Uint8Array.from(descriptor.value);
  };
  const captureField = (raw: unknown, key: string): unknown => {
    if (raw === null || typeof raw !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  type ExecOutcome = Readonly<{ ok: true; status: number; framed: Framed }>
    | Readonly<{ ok: false; malformed: true }>;
  const invoke = (attemptId: string, phase: "prepare" | "commit-prepared" | "read-private" | "read-missing", input: Uint8Array, dispatchSink?: WindowsRecoveryPublishDispatchSink): ExecOutcome => {
    if (poisoned()) return { ok: false, malformed: true };
    let raw: unknown;
    try {
      assertPin();
      if (poisoned()) fail("ARCHIVE");
      checkCurrent();
      const execRequest = Object.freeze({
        executable, args: Object.freeze(["--private-recovery-io"] as const), cwd: systemRoot,
        env: Object.freeze({ SystemRoot: systemRoot, windir: systemRoot, TEMP: childOf(systemRoot, "Temp"), TMP: childOf(systemRoot, "Temp") }),
        input, timeoutMs: WINDOWS_PROBE_TIMEOUT_MS, maxBuffer: WINDOWS_RECOVERY_MAX_WIRE_BYTES,
        shell: false, windowsHide: true, stdio: "pipe", encoding: "buffer",
      });
      if (dispatchSink !== undefined && recoveryPublishDispatchSinks.has(dispatchSink) &&
          (phase === "prepare" || phase === "commit-prepared")) {
        dispatchSink.attemptId = attemptId;
        dispatchSink.stage = phase === "prepare" ? "PREPARE" : "COMMIT";
      }
      raw = exec(execRequest);
    } catch { return { ok: false, malformed: true }; }
    // Raw stdout/stderr reach the durable archive BEFORE any parsing or
    // approval — including protocol-invalid or oversized captures retained
    // EXACTLY within the finite capture bound, never an empty substitute.
    // A capture that cannot be archived within the bound poisons the archive
    // for every factory and the dispatch stays UNKNOWN. Read-only ops carry
    // no attempt, no captures.
    if (phase === "prepare" || phase === "commit-prepared") {
      const stdout = captureBytes(raw, "stdout");
      const stderr = captureBytes(raw, "stderr");
      if (stdout === null || stderr === null) { poison(); return { ok: false, malformed: true }; }
      const errorCode = captureField(raw, "errorCode");
      const signal = captureField(raw, "signal");
      const status = captureField(raw, "status");
      const metadata = {
        status: typeof status === "number" && Number.isInteger(status) ? status : null,
        signal: typeof signal === "string" ? signal : null,
        errorCode: typeof errorCode === "string" ? errorCode : null,
        captureTruncated: errorCode !== undefined || signal !== null ||
          stdout.byteLength > WINDOWS_RECOVERY_MAX_WIRE_BYTES || stderr.byteLength > WINDOWS_RECOVERY_MAX_WIRE_BYTES,
        stdoutLength: stdout.byteLength,
        stderrLength: stderr.byteLength,
      };
      const prefix = phase === "prepare" ? "capture:prepare" : "capture:commit-prepared";
      if (!ack(() => archive.record(attemptId, `${prefix}:stdout` as RecoveryBlobKind, stdout)) ||
          !ack(() => archive.record(attemptId, `${prefix}:stderr` as RecoveryBlobKind, stderr)) ||
          !ack(() => archive.record(attemptId, `${prefix}:metadata` as RecoveryBlobKind, Buffer.from(JSON.stringify(metadata), "utf8")))) {
        poison();
        return { ok: false, malformed: true };
      }
    }
    try { assertPin(); } catch { return { ok: false, malformed: true }; }
    let result: Record<string, unknown>;
    try {
      result = record(raw, ["status", "signal", "stdout", "stderr"], ["errorCode"]);
    } catch { return { ok: false, malformed: true }; }
    if (result.signal !== null || "errorCode" in result ||
        !(result.stderr instanceof Uint8Array) || result.stderr.byteLength !== 0 ||
        !(result.stdout instanceof Uint8Array) || result.stdout.byteLength > WINDOWS_RECOVERY_MAX_WIRE_BYTES ||
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
  const baseKeys = ["contractVersion", "operation", "path", "root", "state"] as const;
  const checkEnvelope = (r: Record<string, unknown>, operation: string, path: string): void => {
    if (r.contractVersion !== 3 || r.operation !== operation || r.path !== path || r.root !== root) fail("ENVELOPE");
  };
  const reject = (path: string): WindowsRecoveryIoFailure =>
    Object.freeze({ contractVersion: 3, state: "REJECTED", path, reason: "PRIVATE_IO_V3_REJECTED", preserve: true });
  const unknown = (path: string, publish?: { attemptId: string; stagingPath: string }): WindowsRecoveryIoFailure =>
    Object.freeze({ contractVersion: 3, state: "UNKNOWN", path, ...publish, reason: "PRIVATE_IO_V3_UNCONFIRMED", preserve: true });
  const failure = (r: Record<string, unknown>, status: number | null, path: string, publish?: { attemptId: string; stagingPath: string }): WindowsRecoveryIoFailure => {
    record(r, [...baseKeys, ...(publish ? ["attemptId", "stagingPath"] : []), "reason"]);
    const state = r.state;
    if (!((state === "REJECTED" && status === 1 && r.reason === "PRIVATE_IO_V3_REJECTED") ||
          (state === "UNKNOWN" && status === 3 && r.reason === "PRIVATE_IO_V3_UNKNOWN") ||
          (publish && state === "EXISTS" && status === 2 && r.reason === "PRIVATE_IO_V3_EXISTS"))) fail("FAILURE");
    return Object.freeze({ contractVersion: 3, state: state as WindowsRecoveryIoFailure["state"], path, ...publish, reason: r.reason as string, preserve: true });
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
    if (ack(() => archive.recordTerminal(attemptId, body))) return true;
    poison();
    return false;
  };

  const io = Object.freeze({
    contractVersion: 3 as const,
    platform: "win32" as const,
    trust,
    publishNew(request: WindowsRecoveryIoPublishRequest | WindowsRawRecoveryPublishRequest, dispatchSink?: WindowsRecoveryPublishDispatchSink): WindowsRecoveryPublishReceipt | WindowsRecoveryIoFailure {
      const pathEcho = requestPath(request);
      if (active || poisoned()) return reject(pathEcho);
      let path: string, parent: string, expectedDirectory: WindowsRuntimeDirectoryIdentity;
      let attemptId: string, stagingPath: string, input: Uint8Array;
      let sha256: string, byteLength: number, callback: (readback: Uint8Array) => void;
      let logicalPath: string | undefined, workspaceId: string | undefined, generation: number | undefined;
      let expectedHead: RecoveryExpectedHead | null = null;
      let bytes: Buffer;
      try {
        // Data-only validation and snapshots of bytes/expected state BEFORE
        // any directoryIdentity/assertCurrent/helper-pin callback: later
        // caller mutation can never alter the archived original or wire.
        // A raw-export request carries no checkpoint intent fields at all —
        // never forged ones either.
        const r = {...record(request, publicationKind === "checkpoint" ? [
          "path", "stagingPath", "attemptId", "bytes", "logicalPath", "workspaceId",
          "generation", "expectedHead", "expectedDirectory", "beforePublish",
        ] : [
          "path", "stagingPath", "attemptId", "bytes",
          "expectedDirectory", "beforePublish",
        ])};
        if (!(r.bytes instanceof Uint8Array)) fail("BYTES");
        bytes = Buffer.from(r.bytes);
        byteLength = boundedSize(bytes.byteLength);
        sha256 = digest(bytes);
        if (publicationKind === "checkpoint") {
        if (!Number.isSafeInteger(r.generation) || (r.generation as number) <= 0) fail("GENERATION");
        if (r.expectedHead === null) expectedHead = null;
        else {
          const h = record(r.expectedHead, ["generation", "attemptId", "sha256"]);
          if (!Number.isSafeInteger(h.generation) || (h.generation as number) <= 0 ||
              typeof h.attemptId !== "string" || !ATTEMPT.test(h.attemptId) ||
              typeof h.sha256 !== "string" || !HASH.test(h.sha256)) fail("GENERATION");
          expectedHead = Object.freeze({ generation: h.generation as number, attemptId: h.attemptId, sha256: h.sha256 });
        }
        generation = r.generation as number;
        if (generation !== (expectedHead?.generation ?? 0) + 1) fail("GENERATION");
        }
        const dirPin = {...record(r.expectedDirectory, ["canonicalPath", "fileId", "volumeId"])};
        if (typeof dirPin.canonicalPath !== "string" ||
            !same(canonical(dirPin.canonicalPath, root), dirPin.canonicalPath) ||
            typeof dirPin.fileId !== "string" || !FILE_ID.test(dirPin.fileId) ||
            typeof dirPin.volumeId !== "string" || !VOLUME_ID.test(dirPin.volumeId)) fail("IDENTITY");
        attemptId = text(r.attemptId, ATTEMPT);
        if (isAsyncLike(r.beforePublish)) fail("CALLBACK");
        callback = r.beforePublish as (readback: Uint8Array) => void;
        // Identity/pin callbacks happen only after every request field and
        // the exact payload copy are fixed.
        ({ path, parent, expectedDirectory } = baseRequest(r.path));
        if (!same(dirPin.canonicalPath, parent) ||
            !same(dirPin.fileId, expectedDirectory.fileId) ||
            !same(dirPin.volumeId, expectedDirectory.volumeId)) fail("IDENTITY");
        stagingPath = canonical(r.stagingPath, root);
        if (!same(parentOf(stagingPath), parent) || same(stagingPath, path)) fail("PATH");
        if (publicationKind === "checkpoint") {
          if (typeof r.logicalPath !== "string" || typeof r.workspaceId !== "string") fail("LOGICAL");
          logicalPath = canonical(r.logicalPath, root);
          if (!same(parentOf(logicalPath), parent) || same(path, logicalPath)) fail("LOGICAL");
          workspaceId = r.workspaceId;
        }
        input = encodeRequest({
          contractVersion: 3, operation: "prepare", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
          attemptId, stagingPath, byteLength, sha256,
        }, bytes);
        if (attempts.has(attemptId) || targets.has(asciiCaseFold(path))) fail("CONSUMED");
        assertPin();
        checkCurrent();
      } catch { return reject(pathEcho); }
      const metadata = { attemptId, stagingPath };
      active = true;
      // Consume both BEFORE any archive or native call. No retry.
      attempts.add(attemptId); targets.add(asciiCaseFold(path));
      try {
        const targetKey = `target:${digest(Buffer.from(
          asciiCaseFold(expectedRoot.volumeId) + "|" + asciiCaseFold(expectedRoot.rootFileId) + "|" +
          asciiCaseFold(expectedDirectory.volumeId) + "|" + asciiCaseFold(expectedDirectory.fileId) + "|" +
          asciiCaseFold(basenameOf(path)), "utf8"))}`;
        // Reservation, the immutable original AND the pointer intent are all
        // durable BEFORE the first helper dispatch — atomically in one
        // transaction. The original passed here is the SAME copy taken before
        // any callback ran. A deterministic refusal (conflict/pending/
        // foreign workspace/metadata) is a typed rejection, not poison —
        // nothing was dispatched and nothing is uncertain.
        let reserved: unknown;
        try {
          reserved = archive.reserve({
            attemptId, targetKey,
            metadata: publicationKind === "checkpoint" ? ({
              kind: "checkpoint", attemptId, path, stagingPath,
              logicalPath: logicalPath!, workspaceId: workspaceId!,
              root: { fileId: expectedRoot.rootFileId, volumeId: expectedRoot.volumeId },
              directory: { canonicalPath: parent, fileId: expectedDirectory.fileId, volumeId: expectedDirectory.volumeId },
              generation: generation!, expectedHead, byteLength, sha256,
            } as Record<string, unknown>) : ({
              kind: "raw-export", attemptId, path, stagingPath,
              root: { fileId: expectedRoot.rootFileId, volumeId: expectedRoot.volumeId },
              directory: { canonicalPath: parent, fileId: expectedDirectory.fileId, volumeId: expectedDirectory.volumeId },
              byteLength, sha256,
            } as Record<string, unknown>),
            original: Uint8Array.from(bytes),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (/WINDOWS_RECOVERY_ARCHIVE_(CONFLICT|PENDING|WORKSPACE|METADATA|ORIGINAL|EXPECTED|GENERATION|INTENT|BUDGET|CAPACITY|TARGET|ATTEMPT|LOGICAL_PATH|STORED|BINDING|SCHEMA|CLOSED|DISPATCH)/.test(message)) {
            const result = reject(path);
            rememberRecoveryIoFailure(result, error);
            return result;
          }
          poison();
          const result = unknown(path, metadata);
          rememberRecoveryIoFailure(result, error);
          return result;
        }
        if (reserved !== undefined || poisoned()) { poison(); return unknown(path, metadata); }
        if (!ack(() => archive.record(attemptId, "wire:prepare", input))) { poison(); return unknown(path, metadata); }

        const dispatched = invoke(attemptId, "prepare", input, dispatchSink);
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
          let typed: WindowsRecoveryIoFailure;
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
          if (digest(preparedReadback) !== sha256 || !preparedReadback.equals(bytes)) fail("RECEIPT");
          const proof = proofs(r, stagingPath, parent, expectedDirectory);
          stageFileId = proof.file.fileId; stageVolumeId = proof.file.volumeId;
          pinnedSid = proof.file.sid;
        } catch {
          terminal(attemptId, "UNKNOWN", { phase: "prepare", status, reply: { malformed: true } });
          return unknown(path, metadata);
        }
        if (!ack(() => archive.record(attemptId, "evidence:prepared", Buffer.from(JSON.stringify({ status, header: r }), "utf8")))) {
          poison(); return unknown(path, metadata);
        }

        // The original callback runs exactly once on a copy of the ACTUAL
        // staged readback; a throw or any thenable is UNKNOWN — no commit.
        try {
          const approval = callback(new Uint8Array(preparedReadback));
          if (utilTypes.isPromise(approval)) Promise.prototype.then.call(approval, undefined, () => undefined);
          if (approval !== undefined || isThenable(approval)) fail("CALLBACK_ASYNC");
        } catch {
          if (!poisoned()) terminal(attemptId, "UNKNOWN", { phase: "callback", status });
          return unknown(path, metadata);
        }

        const commitInput = encodeRequest({
          contractVersion: 3, operation: "commit-prepared", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
          attemptId, stagingPath, fileId: stageFileId, volumeId: stageVolumeId,
          expectedSha256: sha256, byteLength,
        }, new Uint8Array(0));
        if (!ack(() => archive.record(attemptId, "wire:commit-prepared", commitInput))) {
          poison(); return unknown(path, metadata);
        }
        const committed = invoke(attemptId, "commit-prepared", commitInput, dispatchSink);
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
          let typed: WindowsRecoveryIoFailure;
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
          if (digest(finalReadback) !== sha256 || !finalReadback.equals(bytes)) fail("RECEIPT");
          const proof = proofs(c, path, parent, expectedDirectory, stageFileId);
          if (!same(proof.file.volumeId, stageVolumeId)) fail("IDENTITY");
          identity = proof.identity;
          pinnedSid = proof.file.sid;
        } catch {
          terminal(attemptId, "UNKNOWN", { phase: "commit-prepared", status: commitStatus, reply: { malformed: true } });
          return unknown(path, metadata);
        }
        // Terminal carries the identity the file-port needs to pin reads.
        if (!terminal(attemptId, "PUBLISHED", {
          phase: "commit-prepared", status: commitStatus, path, sha256, byteLength,
          identity: { canonicalPath: identity.canonicalPath, fileId: identity.fileId, volumeId: identity.volumeId },
          stagingDisposition: "RENAMED_TO_FINAL",
        }))
          return unknown(path, metadata);
        knownFiles.set(asciiCaseFold(path), { fileId: identity.fileId, volumeId: identity.volumeId });
        return Object.freeze({
          contractVersion: 3, state: "PUBLISHED", path, ...metadata, identity,
          byteLength, sha256, readback: new Uint8Array(finalReadback),
          stagingDisposition: "RENAMED_TO_FINAL", contentFlushed: true,
          namespace: "EXCLUSIVE_NO_REPLACE",
          durability: Object.freeze({ profile: WINDOWS_PRIVATE_DURABILITY_PROFILE_V1, scope: "PROCESS_CRASH" }),
        }) as WindowsRecoveryPublishReceipt;
      } catch {
        // An unexpected break (for example a helper pin change mid-sequence)
        // is always UNKNOWN; the stage is retained, never cleaned or replayed.
        if (!poisoned()) terminal(attemptId, "UNKNOWN", { phase: "dispatch", malformed: true });
        return unknown(path, metadata);
      } finally { active = false; }
    },
    readPrivate(request: WindowsRecoveryIoReadRequest): WindowsRecoveryReadReceipt | WindowsRecoveryIoFailure {
      const pathEcho = requestPath(request);
      if (active || poisoned()) return reject(pathEcho);
      let path: string, parent: string, expectedDirectory: WindowsRuntimeDirectoryIdentity;
      let fileId: string, maxBytes: number, input: Uint8Array;
      let expectedSha256: string | undefined;
      try {
        const r = record(request, ["path", "expectedDirectory", "expectedFile", "maxBytes"], ["expectedSha256"]);
        path = canonical(r.path, root); parent = parentOf(path);
        if (same(path, root)) fail("PATH");
        const expected = directoryIdentity(r.expectedDirectory, expectedRoot.volumeId);
        if (same(parent, root) && !same(expected.fileId, expectedRoot.rootFileId)) fail("IDENTITY");
        expectedDirectory = expected;
        const f = record(r.expectedFile, ["canonicalPath", "fileId", "volumeId"]);
        if (!same(canonical(f.canonicalPath, root), path)) fail("IDENTITY");
        fileId = text(f.fileId, FILE_ID);
        const volumeId = text(f.volumeId, VOLUME_ID);
        if (!same(volumeId, expectedRoot.volumeId)) fail("IDENTITY");
        if ("expectedSha256" in r) expectedSha256 = text(r.expectedSha256, HASH);
        maxBytes = boundedSize(r.maxBytes);
        const pinned = knownFiles.get(asciiCaseFold(path));
        if (pinned !== undefined && (!same(pinned.fileId, fileId) || !same(pinned.volumeId, volumeId))) fail("IDENTITY");
        input = encodeRequest({
          contractVersion: 3, operation: "read-private", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
          fileId, volumeId, maxBytes,
          ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
        }, new Uint8Array(0));
        assertPin();
      } catch { return reject(pathEcho); }
      active = true;
      try {
        const outcome = invoke("", "read-private", input);
        if (!outcome.ok) return unknown(path);
        const r = outcome.framed.header, status = outcome.status;
        try { checkEnvelope(r, "read-private", path); } catch { return unknown(path); }
        if (r.state !== "READ") {
          try { return failure(r, status, path); } catch { return unknown(path); }
        }
        try {
          record(r, [...baseKeys, "file", "directory", "byteLength", "sha256", "filesystem"]);
          const length = boundedSize(r.byteLength);
          const sha = text(r.sha256, HASH);
          if (status !== 0 || length > maxBytes || r.filesystem !== "NTFS" ||
              outcome.framed.payload.byteLength !== length) fail("READ_RECEIPT");
          const bytes = outcome.framed.payload;
          if (digest(bytes) !== sha) fail("READ_RECEIPT");
          if (expectedSha256 !== undefined && sha !== expectedSha256) fail("READ_RECEIPT");
          const proof = proofs(r, path, parent, expectedDirectory, fileId);
          pinnedSid = proof.file.sid;
          knownFiles.set(asciiCaseFold(path), { fileId: proof.identity.fileId, volumeId: proof.identity.volumeId });
          return Object.freeze({
            contractVersion: 3, state: "READ", identity: proof.identity,
            bytes: Uint8Array.from(bytes), byteLength: length, sha256: sha,
          }) as WindowsRecoveryReadReceipt;
        } catch { return unknown(path); }
      } catch { return unknown(path); }
      finally { active = false; }
    },
    readMissing(request: WindowsRecoveryMissingRequest): WindowsRecoveryMissingReceipt | WindowsRecoveryIoFailure {
      const pathEcho = requestPath(request);
      if (active || poisoned()) return reject(pathEcho);
      let path: string, parent: string, expectedDirectory: WindowsRuntimeDirectoryIdentity;
      let input: Uint8Array;
      try {
        const r = record(request, ["path", "expectedDirectory"]);
        path = canonical(r.path, root); parent = parentOf(path);
        if (same(path, root)) fail("PATH");
        const expected = directoryIdentity(r.expectedDirectory, expectedRoot.volumeId);
        if (same(parent, root) && !same(expected.fileId, expectedRoot.rootFileId)) fail("IDENTITY");
        expectedDirectory = expected;
        input = encodeRequest({
          contractVersion: 3, operation: "read-missing", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
        }, new Uint8Array(0));
        assertPin();
        checkCurrent();
      } catch { return reject(pathEcho); }
      active = true;
      try {
        const outcome = invoke("", "read-missing", input);
        if (!outcome.ok) return unknown(path);
        const r = outcome.framed.header, status = outcome.status;
        try { checkEnvelope(r, "read-missing", path); } catch { return unknown(path); }
        try { assertPin(); } catch { return unknown(path); }
        if (r.state === "ABSENT") {
          try {
            record(r, [...baseKeys, "directory"]);
            if (status !== 0 || outcome.framed.payload.byteLength !== 0) fail("RECEIPT");
            const dir = evidence(r.directory, parent);
            if (!same(dir.fileId, expectedDirectory.fileId) ||
                !same(dir.volumeId, expectedDirectory.volumeId)) fail("EVIDENCE");
            checkCurrent();
            pinnedSid = dir.sid;
            return Object.freeze({
              contractVersion: 3, state: "ABSENT", path,
              directory: Object.freeze({ fileId: dir.fileId, volumeId: dir.volumeId }),
            }) as WindowsRecoveryMissingReceipt;
          } catch { return unknown(path); }
        }
        if (r.state === "EXISTS") {
          try {
            record(r, [...baseKeys, "reason"]);
            if (status !== 2 || r.reason !== "PRIVATE_IO_V3_EXISTS" ||
                outcome.framed.payload.byteLength !== 0) fail("RECEIPT");
            checkCurrent();
            return Object.freeze({contractVersion: 3, state: "EXISTS", path,
              reason: "PRIVATE_IO_V3_EXISTS", preserve: true});
          } catch { return unknown(path); }
        }
        try { return failure(r, status, path); } catch { return unknown(path); }
      } finally { active = false; }
    },
  });

  recoveryPublishObservers.set(io, (request) => {
    const dispatchSink: WindowsRecoveryPublishDispatchSink = {};
    recoveryPublishDispatchSinks.add(dispatchSink);
    const publishNew = io.publishNew as WindowsRecoveryPublishCore;
    const dispatch = (): WindowsRecoveryPublishDispatch | undefined =>
      dispatchSink.attemptId !== undefined && dispatchSink.stage !== undefined
        ? Object.freeze({ attemptId: dispatchSink.attemptId, stage: dispatchSink.stage })
        : undefined;
    try {
      const value = publishNew(request, dispatchSink);
      const observedDispatch = dispatch();
      return Object.freeze({
        terminal: "RETURNED" as const,
        trusted: true,
        value,
        ...(observedDispatch !== undefined ? { dispatch: observedDispatch } : {}),
      });
    } catch (value) {
      const observedDispatch = dispatch();
      return Object.freeze({
        terminal: "THREW" as const,
        trusted: true,
        value,
        ...(observedDispatch !== undefined ? { dispatch: observedDispatch } : {}),
      });
    }
  });
  return io;
}

/**
 * One invocation only, mirroring publishPrivateFileV2: a synchronous single
 * callback, exact readback/hash/identity checks, and UNKNOWN thrown for every
 * malformed or unverifiable outcome after entry. Never adapts to v1 or v2.
 */
export function publishPrivateFileV3(
  port: PrivateFileV3Port,
  request: {
    path: string; stagingPath: string; attemptId: string; bytes: Uint8Array;
    beforePublish(readback: Uint8Array): void;
  },
): WindowsRecoveryPublishReceipt {
  if (!port || port.contractVersion !== 3 || port.platform !== "win32" ||
      typeof port.publish !== "function" || utilTypes.isAsyncFunction(port.publish) || utilTypes.isGeneratorFunction(port.publish) ||
      typeof request.beforePublish !== "function" || utilTypes.isAsyncFunction(request.beforePublish) || utilTypes.isGeneratorFunction(request.beforePublish))
    throw new PrivateFilePortUnsupportedError("Synchronous private-file-v3 is required");
  const expected = Buffer.from(request.bytes);
  const sha = digest(expected);
  let active = true, approved = false, calls = 0, callbackFailed = false;
  const unknown = (message: string, result: unknown, cause?: unknown) =>
    new PrivateFilePublicationUnknownError(message, request.path, request.stagingPath, result, cause);
  let result: ReturnType<PrivateFileV3Port["publish"]>;
  try {
    result = port.publish({ ...request, bytes: expected, beforePublish(readback) {
      calls++;
      try {
        if (!active || calls !== 1 || !(readback instanceof Uint8Array) || !Buffer.from(readback).equals(expected))
          throw new Error("Staged v3 readback mismatch");
        const outcome: unknown = request.beforePublish(Uint8Array.from(readback));
        if (outcome !== undefined) {
          if (utilTypes.isPromise(outcome)) Promise.prototype.then.call(outcome, undefined, () => undefined);
          throw new Error("Publication approval must finish synchronously");
        }
        approved = true;
      } catch (error) { callbackFailed = true; throw error; }
    } });
  } catch (cause) { throw unknown("Private v3 publication threw; preserve both artifact locations", undefined, cause); }
  finally { active = false; }
  try {
    if (utilTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
    if (!result || typeof result !== "object" || isThenable(result) || result.contractVersion !== 3 || callbackFailed || calls > 1)
      throw new Error("Malformed v3 publication receipt");
    if (result.state !== "PUBLISHED" || !approved || calls !== 1 || result.path !== request.path ||
        result.stagingPath !== request.stagingPath || result.attemptId !== request.attemptId ||
        result.stagingDisposition !== "RENAMED_TO_FINAL" ||
        result.durability?.profile !== "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" || result.durability.scope !== "PROCESS_CRASH" ||
        result.contentFlushed !== true || result.namespace !== "EXCLUSIVE_NO_REPLACE" ||
        result.byteLength !== expected.byteLength || result.sha256 !== sha ||
        result.identity?.canonicalPath !== request.path ||
        !FILE_ID.test(result.identity.fileId) || !VOLUME_ID.test(result.identity.volumeId) ||
        !(result.readback instanceof Uint8Array) || !Buffer.from(result.readback).equals(expected))
      throw new Error("Private v3 publication evidence differs");
    return result;
  } catch (cause) {
    if (cause instanceof PrivateFileNotPublishedError && !callbackFailed) throw cause;
    throw unknown("Private v3 publication could not be verified", result, cause);
  }
}
