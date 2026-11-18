import {canonical as canonicalJson} from "../../collaboration/runtime/canonical";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { types as utilTypes } from "node:util";
import { CollaborationError, type Json } from "../../collaboration/runtime/contract";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";
import { WINDOWS_PROBE_TIMEOUT_MS } from "./private-root";
import {
  WINDOWS_PUBLICATION_MAX_BYTES,
  WINDOWS_PUBLICATION_MAX_WIRE_BYTES,
  type DurablePublicationAuthority,
  type PublicationReservation,
} from "./publication-contract";
import type {
  WindowsRuntimeDirectoryIdentity,
  WindowsRuntimeFileIdentity,
  WindowsRuntimeFsPort,
  WindowsRuntimeRootIdentity,
} from "./runtime-platform";

export const WINDOWS_PRIVATE_IO_V2_MAX_BYTES = WINDOWS_PUBLICATION_MAX_BYTES;
export const WINDOWS_PRIVATE_IO_V2_MAX_READ_BYTES = 256 * 1024 * 1024;
export const WINDOWS_PRIVATE_IO_V2_MAX_READ_WIRE_BYTES = 4 * Math.ceil(WINDOWS_PRIVATE_IO_V2_MAX_READ_BYTES / 3) + 32 * 1024;
export const WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES = WINDOWS_PUBLICATION_MAX_WIRE_BYTES;
export const WINDOWS_PRIVATE_DURABILITY_PROFILE_V1 = "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1";
export type WindowsPrivatePublicationV2Options = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  expectedRoot: WindowsRuntimeRootIdentity;
  authority: DurablePublicationAuthority;
}>;
export type WindowsPrivatePublishV2Request = Readonly<{
  path: string;
  stagingPath: string;
  attemptId: string;
  bytes: Uint8Array;
  expectedDirectory: WindowsRuntimeDirectoryIdentity;
  beforePublish: (readback: Uint8Array) => void;
}>;
export type WindowsPrivateReadV2Request = Readonly<{
  path: string;
  expectedDirectory: WindowsRuntimeDirectoryIdentity;
  expectedFile: WindowsRuntimeFileIdentity;
  expectedSha256?: string;
  maxBytes: number;
}>;
export type WindowsPrivateIoV2Failure = Readonly<{
  contractVersion: 2;
  state: "UNKNOWN" | "REJECTED" | "EXISTS";
  path: string;
  stagingPath?: string;
  attemptId?: string;
  reason: string;
  preserve: true;
}>;
export type WindowsPrivatePublishV2Receipt = Readonly<{
  contractVersion: 2;
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
export type WindowsPrivateReadV2Receipt = Readonly<{
  contractVersion: 2;
  state: "READ";
  identity: WindowsRuntimeFileIdentity;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
}>;
export type WindowsPrivatePublicationV2Port = Readonly<{
  trust: "native-helper" | "untrusted-test";
  publishNew(request: WindowsPrivatePublishV2Request): WindowsPrivatePublishV2Receipt | WindowsPrivateIoV2Failure;
  readPrivate(request: WindowsPrivateReadV2Request): WindowsPrivateReadV2Receipt | WindowsPrivateIoV2Failure;
}>;
export type WindowsPrivateIoV2ExecRequest = Readonly<{
  executable: string;
  args: readonly ["--private-io-v2"];
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
export type WindowsPrivateIoV2ExecResult = Readonly<{
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  captureEncoding?: "latin1";
}>;
export type WindowsPrivateIoV2TestPort = Readonly<{
  fs: Pick<WindowsRuntimeFsPort, "lstat" | "readFile">;
  exec(request: WindowsPrivateIoV2ExecRequest): WindowsPrivateIoV2ExecResult;
}>;

const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const ATTEMPT = /^[0-9a-f]{32}$/;
const SID = /^S-1-[0-9]+(?:-[0-9]+)+$/;
function fail(code: string): never { throw new CollaborationError(`WINDOWS_PRIVATE_IO_V2_${code}`); }
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: string, b: string): boolean => asciiCaseFold(a) === asciiCaseFold(b);

// An authority object whose reservation or recording acknowledgement was ever
// uncertain is poisoned for every factory that shares it, not just the one
// that observed the failure. Consumed attempts/targets and durable
// fail-closed recovery across restarts remain the authority's own duty.
const failedAuthorities = new WeakSet<object>();

// All boundary records are data-only, including non-enumerable/symbol keys.
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
function directoryIdentity(value: unknown, volume: string): WindowsRuntimeDirectoryIdentity {
  const r = record(value, ["fileId", "volumeId"]);
  const fileId = text(r.fileId, FILE_ID), volumeId = text(r.volumeId, VOLUME_ID);
  if (!same(volumeId, volume)) fail("IDENTITY");
  return Object.freeze({ fileId, volumeId });
}
function boundedSize(value: unknown, maximum = WINDOWS_PRIVATE_IO_V2_MAX_BYTES): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) fail("SIZE");
  return value;
}
function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try { return typeof (value as { then?: unknown }).then === "function"; }
  catch { return true; } // A throwing .then accessor is also not a synchronous value.
}
function isAsyncLike(value: unknown): boolean {
  return typeof value !== "function" || utilTypes.isAsyncFunction(value) || utilTypes.isGeneratorFunction(value);
}

