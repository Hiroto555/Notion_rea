import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
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
  WindowsRuntimeFileIdentity,
  WindowsRuntimeFsPort,
  WindowsRuntimeRootIdentity,
} from "./runtime-platform";

export const WINDOWS_PRIVATE_IO_MAX_BYTES = 1_048_576;
export const WINDOWS_PRIVATE_IO_MAX_STDIN_BYTES = 1_500_000;
export const WINDOWS_PRIVATE_IO_MAX_OUTPUT_BYTES = 1_500_000;
export type WindowsPrivatePublicationOptions = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  expectedRoot: WindowsRuntimeRootIdentity;
}>;
export type WindowsPrivatePublishRequest = Readonly<{
  path: string;
  attemptId: string;
  bytes: Uint8Array;
  expectedDirectory: WindowsRuntimeDirectoryIdentity;
}>;
export type WindowsPrivateReadRequest = Readonly<{
  path: string;
  expectedDirectory: WindowsRuntimeDirectoryIdentity;
  expectedFile: WindowsRuntimeFileIdentity;
  expectedSha256: string;
  maxBytes: number;
}>;
export type WindowsPrivateIoFailure = Readonly<{
  state: "UNKNOWN" | "REJECTED" | "EXISTS";
  path: string;
  stagingPath?: string;
  attemptId?: string;
  reason: string;
  preserve: true;
}>;
export type WindowsPrivatePublishReceipt = Readonly<{
  state: "PUBLISHED";
  path: string;
  stagingPath: string;
  attemptId: string;
  identity: WindowsRuntimeFileIdentity;
  byteLength: number;
  sha256: string;
  contentFlushed: true;
  namespace: "EXCLUSIVE_NO_REPLACE";
  namespaceDurability: "UNPROVEN";
}>;
export type WindowsPrivateReadReceipt = Readonly<{
  state: "READ";
  identity: WindowsRuntimeFileIdentity;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
}>;
export type WindowsPrivatePublicationPort = Readonly<{
  trust: "native-helper" | "untrusted-test";
  publishNew(request: WindowsPrivatePublishRequest): WindowsPrivatePublishReceipt | WindowsPrivateIoFailure;
  readPrivate(request: WindowsPrivateReadRequest): WindowsPrivateReadReceipt | WindowsPrivateIoFailure;
}>;
export type WindowsPrivateIoExecRequest = Readonly<{
  executable: string;
  args: readonly ["--private-io-v1"];
  cwd: string;
  env: Readonly<{ SystemRoot: string; windir: string; TEMP: string; TMP: string }>;
  input: Uint8Array;
  timeoutMs: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  stdio: "pipe";
  encoding: "utf8";
}>;
export type WindowsPrivateIoExecResult = Readonly<{
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}>;
export type WindowsPrivateIoTestPort = Readonly<{
  fs: Pick<WindowsRuntimeFsPort, "lstat" | "readFile">;
  exec(request: WindowsPrivateIoExecRequest): WindowsPrivateIoExecResult;
}>;

const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const ATTEMPT = /^[0-9a-f]{32}$/;
function fail(code: string): never { throw new CollaborationError(`WINDOWS_PRIVATE_IO_${code}`); }
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: string, b: string): boolean => asciiCaseFold(a) === asciiCaseFold(b);

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
function boundedSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > WINDOWS_PRIVATE_IO_MAX_BYTES) fail("SIZE");
  return value;
}

