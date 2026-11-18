import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { types as utilTypes } from "node:util";
import { CollaborationError } from "../../collaboration/runtime/contract";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";
import {
  WINDOWS_PROBE_MAX_OUTPUT_BYTES,
  WINDOWS_PROBE_TIMEOUT_MS,
} from "./private-root";
import type {
  WindowsRuntimeDirectoryIdentity,
  WindowsRuntimeFsPort,
  WindowsRuntimePreparedDirectory,
  WindowsRuntimeRootIdentity,
} from "./runtime-platform";

export const WINDOWS_EXCLUSIVE_DIRECTORY_MAX_REQUEST_BYTES = 4096;
export const WINDOWS_EXCLUSIVE_DIRECTORY_MAX_OUTPUT_BYTES =
  WINDOWS_PROBE_MAX_OUTPUT_BYTES;
export const WINDOWS_EXCLUSIVE_DIRECTORY_WIRE_OPERATION = "create-directory";

export type WindowsExclusiveDirectoryOptions = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  expectedRoot: WindowsRuntimeRootIdentity;
}>;
export type WindowsExclusiveDirectoryRequest = Readonly<{
  path: string;
  attemptId: string;
  expectedDirectory: WindowsRuntimeDirectoryIdentity;
}>;
export type WindowsExclusiveDirectoryEvidence = Readonly<{
  exactWire: string;
  captured: Readonly<{
    stdout: string;
    stderr: string;
    captureEncoding: "latin1";
    status: number | null;
    signal: string | null;
    errorCode?: string;
  }>;
}>;
export type WindowsExclusiveDirectoryResult =
  | Readonly<{
      state: "CREATED";
      path: string;
      attemptId: string;
      preserve: true;
      identity: WindowsRuntimePreparedDirectory;
      evidence: WindowsExclusiveDirectoryEvidence;
    }>
  | Readonly<{
      state: "EXISTS" | "REJECTED" | "UNKNOWN";
      path: string;
      attemptId: string;
      preserve: true;
      reason: string;
      evidence: WindowsExclusiveDirectoryEvidence;
    }>;
export type WindowsExclusiveDirectoryExecRequest = Readonly<{
  executable: string;
  args: readonly ["--exclusive-directory-v1"];
  cwd: string;
  env: Readonly<{
    SystemRoot: string;
    windir: string;
    TEMP: string;
    TMP: string;
  }>;
  input: Uint8Array;
  timeoutMs: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  stdio: "pipe";
  encoding: "buffer";
}>;
export type WindowsExclusiveDirectoryExecResult = Readonly<{
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}>; // stdout/stderr are reversible latin1 of captured Buffer, never UTF8 repaired.
export type WindowsExclusiveDirectoryTestPort = Readonly<{
  fs: Pick<WindowsRuntimeFsPort, "lstat" | "readFile">;
  exec(
    request: WindowsExclusiveDirectoryExecRequest,
  ): WindowsExclusiveDirectoryExecResult;
}>;
export type WindowsExclusiveDirectoryPort = Readonly<{
  create(
    request: WindowsExclusiveDirectoryRequest,
  ): WindowsExclusiveDirectoryResult;
}>;