// Small object/scalar-only JSON reader. JSON.parse alone silently accepts
// duplicate keys, including escaped spellings; this reader rejects both.
// Protocol v2 contains no arrays. A depth bound also rejects nesting attacks.
function parseResponse(source: string, maximum = WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES): unknown {
  if (Buffer.byteLength(source, "utf8") > maximum || /[^\x09\x0a\x0d\x20-\x7e]/.test(source)) fail("OUTPUT");
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
  return result;
}

type Pin = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number }>;
function pinExecutable(fs: WindowsPrivateIoV2TestPort["fs"], path: string, hash: string): Pin {
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
function samePin(a: Pin, b: Pin): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

const nativePort: WindowsPrivateIoV2TestPort = {
  fs: { lstat: lstatSync, readFile: readFileSync },
  exec(request) {
    const result = spawnSync(request.executable, [...request.args], {
      cwd: request.cwd, env: request.env, input: request.input,
      timeout: request.timeoutMs, maxBuffer: request.maxBuffer,
      shell: false, windowsHide: true, stdio: "pipe", encoding: "buffer",
    });
    // Never forward output/error objects, or their messages, to diagnostics.
    return {
      status: result.status, signal: result.signal,
      // A latin1 string is a reversible mapping of every captured byte.
      // Protocol parsing separately requires ASCII; invalid UTF8 is never repaired.
      stdout: result.stdout?.toString("latin1") ?? "", stderr: result.stderr?.toString("latin1") ?? "", captureEncoding: "latin1",
      ...(result.error ? { errorCode: "EXEC_FAILED" } : {}),
    };
  },
};

/** Two-phase publication with a separate durable authority. The authority is
 * the only persistence across reconstruction; the local latches below are
 * reentrancy defense, never substitutes for it. An UNKNOWN never authorizes
 * retry, overwrite, cleanup or implicit reopening. The helper path/hash must
 * come from a trusted installation, not request data. */
export function createWindowsPrivatePublicationV2(options: WindowsPrivatePublicationV2Options): WindowsPrivatePublicationV2Port {
  if (arguments.length !== 1) fail("OPTIONS");
  if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  return create(options, nativePort, "native-helper");
}
/** Non-Windows contract-only fake ports, never native Windows proof. */
export function createWindowsPrivatePublicationV2ForTesting(
  options: WindowsPrivatePublicationV2Options, port: WindowsPrivateIoV2TestPort,
): WindowsPrivatePublicationV2Port {
  if (process.platform === "win32") fail("TEST_PORT_FORBIDDEN");
  return create(options, port, "untrusted-test");
}

// The authority may be a class instance, so its shape is checked by binding
// the four contract methods rather than requiring a data-only record. Every
// method must be a synchronous non-generator function; its specified return
// is void and any other acknowledgement (including a Promise) is poison.
function bindAuthority(candidate: unknown): DurablePublicationAuthority {
  if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) fail("AUTHORITY");
  const bound: Record<string, unknown> = {};
  for (const name of ["reserve", "recordDispatch", "recordPrepared", "recordTerminal"] as const) {
    const method = (candidate as Record<string, unknown>)[name];
    if (isAsyncLike(method)) fail("AUTHORITY");
    bound[name] = (method as (...args: unknown[]) => void).bind(candidate);
  }
  return bound as unknown as DurablePublicationAuthority;
}

