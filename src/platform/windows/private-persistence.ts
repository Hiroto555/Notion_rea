import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { types as utilTypes } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { AcquirePrivateAuthorityLease } from "./authority-lease";
import { CollaborationError } from "../../collaboration/runtime/contract";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";
import { WINDOWS_PROBE_TIMEOUT_MS } from "./private-root";
import type {
  WindowsRuntimeDirectoryIdentity,
  WindowsRuntimeRootIdentity,
} from "./runtime-platform";
import { WINDOWS_PRIVATE_DURABILITY_PROFILE_V1 } from "./private-publication-v2";
import {
  armKReserveObservation,
  consumeKReserveObservation,
  recordKMutationFailure,
  recordKReserveFailure,
  type KCapacityRefusal,
} from "../private-mutation-diagnostic";
import type {
  NativePrivateFile,
  NativePrivateFilesystemPort,
  NativePrivateIdentity,
  NativePrivateReceipt,
  NativePrivateTree,
  NativePrivateDirectoryReceipt,
  NativePrivateCurrentCheck,
  NativePrivateSqliteLease,
} from "../private-persistence";

/**
 * Wire bounds for the `--private-persistence-io` helper mode. The wire payload
 * cap is the existing raw32 envelope family cap and is NOT raised. Streaming
 * copies hash and bound 256 MiB helper-side; the wire carries header-only
 * requests and small readback receipts for copy/rename/unlink.
 */
export const WINDOWS_PRIVATE_HEADER_MAX_BYTES = 8192;
export const WINDOWS_PRIVATE_WIRE_MAX_BYTES = 32 * 1024 * 1024 + 4096;
export const WINDOWS_PRIVATE_MAX_WIRE =
  4 + WINDOWS_PRIVATE_HEADER_MAX_BYTES + WINDOWS_PRIVATE_WIRE_MAX_BYTES;
/** Helper-side streaming bound for copy-new; never carried on the wire. */
export const WINDOWS_PRIVATE_COPY_MAX_BYTES = 256 * 1024 * 1024;

export const WINDOWS_PRIVATE_PERSISTENCE_PROFILE =
  "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" as const;
export const WINDOWS_PRIVATE_PERSISTENCE_SCOPE = "PROCESS_CRASH" as const;

export class NativePrivatePersistenceError extends Error {
  readonly state: "REJECTED" | "EXISTS" | "UNKNOWN";
  readonly preserve = true as const;
  constructor(state: "REJECTED" | "EXISTS" | "UNKNOWN", reason: string, options?: ErrorOptions) {
    super(`WINDOWS_PRIVATE_PERSISTENCE_${state}:${reason}`, options);
    this.name = "NativePrivatePersistenceError";
    this.state = state;
  }
}

/**
 * REQUIRED typed authority port. It is owned independently of the caller's
 * outer transaction: reserve atomically consumes (targetKey, attemptId) and
 * durably reserves terminal/raw capacity with readback BEFORE any dispatch —
 * including rejecting duplicates observed across a restart. capture persists
 * the exact raw pipes BEFORE parsing, and terminal persists the final
 * APPLIED/UNKNOWN verdict BEFORE success is reported. A reserve/capture/
 * terminal acknowledgement that is not an exact synchronous void poisons the
 * factory permanently; the retained intent is never retried and a missing
 * terminal receipt is never treated as proof of non-application.
 */
export interface NativePrivatePersistenceAuthority {
  readonly version: 1;
  readonly independent: true;
  reserve(intent: {
    attemptId: string;
    targetKey: string;
    wire: Uint8Array;
    payload: Uint8Array;
    maxCaptureBytes: number;
  }): void;
  capture(
    attemptId: string,
    capture: {
      stdout: Uint8Array;
      stderr: Uint8Array;
      status: number | null;
      signal: string | null;
      errorCode?: string;
    },
  ): void;
  terminal(attemptId: string, state: "APPLIED" | "UNKNOWN", receipt: string): void;
  assertCurrent(): void;
}

export type WindowsPrivatePersistenceExecRequest = Readonly<{
  executable: string;
  args: readonly ["--private-persistence-io"];
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

export type WindowsPrivatePersistenceExecResult = Readonly<{
  status: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  errorCode?: string;
}>;

export type WindowsPrivatePersistenceTestPort = Readonly<{
  fs: Pick<
    {
      lstat(path: string): {
        isFile(): boolean;
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
        nlink: number;
        dev: number;
        ino: number;
        size: number;
        mtimeMs: number;
      };
      readFile(path: string): Uint8Array;
    },
    "lstat" | "readFile"
  >;
  exec(
    request: WindowsPrivatePersistenceExecRequest,
  ): WindowsPrivatePersistenceExecResult;
}>;

export type WindowsPrivatePersistenceOptions = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  expectedRoot: WindowsRuntimeRootIdentity;
  authority: NativePrivatePersistenceAuthority;
  /** Pinned parent-directory identity for a canonical path. */
  directoryIdentity(path: string): WindowsRuntimeDirectoryIdentity;
  /**
   * A's durable exclusive directory creation (IoExclusiveCreate,
   * `D:P(A;OICI;FA;;;SID)`): children — including a scratch VACUUM INTO
   * database — inherit private ACEs. Must synchronously return the new
   * directory's pinned identity.
   */
  createDirectory(path: string): WindowsRuntimeDirectoryIdentity;
  /** C's held file/root lease; READ|WRITE sharing for SQLite, no DELETE sharing. */
  acquireSqliteLease: AcquirePrivateAuthorityLease;
  /**
   * Caller-supplied synchronous revalidation (authority/cut/epoch/
   * incarnation/writer/session/fingerprint). Runs immediately pre-reserve,
   * pre-dispatch and pre-success; must return exact synchronous void.
   */
  assertCurrent(): void;
  /** Only a confirmed native CREATE_NEW receipt may enroll a new file. */
  onCreatedFile?(receipt: NativePrivateReceipt): void;
  beforeCreatedFile?(path: string): void;
  /** Trusted producer hooks; completion runs only after the complete native
   * rename receipt is validated, before caller success callbacks inspect dest. */
  beforeRelocation?(source: NativePrivateFile | NativePrivateTree, destination: string, kind: "file" | "directory"): void;
  onRelocatedFile?(source: NativePrivateFile, receipt: NativePrivateReceipt): void;
  onRelocatedDirectory?(source: NativePrivateTree, receipt: NativePrivateDirectoryReceipt): void;
}>;