const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const ATTEMPT = /^[0-9a-f]{32}$/;
const SID = /^S-1-[0-9]+(?:-[0-9]+)+$/;
const ENVELOPE_KEYS = [
  "contractVersion",
  "operation",
  "path",
  "root",
  "attemptId",
] as const;
const SUCCESS_KEYS = [
  ...ENVELOPE_KEYS,
  "state",
  "rootEvidence",
  "parent",
  "directory",
  "handleFileId",
  "handleVolumeId",
  "filesystem",
  "ancestorsHeld",
  "daclProtected",
  "namespace",
] as const;
const FAILURE_KEYS = [...ENVELOPE_KEYS, "state", "reason"] as const;
const REASON_REJECTED = "EXCLUSIVE_DIRECTORY_REJECTED";
const REASON_UNKNOWN = "EXCLUSIVE_DIRECTORY_UNKNOWN";
const REASON_EXISTS = "EXCLUSIVE_DIRECTORY_EXISTS";

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_EXCLUSIVE_DIRECTORY_${code}`);
}
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const same = (a: string, b: string): boolean =>
  asciiCaseFold(a) === asciiCaseFold(b);

// All boundary records are data-only, including non-enumerable/symbol keys.
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

// Small object/scalar-only JSON reader. JSON.parse alone silently accepts
// duplicate keys, including escaped spellings; this reader rejects both.
// The create-directory wire contains no arrays. A depth bound also rejects
// nesting attacks.
function parseResponse(
  source: string,
  maximum = WINDOWS_EXCLUSIVE_DIRECTORY_MAX_OUTPUT_BYTES,
): unknown {
  if (
    Buffer.byteLength(source, "latin1") > maximum ||
    /[^\x09\x0a\x0d\x20-\x7e]/.test(source)
  )
    fail("OUTPUT");
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
        if (keys.has(key) || keys.size >= 32) fail("JSON");
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
  return result;
}

type Pin = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number }>;
function samePin(a: Pin, b: Pin): boolean {
  return (
    a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs
  );
}
function pinExecutable(
  fs: WindowsExclusiveDirectoryTestPort["fs"],
  path: string,
  hash: string,
): Pin {
  const stat = (): Pin => {
    const s = fs.lstat(path);
    if (!s.isFile() || s.isDirectory() || s.isSymbolicLink() || s.nlink !== 1)
      fail("HELPER_UNTRUSTED");
    const pin = { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
    if (
      Object.values(pin).some((n) => !Number.isFinite(n) || n < 0) ||
      !Number.isSafeInteger(pin.size)
    )
      fail("HELPER_UNTRUSTED");
    return Object.freeze(pin);
  };
  try {
    const before = stat(), bytes = fs.readFile(path), after = stat();
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

const nativePort: WindowsExclusiveDirectoryTestPort = {
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
    // Never forward output/error objects, or their messages, to diagnostics.
    return {
      status: result.status,
      signal: result.signal,
      // A latin1 string is a reversible mapping of every captured byte.
      // Protocol parsing separately requires ASCII; invalid UTF8 is never repaired.
      stdout: result.stdout?.toString("latin1") ?? "",
      stderr: result.stderr?.toString("latin1") ?? "",
      ...(result.error ? { errorCode: "EXEC_FAILED" } : {}),
    };
  },
};

/**
 * Native exclusive directory creation through the pinned helper. The helper
 * holds non-delete ancestor handles for the whole operation, creates ONE
 * basename below the expected parent via NtCreateFile FILE_CREATE and proves
 * the new directory on the same handle. There is no create-or-open fallback:
 * a missing or malformed receipt is UNKNOWN, never a negative existence
 * claim, and a consumed target or attempt is never dispatched twice on the
 * same port.
 */
export function createWindowsExclusiveDirectory(
  options: WindowsExclusiveDirectoryOptions,
): WindowsExclusiveDirectoryPort {
  if (arguments.length !== 1) fail("OPTIONS");
  if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  return create(options, nativePort);
}
/** Non-Windows contract-only fake ports, never native Windows proof. */
export function createWindowsExclusiveDirectoryForTesting(
  options: WindowsExclusiveDirectoryOptions,
  port: WindowsExclusiveDirectoryTestPort,
): WindowsExclusiveDirectoryPort {
  if (process.platform === "win32") fail("TEST_PORT_FORBIDDEN");
  return create(options, port);
}

function create(
  options: WindowsExclusiveDirectoryOptions,
  port: WindowsExclusiveDirectoryTestPort,
): WindowsExclusiveDirectoryPort {
  let root: string, executable: string, systemRoot: string, expectedHash: string;
  let expectedRoot: WindowsRuntimeRootIdentity;
  let initialPin: Pin;
  let fs: WindowsExclusiveDirectoryTestPort["fs"],
    exec: WindowsExclusiveDirectoryTestPort["exec"];
  try {
    const o = record(options, [
      "root",
      "probeExecutable",
      "expectedHash",
      "systemRoot",
      "expectedRoot",
    ]);
    root = canonical(o.root);
    executable = canonical(o.probeExecutable);
    systemRoot = canonical(o.systemRoot);
    if (!/\.exe$/i.test(executable)) fail("OPTIONS");
    // The helper hash is mandatory and always a lowercase sha256.
    expectedHash = text(o.expectedHash, HASH);
    const r = record(o.expectedRoot, ["rootFileId", "volumeId"]);
    expectedRoot = Object.freeze({
      rootFileId: text(r.rootFileId, FILE_ID),
      volumeId: text(r.volumeId, VOLUME_ID),
    });
    const p = record(port, ["fs", "exec"]);
    const f = record(p.fs, ["lstat", "readFile"]);
    // Synchronous transport only: async or generator callbacks can never
    // supply the primitive result this protocol requires, so they are
    // refused before any invocation rather than after a fabricated receipt.
    if (
      [f.lstat, f.readFile, p.exec].some(
        (fn) =>
          typeof fn !== "function" ||
          utilTypes.isAsyncFunction(fn) ||
          utilTypes.isGeneratorFunction(fn),
      )
    )
      fail("OPTIONS");
    fs = {
      lstat: port.fs.lstat.bind(port.fs),
      readFile: port.fs.readFile.bind(port.fs),
    };
    exec = port.exec.bind(port);
    initialPin = pinExecutable(fs, executable, expectedHash);
  } catch {
    return fail("OPTIONS_OR_HELPER_UNTRUSTED");
  }

  const attempts = new Set<string>(), targets = new Set<string>();
  const assertPin = (): void => {
    if (!samePin(initialPin, pinExecutable(fs, executable, expectedHash)))
      fail("HELPER_CHANGED");
  };
  const echo = (request: unknown, field: string): string => {
    try {
      if (typeof request !== "object" || request === null) return "";
      const descriptor = Object.getOwnPropertyDescriptor(request, field);
      return descriptor && "value" in descriptor &&
          typeof descriptor.value === "string"
        ? descriptor.value
        : "";
    } catch {
      return "";
    }
  };
  type Captured = Readonly<{
    stdout: string;
    stderr: string;
    captureEncoding: "latin1";
    status: number | null;
    signal: string | null;
    errorCode?: string;
  }>;
  const emptyCaptured: Captured = Object.freeze({
    stdout: "",
    stderr: "",
    captureEncoding: "latin1",
    status: null,
    signal: null,
  });
  const evidence = (
    exactWire: string,
    captured: Captured,
  ): WindowsExclusiveDirectoryEvidence =>
    Object.freeze({ exactWire, captured });
  const preflight = (
    path: string,
    attemptId: string,
    reason: string,
  ): WindowsExclusiveDirectoryResult =>
    Object.freeze({
      state: "REJECTED",
      path,
      attemptId,
      preserve: true,
      reason,
      evidence: evidence("", emptyCaptured),
    });
  const unknown = (
    path: string,
    attemptId: string,
    wire: string,
    captured: Captured,
  ): WindowsExclusiveDirectoryResult =>
    Object.freeze({
      state: "UNKNOWN",
      path,
      attemptId,
      preserve: true,
      reason: REASON_UNKNOWN,
      evidence: evidence(wire, captured),
    });

  // Preserve the actual pipe reply privately before parsing or post-call
  // proof. The whole result must be a plain record of exactly the protocol
  // fields (plus optional errorCode): accessors, inherited/extra keys,
  // thenables, or a wrong prototype flag the capture malformed. Available
  // own primitive fields are still retained verbatim — captured strings are
  // never sliced, even when over the parse bound; oversize only marks the
  // receipt malformed. A real promise's rejection is sunk without invoking
  // any supplied `.then`.
  const capture = (raw: unknown): { captured: Captured; malformed: boolean } => {
    const out: {
      stdout: string;
      stderr: string;
      status: number | null;
      signal: string | null;
      errorCode?: string;
    } = { stdout: "", stderr: "", status: null, signal: null };
    let malformed = false;
    if (utilTypes.isPromise(raw)) {
      try {
        Promise.prototype.then.call(raw, undefined, () => undefined);
      } catch {
        // Sinking must never surface a transport rejection here.
      }
    }
    if (raw === null || typeof raw !== "object")
      return {
        captured: Object.freeze({ ...out, captureEncoding: "latin1" }),
        malformed: true,
      };
    try {
      record(raw, ["status", "signal", "stdout", "stderr"], ["errorCode"]);
    } catch {
      malformed = true;
    }
    for (const key of [
      "status",
      "signal",
      "stdout",
      "stderr",
      "errorCode",
    ] as const) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(raw, key);
      } catch {
        malformed = true;
        continue;
      }
      if (!descriptor) continue;
      if (!("value" in descriptor)) {
        malformed = true;
        continue;
      }
      const value: unknown = descriptor.value;
      if (key === "status") {
        if (value === null || Number.isInteger(value))
          out.status = value as number | null;
        else malformed = true;
      } else if (key === "signal") {
        if (value === null || typeof value === "string")
          out.signal = value as string | null;
        else malformed = true;
      } else if (key === "errorCode") {
        if (typeof value === "string") out.errorCode = value;
        else malformed = true;
      } else if (typeof value === "string") {
        out[key] = value; // Never slice: retain every captured byte.
        if (value.length > WINDOWS_EXCLUSIVE_DIRECTORY_MAX_OUTPUT_BYTES)
          malformed = true;
      } else malformed = true;
    }
    return {
      captured: Object.freeze({ ...out, captureEncoding: "latin1" }),
      malformed,
    };
  };

  const probeEvidence = (
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
      !SID.test(p.sid)
    )
      fail("EVIDENCE");
    return p;
  };

  return Object.freeze({
    create(
      request: WindowsExclusiveDirectoryRequest,
    ): WindowsExclusiveDirectoryResult {
      const pathEcho = echo(request, "path");
      const attemptEcho = echo(request, "attemptId");
      let path: string, parent: string, attemptId: string, wire: string;
      let expectedDirectory: WindowsRuntimeDirectoryIdentity;
      try {
        const r = record(request, ["path", "attemptId", "expectedDirectory"]);
        path = canonical(r.path, root);
        // Strict descendant: a single basename below the existing parent.
        if (same(path, root)) fail("PATH");
        parent = parentOf(path);
        canonical(parent, root);
        const d = record(r.expectedDirectory, ["fileId", "volumeId"]);
        expectedDirectory = Object.freeze({
          fileId: text(d.fileId, FILE_ID),
          volumeId: text(d.volumeId, VOLUME_ID),
        });
        // The parent identity is bound to the expected root volume; when the
        // parent IS the root the two native ids must be identical.
        if (!same(expectedDirectory.volumeId, expectedRoot.volumeId))
          fail("IDENTITY");
        if (
          same(parent, root) &&
          !same(expectedDirectory.fileId, expectedRoot.rootFileId)
        )
          fail("IDENTITY");
        attemptId = text(r.attemptId, ATTEMPT);
        // The complete dispatch wire is built and bounded BEFORE consumption.
        wire = JSON.stringify({
          contractVersion: 1,
          operation: "create-directory",
          path,
          root,
          attemptId,
          rootFileId: expectedRoot.rootFileId,
          rootVolumeId: expectedRoot.volumeId,
          directoryFileId: expectedDirectory.fileId,
          directoryVolumeId: expectedDirectory.volumeId,
        });
        if (
          Buffer.byteLength(wire, "utf8") >
          WINDOWS_EXCLUSIVE_DIRECTORY_MAX_REQUEST_BYTES
        )
          fail("WIRE_SIZE");
        if (attempts.has(attemptId) || targets.has(asciiCaseFold(path)))
          fail("CONSUMED");
        assertPin();
      } catch {
        return preflight(
          pathEcho,
          attemptEcho,
          REASON_REJECTED,
        );
      }
      // Consume both BEFORE any native call. A path or attempt is never
      // dispatched twice on this port, not even after UNKNOWN.
      attempts.add(attemptId);
      targets.add(asciiCaseFold(path));

      let raw: WindowsExclusiveDirectoryExecResult | undefined;
      try {
        raw = exec(
          Object.freeze({
            executable,
            args: Object.freeze(["--exclusive-directory-v1"] as const),
            cwd: systemRoot,
            env: Object.freeze({
              SystemRoot: systemRoot,
              windir: systemRoot,
              TEMP: childOf(systemRoot, "Temp"),
              TMP: childOf(systemRoot, "Temp"),
            }),
            input: Buffer.from(wire, "utf8"),
            timeoutMs: WINDOWS_PROBE_TIMEOUT_MS,
            maxBuffer: WINDOWS_EXCLUSIVE_DIRECTORY_MAX_OUTPUT_BYTES,
            shell: false,
            windowsHide: true,
            stdio: "pipe",
            encoding: "buffer",
          }),
        );
      } catch {
        return unknown(path, attemptId, wire, emptyCaptured);
      }
      const { captured, malformed } = capture(raw);
      // The helper must be the same pinned file AFTER the invocation.
      try {
        assertPin();
      } catch {
        return unknown(path, attemptId, wire, captured);
      }
      if (malformed) return unknown(path, attemptId, wire, captured);
      const status = captured.status;
      if (
        status === null ||
        captured.signal !== null ||
        captured.errorCode !== undefined ||
        captured.stderr !== "" ||
        status < 0 ||
        status > 3
      )
        return unknown(path, attemptId, wire, captured);
      let response: unknown;
      try {
        response = parseResponse(captured.stdout);
      } catch {
        return unknown(path, attemptId, wire, captured);
      }
      let r: Record<string, unknown>;
      try {
        r = record(response, [...ENVELOPE_KEYS, "state"], [
          "rootEvidence",
          "parent",
          "directory",
          "handleFileId",
          "handleVolumeId",
          "filesystem",
          "ancestorsHeld",
          "daclProtected",
          "namespace",
          "reason",
        ]);
        if (
          r.contractVersion !== 1 ||
          r.operation !== "create-directory" ||
          r.path !== path ||
          r.root !== root ||
          r.attemptId !== attemptId
        )
          fail("ENVELOPE");
      } catch {
        return unknown(path, attemptId, wire, captured);
      }
      if (r.state === "CREATED") {
        try {
          record(r, [...SUCCESS_KEYS]);
          if (
            status !== 0 ||
            r.filesystem !== "NTFS" ||
            r.ancestorsHeld !== true ||
            r.daclProtected !== true ||
            r.namespace !== "EXCLUSIVE_CREATE"
          )
            fail("RECEIPT");
          const rootEvidence = probeEvidence(
            r.rootEvidence,
            root,
            expectedRoot.rootFileId,
          );
          const parentEvidence = probeEvidence(
            r.parent,
            parent,
            expectedDirectory.fileId,
          );
          if (!same(parentEvidence.volumeId, expectedDirectory.volumeId))
            fail("EVIDENCE");
          const directory = probeEvidence(r.directory, path);
          // Every evidence object carries the same current SID/owner, and the
          // new directory is provably neither the root nor the parent object.
          if (
            rootEvidence.sid !== parentEvidence.sid ||
            parentEvidence.sid !== directory.sid
          )
            fail("EVIDENCE");
          if (
            same(directory.fileId, expectedRoot.rootFileId) ||
            same(directory.fileId, expectedDirectory.fileId)
          )
            fail("EVIDENCE");
          const handleFileId = text(r.handleFileId, FILE_ID);
          const handleVolumeId = text(r.handleVolumeId, VOLUME_ID);
          if (
            !same(handleFileId, directory.fileId) ||
            !same(handleVolumeId, directory.volumeId)
          )
            fail("EVIDENCE");
          const identity: WindowsRuntimePreparedDirectory = Object.freeze({
            canonicalPath: directory.canonicalPath,
            directoryFileId: directory.fileId,
            directoryVolumeId: directory.volumeId,
            rootFileId: directory.rootFileId,
            rootVolumeId: directory.rootVolumeId,
          });
          return Object.freeze({
            state: "CREATED",
            path,
            attemptId,
            preserve: true,
            identity,
            evidence: evidence(wire, captured),
          }) as WindowsExclusiveDirectoryResult;
        } catch {
          return unknown(path, attemptId, wire, captured);
        }
      }
      try {
        record(r, [...FAILURE_KEYS]);
        const state = r.state;
        const reason = r.reason;
        const valid =
          (state === "EXISTS" &&
            status === 2 &&
            reason === REASON_EXISTS) ||
          (state === "REJECTED" &&
            status === 1 &&
            reason === REASON_REJECTED) ||
          (state === "UNKNOWN" &&
            status === 3 &&
            reason === REASON_UNKNOWN);
        if (!valid || typeof reason !== "string") fail("FAILURE");
        return Object.freeze({
          state: state as "EXISTS" | "REJECTED" | "UNKNOWN",
          path,
          attemptId,
          preserve: true,
          reason,
          evidence: evidence(wire, captured),
        }) as WindowsExclusiveDirectoryResult;
      } catch {
        return unknown(path, attemptId, wire, captured);
      }
    },
  });
}