function create(options: WindowsPrivatePublicationV2Options, port: WindowsPrivateIoV2TestPort, trust: WindowsPrivatePublicationV2Port["trust"]): WindowsPrivatePublicationV2Port {
  let root: string, executable: string, systemRoot: string, expectedHash: string;
  let expectedRoot: WindowsRuntimeRootIdentity;
  let initialPin: Pin;
  let fs: WindowsPrivateIoV2TestPort["fs"], exec: WindowsPrivateIoV2TestPort["exec"];
  let authority: DurablePublicationAuthority, authorityObject: object;
  try {
    const o = record(options, ["root", "probeExecutable", "expectedHash", "systemRoot", "expectedRoot", "authority"]);
    root = canonical(o.root); executable = canonical(o.probeExecutable); systemRoot = canonical(o.systemRoot);
    if (!/\.exe$/i.test(executable)) fail("OPTIONS");
    expectedHash = text(o.expectedHash, HASH);
    const r = record(o.expectedRoot, ["rootFileId", "volumeId"]);
    expectedRoot = Object.freeze({ rootFileId: text(r.rootFileId, FILE_ID), volumeId: text(r.volumeId, VOLUME_ID) });
    authority = bindAuthority(o.authority);
    authorityObject = o.authority as object;
    const p = record(port, ["fs", "exec"]);
    const f = record(p.fs, ["lstat", "readFile"]);
    if (typeof f.lstat !== "function" || typeof f.readFile !== "function" || typeof p.exec !== "function") fail("OPTIONS");
    fs = { lstat: port.fs.lstat.bind(port.fs), readFile: port.fs.readFile.bind(port.fs) };
    exec = port.exec.bind(port);
    initialPin = pinExecutable(fs, executable, expectedHash);
  } catch { return fail("OPTIONS_OR_HELPER_UNTRUSTED"); }

  const attempts = new Set<string>(), targets = new Set<string>();
  // Known final identities by case-folded path. expectedFile is mandatory for
  // reads; replacing an already-pinned identity is rejected before any I/O.
  const knownFiles = new Map<string, { fileId: string; volumeId: string }>();
  let pinnedSid: string | undefined;
  let authorityFailed = false;
  let active = false;
  const poisoned = (): boolean => authorityFailed || failedAuthorities.has(authorityObject);
  const poison = (): void => { authorityFailed = true; failedAuthorities.add(authorityObject); };
  const assertPin = (): void => {
    if (!samePin(initialPin, pinExecutable(fs, executable, expectedHash))) fail("HELPER_CHANGED");
  };
  const baseRequest = (pathValue: unknown, directoryValue: unknown) => {
    const path = canonical(pathValue, root), parent = parentOf(path);
    if (same(path, root)) fail("PATH");
    const expectedDirectory = directoryIdentity(directoryValue, expectedRoot.volumeId);
    if (same(parent, root) && !same(expectedDirectory.fileId, expectedRoot.rootFileId)) fail("IDENTITY");
    return { path, parent, expectedDirectory };
  };
  // An authority call is only valid when it returns undefined synchronously.
  const ack = (call: () => unknown): boolean => {
    if (poisoned()) return false;
    try {
      const result = call();
      if (utilTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
      return result === undefined && !poisoned();
    } catch { return false; }
  };
  const terminal = (attemptId: string, outcome: "PUBLISHED" | "UNKNOWN" | "REJECTED", evidence: Json): boolean => {
    if (ack(() => authority.recordTerminal(attemptId, outcome, evidence))) return true;
    // After a failed recording the authority can no longer be trusted; never
    // attempt another terminal record on it.
    poison();
    return false;
  };
  let lastCapture: Json = null;
  // Preserve the actual pipe reply privately before parsing or post-call proof.
  // Descriptors avoid executing accessors on an untrusted executor result.
  const capture = (raw: unknown): Json => {
    const out: Record<string, Json> = {};
    if (raw === null || typeof raw !== "object") return { malformedExecutor: true };
    for (const key of ["status", "signal", "stdout", "stderr", "errorCode", "captureEncoding"]) {
      const d = Object.getOwnPropertyDescriptor(raw, key);
      if (!d) continue;
      if (!("value" in d)) { out[key] = { accessor: true }; continue; }
      const v: unknown = d.value;
      out[key] = v === null || typeof v === "string" || typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v)) ? v as Json : { invalidType: typeof v };
    }
    return out;
  };
  type ExecOutcome = Readonly<{ ok: true; status: number; response: Record<string, unknown> }>
    | Readonly<{ ok: false; evidence: Json }>;
  const invoke = (input: Uint8Array, outputLimit = WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES): ExecOutcome => {
    if (poisoned()) return {ok: false, evidence: {authorityPoisoned: true}};
    let raw: WindowsPrivateIoV2ExecResult | undefined;
    lastCapture = null;
    try {
      assertPin();
      if (poisoned()) fail("AUTHORITY");
      raw = exec(Object.freeze({
        executable, args: Object.freeze(["--private-io-v2"] as const), cwd: systemRoot,
        env: Object.freeze({ SystemRoot: systemRoot, windir: systemRoot, TEMP: childOf(systemRoot, "Temp"), TMP: childOf(systemRoot, "Temp") }),
        input, timeoutMs: WINDOWS_PROBE_TIMEOUT_MS, maxBuffer: outputLimit,
        shell: false, windowsHide: true, stdio: "pipe", encoding: "buffer",
      }));
      lastCapture = capture(raw);
    } catch { return {ok: false, evidence: {exec: "threw"}}; }
    try { assertPin(); } catch { return {ok: false, evidence: {helperChanged: true}}; }
    let result: Record<string, unknown>;
    try { result = record(raw, ["status", "signal", "stdout", "stderr"], ["errorCode", "captureEncoding"]); }
    catch { return {ok: false, evidence: {malformed: true}}; }
    if (("captureEncoding" in result && result.captureEncoding !== "latin1") || result.signal !== null || result.stderr !== "" || "errorCode" in result ||
        !Number.isInteger(result.status) || typeof result.stdout !== "string")
      return {ok: false, evidence: {malformed: true}};
    let response: unknown;
    try { response = parseResponse(result.stdout, outputLimit); } catch { response = undefined; }
    if (typeof response !== "object" || response === null || Array.isArray(response))
      return {ok: false, evidence: {malformed: true}};
    return {ok: true, status: result.status as number, response: response as Record<string, unknown>};
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
    if (r.contractVersion !== 2 || r.operation !== operation || r.path !== path || r.root !== root) fail("ENVELOPE");
  };
  const replyEvidence = (phase: string, status: number, r: Record<string, unknown>): Json => {
    // Raw stdout is the immutable original. Avoid duplicating its large base64
    // body in the parsed summary; length/hash and all native proofs remain.
    const {bytesBase64: _bytes, ...summary} = r;
    let bounded: unknown = summary;
    try {canonicalJson(summary, 32 * 1024);} catch {bounded = {parsedSummaryOmitted: true};}
    return {phase, status, reply: bounded, captured: lastCapture} as unknown as Json;
  };
  const reject = (path: string): WindowsPrivateIoV2Failure =>
    Object.freeze({ contractVersion: 2, state: "REJECTED", path, reason: "PRIVATE_IO_V2_REJECTED", preserve: true });
  const unknown = (path: string, publish?: { attemptId: string; stagingPath: string }): WindowsPrivateIoV2Failure =>
    Object.freeze({ contractVersion: 2, state: "UNKNOWN", path, ...publish, reason: "PRIVATE_IO_V2_UNCONFIRMED", preserve: true });
  const failure = (r: Record<string, unknown>, status: number | null, path: string, publish?: { attemptId: string; stagingPath: string }): WindowsPrivateIoV2Failure => {
    record(r, [...baseKeys, ...(publish ? ["attemptId", "stagingPath"] : []), "reason"]);
    const state = r.state;
    if (!((state === "REJECTED" && status === 1 && r.reason === "PRIVATE_IO_V2_REJECTED") ||
          (state === "UNKNOWN" && status === 3 && r.reason === "PRIVATE_IO_V2_UNKNOWN") ||
          (publish && state === "EXISTS" && status === 2 && r.reason === "PRIVATE_IO_V2_EXISTS"))) fail("FAILURE");
    return Object.freeze({ contractVersion: 2, state: state as WindowsPrivateIoV2Failure["state"], path, ...publish, reason: r.reason as string, preserve: true });
  };
  const requestPath = (request: unknown): string => {
    try {
      if (typeof request !== "object" || request === null) return "";
      const descriptor = Object.getOwnPropertyDescriptor(request, "path");
      return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : "";
    } catch { return ""; }
  };

  return Object.freeze({
    trust,
    publishNew(request: WindowsPrivatePublishV2Request): WindowsPrivatePublishV2Receipt | WindowsPrivateIoV2Failure {
      const pathEcho = requestPath(request);
      // A reentrant call (authority, executor or callback) is refused before
      // it can reach any durable record or the native helper.
      if (active || poisoned()) return reject(pathEcho);
      let path: string, parent: string, expectedDirectory: WindowsRuntimeDirectoryIdentity;
      let attemptId: string, stagingPath: string, input: Uint8Array, wire: string;
      let sha256: string, byteLength: number, callback: (readback: Uint8Array) => void;
      try {
        const r = record(request, ["path", "stagingPath", "attemptId", "bytes", "expectedDirectory", "beforePublish"]);
        ({ path, parent, expectedDirectory } = baseRequest(r.path, r.expectedDirectory));
        stagingPath = canonical(r.stagingPath, root);
        if (!same(parentOf(stagingPath), parent) || same(stagingPath, path)) fail("PATH");
        attemptId = text(r.attemptId, ATTEMPT);
        if (isAsyncLike(r.beforePublish)) fail("CALLBACK");
        callback = r.beforePublish as (readback: Uint8Array) => void;
        if (!(r.bytes instanceof Uint8Array)) fail("BYTES");
        byteLength = boundedSize(r.bytes.byteLength);
        const bytes = Buffer.from(r.bytes);
        sha256 = digest(bytes);
        // The complete prepare wire is built and bounded BEFORE reservation.
        wire = JSON.stringify({
          contractVersion: 2, operation: "prepare", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
          attemptId, stagingPath, bytesBase64: bytes.toString("base64"),
        });
        input = Buffer.from(wire, "utf8");
        if (input.byteLength > WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES) fail("WIRE_SIZE");
        if (attempts.has(attemptId) || targets.has(asciiCaseFold(path))) fail("CONSUMED");
        assertPin();
      } catch { return reject(pathEcho); }
      const metadata = { attemptId, stagingPath };
      active = true;
      // Consume both BEFORE any authority or native call. No retry.
      attempts.add(attemptId); targets.add(asciiCaseFold(path));
      try {
        const reservation: PublicationReservation = Object.freeze({
          contractVersion: 2, attemptId, path, stagingPath,
          root: Object.freeze({ canonicalPath: root, fileId: expectedRoot.rootFileId, volumeId: expectedRoot.volumeId }),
          directory: Object.freeze({ canonicalPath: parent, fileId: expectedDirectory.fileId, volumeId: expectedDirectory.volumeId }),
          byteLength, sha256,
        });
        if (!ack(() => authority.reserve(reservation))) { poison(); return unknown(path, metadata); }
        if (!ack(() => authority.recordDispatch(attemptId, "prepare", wire))) { poison(); return unknown(path, metadata); }

        const dispatched = invoke(input);
        if (!dispatched.ok) {
          terminal(attemptId, "UNKNOWN", Object.freeze({ phase: "prepare", reply: dispatched.evidence, captured: lastCapture }) as Json);
          return unknown(path, metadata);
        }
        const r = dispatched.response, status = dispatched.status;
        try {
          checkEnvelope(r, "prepare", path);
          if (r.attemptId !== attemptId || r.stagingPath !== stagingPath) fail("ENVELOPE");
        } catch {
          terminal(attemptId, "UNKNOWN", replyEvidence("prepare", status, r));
          return unknown(path, metadata);
        }
        if (r.state !== "PREPARED") {
          let typed: WindowsPrivateIoV2Failure;
          try { typed = failure(r, status, path, metadata); }
          catch {
            terminal(attemptId, "UNKNOWN", replyEvidence("prepare", status, r));
            return unknown(path, metadata);
          }
          if (!terminal(attemptId, typed.state === "UNKNOWN" ? "UNKNOWN" : "REJECTED", replyEvidence("prepare", status, r))) {
            return unknown(path, metadata);
          }
          return typed;
        }
        let stageFileId: string, stageVolumeId: string, preparedReadback: Buffer;
        try {
          record(r, [...baseKeys, "attemptId", "stagingPath", "file", "directory", "byteLength", "sha256", "bytesBase64", "contentFlushed", "filesystem"]);
          const length = boundedSize(r.byteLength);
          if (status !== 0 || length !== byteLength || r.sha256 !== sha256 || r.contentFlushed !== true ||
              r.filesystem !== "NTFS" || typeof r.bytesBase64 !== "string" ||
              r.bytesBase64.length !== 4 * Math.ceil(length / 3)) fail("RECEIPT");
          preparedReadback = Buffer.from(r.bytesBase64, "base64");
          if (preparedReadback.toString("base64") !== r.bytesBase64 || preparedReadback.byteLength !== length ||
              digest(preparedReadback) !== sha256) fail("RECEIPT");
          const proof = proofs(r, stagingPath, parent, expectedDirectory);
          stageFileId = proof.file.fileId; stageVolumeId = proof.file.volumeId;
          pinnedSid = proof.file.sid;
        } catch {
          terminal(attemptId, "UNKNOWN", replyEvidence("prepare", status, r));
          return unknown(path, metadata);
        }
        if (!ack(() => authority.recordPrepared(attemptId, replyEvidence("prepare", status, r)))) {
          poison(); return unknown(path, metadata);
        }

        // The original callback runs exactly once on a copy of the ACTUAL
        // staged readback, so callback mutation cannot alter the verified
        // pins. A throw or any thenable is UNKNOWN: no commit is dispatched.
        try {
          const approval = callback(new Uint8Array(preparedReadback));
          if (utilTypes.isPromise(approval)) Promise.prototype.then.call(approval, undefined, () => undefined);
          if (approval !== undefined || isThenable(approval)) fail("CALLBACK_ASYNC");
        } catch {
          if (!poisoned()) terminal(attemptId, "UNKNOWN", replyEvidence("callback", status, r));
          return unknown(path, metadata);
        }

        const commitWire = JSON.stringify({
          contractVersion: 2, operation: "commit-prepared", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
          attemptId, stagingPath, fileId: stageFileId, volumeId: stageVolumeId,
          expectedSha256: sha256, byteLength,
        });
        const commitInput = Buffer.from(commitWire, "utf8");
        if (commitInput.byteLength > WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES) {
          terminal(attemptId, "UNKNOWN", Object.freeze({ phase: "commit-prepared", malformed: true }) as Json);
          return unknown(path, metadata);
        }
        if (!ack(() => authority.recordDispatch(attemptId, "commit-prepared", commitWire))) {
          poison(); return unknown(path, metadata);
        }
        const committed = invoke(commitInput);
        if (!committed.ok) {
          terminal(attemptId, "UNKNOWN", Object.freeze({ phase: "commit-prepared", reply: committed.evidence, captured: lastCapture }) as Json);
          return unknown(path, metadata);
        }
        const c = committed.response, commitStatus = committed.status;
        try {
          checkEnvelope(c, "commit-prepared", path);
          if (c.attemptId !== attemptId || c.stagingPath !== stagingPath) fail("ENVELOPE");
        } catch {
          terminal(attemptId, "UNKNOWN", replyEvidence("commit-prepared", commitStatus, c));
          return unknown(path, metadata);
        }
        if (c.state !== "PUBLISHED") {
          let typed: WindowsPrivateIoV2Failure;
          try { typed = failure(c, commitStatus, path, metadata); }
          catch {
            terminal(attemptId, "UNKNOWN", replyEvidence("commit-prepared", commitStatus, c));
            return unknown(path, metadata);
          }
          if (!terminal(attemptId, typed.state === "UNKNOWN" ? "UNKNOWN" : "REJECTED", replyEvidence("commit-prepared", commitStatus, c))) {
            return unknown(path, metadata);
          }
          return typed;
        }
        let finalReadback: Buffer, identity: WindowsRuntimeFileIdentity;
        try {
          record(c, [...baseKeys, "attemptId", "stagingPath", "file", "directory", "byteLength", "sha256",
            "bytesBase64", "contentFlushed", "filesystem", "stagingDisposition", "namespace", "durability"]);
          const length = boundedSize(c.byteLength);
          const durability = record(c.durability, ["profile", "scope"]);
          if (commitStatus !== 0 || length !== byteLength || c.sha256 !== sha256 || c.contentFlushed !== true ||
              c.filesystem !== "NTFS" || c.stagingDisposition !== "RENAMED_TO_FINAL" ||
              c.namespace !== "EXCLUSIVE_NO_REPLACE" ||
              durability.profile !== WINDOWS_PRIVATE_DURABILITY_PROFILE_V1 || durability.scope !== "PROCESS_CRASH" ||
              typeof c.bytesBase64 !== "string" || c.bytesBase64.length !== 4 * Math.ceil(length / 3)) fail("RECEIPT");
          finalReadback = Buffer.from(c.bytesBase64, "base64");
          if (finalReadback.toString("base64") !== c.bytesBase64 || finalReadback.byteLength !== length ||
              digest(finalReadback) !== sha256) fail("RECEIPT");
          const proof = proofs(c, path, parent, expectedDirectory, stageFileId);
          if (!same(proof.file.volumeId, stageVolumeId)) fail("IDENTITY");
          identity = proof.identity;
          pinnedSid = proof.file.sid;
        } catch {
          terminal(attemptId, "UNKNOWN", replyEvidence("commit-prepared", commitStatus, c));
          return unknown(path, metadata);
        }
        if (!terminal(attemptId, "PUBLISHED", replyEvidence("commit-prepared", commitStatus, c))) {
          return unknown(path, metadata);
        }
        knownFiles.set(asciiCaseFold(path), { fileId: identity.fileId, volumeId: identity.volumeId });
        return Object.freeze({
          contractVersion: 2, state: "PUBLISHED", path, ...metadata, identity,
          byteLength, sha256, readback: new Uint8Array(finalReadback),
          stagingDisposition: "RENAMED_TO_FINAL", contentFlushed: true,
          namespace: "EXCLUSIVE_NO_REPLACE",
          durability: Object.freeze({ profile: WINDOWS_PRIVATE_DURABILITY_PROFILE_V1, scope: "PROCESS_CRASH" }),
        }) as WindowsPrivatePublishV2Receipt;
      } catch {
        // An unexpected break (for example a helper pin change mid-sequence)
        // is always UNKNOWN; the stage is retained, never cleaned or replayed.
        if (!poisoned()) terminal(attemptId, "UNKNOWN", Object.freeze({ phase: "dispatch", malformed: true, captured: lastCapture }) as unknown as Json);
        return unknown(path, metadata);
      } finally { active = false; }
    },
    readPrivate(request: WindowsPrivateReadV2Request): WindowsPrivateReadV2Receipt | WindowsPrivateIoV2Failure {
      const pathEcho = requestPath(request);
      // A poisoned authority blocks every later native dispatch, reads included.
      if (active || poisoned()) return reject(pathEcho);
      let path: string, parent: string, expectedDirectory: WindowsRuntimeDirectoryIdentity;
      let fileId: string, maxBytes: number, input: Uint8Array;
      let expectedSha256: string | undefined;
      try {
        const r = record(request, ["path", "expectedDirectory", "expectedFile", "maxBytes"], ["expectedSha256"]);
        ({ path, parent, expectedDirectory } = baseRequest(r.path, r.expectedDirectory));
        const f = record(r.expectedFile, ["canonicalPath", "fileId", "volumeId"]);
        if (!same(canonical(f.canonicalPath, root), path)) fail("IDENTITY");
        fileId = text(f.fileId, FILE_ID);
        const volumeId = text(f.volumeId, VOLUME_ID);
        if (!same(volumeId, expectedRoot.volumeId)) fail("IDENTITY");
        if ("expectedSha256" in r) expectedSha256 = text(r.expectedSha256, HASH);
        maxBytes = boundedSize(r.maxBytes, WINDOWS_PRIVATE_IO_V2_MAX_READ_BYTES);
        const pinned = knownFiles.get(asciiCaseFold(path));
        if (pinned !== undefined && (!same(pinned.fileId, fileId) || !same(pinned.volumeId, volumeId))) fail("IDENTITY");
        input = Buffer.from(JSON.stringify({
          contractVersion: 2, operation: "read-private", path, root,
          rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId, directoryVolumeId: expectedDirectory.volumeId,
          fileId, volumeId, maxBytes,
          ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
        }), "utf8");
        if (input.byteLength > WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES) fail("WIRE_SIZE");
        assertPin();
      } catch { return reject(pathEcho); }
      active = true;
      try {
        const outcome = invoke(input, Math.max(WINDOWS_PRIVATE_IO_V2_MAX_WIRE_BYTES, 4 * Math.ceil(maxBytes / 3) + 32 * 1024));
        if (!outcome.ok) return unknown(path);
        const r = outcome.response, status = outcome.status;
        try { checkEnvelope(r, "read-private", path); } catch { return unknown(path); }
        if (r.state !== "READ") {
          try { return failure(r, status, path); } catch { return unknown(path); }
        }
        try {
          record(r, [...baseKeys, "file", "directory", "byteLength", "sha256", "bytesBase64", "filesystem"]);
          const length = boundedSize(r.byteLength, WINDOWS_PRIVATE_IO_V2_MAX_READ_BYTES);
          const sha = text(r.sha256, HASH);
          if (status !== 0 || length > maxBytes || r.filesystem !== "NTFS" ||
              typeof r.bytesBase64 !== "string" || r.bytesBase64.length !== 4 * Math.ceil(length / 3)) fail("READ_RECEIPT");
          const bytes = Buffer.from(r.bytesBase64, "base64");
          // Digest and length are always recomputed, even when the caller did
          // not pin an expected hash.
          if (bytes.toString("base64") !== r.bytesBase64 || bytes.byteLength !== length || digest(bytes) !== sha) fail("READ_RECEIPT");
          if (expectedSha256 !== undefined && sha !== expectedSha256) fail("READ_RECEIPT");
          const proof = proofs(r, path, parent, expectedDirectory, fileId);
          pinnedSid = proof.file.sid;
          knownFiles.set(asciiCaseFold(path), {fileId: proof.identity.fileId, volumeId: proof.identity.volumeId});
          return Object.freeze({
            contractVersion: 2, state: "READ", identity: proof.identity,
            bytes: new Uint8Array(bytes), byteLength: length, sha256: sha,
          }) as WindowsPrivateReadV2Receipt;
        } catch { return unknown(path); }
      } catch { return unknown(path); }
      finally { active = false; }
    },
  });
}