// Small object/scalar-only JSON reader. JSON.parse alone silently accepts
// duplicate keys, including escaped spellings; this reader rejects both.
// Protocol v1 contains no arrays. A depth bound also rejects nesting attacks.
function parseResponse(source: string): unknown {
  if (Buffer.byteLength(source, "utf8") > WINDOWS_PRIVATE_IO_MAX_OUTPUT_BYTES || /[^\x09\x0a\x0d\x20-\x7e]/.test(source)) fail("OUTPUT");
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
function pinExecutable(fs: WindowsPrivateIoTestPort["fs"], path: string, hash: string): Pin {
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

const nativePort: WindowsPrivateIoTestPort = {
  fs: { lstat: lstatSync, readFile: readFileSync },
  exec(request) {
    const result = spawnSync(request.executable, [...request.args], {
      cwd: request.cwd, env: request.env, input: request.input,
      timeout: request.timeoutMs, maxBuffer: request.maxBuffer,
      shell: false, windowsHide: true, stdio: "pipe", encoding: "utf8",
    });
    // Never forward output/error objects, or their messages, to diagnostics.
    return {
      status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr,
      ...(result.error ? { errorCode: "EXEC_FAILED" } : {}),
    };
  },
};

/** Native exclusive visibility, NOT a crash-durable namespace/writer receipt.
 * The caller must persist consumed attempts AND targets across reconstruction.
 * An UNKNOWN never authorizes retry, overwrite, cleanup or implicit reopening.
 * The helper path/hash must come from a trusted installation, not request data.
 */
export function createWindowsPrivatePublication(options: WindowsPrivatePublicationOptions): WindowsPrivatePublicationPort {
  if (arguments.length !== 1) fail("OPTIONS");
  if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  return create(options, nativePort, "native-helper");
}
/** Non-Windows contract-only fake ports, never native Windows proof. */
export function createWindowsPrivatePublicationForTesting(
  options: WindowsPrivatePublicationOptions, port: WindowsPrivateIoTestPort,
): WindowsPrivatePublicationPort {
  if (process.platform === "win32") fail("TEST_PORT_FORBIDDEN");
  return create(options, port, "untrusted-test");
}

function create(options: WindowsPrivatePublicationOptions, port: WindowsPrivateIoTestPort, trust: WindowsPrivatePublicationPort["trust"]): WindowsPrivatePublicationPort {
  let root: string, executable: string, systemRoot: string, expectedHash: string;
  let expectedRoot: WindowsRuntimeRootIdentity;
  let initialPin: Pin;
  let fs: WindowsPrivateIoTestPort["fs"], exec: WindowsPrivateIoTestPort["exec"];
  try {
    const o = record(options, ["root", "probeExecutable", "expectedHash", "systemRoot", "expectedRoot"]);
    root = canonical(o.root); executable = canonical(o.probeExecutable); systemRoot = canonical(o.systemRoot);
    if (!/\.exe$/i.test(executable)) fail("OPTIONS");
    expectedHash = text(o.expectedHash, HASH);
    const r = record(o.expectedRoot, ["rootFileId", "volumeId"]);
    expectedRoot = Object.freeze({ rootFileId: text(r.rootFileId, FILE_ID), volumeId: text(r.volumeId, VOLUME_ID) });
    const p = record(port, ["fs", "exec"]);
    const f = record(p.fs, ["lstat", "readFile"]);
    if (typeof f.lstat !== "function" || typeof f.readFile !== "function" || typeof p.exec !== "function") fail("OPTIONS");
    fs = { lstat: port.fs.lstat.bind(port.fs), readFile: port.fs.readFile.bind(port.fs) };
    exec = port.exec.bind(port);
    initialPin = pinExecutable(fs, executable, expectedHash);
  } catch { return fail("OPTIONS_OR_HELPER_UNTRUSTED"); }

  const attempts = new Set<string>(), targets = new Set<string>();
  let pinnedSid: string | undefined;
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
  const inputFor = (path: string, directory: WindowsRuntimeDirectoryIdentity, extra: object): Uint8Array => {
    const input = Buffer.from(JSON.stringify({
      version: 1, path, root, rootFileId: expectedRoot.rootFileId, rootVolumeId: expectedRoot.volumeId,
      directoryFileId: directory.fileId, directoryVolumeId: directory.volumeId, ...extra,
    }), "utf8");
    if (input.byteLength > WINDOWS_PRIVATE_IO_MAX_STDIN_BYTES) fail("STDIN_SIZE");
    return input;
  };
  const invoke = (input: Uint8Array): { response: Record<string, unknown>; status: number | null } => {
    let raw: WindowsPrivateIoExecResult;
    try {
      raw = exec(Object.freeze({
        executable, args: Object.freeze(["--private-io-v1"] as const), cwd: systemRoot,
        env: Object.freeze({ SystemRoot: systemRoot, windir: systemRoot, TEMP: childOf(systemRoot, "Temp"), TMP: childOf(systemRoot, "Temp") }),
        input, timeoutMs: WINDOWS_PROBE_TIMEOUT_MS, maxBuffer: WINDOWS_PRIVATE_IO_MAX_OUTPUT_BYTES,
        shell: false, windowsHide: true, stdio: "pipe", encoding: "utf8",
      }));
    } finally {
      // Also pin after a throwing executor. No bytes escape before this check.
      assertPin();
    }
    const result = record(raw, ["status", "signal", "stdout", "stderr"], ["errorCode"]);
    if (result.signal !== null || result.stderr !== "" || "errorCode" in result ||
        !Number.isInteger(result.status) || typeof result.stdout !== "string") fail("EXEC");
    const response = parseResponse(result.stdout);
    if (typeof response !== "object" || response === null) fail("OUTPUT");
    return { response: response as Record<string, unknown>, status: result.status as number };
  };
  const evidence = (raw: unknown, path: string, fileId?: string): WindowsProbeEvidence => {
    assertWindowsProbe(raw, { canonicalPath: path, canonicalRoot: root });
    const p = raw as WindowsProbeEvidence;
    canonical(p.canonicalPath, root); canonical(p.canonicalRoot);
    if (!same(p.rootFileId, expectedRoot.rootFileId) || !same(p.rootVolumeId, expectedRoot.volumeId) ||
        !same(p.volumeId, expectedRoot.volumeId) || (fileId !== undefined && !same(p.fileId, fileId)) ||
        !/^S-1-[0-9]+(?:-[0-9]+)+$/.test(p.sid) || (pinnedSid !== undefined && p.sid !== pinnedSid)) fail("EVIDENCE");
    return p;
  };
  const proofs = (r: Record<string, unknown>, path: string, parent: string, directory: WindowsRuntimeDirectoryIdentity, fileId?: string) => {
    const file = evidence(r.file, path, fileId), dir = evidence(r.directory, parent, directory.fileId);
    if (file.sid !== dir.sid || !same(dir.volumeId, directory.volumeId)) fail("EVIDENCE");
    return { file, identity: Object.freeze({ canonicalPath: file.canonicalPath, fileId: file.fileId, volumeId: file.volumeId }) };
  };
  const baseKeys = ["version", "operation", "path", "root", "state"] as const;
  const checkEnvelope = (r: Record<string, unknown>, operation: string, path: string): void => {
    if (r.version !== 1 || r.operation !== operation || r.path !== path || r.root !== root) fail("ENVELOPE");
  };
  const unknown = (path: string, publish?: { attemptId: string; stagingPath: string }): WindowsPrivateIoFailure =>
    Object.freeze({ state: "UNKNOWN", path, ...publish, reason: "PRIVATE_IO_UNCONFIRMED", preserve: true });
  const failure = (r: Record<string, unknown>, status: number | null, path: string, publish?: { attemptId: string; stagingPath: string }): WindowsPrivateIoFailure => {
    record(r, [...baseKeys, ...(publish ? ["attemptId", "stagingPath"] : []), "reason"]);
    const state = r.state;
    if (!((state === "REJECTED" && status === 1 && r.reason === "PRIVATE_IO_REJECTED") ||
          (state === "UNKNOWN" && status === 3 && r.reason === "PRIVATE_IO_UNKNOWN") ||
          (publish && state === "EXISTS" && status === 2 && r.reason === "PRIVATE_IO_EXISTS"))) fail("FAILURE");
    return Object.freeze({ state: state as WindowsPrivateIoFailure["state"], path, ...publish, reason: r.reason as string, preserve: true });
  };

  return Object.freeze({
    trust,
    publishNew(request: WindowsPrivatePublishRequest): WindowsPrivatePublishReceipt | WindowsPrivateIoFailure {
      let path: string, parent: string, expectedDirectory: WindowsRuntimeDirectoryIdentity;
      let attemptId: string, stagingPath: string, input: Uint8Array, sha256: string, byteLength: number;
      try {
        const r = record(request, ["path", "attemptId", "bytes", "expectedDirectory"]);
        ({ path, parent, expectedDirectory } = baseRequest(r.path, r.expectedDirectory));
        attemptId = text(r.attemptId, ATTEMPT);
        stagingPath = canonical(childOf(parent, `.folio-private-${attemptId}.tmp`), root);
        if (same(stagingPath, path)) fail("PATH");
        if (!(r.bytes instanceof Uint8Array)) fail("BYTES");
        byteLength = boundedSize(r.bytes.byteLength);
        const bytes = Buffer.from(r.bytes);
        sha256 = digest(bytes);
        input = inputFor(path, expectedDirectory, { operation: "publish-new", attemptId, bytesBase64: bytes.toString("base64") });
        if (attempts.has(attemptId) || targets.has(asciiCaseFold(path))) fail("CONSUMED");
        assertPin();
      } catch { return fail("PUBLISH_REJECTED"); }
      // Consume both BEFORE dispatch, even when exec throws/times out. No retry.
      attempts.add(attemptId); targets.add(asciiCaseFold(path));
      const metadata = { attemptId, stagingPath };
      try {
        const { response: r, status } = invoke(input);
        checkEnvelope(r, "publish-new", path);
        if (r.attemptId !== attemptId || r.stagingPath !== stagingPath) fail("ENVELOPE");
        if (r.state !== "PUBLISHED") return failure(r, status, path, metadata);
        record(r, [...baseKeys, "attemptId", "stagingPath", "file", "directory", "byteLength", "sha256", "contentFlushed", "namespace", "namespaceDurability"]);
        if (status !== 0 || r.byteLength !== byteLength || r.sha256 !== sha256 || r.contentFlushed !== true ||
            r.namespace !== "EXCLUSIVE_NO_REPLACE" || r.namespaceDurability !== "UNPROVEN") fail("RECEIPT");
        const proof = proofs(r, path, parent, expectedDirectory);
        pinnedSid = proof.file.sid;
        return Object.freeze({ state: "PUBLISHED", path, ...metadata, identity: proof.identity, byteLength, sha256,
          contentFlushed: true, namespace: "EXCLUSIVE_NO_REPLACE", namespaceDurability: "UNPROVEN" });
      } catch { return unknown(path, metadata); }
    },
    readPrivate(request: WindowsPrivateReadRequest): WindowsPrivateReadReceipt | WindowsPrivateIoFailure {
      let path: string, parent: string, expectedDirectory: WindowsRuntimeDirectoryIdentity;
      let fileId: string, sha256: string, maxBytes: number, input: Uint8Array;
      try {
        const r = record(request, ["path", "expectedDirectory", "expectedFile", "expectedSha256", "maxBytes"]);
        ({ path, parent, expectedDirectory } = baseRequest(r.path, r.expectedDirectory));
        const f = record(r.expectedFile, ["canonicalPath", "fileId", "volumeId"]);
        if (!same(canonical(f.canonicalPath, root), path)) fail("IDENTITY");
        fileId = text(f.fileId, FILE_ID);
        const volumeId = text(f.volumeId, VOLUME_ID);
        if (!same(volumeId, expectedRoot.volumeId)) fail("IDENTITY");
        sha256 = text(r.expectedSha256, HASH); maxBytes = boundedSize(r.maxBytes);
        input = inputFor(path, expectedDirectory, { operation: "read-private", fileId, volumeId, expectedSha256: sha256, maxBytes });
        assertPin();
      } catch { return fail("READ_REJECTED"); }
      try {
        const { response: r, status } = invoke(input);
        checkEnvelope(r, "read-private", path);
        if (r.state !== "READ") return failure(r, status, path);
        record(r, [...baseKeys, "file", "directory", "bytesBase64", "byteLength", "sha256"]);
        const length = boundedSize(r.byteLength);
        if (status !== 0 || length > maxBytes || r.sha256 !== sha256 || typeof r.bytesBase64 !== "string" ||
            r.bytesBase64.length !== 4 * Math.ceil(length / 3)) fail("READ_RECEIPT");
        const bytes = Buffer.from(r.bytesBase64, "base64");
        if (bytes.toString("base64") !== r.bytesBase64 || bytes.byteLength !== length || digest(bytes) !== sha256) fail("READ_RECEIPT");
        const proof = proofs(r, path, parent, expectedDirectory, fileId);
        pinnedSid = proof.file.sid;
        return Object.freeze({ state: "READ", identity: proof.identity, bytes: new Uint8Array(bytes), byteLength: length, sha256 });
      } catch { return unknown(path); }
    },
  });
}