const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const ATTEMPT = /^[0-9a-f]{32}$/;
const SID = /^S-1-[0-9]+(?:-[0-9]+)+$/;
const DIGEST = /^[0-9a-f]{64}$/;

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_PRIVATE_PERSISTENCE_${code}`);
}
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const same = (a: string, b: string): boolean =>
  asciiCaseFold(a) === asciiCaseFold(b);

function record(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null) fail("SCHEMA");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("SCHEMA");
  const names = Reflect.ownKeys(value);
  if (keys.some((key) => !names.includes(key))) fail("SCHEMA");
  for (const key of names) {
    if (
      typeof key !== "string" ||
      (!keys.includes(key) && !optional.includes(key))
    )
      fail("SCHEMA");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail("SCHEMA");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) fail("SCHEMA");
  return value;
}

function canonical(value: unknown, root?: string): string {
  if (
    typeof value !== "string" ||
    value.length > 240 ||
    !/^[A-Z]:\\[\x20-\x7e]*$/.test(value)
  )
    fail("PATH");
  try {
    if (
      validateWindowsPath(value, root ?? `${value[0]}:\\`).canonical !== value
    )
      fail("PATH");
  } catch {
    fail("PATH");
  }
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
function directoryIdentityOf(
  value: unknown,
  volume: string,
): WindowsRuntimeDirectoryIdentity {
  const r = record(value, ["fileId", "volumeId"]);
  const fileId = text(r.fileId, FILE_ID);
  const volumeId = text(r.volumeId, VOLUME_ID);
  if (!same(volumeId, volume)) fail("IDENTITY");
  return Object.freeze({ fileId, volumeId });
}
function boundedSize(value: unknown, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  )
    fail("SIZE");
  return value;
}
function isThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  )
    return false;
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return true;
  }
}
function isAsyncLike(value: unknown): boolean {
  return (
    typeof value !== "function" ||
    utilTypes.isAsyncFunction(value) ||
    utilTypes.isGeneratorFunction(value)
  );
}

function headerJson(
  fields: Record<string, unknown>,
  order: readonly string[],
): string {
  const out: Record<string, unknown> = Object.create(null);
  for (const key of order) if (key in fields) out[key] = fields[key];
  const json = JSON.stringify(out);
  if (
    Buffer.byteLength(json, "ascii") !== json.length ||
    json.length > WINDOWS_PRIVATE_HEADER_MAX_BYTES
  )
    fail("HEADER");
  return json;
}

const REQUEST_ORDER = [
  "attemptId",
  "byteLength",
  "contractVersion",
  "destination",
  "destinationDirectoryFileId",
  "destinationDirectoryVolumeId",
  "directoryFileId",
  "directoryVolumeId",
  "entries",
  "expectedSha256",
  "fileId",
  "maxBytes",
  "operation",
  "path",
  "root",
  "rootFileId",
  "rootVolumeId",
  "sha256",
  "sourceFileId",
  "sourceSha256",
  "sourceVolumeId",
  "volumeId",
] as const;

function encodeRequest(
  header: Record<string, unknown>,
  payload: Uint8Array,
): Buffer {
  const json = Buffer.from(headerJson(header, REQUEST_ORDER), "ascii");
  const frame = Buffer.alloc(4 + json.byteLength + payload.byteLength);
  frame.writeUInt32LE(json.byteLength, 0);
  json.copy(frame, 4);
  frame.set(payload, 4 + json.byteLength);
  return frame;
}

function parseHeader(bytes: Uint8Array): Record<string, unknown> {
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > WINDOWS_PRIVATE_HEADER_MAX_BYTES
  )
    fail("HEADER");
  for (const byte of bytes) if (byte > 0x7f) fail("HEADER");
  const source = Buffer.from(bytes).toString("latin1");
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(source)) fail("HEADER");
  let at = 0;
  const white = (): void => {
    while (at < source.length && /[ \t\r\n]/.test(source[at])) at++;
  };
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
      at++;
      white();
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (source[at] === "}") {
        at++;
        return result;
      }
      for (;;) {
        white();
        if (source[at] !== '"') fail("JSON");
        const key = string();
        if (keys.has(key) || keys.size >= 48) fail("JSON");
        keys.add(key);
        white();
        if (source[at++] !== ":") fail("JSON");
        result[key] = value(depth + 1);
        white();
        const delimiter = source[at++];
        if (delimiter === "}") return result;
        if (delimiter !== ",") fail("JSON");
      }
    }
    const token =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        source.slice(at),
      );
    if (!token) fail("JSON");
    at += token[0].length;
    return JSON.parse(token[0]) as unknown;
  };
  const result = value(0);
  white();
  if (at !== source.length) fail("JSON");
  if (typeof result !== "object" || result === null || Array.isArray(result))
    fail("JSON");
  return result as Record<string, unknown>;
}

type Framed = Readonly<{
  header: Record<string, unknown>;
  payload: Uint8Array;
}>;
function decodeResponse(stdout: Uint8Array): Framed {
  if (
    !(stdout instanceof Uint8Array) ||
    stdout.byteLength < 4 ||
    stdout.byteLength > WINDOWS_PRIVATE_MAX_WIRE
  )
    fail("OUTPUT");
  const headerLength =
    stdout[0] | (stdout[1] << 8) | (stdout[2] << 16) | (stdout[3] << 24);
  if (
    headerLength <= 0 ||
    headerLength > WINDOWS_PRIVATE_HEADER_MAX_BYTES ||
    stdout.byteLength < 4 + headerLength
  )
    fail("OUTPUT");
  const header = parseHeader(stdout.subarray(4, 4 + headerLength));
  return Object.freeze({
    header,
    payload: Uint8Array.from(stdout.subarray(4 + headerLength)),
  });
}

type Pin = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}>;
function samePin(a: Pin, b: Pin): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}
function pinExecutable(
  fs: WindowsPrivatePersistenceTestPort["fs"],
  path: string,
  hash: string,
): Pin {
  const stat = (): Pin => {
    const s = fs.lstat(path);
    if (!s.isFile() || s.isDirectory() || s.isSymbolicLink() || s.nlink !== 1)
      fail("HELPER_UNTRUSTED");
    const pin = {
      dev: s.dev,
      ino: s.ino,
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
    if (
      Object.values(pin).some((n) => !Number.isFinite(n) || n < 0) ||
      !Number.isSafeInteger(pin.size)
    )
      fail("HELPER_UNTRUSTED");
    return Object.freeze(pin);
  };
  try {
    const before = stat();
    const bytes = fs.readFile(path);
    const after = stat();
    if (
      bytes.byteLength !== before.size ||
      digest(bytes) !== hash ||
      !samePin(before, after)
    )
      fail("HELPER_UNTRUSTED");
    return after;
  } catch {
    return fail("HELPER_UNTRUSTED");
  }
}

const nativePort: WindowsPrivatePersistenceTestPort = {
  fs: { lstat: lstatSync, readFile: readFileSync },
  exec(request) {
    const result = spawnSync(request.executable, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      input: request.input,
      timeout: request.timeoutMs,
      maxBuffer: request.maxBuffer,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
      encoding: "buffer",
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? new Uint8Array(0),
      stderr: result.stderr ?? new Uint8Array(0),
      ...(result.error ? { errorCode: "EXEC_FAILED" } : {}),
    };
  },
};

/**
 * Single-dispatch private persistence port. Every mutating operation archives
 * the immutable wire+payload BEFORE mutation through the independent
 * authority, captures the exact pipes BEFORE parsing, and records a durable
 * terminal verdict BEFORE success is reported. Any post-dispatch ambiguity is
 * UNKNOWN and preserved; there are no automatic retries, resends, or deletions.
 */
export function createWindowsPrivatePersistence(
  options: WindowsPrivatePersistenceOptions,
): NativePrivateFilesystemPort {
  if (arguments.length !== 1) fail("OPTIONS");
  if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  return create(options, nativePort);
}

/**
 * Non-Windows contract-only adapter for finite transport simulations. It is
 * explicitly labelled untrusted contract simulation — never native Windows
 * proof and never OS acceptance.
 */
export function createWindowsPrivatePersistenceForTesting(
  options: WindowsPrivatePersistenceOptions,
  port: WindowsPrivatePersistenceTestPort,
): NativePrivateFilesystemPort {
  if (process.platform === "win32") fail("TEST_PORT_FORBIDDEN");
  return create(options, port);
}

const failedAuthorities = new WeakSet<object>();

function bindAuthority(candidate: unknown): NativePrivatePersistenceAuthority {
  if (
    candidate === null ||
    (typeof candidate !== "object" && typeof candidate !== "function")
  )
    fail("AUTHORITY");
  const record_ = candidate as Record<string, unknown>;
  if (record_.version !== 1 || record_.independent !== true) fail("AUTHORITY");
  const bound: Record<string, unknown> = {};
  for (const name of [
    "reserve",
    "capture",
    "terminal",
    "assertCurrent",
  ] as const) {
    const method = record_[name];
    if (isAsyncLike(method)) fail("AUTHORITY");
    bound[name] = (method as (...args: unknown[]) => unknown).bind(candidate);
  }
  return bound as unknown as NativePrivatePersistenceAuthority;
}

function create(
  options: WindowsPrivatePersistenceOptions,
  port: WindowsPrivatePersistenceTestPort,
): NativePrivateFilesystemPort {
  let root: string, executable: string, systemRoot: string;
  let expectedRoot: WindowsRuntimeRootIdentity;
  let initialPin: Pin;
  let fs: WindowsPrivatePersistenceTestPort["fs"],
    exec: WindowsPrivatePersistenceTestPort["exec"];
  let authority: NativePrivatePersistenceAuthority, authorityObject: object;
  let directoryIdentityFor: (path: string) => WindowsRuntimeDirectoryIdentity;
  let createDirectoryAdapter: (path: string) => WindowsRuntimeDirectoryIdentity;
  let acquireSqliteLease: AcquirePrivateAuthorityLease;
  let revalidate: () => void;
  try {
    const o = record(options, [
      "root",
      "probeExecutable",
      "expectedHash",
      "systemRoot",
      "expectedRoot",
      "authority",
      "directoryIdentity",
      "createDirectory",
      "acquireSqliteLease",
      "assertCurrent",
    ], ["beforeCreatedFile", "onCreatedFile", "beforeRelocation", "onRelocatedFile", "onRelocatedDirectory"]);
    for (const name of ["beforeCreatedFile", "onCreatedFile", "beforeRelocation", "onRelocatedFile", "onRelocatedDirectory"])
      if (o[name] !== undefined && isAsyncLike(o[name])) fail("OPTIONS");
    root = canonical(o.root);
    executable = canonical(o.probeExecutable);
    systemRoot = canonical(o.systemRoot);
    if (!/\.exe$/i.test(executable)) fail("OPTIONS");
    text(o.expectedHash, HASH);
    const r = record(o.expectedRoot, ["rootFileId", "volumeId"]);
    expectedRoot = Object.freeze({
      rootFileId: text(r.rootFileId, FILE_ID),
      volumeId: text(r.volumeId, VOLUME_ID),
    });
    authority = bindAuthority(o.authority);
    authorityObject = o.authority as object;
    if (
      isAsyncLike(o.directoryIdentity) ||
      isAsyncLike(o.createDirectory) ||
      isAsyncLike(o.acquireSqliteLease) ||
      isAsyncLike(o.assertCurrent)
    )
      fail("OPTIONS");
    directoryIdentityFor =
      o.directoryIdentity as WindowsPrivatePersistenceOptions["directoryIdentity"];
    createDirectoryAdapter =
      o.createDirectory as WindowsPrivatePersistenceOptions["createDirectory"];
    acquireSqliteLease = o.acquireSqliteLease as AcquirePrivateAuthorityLease;
    revalidate =
      o.assertCurrent as WindowsPrivatePersistenceOptions["assertCurrent"];
    const p = record(port, ["fs", "exec"]);
    const f = record(p.fs, ["lstat", "readFile"]);
    if (
      isAsyncLike(f.lstat) ||
      isAsyncLike(f.readFile) ||
      isAsyncLike(p.exec)
    )
      fail("OPTIONS");
    fs = {
      lstat: port.fs.lstat.bind(port.fs),
      readFile: port.fs.readFile.bind(port.fs),
    };
    exec = port.exec.bind(port);
    initialPin = pinExecutable(fs, executable, text(o.expectedHash, HASH));
  } catch {
    return fail("OPTIONS_OR_HELPER_UNTRUSTED");
  }

  let authorityFailed = false;
  let active = false;
  let checkingCurrent = false;
  let checkingOperation = false;
  let pinnedSid: string | undefined;
  const poisoned = (): boolean =>
    authorityFailed || failedAuthorities.has(authorityObject);
  const poison = (): void => {
    authorityFailed = true;
    failedAuthorities.add(authorityObject);
  };
  const assertPin = (): void => {
    if (!samePin(initialPin, pinExecutable(fs, executable, text(options.expectedHash, HASH))))
      fail("HELPER_CHANGED");
  };
  const syncVoid = (call: () => unknown): void => {
    let outcome: unknown;
    try {
      outcome = call();
    } catch (cause) {
      // Keep the stable public code while Main can still recognize an
      // independently retained reader/owner before IPC serialization.
      const failure = new CollaborationError("WINDOWS_PRIVATE_PERSISTENCE_REVALIDATE");
      Object.defineProperty(failure, "cause", {value: cause});
      throw failure;
    }
    if (utilTypes.isPromise(outcome))
      Promise.prototype.then.call(outcome, undefined, () => undefined);
    if (outcome !== undefined || isThenable(outcome)) fail("REVALIDATE");
  };
  const checkCurrent = (): void => {
    if (checkingCurrent) fail("REENTRANT");
    checkingCurrent = true;
    try {
      syncVoid(() => revalidate());
      syncVoid(() => authority.assertCurrent());
    } finally { checkingCurrent = false; }
  };
  let acknowledgementFailure: {error: unknown} | undefined;
  const unknownFailure = (reason: string, primary?: {error: unknown}): NativePrivatePersistenceError => {
    const errors = [...(primary ? [primary.error] : []), ...(acknowledgementFailure ? [acknowledgementFailure.error] : [])];
    return new NativePrivatePersistenceError("UNKNOWN", reason, errors.length ? {
      cause: errors.length === 1 ? errors[0] : new AggregateError(errors, "Native operation and authority acknowledgement failed"),
    } : undefined);
  };
  const ack = (call: () => unknown, onNonVoid?: () => void): boolean => {
    if (poisoned()) return false;
    try {
      const result = call();
      if (result !== undefined) onNonVoid?.();
      if (utilTypes.isPromise(result))
        Promise.prototype.then.call(result, undefined, () => undefined);
      return result === undefined && !poisoned();
    } catch (error) {
      acknowledgementFailure ??= {error};
      return false;
    }
  };

  const expectedFile = (value: unknown, maximum: number): NativePrivateFile => {
    const f = record(value, ["path", "fileId", "volumeId", "bytes", "sha256"]);
    return Object.freeze({
      path: canonical(f.path, root),
      fileId: text(f.fileId, FILE_ID),
      volumeId: text(f.volumeId, VOLUME_ID),
      bytes: boundedSize(f.bytes, maximum),
      sha256: text(f.sha256, DIGEST),
    });
  };

  const baseRequest = (pathValue: unknown) => {
    const path = canonical(pathValue, root);
    const parent = parentOf(path);
    if (same(path, root)) fail("PATH");
    let raw: unknown;
    try {
      raw = directoryIdentityFor(parent);
    } catch {
      fail("IDENTITY");
    }
    if (utilTypes.isPromise(raw) || isThenable(raw)) fail("IDENTITY");
    const expectedDirectory = directoryIdentityOf(raw, expectedRoot.volumeId);
    if (
      same(parent, root) &&
      !same(expectedDirectory.fileId, expectedRoot.rootFileId)
    )
      fail("IDENTITY");
    return { path, parent, expectedDirectory };
  };

  const evidence = (
    raw: unknown,
    path: string,
    fileId?: string,
  ): WindowsProbeEvidence => {
    assertWindowsProbe(raw, { canonicalPath: path, canonicalRoot: root });
    const p = raw as WindowsProbeEvidence;
    canonical(p.canonicalPath, root);
    canonical(p.canonicalRoot);
    if (
      !same(p.rootFileId, expectedRoot.rootFileId) ||
      !same(p.rootVolumeId, expectedRoot.volumeId) ||
      !same(p.volumeId, expectedRoot.volumeId) ||
      (fileId !== undefined && !same(p.fileId, fileId)) ||
      !SID.test(p.sid) ||
      (pinnedSid !== undefined && p.sid !== pinnedSid)
    )
      fail("EVIDENCE");
    return p;
  };

  const baseKeys = ["contractVersion", "operation", "path", "root", "state"] as const;
  const checkEnvelope = (
    r: Record<string, unknown>,
    operation: string,
    path: string,
  ): void => {
    if (
      r.contractVersion !== 4 ||
      r.operation !== operation ||
      r.path !== path ||
      r.root !== root
    )
      fail("ENVELOPE");
  };

  type Capture = {
    stdout: Uint8Array;
    stderr: Uint8Array;
    status: number | null;
    signal: string | null;
    errorCode?: string;
  };
  const captureBytes = (raw: unknown, key: "stdout" | "stderr"): Uint8Array => {
    if (raw === null || typeof raw !== "object") return new Uint8Array(0);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !(descriptor.value instanceof Uint8Array)
    )
      return new Uint8Array(0);
    return Uint8Array.from(descriptor.value);
  };
  const captureOf = (raw: unknown): Capture => {
    const out: Capture = {
      stdout: captureBytes(raw, "stdout"),
      stderr: captureBytes(raw, "stderr"),
      status: null,
      signal: null,
    };
    if (raw !== null && typeof raw === "object") {
      const r: Record<string, unknown> = {};
      for (const key of ["status", "signal", "errorCode"]) {
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (descriptor && "value" in descriptor) r[key] = descriptor.value;
      }
      if (typeof r.status === "number" || r.status === null)
        out.status = r.status as number | null;
      if (typeof r.signal === "string" || r.signal === null)
        out.signal = r.signal as string | null;
      if (typeof r.errorCode === "string") out.errorCode = r.errorCode;
    }
    return out;
  };

  const runHelper = (
    input: Uint8Array,
    maxBuffer = WINDOWS_PRIVATE_MAX_WIRE,
    onMutationExec?: () => void,
  ):
    | { ok: true; status: number; stdout: Uint8Array; raw: unknown }
    | { ok: false; raw: unknown } => {
    let raw: unknown;
    try {
      assertPin();
      const request = Object.freeze({
        executable,
        args: Object.freeze(["--private-persistence-io"] as const),
        cwd: systemRoot,
        env: Object.freeze({
          SystemRoot: systemRoot,
          windir: systemRoot,
          TEMP: childOf(systemRoot, "Temp"),
          TMP: childOf(systemRoot, "Temp"),
        }),
        input,
        timeoutMs: WINDOWS_PROBE_TIMEOUT_MS,
        maxBuffer,
        shell: false,
        windowsHide: true,
        stdio: "pipe",
        encoding: "buffer",
      });
      onMutationExec?.();
      raw = exec(request);
    } catch {
      return { ok: false, raw: undefined };
    }
    try {
      assertPin();
    } catch {
      return { ok: false, raw };
    }
    let result: Record<string, unknown>;
    try {
      result = record(raw, ["status", "signal", "stdout", "stderr"], ["errorCode"]);
    } catch {
      return { ok: false, raw };
    }
    if (
      result.signal !== null ||
      "errorCode" in result ||
      !(result.stderr instanceof Uint8Array) ||
      result.stderr.byteLength !== 0 ||
      !(result.stdout instanceof Uint8Array) ||
      !Number.isInteger(result.status)
    )
      return { ok: false, raw };
    try {
      return {
        ok: true,
        status: result.status as number,
        stdout: Uint8Array.from(result.stdout as Uint8Array),
        raw,
      };
    } catch {
      return { ok: false, raw };
    }
  };

  const failureState = (
    r: Record<string, unknown>,
    status: number,
  ): "REJECTED" | "EXISTS" | "UNKNOWN" => {
    record(r, [...baseKeys, "reason"], ["attemptId"]);
    const state = r.state;
    if (
      !(
        (state === "REJECTED" && status === 1) ||
        (state === "EXISTS" && status === 2) ||
        (state === "UNKNOWN" && status === 3)
      ) ||
      typeof r.reason !== "string"
    )
      fail("FAILURE");
    return state;
  };

  const fileReceipt = (
    r: Record<string, unknown>,
    path: string,
    parent: string,
    directory: WindowsRuntimeDirectoryIdentity,
    maximum: number,
    fileId?: string,
    withDurability = false,
  ): NativePrivateReceipt => {
    record(
      r,
      [
        ...baseKeys,
        "file",
        "directory",
        "byteLength",
        "sha256",
        "filesystem",
        ...(withDurability ? (["durability"] as const) : []),
      ],
      [
        "attemptId",
        "sourceDirectory",
        "destination",
        "unlinked",
        "contentFlushed",
      ],
    );
    const length = boundedSize(r.byteLength, maximum);
    const sha = text(r.sha256, DIGEST);
    if (r.filesystem !== "NTFS") fail("RECEIPT");
    if (withDurability) {
      const durability = record(r.durability, ["profile", "scope"]);
      if (
        durability.profile !== WINDOWS_PRIVATE_DURABILITY_PROFILE_V1 ||
        durability.scope !== "PROCESS_CRASH" ||
        r.contentFlushed !== true
      )
        fail("RECEIPT");
    }
    const file = evidence(r.file, path, fileId);
    const dir = evidence(r.directory, parent, directory.fileId);
    if (file.sid !== dir.sid || !same(dir.volumeId, directory.volumeId))
      fail("EVIDENCE");
    pinnedSid = file.sid;
    return Object.freeze({
      profile: WINDOWS_PRIVATE_PERSISTENCE_PROFILE,
      scope: WINDOWS_PRIVATE_PERSISTENCE_SCOPE,
      identity: Object.freeze({
        path: file.canonicalPath,
        fileId: file.fileId,
        volumeId: file.volumeId,
        bytes: length,
        sha256: sha,
      }),
    });
  };

  /** Non-archived read-class single dispatch. */
  const inspect = (
    operation: string,
    header: Record<string, unknown>,
    path: string,
  ): { r: Record<string, unknown>; payload: Uint8Array; status: number } => {
    const input = encodeRequest(header, new Uint8Array(0));
    assertPin();
    checkCurrent();
    const outcome = runHelper(input);
    if (!outcome.ok)
      throw unknownFailure("DISPATCH");
    let framed: Framed;
    try { framed = decodeResponse(outcome.stdout); }
    catch { throw unknownFailure("FRAME"); }
    if (operation === "inspect-tree" && framed.payload.byteLength !== 0)
      throw unknownFailure("TREE_PAYLOAD");
    const r = framed.header;
    try {
      checkEnvelope(r, operation, String(header.path));
    } catch {
      throw unknownFailure("ENVELOPE");
    }
    if (r.state !== "OK") {
      let state: "REJECTED" | "EXISTS" | "UNKNOWN";
      try {
        state = failureState(r, outcome.status);
      } catch {
        throw unknownFailure("FAILURE_ENVELOPE");
      }
      throw new NativePrivatePersistenceError(state, String(r.reason), acknowledgementFailure ? {cause: acknowledgementFailure.error} : undefined);
    }
    if (outcome.status !== 0)
      throw unknownFailure("STATUS");
    checkCurrent();
    return { r, payload: framed.payload, status: outcome.status };
  };

  /** Archived mutating single dispatch: reserve → dispatch → capture → terminal. */
  const mutate = (
    operation: string,
    targetKey: string,
    header: Record<string, unknown>,
    payload: Uint8Array,
    path: string,
    approve: (
      r: Record<string, unknown>,
      status: number,
      payload: Uint8Array,
    ) => void,
    operationCheck?: NativePrivateCurrentCheck,
  ): void => {
    if (poisoned()) throw unknownFailure("AUTHORITY");
    if (operationCheck !== undefined && isAsyncLike(operationCheck)) fail("REVALIDATE");
    const phase = (name: "reserve" | "dispatch" | "success"): void => {
      checkCurrent();
      if (!operationCheck) return;
      // Operation checks may perform read-only proofs, but cannot recursively
      // mutate or reserve another operation on this factory.
      const wasActive = active;
      active = false;
      checkingOperation = true;
      try { syncVoid(() => operationCheck(name)); }
      finally { checkingOperation = false; active = wasActive; }
    };
    const attemptId = randomUUID().replace(/-/g, "");
    if (!ATTEMPT.test(attemptId)) fail("ATTEMPT");
    const wire = encodeRequest({ ...header, attemptId }, payload);
    const outputLimit = 4 + WINDOWS_PRIVATE_HEADER_MAX_BYTES + payload.byteLength;
    const current: {
      error?: object;
      state?: "REJECTED" | "EXISTS" | "UNKNOWN";
      reason?: string;
      dispatched?: true;
      capacityRefusal?: KCapacityRefusal;
      uncertainty?: {
        stage: "RESERVE" | "DISPATCH" | "CAPTURE" | "TERMINAL";
        origin:
          | "JOURNAL_TRANSACTION"
          | "JOURNAL_READBACK"
          | "JOURNAL_ASSOCIATION"
          | "NON_VOID_ACK"
          | "MUTATION_EXEC";
      };
    } = {};
    const mutationFailure = (reason: string, primary?: { error: unknown }): NativePrivatePersistenceError => {
      const error = unknownFailure(reason, primary);
      current.error = error;
      current.state = "UNKNOWN";
      current.reason = reason;
      return error;
    };
    const mergeReserveObservation = (
      observed: ReturnType<typeof consumeKReserveObservation>,
    ): void => {
      if (!observed.matched) return;
      if (observed.capacityRefusal !== undefined) current.capacityRefusal = observed.capacityRefusal;
      if (observed.uncertainty !== undefined) {
        current.uncertainty = {
          stage: "RESERVE",
          origin:
            observed.uncertainty === "TRANSACTION" ? "JOURNAL_TRANSACTION"
            : observed.uncertainty === "READBACK" ? "JOURNAL_READBACK"
            : "JOURNAL_ASSOCIATION",
        };
      }
    };
    const unknownTerminal = (body: Record<string, unknown>): void =>
      terminalSafe(attemptId, "UNKNOWN", body, () => {
        current.uncertainty = { stage: "TERMINAL", origin: "NON_VOID_ACK" };
      });
    try {
      // Exact synchronous void pre-reserve revalidation.
      phase("reserve");
      // Reservation + immutable wire/payload are durable BEFORE dispatch; a
      // non-void acknowledgement poisons the factory and retains the intent.
      const acknowledgementFailureBeforeReserve = acknowledgementFailure;
      if (
        !ack(() => {
          const intent = {
            attemptId,
            targetKey,
            wire: Uint8Array.from(wire),
            payload: Uint8Array.from(payload),
            // Include bounded pipe-chunk overshoot beyond spawnSync's threshold.
            maxCaptureBytes: outputLimit + 1024 * 1024,
          };
          const handle = armKReserveObservation(intent, attemptId);
          try {
            const result: unknown = authority.reserve(intent);
            mergeReserveObservation(consumeKReserveObservation(handle, "RETURNED", result));
            return result;
          } catch (thrown) {
            mergeReserveObservation(consumeKReserveObservation(handle, "THREW", thrown));
            throw thrown;
          }
        }, () => {
          current.uncertainty = { stage: "RESERVE", origin: "NON_VOID_ACK" };
        })
      ) {
        poison();
        const reserveError = mutationFailure("RESERVE");
        const directCurrentCause =
          acknowledgementFailure !== undefined &&
          acknowledgementFailure !== acknowledgementFailureBeforeReserve
            ? acknowledgementFailure.error
            : undefined;
        recordKReserveFailure(reserveError, attemptId, directCurrentCause);
        throw reserveError;
      }
      // Exact synchronous void immediately pre-dispatch.
      try {
        phase("dispatch");
      } catch (error) {
        unknownTerminal({ phase: "pre-dispatch" });
        throw mutationFailure("REVALIDATE", {error});
      }
      const outcome = runHelper(wire, outputLimit, () => {
        current.dispatched = true;
        current.uncertainty ??= { stage: "DISPATCH", origin: "MUTATION_EXEC" };
      });
      // Raw captured pipes reach the durable authority BEFORE any parsing.
      if (
        !ack(
          () => authority.capture(attemptId, captureOf(outcome.raw)),
          () => {
            current.uncertainty = { stage: "CAPTURE", origin: "NON_VOID_ACK" };
          },
        )
      ) {
        poison();
        throw mutationFailure("CAPTURE");
      }
      if (!outcome.ok) {
        unknownTerminal({ phase: "dispatch", malformed: true });
        throw mutationFailure("DISPATCH");
      }
      let framed: Framed;
      try { framed = decodeResponse(outcome.stdout); }
      catch {
        unknownTerminal({ phase: operation, malformed: true });
        throw mutationFailure("FRAME");
      }
      const r = framed.header;
      const status = outcome.status;
      if (operation === "rename-directory-new" && framed.payload.byteLength !== 0) {
        unknownTerminal({ phase: operation, malformed: true });
        throw mutationFailure("TREE_PAYLOAD");
      }
      try {
        checkEnvelope(r, operation, String(header.path));
        if (r.attemptId !== attemptId) fail("ENVELOPE");
      } catch {
        unknownTerminal({
          phase: operation,
          status,
          reply: { malformed: true },
        });
        throw mutationFailure("ENVELOPE");
      }
      if (r.state !== "APPLIED") {
        let state: "REJECTED" | "EXISTS" | "UNKNOWN";
        try {
          state = failureState(record(r, [...baseKeys, "attemptId", "reason"]), status);
        } catch {
          unknownTerminal({
            phase: operation,
            status,
            reply: { malformed: true },
          });
          throw mutationFailure("FAILURE_ENVELOPE");
        }
        unknownTerminal({ phase: operation, status, reply: r });
        const reason = String(r.reason);
        const typed = new NativePrivatePersistenceError(state, reason, acknowledgementFailure ? {cause: acknowledgementFailure.error} : undefined);
        current.error = typed;
        current.state = state;
        current.reason = reason;
        throw typed;
      }
      // Exact synchronous void immediately pre-success.
      try {
        approve(r, status, framed.payload);
        phase("success");
      } catch (error) {
        unknownTerminal({
          phase: operation,
          status,
          reply: { malformed: true },
        });
        throw mutationFailure("RECEIPT", {error});
      }
      if (
        !ack(
          () =>
            authority.terminal(
              attemptId,
              "APPLIED",
              JSON.stringify({ attemptId, operation, path, status, reply: r }),
            ),
          () => {
            current.uncertainty = { stage: "TERMINAL", origin: "NON_VOID_ACK" };
          },
        )
      ) {
        poison();
        throw mutationFailure("TERMINAL");
      }
    } catch (error) {
      if (
        (typeof error === "object" && error !== null || typeof error === "function") &&
        error === current.error &&
        current.state !== undefined &&
        current.reason !== undefined
      ) {
        recordKMutationFailure(error, {
          attemptId,
          sourceOutcome: {
            source: "K_EXCEPTION",
            state: current.state,
            reason: current.reason,
          },
          mutationDispatch: current.dispatched === true ? "DISPATCHED" : "NOT_DISPATCHED_PROVEN",
          ...(current.capacityRefusal !== undefined ? { capacityRefusal: current.capacityRefusal } : {}),
          ...(current.uncertainty !== undefined
            ? { uncertainty: Object.freeze({ stage: current.uncertainty.stage, origin: current.uncertainty.origin }) }
            : {}),
        });
      }
      throw error;
    }
  };

  const terminalSafe = (
    attemptId: string,
    state: "APPLIED" | "UNKNOWN",
    evidenceBody: Record<string, unknown>,
    onNonVoid?: () => void,
  ): void => {
    let body: string;
    try {
      body = JSON.stringify({ attemptId, state, ...evidenceBody });
      if (Buffer.byteLength(body) > 48 * 1024)
        body = JSON.stringify({ attemptId, state, evidenceOmitted: true });
    } catch {
      body = JSON.stringify({ attemptId, state, evidenceOmitted: true });
    }
    if (!ack(() => authority.terminal(attemptId, state, body), onNonVoid)) poison();
  };

  const targetKey = (path: string, directory: WindowsRuntimeDirectoryIdentity) =>
    `target:${digest(
      Buffer.from(
        asciiCaseFold(expectedRoot.volumeId) +
          "|" +
          asciiCaseFold(expectedRoot.rootFileId) +
          "|" +
          asciiCaseFold(directory.volumeId) +
          "|" +
          asciiCaseFold(directory.fileId) +
          "|" +
          asciiCaseFold(basenameOf(path)),
        "utf8",
      ),
    )}`;

  const directoryFields = (directory: WindowsRuntimeDirectoryIdentity) => ({
    rootFileId: expectedRoot.rootFileId,
    rootVolumeId: expectedRoot.volumeId,
    directoryFileId: directory.fileId,
    directoryVolumeId: directory.volumeId,
  });

  const identityOf = (
    r: Record<string, unknown>,
    path: string,
  ): NativePrivateIdentity => {
    const file = evidence(r.file, path);
    pinnedSid = file.sid;
    return Object.freeze({
      path: file.canonicalPath,
      fileId: file.fileId,
      volumeId: file.volumeId,
    });
  };

  const ensureFree = (readOnly = false): void => {
    if (active || checkingCurrent || (checkingOperation && !readOnly) || poisoned()) throw new NativePrivatePersistenceError("REJECTED", "BUSY");
  };

  const treeReceipt = (r: Record<string, unknown>, path: string, parent: string,
    directory: WindowsRuntimeDirectoryIdentity, moved = false): NativePrivateTree => {
    record(r, [...baseKeys, "file", "directory", "entries", "byteLength", "sha256", "filesystem",
      ...(moved ? ["attemptId", "destination", "sourceDirectory", "durability"] : [])]);
    const entries = boundedSize(r.entries, 4096);
    if (entries < 1 || r.filesystem !== "NTFS") fail("TREE");
    const file = evidence(r.file, path);
    const dir = evidence(r.directory, parent, directory.fileId);
    if (file.sid !== dir.sid || !same(dir.volumeId, directory.volumeId)) fail("TREE");
    pinnedSid = file.sid;
    if (moved) {
      const d = record(r.durability, ["profile", "scope"]);
      if (d.profile !== "WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1" || d.scope !== "PROCESS_CRASH") fail("TREE");
    }
    return Object.freeze({ path, fileId: file.fileId, volumeId: file.volumeId, entries,
      bytes: boundedSize(r.byteLength, WINDOWS_PRIVATE_COPY_MAX_BYTES), sha256: text(r.sha256, DIGEST) });
  };

  const filesystem: NativePrivateFilesystemPort = {
    platform: "win32" as const,
    version: 1 as const,
    synchronous: true as const,
    inspectDirectory(path: string): NativePrivateIdentity {
      ensureFree(true);
      const { path: p, expectedDirectory } = baseRequest(path);
      active = true;
      try {
        const { r } = inspect(
          "inspect-directory",
          {
            contractVersion: 4,
            operation: "inspect-directory",
            path: p,
            root,
            ...directoryFields(expectedDirectory),
          },
          p,
        );
        try {
          record(r, [...baseKeys, "file", "directory"]);
          const dir = evidence(r.file, p);
          const parent = evidence(r.directory, parentOf(p), expectedDirectory.fileId);
          if (dir.sid !== parent.sid) fail("EVIDENCE");
          pinnedSid = dir.sid;
          return Object.freeze({
            path: dir.canonicalPath,
            fileId: dir.fileId,
            volumeId: dir.volumeId,
          });
        } catch {
          throw unknownFailure("RECEIPT");
        }
      } finally {
        active = false;
      }
    },
    inspectFileIdentity(path: string): NativePrivateIdentity {
      ensureFree(true);
      const { path: p, expectedDirectory } = baseRequest(path);
      active = true;
      try {
        const { r } = inspect(
          "inspect-file-identity",
          {
            contractVersion: 4,
            operation: "inspect-file-identity",
            path: p,
            root,
            ...directoryFields(expectedDirectory),
          },
          p,
        );
        try {
          record(r, [...baseKeys, "file", "directory"]);
          const parent = evidence(r.directory, parentOf(p), expectedDirectory.fileId);
          const result = identityOf(r, p);
          if (parent.sid !== pinnedSid) fail("EVIDENCE");
          return result;
        } catch {
          throw unknownFailure("RECEIPT");
        }
      } finally {
        active = false;
      }
    },
    inspectFile(path: string, maxBytes: number): NativePrivateFile {
      ensureFree(true);
      const { path: p, parent, expectedDirectory } = baseRequest(path);
      const maximum = boundedSize(maxBytes, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      active = true;
      try {
        const { r } = inspect(
          "inspect-file",
          {
            contractVersion: 4,
            operation: "inspect-file",
            path: p,
            root,
            ...directoryFields(expectedDirectory),
            maxBytes: maximum,
          },
          p,
        );
        try {
          const receipt = fileReceipt(r, p, parent, expectedDirectory, maximum);
          return receipt.identity;
        } catch {
          throw unknownFailure("RECEIPT");
        }
      } finally {
        active = false;
      }
    },
    read(
      path: string,
      expected: NativePrivateFile,
      maxBytes: number,
    ): Uint8Array {
      ensureFree(true);
      const { path: p, parent, expectedDirectory } = baseRequest(path);
      const want = expectedFile(expected, WINDOWS_PRIVATE_WIRE_MAX_BYTES);
      const maximum = boundedSize(maxBytes, WINDOWS_PRIVATE_WIRE_MAX_BYTES);
      if (!same(want.path, p)) throw new NativePrivatePersistenceError("REJECTED", "IDENTITY");
      active = true;
      try {
        const { r, payload } = inspect(
          "read",
          {
            contractVersion: 4,
            operation: "read",
            path: p,
            root,
            ...directoryFields(expectedDirectory),
            fileId: want.fileId,
            volumeId: want.volumeId,
            expectedSha256: want.sha256,
            maxBytes: maximum,
          },
          p,
        );
        try {
          const receipt = fileReceipt(
            r,
            p,
            parent,
            expectedDirectory,
            maximum,
            want.fileId,
          );
          if (
            receipt.identity.bytes !== want.bytes ||
            receipt.identity.sha256 !== want.sha256 ||
            payload.byteLength !== want.bytes ||
            digest(payload) !== want.sha256
          )
            fail("READ_RECEIPT");
          return Uint8Array.from(payload);
        } catch {
          throw unknownFailure("READ_RECEIPT");
        }
      } finally {
        active = false;
      }
    },
    writeNew(
      path: string,
      bytes: Uint8Array,
      maxBytes: number,
    ): NativePrivateReceipt {
      ensureFree();
      const { path: p, parent, expectedDirectory } = baseRequest(path);
      if (!(bytes instanceof Uint8Array))
        throw new NativePrivatePersistenceError("REJECTED", "BYTES");
      const maximum = boundedSize(maxBytes, WINDOWS_PRIVATE_WIRE_MAX_BYTES);
      const payload = Uint8Array.from(bytes);
      const length = boundedSize(payload.byteLength, maximum);
      const sha = digest(payload);
      if (options.beforeCreatedFile) syncVoid(() => options.beforeCreatedFile!(p));
      let receipt: NativePrivateReceipt | undefined;
      active = true;
      try {
        mutate(
          "write-new",
          targetKey(p, expectedDirectory),
          {
            contractVersion: 4,
            operation: "write-new",
            path: p,
            root,
            ...directoryFields(expectedDirectory),
            byteLength: length,
            sha256: sha,
            maxBytes: maximum,
          },
          payload,
          p,
          (r, status, readback) => {
            if (status !== 0) fail("STATUS");
            const proven = fileReceipt(
              r,
              p,
              parent,
              expectedDirectory,
              maximum,
              undefined,
              true,
            );
            if (
              proven.identity.bytes !== length ||
              proven.identity.sha256 !== sha ||
              r.contentFlushed !== true ||
              !Buffer.from(readback).equals(Buffer.from(payload))
            )
              fail("RECEIPT");
            if (options.onCreatedFile) {
              if (isAsyncLike(options.onCreatedFile)) fail("CREATED_BINDING");
              syncVoid(() => options.onCreatedFile!(proven));
            }
            receipt = proven;
          },
        );
      } finally {
        active = false;
      }
      return receipt as NativePrivateReceipt;
    },
    copyNew(
      source: string,
      destination: string,
      expected: NativePrivateFile,
      maxBytes: number,
    ): NativePrivateReceipt {
      ensureFree();
      const { path: dest, parent, expectedDirectory } = baseRequest(destination);
      if (options.beforeCreatedFile) syncVoid(() => options.beforeCreatedFile!(dest));
      const src = baseRequest(source);
      if (same(src.path, dest))
        throw new NativePrivatePersistenceError("REJECTED", "PATH");
      const want = expectedFile(expected, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      const maximum = boundedSize(maxBytes, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      if (!same(want.path, src.path))
        throw new NativePrivatePersistenceError("REJECTED", "IDENTITY");
      let receipt: NativePrivateReceipt | undefined;
      active = true;
      try {
        mutate(
          "copy-new",
          targetKey(dest, expectedDirectory),
          {
            contractVersion: 4,
            operation: "copy-new",
            path: src.path,
            root,
            ...directoryFields(src.expectedDirectory),
            destination: dest,
            destinationDirectoryFileId: expectedDirectory.fileId,
            destinationDirectoryVolumeId: expectedDirectory.volumeId,
            sourceFileId: want.fileId,
            sourceVolumeId: want.volumeId,
            sourceSha256: want.sha256,
            byteLength: want.bytes,
            maxBytes: maximum,
          },
          new Uint8Array(0),
          dest,
          (r, status) => {
            if (status !== 0) fail("STATUS");
            const proven = fileReceipt(
              r,
              dest,
              parent,
              expectedDirectory,
              maximum,
              undefined,
              true,
            );
            if (
              proven.identity.bytes !== want.bytes ||
              proven.identity.sha256 !== want.sha256
            )
              fail("RECEIPT");
            const srcDir = evidence(
              r.sourceDirectory,
              src.parent,
              src.expectedDirectory.fileId,
            );
            if (
              !same(srcDir.volumeId, src.expectedDirectory.volumeId) ||
              srcDir.sid !== pinnedSid
            )
              fail("EVIDENCE");
            if (options.onCreatedFile) syncVoid(() => options.onCreatedFile!(proven));
            receipt = proven;
          },
        );
      } finally {
        active = false;
      }
      return receipt as NativePrivateReceipt;
    },
    renameNew(
      source: string,
      destination: string,
      expected: NativePrivateFile,
      maxBytes: number,
    ): NativePrivateReceipt {
      ensureFree();
      const { path: dest, parent, expectedDirectory } = baseRequest(destination);
      const src = baseRequest(source);
      if (same(src.path, dest))
        throw new NativePrivatePersistenceError("REJECTED", "PATH");
      const want = expectedFile(expected, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      const maximum = boundedSize(maxBytes, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      if (!same(want.path, src.path))
        throw new NativePrivatePersistenceError("REJECTED", "IDENTITY");
      if (options.beforeRelocation) syncVoid(() => options.beforeRelocation!(want, dest, "file"));
      let receipt: NativePrivateReceipt | undefined;
      active = true;
      try {
        mutate(
          "rename-new",
          targetKey(dest, expectedDirectory),
          {
            contractVersion: 4,
            operation: "rename-new",
            path: src.path,
            root,
            ...directoryFields(src.expectedDirectory),
            destination: dest,
            destinationDirectoryFileId: expectedDirectory.fileId,
            destinationDirectoryVolumeId: expectedDirectory.volumeId,
            sourceFileId: want.fileId,
            sourceVolumeId: want.volumeId,
            sourceSha256: want.sha256,
            byteLength: want.bytes,
            maxBytes: maximum,
          },
          new Uint8Array(0),
          dest,
          (r, status) => {
            if (status !== 0) fail("STATUS");
            const proven = fileReceipt(
              r,
              dest,
              parent,
              expectedDirectory,
              maximum,
              want.fileId,
              true,
            );
            if (
              proven.identity.bytes !== want.bytes ||
              proven.identity.sha256 !== want.sha256
            )
              fail("RECEIPT");
            const srcDir = evidence(
              r.sourceDirectory,
              src.parent,
              src.expectedDirectory.fileId,
            );
            if (
              !same(srcDir.volumeId, src.expectedDirectory.volumeId) ||
              srcDir.sid !== pinnedSid
            )
              fail("EVIDENCE");
            if (options.onRelocatedFile) syncVoid(() => options.onRelocatedFile!(want, proven));
            receipt = proven;
          },
        );
      } finally {
        active = false;
      }
      return receipt as NativePrivateReceipt;
    },
    unlinkExact(
      path: string,
      expected: NativePrivateFile,
      maxBytes: number,
    ): void {
      ensureFree();
      const { path: p, expectedDirectory } = baseRequest(path);
      const want = expectedFile(expected, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      const maximum = boundedSize(maxBytes, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      if (!same(want.path, p))
        throw new NativePrivatePersistenceError("REJECTED", "IDENTITY");
      active = true;
      try {
        mutate(
          "unlink-exact",
          targetKey(p, expectedDirectory),
          {
            contractVersion: 4,
            operation: "unlink-exact",
            path: p,
            root,
            ...directoryFields(expectedDirectory),
            fileId: want.fileId,
            volumeId: want.volumeId,
            expectedSha256: want.sha256,
            byteLength: want.bytes,
            maxBytes: maximum,
          },
          new Uint8Array(0),
          p,
          (r, status) => {
            if (status !== 0 || r.unlinked !== true) fail("RECEIPT");
            const proven = fileReceipt(r, p, parentOf(p), expectedDirectory, maximum, want.fileId);
            if (proven.identity.bytes !== want.bytes || proven.identity.sha256 !== want.sha256)
              fail("RECEIPT");
          },
        );
      } finally {
        active = false;
      }
    },
    proveSync(path: string, expected: NativePrivateFile): NativePrivateReceipt {
      ensureFree();
      const { path: p, parent, expectedDirectory } = baseRequest(path);
      const want = expectedFile(expected, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      if (!same(want.path, p))
        throw new NativePrivatePersistenceError("REJECTED", "IDENTITY");
      let receipt: NativePrivateReceipt | undefined;
      active = true;
      try {
        mutate(
          "prove-sync",
          targetKey(p, expectedDirectory),
          {
            contractVersion: 4,
            operation: "prove-sync",
            path: p,
            root,
            ...directoryFields(expectedDirectory),
            fileId: want.fileId,
            volumeId: want.volumeId,
            expectedSha256: want.sha256,
            byteLength: want.bytes,
          },
          new Uint8Array(0),
          p,
          (r, status) => {
            if (status !== 0 || r.contentFlushed !== true) fail("RECEIPT");
            const proven = fileReceipt(
              r,
              p,
              parent,
              expectedDirectory,
              want.bytes,
              want.fileId,
              true,
            );
            if (proven.identity.sha256 !== want.sha256) fail("RECEIPT");
            receipt = proven;
          },
        );
      } finally {
        active = false;
      }
      return receipt as NativePrivateReceipt;
    },
    createDirectory(path: string): NativePrivateIdentity {
      ensureFree();
      const { path: p } = baseRequest(path);
      active = true;
      try {
      checkCurrent();
      let raw: unknown;
      try {
        raw = createDirectoryAdapter(p);
      } catch {
        throw unknownFailure("DIRECTORY");
      }
      if (utilTypes.isPromise(raw) || isThenable(raw))
        throw unknownFailure("DIRECTORY_ASYNC");
      const identity = directoryIdentityOf(raw, expectedRoot.volumeId);
      checkCurrent();
      return Object.freeze({
        path: p,
        fileId: identity.fileId,
        volumeId: identity.volumeId,
      });
      } finally { active = false; }
    },
    inspectTree(path: string): NativePrivateTree {
      ensureFree(true);
      const src = baseRequest(path);
      active = true;
      try {
        const { r, payload } = inspect("inspect-tree", { contractVersion: 4,
          operation: "inspect-tree", path: src.path, root, ...directoryFields(src.expectedDirectory) }, src.path);
        try {
          if (payload.byteLength !== 0) fail("TREE");
          return treeReceipt(r, src.path, src.parent, src.expectedDirectory);
        } catch { throw unknownFailure("TREE_RECEIPT"); }
      } finally { active = false; }
    },
    renameDirectoryNew(source, destination, expected, operationCheck): NativePrivateDirectoryReceipt {
      ensureFree();
      const src = baseRequest(source), dest = baseRequest(destination);
      const f = record(expected, ["path", "fileId", "volumeId", "entries", "bytes", "sha256"]);
      const want: NativePrivateTree = { path: canonical(f.path, root), fileId: text(f.fileId, FILE_ID),
        volumeId: text(f.volumeId, VOLUME_ID), entries: boundedSize(f.entries, 4096),
        bytes: boundedSize(f.bytes, WINDOWS_PRIVATE_COPY_MAX_BYTES), sha256: text(f.sha256, DIGEST) };
      const within = (a: string, b: string) => same(a, b) || asciiCaseFold(a).startsWith(asciiCaseFold(b) + "\\");
      if (!same(want.path, src.path) || want.entries < 1 || within(src.path, dest.path) ||
        within(dest.path, src.path) || !same(want.volumeId, dest.expectedDirectory.volumeId)) fail("TREE");
      if (options.beforeRelocation) syncVoid(() => options.beforeRelocation!(want, dest.path, "directory"));
      let result: NativePrivateDirectoryReceipt | undefined;
      active = true;
      try {
        mutate("rename-directory-new", targetKey(dest.path, dest.expectedDirectory), {
          contractVersion: 4, operation: "rename-directory-new", path: src.path, root,
          ...directoryFields(src.expectedDirectory), destination: dest.path,
          destinationDirectoryFileId: dest.expectedDirectory.fileId,
          destinationDirectoryVolumeId: dest.expectedDirectory.volumeId,
          sourceFileId: want.fileId, sourceVolumeId: want.volumeId, sourceSha256: want.sha256,
          entries: want.entries, byteLength: want.bytes,
        }, new Uint8Array(), dest.path, (r, status, payload) => {
          if (status !== 0 || payload.byteLength !== 0 || r.destination !== dest.path) fail("TREE");
          const tree = treeReceipt(r, dest.path, dest.parent, dest.expectedDirectory, true);
          const sourceDirectory = evidence(r.sourceDirectory, src.parent, src.expectedDirectory.fileId);
          if (!same(sourceDirectory.volumeId, src.expectedDirectory.volumeId) ||
            !same(tree.fileId, want.fileId) || !same(tree.volumeId, want.volumeId) ||
            tree.entries !== want.entries || tree.bytes !== want.bytes || tree.sha256 !== want.sha256) fail("TREE");
          result = Object.freeze({ profile: "WINDOWS_LOCAL_NTFS_DIRECTORY_RENAME_V1", scope: "PROCESS_CRASH", identity: tree });
          if (options.onRelocatedDirectory) syncVoid(() => options.onRelocatedDirectory!(want, result!));
        }, operationCheck);
      } finally { active = false; }
      return result!;
    },
    acquireSqliteLease(path, expected): NativePrivateSqliteLease {
      // An independent held reader is legal inside a rename phase callback:
      // the operation check suspended `active`, so only the read gate applies.
      ensureFree(true);
      checkCurrent();
      const p = canonical(path, root);
      const e = record(expected, ["path", "fileId", "volumeId"], ["bytes", "sha256"]);
      if (e.path !== p) fail("SQLITE_IDENTITY");
      const fileId = text(e.fileId, FILE_ID), volumeId = text(e.volumeId, VOLUME_ID);
      const identity = (): void => {
        const now = filesystem.inspectFileIdentity(p);
        if (!same(now.fileId, fileId) || !same(now.volumeId, volumeId) || now.path !== p) fail("SQLITE_IDENTITY");
      };
      identity();
      let raw: ReturnType<AcquirePrivateAuthorityLease> | undefined;
      try {
        raw = acquireSqliteLease(p);
        if (isThenable(raw)) {
          if (utilTypes.isPromise(raw)) Promise.prototype.then.call(raw, undefined, () => undefined);
          fail("SQLITE_LEASE");
        }
        if (!raw || (process.platform === "win32" ? raw.trust !== "native-owned-helper" :
          raw.trust !== "native-owned-helper" && raw.trust !== "untrusted-test") ||
          isAsyncLike(raw.assertHeld) || isAsyncLike(raw.close)) fail("SQLITE_LEASE");
        syncVoid(() => raw!.assertHeld());
        identity();
        checkCurrent();
      } catch (error) {
        poison();
        if (raw && !isAsyncLike(raw.close)) {
          try { syncVoid(() => raw!.close()); }
          catch (close) { throw new AggregateError([error, close], "private SQLite lease UNKNOWN"); }
        }
        throw error;
      }
      const lease = raw!;
      let closed = false, closing = false;
      const closeFailures: unknown[] = [];
      return Object.freeze({
        assertHeld(): void {
          try {
            ensureFree(true);
            if (closed || closing) fail("SQLITE_LEASE_CLOSED");
            syncVoid(() => lease.assertHeld()); checkCurrent(); identity();
          } catch (error) { poison(); throw error; }
        },
        close(): void {
          // A confirmed close is idempotent; a thrown close poisons but the
          // caller may explicitly retry — only an acknowledged undefined
          // settles `closed`, and poison keeps all future operations dead.
          if (closed) return;
          if (closing) fail("SQLITE_LEASE_REENTRANT");
          closing = true;
          try {
            // Raw close result is checked directly so the first/latest raw
            // cause reaches the AggregateError instead of syncVoid's
            // revalidate envelope.
            const result: unknown = lease.close();
            if (utilTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
            if (result !== undefined || isThenable(result)) fail("SQLITE_LEASE_CLOSE_ACK");
            closed = true;
          } catch (error) {
            poison();
            if (closeFailures.length < 2) closeFailures.push(error);
            else closeFailures[closeFailures.length - 1] = error;
            throw new AggregateError([...closeFailures], "private SQLite lease close UNKNOWN");
          } finally { closing = false; }
        },
      });
    },
    snapshotSqlite(db: DatabaseSync, destination: string): NativePrivateReceipt {
      ensureFree();
      if (db.isTransaction !== false) fail("SQLITE_TRANSACTION");
      const main = db.prepare("PRAGMA database_list").all().find(row => row.name === "main");
      if (typeof main?.file !== "string") fail("SQLITE_SOURCE");
      const original = filesystem.inspectFileIdentity(main.file);
      const intentPath = childOf(root, `.folio-sqlite-intent-${randomUUID()}`);
      // Internal snapshot evidence lives at the pinned ioRoot itself, never
      // inside the output bundle — output-parent placement would contaminate
      // the archived inventory.
      baseRequest(intentPath);
      // VACUUM INTO accepts a pre-existing EMPTY file. CREATE_NEW first gives
      // that file a protected DACL and an immutable native creation intent.
      const empty = filesystem.writeNew(destination, new Uint8Array(), 0).identity;
      filesystem.writeNew(intentPath,
        Buffer.from(JSON.stringify({ version: 1, operation: "VACUUM INTO", source: original, destination: empty })),
        8192);
      const lease = filesystem.acquireSqliteLease!(destination, empty);
      let primary: unknown, result: NativePrivateReceipt | undefined;
      try {
        syncVoid(() => lease.assertHeld());
        const current = filesystem.inspectFileIdentity(destination);
        if (!same(current.fileId, empty.fileId) || !same(current.volumeId, empty.volumeId)) fail("SQLITE_IDENTITY");
        checkCurrent();
        db.prepare("VACUUM INTO ?").run(destination);
        syncVoid(() => lease.assertHeld());
        const after = filesystem.inspectFileIdentity(main.file);
        if (!same(after.fileId, original.fileId) || !same(after.volumeId, original.volumeId)) fail("SQLITE_SOURCE_CHANGED");
      } catch (error) { primary = error; }
      try { syncVoid(() => lease.close()); } catch (error) {
        throw new AggregateError(primary === undefined ? [error] : [primary, error], "private SQLite snapshot UNKNOWN");
      }
      if (primary !== undefined) throw primary;
      const snapshot = filesystem.inspectFile(destination, WINDOWS_PRIVATE_COPY_MAX_BYTES);
      if (!same(snapshot.fileId, empty.fileId) || !same(snapshot.volumeId, empty.volumeId)) fail("SQLITE_IDENTITY");
      result = filesystem.proveSync(destination, snapshot);
      return result!;
    },
  };
  return Object.freeze(filesystem);
}
