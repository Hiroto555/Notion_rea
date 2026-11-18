import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { types as utilTypes } from "node:util";
import {
  CollaborationError,
  type Json,
} from "../../collaboration/runtime/contract";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";
import { WINDOWS_PROBE_TIMEOUT_MS } from "./private-root";
import type {
  WindowsRuntimeFileIdentity,
  WindowsRuntimeFsPort,
  WindowsRuntimePreparedDirectory,
} from "./runtime-platform";

export const WINDOWS_HOT_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
export const WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS = 4;
// Receipts carry only manifest entries and proof objects, never file bytes.
const WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES = 64 * 1024;
// Lifecycle operations (seal/inspect/release) carry captured pipe bytes and
// inspection evidence; the separate 1MiB lifecycle stdin cap never enlarges
// the 64KiB snapshot/revalidate wire.
export const WINDOWS_HOT_JOURNAL_LIFECYCLE_WIRE_BYTES = 1024 * 1024;
// Archive-scale profiles re-stream multi-GiB sources several times; the
// small-ledger profile keeps WINDOWS_PROBE_TIMEOUT_MS.
export const WINDOWS_HOT_JOURNAL_ARCHIVE_TIMEOUT_MS = 30 * 60 * 1000;
const WINDOWS_HOT_JOURNAL_SLOT_PREFIX = ".folio-hot-snapshot-";
const WINDOWS_HOT_JOURNAL_ARCHIVE_PREFIX = ".folio-hot-archive-";
const WINDOWS_HOT_JOURNAL_CAPTURE_PREFIX = ".folio-hot-capture-";
const SOURCE_SUFFIXES = ["", "-journal", "-wal", "-shm"] as const;

export type WindowsHotJournalSnapshotProfile =
  | "small-ledger"
  | "recovery-archive"
  | "backup-artifact";
export const WINDOWS_HOT_JOURNAL_PROFILES = Object.freeze({
  "small-ledger": Object.freeze({
    mainBytes: 64 * 1024 * 1024,
    sidecarBytes: 64 * 1024 * 1024,
    combinedBytes: 256 * 1024 * 1024,
  }),
  "recovery-archive": Object.freeze({
    mainBytes: 1024 * 1024 * 1024,
    sidecarBytes: 1024 * 1024 * 1024,
    combinedBytes: 2 * 1024 * 1024 * 1024,
  }),
  "backup-artifact": Object.freeze({
    mainBytes: 4 * 1024 * 1024 * 1024,
    sidecarBytes: 8 * 1024 * 1024 * 1024,
    combinedBytes: 28 * 1024 * 1024 * 1024,
  }),
});

export type WindowsHotJournalSnapshotOptions = Readonly<{
  root: string;
  probeExecutable: string;
  expectedHash: string;
  systemRoot: string;
  // Omission selects small-ledger. The profile is never inferred from a
  // file name or a measured size; it is pinned on the wire and in every
  // persisted manifest and replay/revalidation record.
  profile?: WindowsHotJournalSnapshotProfile;
}>;
export type WindowsHotJournalSnapshotRequest = Readonly<{
  path: string;
  expectedDirectory: WindowsRuntimePreparedDirectory;
  expectedFile: WindowsRuntimeFileIdentity;
  /** May repeat, but never override, the factory-selected profile. */
  profile?: WindowsHotJournalSnapshotProfile;
}>;
export type WindowsHotJournalSnapshotReference = Readonly<{
  attemptId: string;
  slot: number;
  slotFileId: string;
  slotVolumeId: string;
}>;
export type WindowsHotJournalSnapshotInspection = Readonly<{
  reference: WindowsHotJournalSnapshotReference;
  state: "REVALIDATED" | "RELEASED" | "UNKNOWN";
  fingerprint: string;
  evidence: Json;
}>;
export type WindowsHotJournalReleaseCapture = Readonly<{
  /** Canonical base64 of the exact release request/stdout/stderr bytes. */
  request: string;
  response: string;
  stderr: string;
}>;
export type WindowsHotJournalSnapshotReleaseAuthority = Readonly<{
  fingerprint: string;
  assertCurrent(): void;
}>;
export type WindowsHotJournalSnapshotExecRequest = Readonly<{
  executable: string;
  args: readonly ["--private-journal-snapshot"];
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
export type WindowsHotJournalSnapshotExecResult = Readonly<{
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  captureEncoding?: "latin1";
}>;
export type WindowsHotJournalSnapshotTestPort = Readonly<{
  fs: Pick<WindowsRuntimeFsPort, "lstat" | "readFile">;
  exec(
    request: WindowsHotJournalSnapshotExecRequest,
  ): WindowsHotJournalSnapshotExecResult;
}>;

export class WindowsHotJournalSnapshotError extends CollaborationError {
  readonly evidence: Json;
  constructor(code: string, evidence: Json) {
    super(code);
    this.evidence = freezeJson(evidence);
  }
}

const HASH = /^[0-9a-f]{64}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const VOLUME_ID = /^[0-9a-fA-F]{16}$/;
const SID = /^S-1-[0-9]+(?:-[0-9]+)+$/;
const FAILURE_REASON = /^PRIVATE_JOURNAL_SNAPSHOT_[A-Z_]+$/;
const NATIVE_PROMISE_THEN = Promise.prototype.then;
const IGNORE_NATIVE_RESULT = (): void => {};
const same = (a: string, b: string): boolean =>
  asciiCaseFold(a) === asciiCaseFold(b);

// All boundary records are data-only, including non-enumerable/symbol keys.
function record(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("SCHEMA");
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("SCHEMA");
  const names = Reflect.ownKeys(value);
  if (keys.some((key) => !names.includes(key))) fail("SCHEMA");
  for (const key of names) {
    if (typeof key !== "string" || (!keys.includes(key) && !optional.includes(key)))
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
    if (validateWindowsPath(value, root ?? `${value[0]}:\\`).canonical !== value)
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
function isAsyncLike(value: unknown): boolean {
  return (
    typeof value !== "function" ||
    utilTypes.isAsyncFunction(value) ||
    utilTypes.isGeneratorFunction(value)
  );
}
function quietlyConsume(result: unknown): void {
  try {
    if (utilTypes.isPromise(result))
      Reflect.apply(NATIVE_PROMISE_THEN, result, [
        IGNORE_NATIVE_RESULT,
        IGNORE_NATIVE_RESULT,
      ]);
  } catch {}
}

// Strict small JSON reader: rejects duplicate keys (including escaped
// spellings), non-ASCII input, deep nesting and trailing bytes. Objects and
// arrays only; both are bounded.
function parseResponse(
  source: string,
  maximum = WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES,
): unknown {
  if (
    Buffer.byteLength(source, "utf8") > maximum ||
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
    if (source[at] === "[") {
      at++;
      const result: unknown[] = [];
      white();
      if (source[at] === "]") {
        at++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        if (result.length > 16) fail("JSON");
        white();
        const delimiter = source[at++];
        if (delimiter === "]") return result;
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
    a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
  );
}

type ActiveAttempt = {
  attemptId: string;
  path: string;
  events: { phase: string; captured?: Json; reply?: Json; outcome?: string }[];
  captures?: Record<string, Json>[];
};
function freezeJson(value: Json): Json {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function attemptEvidence(attempt: ActiveAttempt | null): Json {
  return freezeJson(
    attempt === null
      ? null
      : {
          attemptId: attempt.attemptId,
          path: attempt.path,
          captures: attempt.captures?.map((capture) => ({ ...capture })) ?? [],
          events: attempt.events.map((event) => ({
            phase: event.phase,
            ...(event.captured === undefined ? {} : { captured: event.captured }),
            ...(event.reply === undefined ? {} : { reply: event.reply }),
            ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
          })),
        },
  );
}
function fail(code: string): never {
  throw new WindowsHotJournalSnapshotError(
    `WINDOWS_HOT_JOURNAL_SNAPSHOT_${code}`,
    null,
  );
}

const nativePort: WindowsHotJournalSnapshotTestPort = {
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
      captureEncoding: "latin1",
      ...(result.error
        ? { errorCode: typeof (result.error as NodeJS.ErrnoException).code === "string"
          ? (result.error as NodeJS.ErrnoException).code! : "EXEC_FAILED" }
        : {}),
    };
  },
};

/**
 * Windows native hot rollback-journal snapshot controller. Every core helper
 * invocation has an independent evidence-only intent/wire/ready/output boundary.
 * `snapshot` acquires every present source file
 * (main/-journal/-wal/-shm) read-only, copies them into a fixed four-slot
 * private snapshot directory under the source parent, and returns ordered
 * manifest evidence; `revalidate` reacquires all source handles after the
 * callback and proves presence, File ID, volume, length and SHA-256 are
 * unchanged. Source handles are therefore reacquired across the callback —
 * they are NOT held continuously through the caller's source reopen. A
 * missing reply never proves nonapplication, UNKNOWN evidence is retained,
 * and nothing is resent, overwritten or recursively deleted.
 */
export function createWindowsHotJournalSnapshot(
  options: WindowsHotJournalSnapshotOptions,
  untrustedTestPort?: WindowsHotJournalSnapshotTestPort,
): Readonly<{
  withSnapshot(
    request: WindowsHotJournalSnapshotRequest,
    callback: (snapshotPath: string) => void,
  ): void;
  /** Immutable bounded captures, including attempts whose callback threw. */
  inspectEvidence(): readonly Json[];
  /** Read durable lifecycle evidence for a retained slot and return the
   * deterministic fingerprint over the CURRENT source/slot state. */
  inspectSnapshot(
    request: WindowsHotJournalSnapshotRequest,
    reference: WindowsHotJournalSnapshotReference,
    archived?: boolean,
  ): WindowsHotJournalSnapshotInspection;
  /** Explicit operator release: only the fixed working snapshot.sqlite{suffix}
   * files are disposed on held DELETE handles, then the evidence-only slot is
   * renamed to its attempt-bound archive name. Never called automatically. */
  releaseSnapshot(
    request: WindowsHotJournalSnapshotRequest,
    inspection: WindowsHotJournalSnapshotInspection,
    authority: WindowsHotJournalSnapshotReleaseAuthority,
  ): void;
  /** Append-only terminal evidence commit. A fresh controller may be used
   * after an explicit investigation; this never resends the release. */
  commitReleaseEvidence(
    request: WindowsHotJournalSnapshotRequest,
    reference: WindowsHotJournalSnapshotReference,
    capture: WindowsHotJournalReleaseCapture,
  ): void;
}> {
  const port =
    untrustedTestPort === undefined ? nativePort : untrustedTestPort;
  if (untrustedTestPort === undefined) {
    if (process.platform !== "win32") fail("UNSUPPORTED_PLATFORM");
  } else if (process.platform === "win32") {
    // The test port is an explicit untrusted simulation, never native proof.
    fail("TEST_PORT_FORBIDDEN");
  }
  let root: string, executable: string, systemRoot: string, expectedHash: string;
  let initialPin: Pin;
  let fs: WindowsHotJournalSnapshotTestPort["fs"],
    exec: WindowsHotJournalSnapshotTestPort["exec"],
    profile: WindowsHotJournalSnapshotProfile;
  try {
    const o = record(
      options,
      ["root", "probeExecutable", "expectedHash", "systemRoot"],
      ["profile"],
    );
    root = canonical(o.root);
    executable = canonical(o.probeExecutable);
    systemRoot = canonical(o.systemRoot);
    if (!/\.exe$/i.test(executable)) fail("OPTIONS");
    expectedHash = text(o.expectedHash, HASH);
    profile =
      o.profile === undefined
        ? "small-ledger"
        : text(o.profile, /^(small-ledger|recovery-archive|backup-artifact)$/) as WindowsHotJournalSnapshotProfile;
    const p = record(port, ["fs", "exec"]);
    const f = record(p.fs, ["lstat", "readFile"]);
    if (isAsyncLike(f.lstat) || isAsyncLike(f.readFile) || isAsyncLike(p.exec))
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

  const attempts: ActiveAttempt[] = [];
  let activeAttempt: ActiveAttempt | null = null;
  let pinnedSid: string | undefined;
  let active = false;
  const consumedReleases = new Set<string>();
  const consumedCommits = new Set<string>();
  let stablePoison: WindowsHotJournalSnapshotError | undefined;
  const poison = (): WindowsHotJournalSnapshotError => {
    if (stablePoison === undefined) {
      stablePoison = new WindowsHotJournalSnapshotError(
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_POISONED",
        attemptEvidence(activeAttempt),
      );
    }
    return stablePoison;
  };
  const assertPin = (): void => {
    try {
      if (!samePin(initialPin, pinExecutable(fs, executable, expectedHash)))
        fail("HELPER_CHANGED");
    } catch (error) {
      poison();
      throw error;
    }
  };
  const recordEvent = (
    phase: string,
    captured?: Json,
    reply?: Json,
    outcome?: string,
  ): void => {
    activeAttempt?.events.push({
      phase,
      ...(captured === undefined ? {} : { captured: freezeJson(captured) }),
      ...(reply === undefined ? {} : { reply: freezeJson(reply) }),
      ...(outcome === undefined ? {} : { outcome }),
    });
  };

  const profileLimits = WINDOWS_HOT_JOURNAL_PROFILES[profile];
  const timeoutMs =
    profile === "small-ledger"
      ? WINDOWS_PROBE_TIMEOUT_MS
      : WINDOWS_HOT_JOURNAL_ARCHIVE_TIMEOUT_MS;
  const capture = (raw: unknown): Json => {
    const out: Record<string, Json> = {};
    if (raw === null || typeof raw !== "object")
      return { malformedExecutor: true };
    for (const key of [
      "status",
      "signal",
      "stdout",
      "stderr",
      "errorCode",
      "captureEncoding",
    ]) {
      const d = Object.getOwnPropertyDescriptor(raw, key);
      if (!d) continue;
      if (!("value" in d)) {
        out[key] = { accessor: true };
        continue;
      }
      const v: unknown = d.value;
      out[key] =
        v === null ||
        typeof v === "string" ||
        typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v))
          ? (v as Json)
          : { invalidType: typeof v };
    }
    return out;
  };

  type ExecOutcome =
    | Readonly<{ ok: true; status: number; response: Record<string, unknown> }>
    | Readonly<{ ok: false }>;
  const execute = (input: Uint8Array): WindowsHotJournalSnapshotExecResult =>
    exec(
        Object.freeze({
          executable,
          args: Object.freeze(["--private-journal-snapshot"] as const),
          cwd: systemRoot,
          env: Object.freeze({
            SystemRoot: systemRoot,
            windir: systemRoot,
            TEMP: childOf(systemRoot, "Temp"),
            TMP: childOf(systemRoot, "Temp"),
          }),
          input: Buffer.from(input),
          timeoutMs,
          maxBuffer: WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES,
          shell: false,
          windowsHide: true,
          stdio: "pipe",
          encoding: "buffer",
        }),
      );
  const invoke = (
    phase: string,
    input: Uint8Array,
    beforeDispatch?: () => void,
  ): ExecOutcome => {
    if (stablePoison !== undefined) throw stablePoison;
    const original = Buffer.from(input);
    const captured: Record<string, Json> = { requestBase64: original.toString("base64") };
    const durable: Record<string, Json> = {
      captureId: randomBytes(16).toString("hex"), phase,
      state: "UNKNOWN_CAPTURE_NOT_ACKNOWLEDGED",
    };
    (activeAttempt!.captures ??= []).push(durable);
    const captureUnknown = (): never => {
      durable.state = "UNKNOWN_CAPTURE_NOT_ACKNOWLEDGED";
      recordEvent(phase, captured);
      // Keep the complete original request and observed raw result even if
      // the trusted root, helper, disk, reservation or ACK becomes unavailable.
      stablePoison = new WindowsHotJournalSnapshotError(
        "WINDOWS_HOT_JOURNAL_SNAPSHOT_UNKNOWN_CAPTURE_NOT_ACKNOWLEDGED",
        attemptEvidence(activeAttempt),
      );
      throw stablePoison;
    };
    let captureFileId: string | undefined;
    // This is OUR serialized, validated request, never native stdout. Only
    // these trusted pins select the evidence parent; no capture root adoption.
    const wire = JSON.parse(original.toString("utf8")) as Record<string, Json>;
    const expected: ExpectedDirectory = {
      canonicalPath: parentOf(wire.path as string),
      rootFileId: wire.rootFileId as string, rootVolumeId: wire.rootVolumeId as string,
      directoryFileId: wire.directoryFileId as string, directoryVolumeId: wire.directoryVolumeId as string,
    };
    const binding = {
      version: 1, path: wire.path, root,
      rootFileId: expected.rootFileId, rootVolumeId: expected.rootVolumeId,
      directoryFileId: expected.directoryFileId, directoryVolumeId: expected.directoryVolumeId,
      fileId: wire.fileId, volumeId: wire.volumeId, attemptId: wire.attemptId, profile,
      captureId: durable.captureId, capturePhase: phase,
      wireByteLength: original.length,
      wireSha256: createHash("sha256").update(original).digest("hex"),
    };
    const step = (operation: string, extra: Record<string, Json> = {}): void => {
      try {
        assertPin();
        const bytes = Buffer.from(JSON.stringify({
          ...binding, operation,
          ...(captureFileId === undefined ? {} : { captureFileId }), ...extra,
        }));
        if (bytes.length > WINDOWS_HOT_JOURNAL_LIFECYCLE_WIRE_BYTES) fail("CAPTURE");
        // ACKs terminate this finite protocol: metadata only, never recursively
        // capture their own pipes. A missing/malformed ACK remains UNKNOWN.
        const rawAck = execute(bytes);
        assertPin();
        const ack = record(rawAck, ["status", "signal", "stdout", "stderr"], ["errorCode", "captureEncoding"]);
        if (ack.status !== 0 || ack.signal !== null || ack.stderr !== "" ||
            "errorCode" in ack || typeof ack.stdout !== "string" ||
            ("captureEncoding" in ack && ack.captureEncoding !== "latin1")) fail("CAPTURE");
        const reply = record(parseResponse(ack.stdout), [
          ...baseKeys, "profile", "captureId", "capturePhase", "requestSha256", "directory", "captureDirectory",
        ]);
        checkEnvelope(reply, operation, wire.path as string, wire.attemptId as string);
        if (reply.state !== "CAPTURE_ACK" || reply.profile !== profile ||
            reply.captureId !== durable.captureId || reply.capturePhase !== phase ||
            reply.requestSha256 !== createHash("sha256").update(bytes).digest("hex")) fail("CAPTURE");
        const parent = evidence(reply.directory, expected, expected.canonicalPath, expected.directoryFileId);
        pinnedSid ??= parent.sid;
        const capturePath = childOf(expected.canonicalPath, `${WINDOWS_HOT_JOURNAL_CAPTURE_PREFIX}${durable.captureId}`);
        const directory = evidence(reply.captureDirectory, expected, capturePath, captureFileId);
        captureFileId = directory.fileId;
        durable.captureFileId = captureFileId;
        durable.directory = capturePath;
        durable.state = `${operation.toUpperCase().replaceAll("-", "_")}_ACKNOWLEDGED`;
      } catch { captureUnknown(); }
    };
    step("capture-intent");
    for (let at = 0, index = 0; at < original.length; at += WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES, index++)
      step("capture-wire", {
        index, bytes: original.subarray(at, at + WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES).toString("base64"),
      });
    step("capture-ready");
    // Current authority and helper checks are adjacent to the CORE dispatch,
    // after the intent has committed. Native root/parent guards run before
    // source handles open; the capture producer never opens the source file.
    try {
      if (stablePoison !== undefined) throw stablePoison;
      if (beforeDispatch) beforeDispatch();
    }
    catch (error) { recordEvent(phase, captured, undefined, "NOT_DISPATCHED"); throw error; }
    try { assertPin(); } catch { captureUnknown(); }
    let raw: WindowsHotJournalSnapshotExecResult | undefined;
    let threw = false;
    try {
      raw = execute(original);
      Object.assign(captured, capture(raw));
    } catch (error) {
      threw = true;
      captured.exec = "threw";
      captured.status = null;
      captured.signal = null;
      captured.stdout = "";
      captured.stderr = "";
      if (error !== null && typeof error === "object") {
        // Never execute an exception getter to obtain diagnostics.
        try {
          const descriptor = Object.getOwnPropertyDescriptor(error, "code");
          if (descriptor && "value" in descriptor && typeof descriptor.value === "string")
            captured.errorCode = descriptor.value;
          for (const name of ["stdout", "stderr"] as const) {
            const pipe = Object.getOwnPropertyDescriptor(error, name);
            if (!pipe) continue;
            if (!("value" in pipe)) captured[name] = { accessor: true };
            else if (Buffer.isBuffer(pipe.value)) {
              captured[name] = pipe.value.toString("latin1");
              captured.captureEncoding = "latin1";
            } else if (typeof pipe.value === "string") {
              captured[name] = Buffer.from(pipe.value, "utf8").toString("latin1");
              captured.captureEncoding = "latin1";
            } else captured[name] = { invalidType: typeof pipe.value };
          }
          for (const name of ["status", "signal"] as const) {
            const field = Object.getOwnPropertyDescriptor(error, name);
            if (!field) continue;
            captured[name] = "value" in field &&
              (field.value === null || typeof field.value === "string" ||
                (typeof field.value === "number" && Number.isFinite(field.value)))
              ? field.value as Json : { unavailable: true };
          }
        } catch { captured.exceptionMetadataUnavailable = true; }
      }
    }
    // Persist raw bytes and status BEFORE ANY result schema/JSON/semantic
    // validation, even for failures, invalid UTF8, ENOBUFS, signals and throws.
    const metadata: Record<string, Json> = { exec: threw ? "threw" : "returned" };
    for (const [key, value] of Object.entries(captured))
      if (key !== "stdout" && key !== "stderr" && key !== "requestBase64") metadata[key] = value;
    let complete = captured.exceptionMetadataUnavailable !== true;
    const component = (name: "stdout" | "stderr"): string => {
      const value = captured[name];
      if (typeof value !== "string") {
        metadata[name] = value === undefined ? { missing: true } : value;
        complete = false;
        return "";
      }
      const bytes = Buffer.from(value, captured.captureEncoding === "latin1" ? "latin1" : "utf8");
      metadata[`${name}ByteLength`] = bytes.length;
      metadata[`${name}Sha256`] = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length > WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES) complete = false;
      // An out-of-contract oversized result is NOT acknowledged as complete.
      // Retain its bounded prefix on disk and its entire observed value in
      // memory; never claim exact durable capture of discarded tail bytes.
      return bytes.subarray(0, WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES).toString("base64");
    };
    const stdout = component("stdout"), stderr = component("stderr");
    metadata.complete = complete;
    const metadataBytes = Buffer.from(JSON.stringify(metadata));
    if (metadataBytes.length > WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES) captureUnknown();
    step("capture-output", { stdout, stderr, metadata: metadataBytes.toString("base64") });
    if (!complete) captureUnknown();
    if (stablePoison !== undefined) {
      recordEvent(phase, captured);
      throw stablePoison;
    }
    if (threw) {
      recordEvent(phase, captured);
      return { ok: false };
    }
    let result: Record<string, unknown>;
    try {
      result = record(
        raw,
        ["status", "signal", "stdout", "stderr"],
        ["errorCode", "captureEncoding"],
      );
    } catch {
      recordEvent(phase, captured);
      return { ok: false };
    }
    try {
      assertPin();
    } catch {
      recordEvent(phase, captured);
      throw poison();
    }
    if (
      ("captureEncoding" in result && result.captureEncoding !== "latin1") ||
      result.signal !== null ||
      result.stderr !== "" ||
      "errorCode" in result ||
      !Number.isInteger(result.status) ||
      typeof result.stdout !== "string"
    ) {
      recordEvent(phase, captured);
      return { ok: false };
    }
    let response: unknown;
    try {
      response = parseResponse(result.stdout as string);
    } catch {
      recordEvent(phase, captured);
      return { ok: false };
    }
    if (
      typeof response !== "object" ||
      response === null ||
      Array.isArray(response)
    ) {
      recordEvent(phase, captured);
      return { ok: false };
    }
    recordEvent(phase, captured, response as Json);
    return {
      ok: true,
      status: result.status as number,
      response: response as Record<string, unknown>,
    };
  };

  type ExpectedDirectory = Readonly<{
    canonicalPath: string;
    directoryFileId: string;
    directoryVolumeId: string;
    rootFileId: string;
    rootVolumeId: string;
  }>;
  type SourceEntry =
    | Readonly<{ suffix: string; present: false }>
    | Readonly<{
        suffix: string;
        present: true;
        fileId: string;
        volumeId: string;
        byteLength: number;
        sha256: string;
      }>;

  const evidence = (
    raw: unknown,
    expected: ExpectedDirectory,
    path: string,
    fileId?: string,
  ): WindowsProbeEvidence => {
    assertWindowsProbe(raw, { canonicalPath: path, canonicalRoot: root });
    const p = raw as WindowsProbeEvidence;
    canonical(p.canonicalPath, root);
    canonical(p.canonicalRoot);
    if (
      !same(p.rootFileId, expected.rootFileId) ||
      !same(p.rootVolumeId, expected.rootVolumeId) ||
      !same(p.volumeId, expected.rootVolumeId) ||
      (fileId !== undefined && !same(p.fileId, fileId)) ||
      !SID.test(p.sid) ||
      (pinnedSid !== undefined && p.sid !== pinnedSid)
    )
      fail("EVIDENCE");
    return p;
  };

  const manifest = (
    value: unknown,
    expected: ExpectedDirectory,
    path: string,
    mainFileId: string,
  ): SourceEntry[] => {
    if (!Array.isArray(value) || value.length !== SOURCE_SUFFIXES.length)
      fail("MANIFEST");
    const entries: SourceEntry[] = [];
    for (let index = 0; index < SOURCE_SUFFIXES.length; index++) {
      const suffix = SOURCE_SUFFIXES[index];
      const item = value[index];
      if (
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).present === false
      ) {
        const r = record(item, ["suffix", "present"]);
        if (r.suffix !== suffix) fail("MANIFEST");
        entries.push({ suffix, present: false });
        continue;
      }
      const r = record(item, [
        "suffix",
        "present",
        "byteLength",
        "sha256",
        "evidence",
      ]);
      if (r.suffix !== suffix || r.present !== true) fail("MANIFEST");
      // Per-role profile limit: the main file and every sidecar are bound
      // by the selected profile, never by a shared flat maximum.
      const byteLength = boundedSize(
        r.byteLength,
        suffix === "" ? profileLimits.mainBytes : profileLimits.sidecarBytes,
      );
      const sha256 = text(r.sha256, HASH);
      // The fixed manifest order pins each source to its path+suffix; only the
      // mandatory main file has a caller-pinned File ID.
      const sourceEvidence = evidence(
        r.evidence,
        expected,
        path + suffix,
        suffix === "" ? mainFileId : undefined,
      );
      entries.push({
        suffix,
        present: true,
        fileId: sourceEvidence.fileId,
        volumeId: sourceEvidence.volumeId,
        byteLength,
        sha256,
      });
    }
    if (!entries[0].present) fail("MANIFEST");
    let combined = 0;
    for (const entry of entries)
      if (entry.present) combined += entry.byteLength;
    if (combined > profileLimits.combinedBytes) fail("MANIFEST");
    return entries;
  };

  const sameManifest = (left: SourceEntry[], right: SourceEntry[]): boolean =>
    left.every(
      (entry, index) =>
        entry.present === right[index].present &&
        (!entry.present ||
          (same(entry.fileId, (right[index] as { fileId: string }).fileId) &&
            same(entry.volumeId, (right[index] as { volumeId: string }).volumeId) &&
            entry.byteLength ===
              (right[index] as { byteLength: number }).byteLength &&
            entry.sha256 === (right[index] as { sha256: string }).sha256)),
    );

  const baseKeys = [
    "version",
    "operation",
    "state",
    "path",
    "root",
    "attemptId",
  ] as const;
  const checkEnvelope = (
    r: Record<string, unknown>,
    operation: string,
    path: string,
    attemptId: string,
  ): void => {
    if (
      r.version !== 1 ||
      r.operation !== operation ||
      r.path !== path ||
      r.root !== root ||
      r.attemptId !== attemptId
    )
      fail("ENVELOPE");
  };
  const failureState = (
    r: Record<string, unknown>,
    status: number,
  ): "REJECTED" | "UNKNOWN" => {
    record(r, [...baseKeys, "reason"], ["slot"]);
    text(r.reason, FAILURE_REASON);
    if (r.state === "REJECTED" && status === 1) return "REJECTED";
    if (r.state === "UNKNOWN" && status === 3) return "UNKNOWN";
    return fail("FAILURE");
  };

  type ValidatedRequest = Readonly<{
    path: string;
    parent: string;
    expected: ExpectedDirectory;
    fileId: string;
    volumeId: string;
  }>;
  // Shared strict request proof for every native operation: canonical path
  // under root, prepared-directory identity and expected main-file identity.
  const validateRequest = (
    request: WindowsHotJournalSnapshotRequest,
  ): ValidatedRequest => {
    const r = record(request, [
      "path",
      "expectedDirectory",
      "expectedFile",
    ], ["profile"]);
    if (r.profile !== undefined && r.profile !== profile) fail("PROFILE");
    const path = canonical(r.path, root);
    const parent = parentOf(path);
    if (same(path, root)) fail("PATH");
    const d = record(r.expectedDirectory, [
      "canonicalPath",
      "directoryFileId",
      "directoryVolumeId",
      "rootFileId",
      "rootVolumeId",
    ]);
    const expected = Object.freeze({
      canonicalPath: canonical(d.canonicalPath, root),
      directoryFileId: text(d.directoryFileId, FILE_ID),
      directoryVolumeId: text(d.directoryVolumeId, VOLUME_ID),
      rootFileId: text(d.rootFileId, FILE_ID),
      rootVolumeId: text(d.rootVolumeId, VOLUME_ID),
    });
    if (!same(parent, expected.canonicalPath)) fail("IDENTITY");
    if (
      !same(expected.directoryVolumeId, expected.rootVolumeId) ||
      (same(parent, root) &&
        !same(expected.directoryFileId, expected.rootFileId))
    )
      fail("IDENTITY");
    const f = record(r.expectedFile, [
      "canonicalPath",
      "fileId",
      "volumeId",
    ]);
    if (!same(canonical(f.canonicalPath, root), path)) fail("IDENTITY");
    const fileId = text(f.fileId, FILE_ID);
    const volumeId = text(f.volumeId, VOLUME_ID);
    if (!same(volumeId, expected.rootVolumeId)) fail("IDENTITY");
    return Object.freeze({ path, parent, expected, fileId, volumeId });
  };

  const lifecycleInput = (
    operation: "inspect" | "release" | "commit-release-evidence",
    validated: ValidatedRequest,
    attemptId: string,
    reference: WindowsHotJournalSnapshotReference,
    extra: Record<string, unknown> = {},
  ): Buffer =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        operation,
        path: validated.path,
        root,
        rootFileId: validated.expected.rootFileId,
        rootVolumeId: validated.expected.rootVolumeId,
        directoryFileId: validated.expected.directoryFileId,
        directoryVolumeId: validated.expected.directoryVolumeId,
        fileId: validated.fileId,
        volumeId: validated.volumeId,
        attemptId,
        profile,
        slot: reference.slot,
        slotFileId: reference.slotFileId,
        slotVolumeId: reference.slotVolumeId,
        ...extra,
      }),
      "utf8",
    );

  const validateReference = (
    reference: WindowsHotJournalSnapshotReference,
  ): WindowsHotJournalSnapshotReference => {
    const r = record(reference, [
      "attemptId",
      "slot",
      "slotFileId",
      "slotVolumeId",
    ]);
    const attemptId = text(r.attemptId, /^[0-9a-f]{32}$/);
    const slot = boundedSize(r.slot, WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS - 1);
    return Object.freeze({
      attemptId,
      slot,
      slotFileId: text(r.slotFileId, FILE_ID),
      slotVolumeId: text(r.slotVolumeId, VOLUME_ID),
    });
  };

  // Validate the release authority contract up front: a known synchronous
  // callable and a bounded opaque fingerprint supplied by the trusted caller.
  const validateAuthority = (
    authority: WindowsHotJournalSnapshotReleaseAuthority,
  ): { fingerprint: string; assertCurrent(): void } => {
    const r = record(authority, ["fingerprint", "assertCurrent"]);
    const fingerprint = text(r.fingerprint, /^[\x21-\x7e]{1,256}$/);
    if (isAsyncLike(r.assertCurrent)) { poison(); fail("AUTHORITY"); }
    const assertCurrent = (r.assertCurrent as () => void).bind(authority);
    return { fingerprint, assertCurrent };
  };

  // The authority is invoked before native dispatch and after the response;
  // a non-undefined return permanently poisons this controller.
  const invokeAuthority = (
    assertCurrent: () => void,
  ): void => {
    let result: unknown;
    try { result = assertCurrent(); }
    catch (error) { poison(); throw error; }
    if (result !== undefined) { quietlyConsume(result); poison(); fail("AUTHORITY"); }
    if (stablePoison !== undefined) throw stablePoison;
  };

  const commitCapture = (validated: ValidatedRequest, ref: WindowsHotJournalSnapshotReference,
    captureValue: WindowsHotJournalReleaseCapture): void => {
    const key = `${validated.path}|${ref.attemptId}|${ref.slotFileId}`;
    if (consumedCommits.has(key)) fail("CONSUMED");
    const captureRecord = record(captureValue, ["request", "response", "stderr"]);
    const parts: Record<string, Json> = {};
    for (const name of ["request", "response", "stderr"]) {
      const value = captureRecord[name];
      if (typeof value !== "string" || value.length > 2 * WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES) fail("CAPTURE");
      const bytes = Buffer.from(value, "base64");
      if (bytes.length > WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES || bytes.toString("base64") !== value) fail("CAPTURE");
      parts[name] = {value, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
    }
    const input = lifecycleInput("commit-release-evidence", validated, ref.attemptId, ref, {capture: parts});
    if (input.length > WINDOWS_HOT_JOURNAL_LIFECYCLE_WIRE_BYTES) fail("WIRE_SIZE");
    consumedCommits.add(key);
    const result = invoke("commit-release-evidence", input);
    if (!result.ok) fail("UNKNOWN");
    const c = result.response;
    if (c.state !== "EVIDENCE_COMMITTED") {
      checkEnvelope(c, "commit-release-evidence", validated.path, ref.attemptId);
      failureState(c, result.status); fail("UNKNOWN");
    }
    record(c, [...baseKeys, "profile", "slot", "archive", "directory", "slotDirectory"]);
    checkEnvelope(c, "commit-release-evidence", validated.path, ref.attemptId);
    const archive = childOf(validated.parent, `${WINDOWS_HOT_JOURNAL_ARCHIVE_PREFIX}${ref.attemptId}`);
    if (result.status !== 0 || c.profile !== profile || c.slot !== ref.slot || c.archive !== archive) fail("RECEIPT");
    const directory = evidence(c.directory, validated.expected, validated.parent, validated.expected.directoryFileId);
    pinnedSid ??= directory.sid;
    evidence(c.slotDirectory, validated.expected, archive, ref.slotFileId);
  };

  const snapshotInput = (
    path: string,
    expected: ExpectedDirectory,
    fileId: string,
    volumeId: string,
    attemptId: string,
  ): Buffer =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        operation: "snapshot",
        path,
        root,
        rootFileId: expected.rootFileId,
        rootVolumeId: expected.rootVolumeId,
        directoryFileId: expected.directoryFileId,
        directoryVolumeId: expected.directoryVolumeId,
        fileId,
        volumeId,
        attemptId,
        profile,
      }),
      "utf8",
    );

  return Object.freeze({
    inspectEvidence(): readonly Json[] {
      return Object.freeze(attempts.map(attemptEvidence));
    },
    withSnapshot(
      request: WindowsHotJournalSnapshotRequest,
      callback: (snapshotPath: string) => void,
    ): void {
      if (stablePoison !== undefined) throw stablePoison;
      if (active) throw poison(); // Reentrancy is a permanent boundary failure.
      let path: string, parent: string, expected: ExpectedDirectory;
      let fileId: string, volumeId: string;
      try {
        const validated = validateRequest(request);
        path = validated.path;
        parent = validated.parent;
        expected = validated.expected;
        fileId = validated.fileId;
        volumeId = validated.volumeId;
        if (isAsyncLike(callback)) { poison(); fail("CALLBACK"); }
        assertPin();
        if (attempts.length >= WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS)
          fail("CONSUMED");
      } catch (error) {
        if (error instanceof WindowsHotJournalSnapshotError) throw error;
        fail("REJECTED");
      }
      const attemptId = randomBytes(16).toString("hex");
      const attempt: ActiveAttempt = { attemptId, path, events: [] };
      attempts.push(attempt);
      activeAttempt = attempt;
      active = true;
      let semanticFailure: { error: unknown } | undefined;
      try {
        // Operation 1: acquire every present source read-only and copy into
        // the fixed slot; the reply's manifest is the snapshot evidence.
        const input = snapshotInput(
          path,
          expected,
          fileId,
          volumeId,
          attemptId,
        );
        if (input.byteLength > WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES)
          fail("WIRE_SIZE");
        const dispatched = invoke("snapshot", input);
        if (!dispatched.ok) fail("UNKNOWN");
        const r = dispatched.response,
          status = dispatched.status;
        if (r.state !== "SNAPSHOT") {
          checkEnvelope(r, "snapshot", path, attemptId);
          const state = failureState(r, status);
          if (state === "REJECTED") fail("REJECTED");
          fail("UNKNOWN");
        }
        let slot: number, snapshotDirectory: string, snapshotPath: string;
        let slotFileId: string, slotVolumeId: string;
        let sources: SourceEntry[];
        try {
          record(r, [
            ...baseKeys,
            "profile",
            "slot",
            "snapshotDirectory",
            "snapshotPath",
            "sources",
            "directory",
            "slotDirectory",
          ]);
          checkEnvelope(r, "snapshot", path, attemptId);
          if (r.profile !== profile || status !== 0) fail("RECEIPT");
          slot = boundedSize(r.slot, WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS - 1);
          snapshotDirectory = canonical(
            r.snapshotDirectory,
            root,
          );
          if (
            !same(
              snapshotDirectory,
              childOf(parent, `${WINDOWS_HOT_JOURNAL_SLOT_PREFIX}${slot}`),
            )
          )
            fail("SLOT");
          snapshotPath = canonical(r.snapshotPath, root);
          if (
            !same(snapshotPath, childOf(snapshotDirectory, "snapshot.sqlite")) ||
            same(snapshotPath, path)
          )
            fail("SLOT");
          const directory = evidence(r.directory, expected, parent, expected.directoryFileId);
          if (!same(directory.volumeId, expected.directoryVolumeId))
            fail("EVIDENCE");
          const slotEvidence = evidence(
            r.slotDirectory,
            expected,
            snapshotDirectory,
          );
          if (directory.sid !== slotEvidence.sid) fail("EVIDENCE");
          pinnedSid = slotEvidence.sid;
          slotFileId = slotEvidence.fileId;
          slotVolumeId = slotEvidence.volumeId;
          // Pin the SID before checking *every* source, including the first
          // reply; otherwise a mixed-SID source manifest could be accepted.
          sources = manifest(r.sources, expected, path, fileId);
        } catch (error) {
          if (error instanceof WindowsHotJournalSnapshotError) throw error;
          fail("UNKNOWN");
        }

        // The caller callback runs exactly once synchronously on the working
        // copy only. A callback failure skips the success revalidation; the
        // retained slot keeps the immutable intent/raw evidence either way.
        let callbackError: unknown;
        let callbackFailed = false;
        let malformedReturn = false;
        try {
          const result = callback(snapshotPath);
          if (utilTypes.isPromise(result)) quietlyConsume(result);
          malformedReturn = result !== undefined;
        } catch (error) {
          callbackFailed = true;
          callbackError = error;
          semanticFailure = { error };
        }
        recordEvent(
          "callback",
          undefined,
          undefined,
          callbackFailed
            ? "failed"
            : malformedReturn
              ? "malformed"
              : "ok",
        );
        if (malformedReturn) throw poison();
        if (callbackFailed) throw callbackError;

        // Operation 2: reacquire all source handles and prove the saved
        // manifest still holds (presence, File ID, volume, length, SHA-256).
        const revalidateInput = Buffer.from(
          JSON.stringify({
            version: 1,
            operation: "revalidate",
            path,
            root,
            rootFileId: expected.rootFileId,
            rootVolumeId: expected.rootVolumeId,
            directoryFileId: expected.directoryFileId,
            directoryVolumeId: expected.directoryVolumeId,
            fileId,
            volumeId,
            attemptId,
            profile,
            slot,
            slotFileId,
            slotVolumeId,
          }),
          "utf8",
        );
        if (revalidateInput.byteLength > WINDOWS_HOT_JOURNAL_MAX_WIRE_BYTES)
          fail("WIRE_SIZE");
        const revalidated = invoke("revalidate", revalidateInput);
        if (!revalidated.ok) fail("UNKNOWN");
        const c = revalidated.response,
          revalidateStatus = revalidated.status;
        if (c.state !== "REVALIDATED") {
          checkEnvelope(c, "revalidate", path, attemptId);
          const state = failureState(c, revalidateStatus);
          if (state === "REJECTED") fail("REJECTED");
          fail("UNKNOWN");
        }
        try {
          record(c, [
            ...baseKeys,
            "profile",
            "slot",
            "sources",
            "directory",
            "slotDirectory",
          ]);
          checkEnvelope(c, "revalidate", path, attemptId);
          if (c.profile !== profile || revalidateStatus !== 0 || c.slot !== slot)
            fail("RECEIPT");
          const again = manifest(c.sources, expected, path, fileId);
          if (!sameManifest(sources, again)) fail("REVALIDATED_MISMATCH");
          evidence(c.directory, expected, parent, expected.directoryFileId);
          evidence(c.slotDirectory, expected, snapshotDirectory, slotFileId);
        } catch (error) {
          if (error instanceof WindowsHotJournalSnapshotError) throw error;
          fail("UNKNOWN");
        }
        // Operation 3 (seal): persist the exact captured request wires and
        // pipe bytes of operations 1 and 2 as immutable captures.json before
        // the attempt counts as complete. Seal failure is UNKNOWN, never a
        // silent unsealed success.
        const snapshotEvent = attempt.events.find(
          (event) => event.phase === "snapshot",
        );
        const revalidateEvent = attempt.events.find(
          (event) => event.phase === "revalidate",
        );
        const capturedStdout = (
          event: { captured?: Json } | undefined,
        ): string => {
          const captured = event?.captured;
          if (
            typeof captured !== "object" ||
            captured === null ||
            typeof (captured as Record<string, unknown>).stdout !== "string"
          )
            fail("CAPTURE");
          return Buffer.from(
            (captured as Record<string, unknown>).stdout as string,
            "latin1",
          ).toString("base64");
        };
        const sealInput = Buffer.from(
          JSON.stringify({
            version: 1,
            operation: "seal",
            path,
            root,
            rootFileId: expected.rootFileId,
            rootVolumeId: expected.rootVolumeId,
            directoryFileId: expected.directoryFileId,
            directoryVolumeId: expected.directoryVolumeId,
            fileId,
            volumeId,
            attemptId,
            profile,
            slot,
            slotFileId,
            slotVolumeId,
            captures: {
              snapshot: {
                request: input.toString("base64"),
                response: capturedStdout(snapshotEvent),
                stderr: "", // Successful native replies require exact empty stderr.
              },
              revalidate: {
                request: revalidateInput.toString("base64"),
                response: capturedStdout(revalidateEvent),
                stderr: "",
              },
            },
          }),
          "utf8",
        );
        if (sealInput.byteLength > WINDOWS_HOT_JOURNAL_LIFECYCLE_WIRE_BYTES)
          fail("WIRE_SIZE");
        const sealed = invoke("seal", sealInput);
        if (!sealed.ok) fail("UNKNOWN");
        const s = sealed.response,
          sealStatus = sealed.status;
        if (s.state !== "SEALED") {
          checkEnvelope(s, "seal", path, attemptId);
          const state = failureState(s, sealStatus);
          if (state === "REJECTED") fail("REJECTED");
          fail("UNKNOWN");
        }
        try {
          record(s, [
            ...baseKeys,
            "profile",
            "slot",
            "directory",
            "slotDirectory",
          ]);
          checkEnvelope(s, "seal", path, attemptId);
          if (s.profile !== profile || sealStatus !== 0 || s.slot !== slot)
            fail("RECEIPT");
          evidence(s.directory, expected, parent, expected.directoryFileId);
          evidence(s.slotDirectory, expected, snapshotDirectory, slotFileId);
        } catch (error) {
          if (error instanceof WindowsHotJournalSnapshotError) throw error;
          fail("UNKNOWN");
        }
        recordEvent("complete", undefined, undefined, "SEALED");
      } catch (error) {
        // Helper/parser failures retain this controller's exact capture.
        // Semantic errors keep their identity; inspectEvidence still exposes
        // their immutable attempt without a module-global mutable context.
        if (semanticFailure !== undefined && error === semanticFailure.error) throw error;
        if (error instanceof WindowsHotJournalSnapshotError && error !== stablePoison && error.evidence === null)
          throw new WindowsHotJournalSnapshotError(error.code, attemptEvidence(attempt));
        throw error;
      } finally {
        activeAttempt = null;
        active = false;
      }
    },
    inspectSnapshot(
      request: WindowsHotJournalSnapshotRequest,
      reference: WindowsHotJournalSnapshotReference,
      archived = false,
    ): WindowsHotJournalSnapshotInspection {
      if (stablePoison !== undefined) throw stablePoison;
      if (active) throw poison();
      let validated: ValidatedRequest;
      let ref: WindowsHotJournalSnapshotReference;
      try {
        validated = validateRequest(request);
        ref = validateReference(reference);
        if (typeof archived !== "boolean" || !same(ref.slotVolumeId, validated.volumeId)) fail("REFERENCE");
        assertPin();
        if (attempts.length >= WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS)
          fail("CONSUMED");
      } catch (error) {
        if (error instanceof WindowsHotJournalSnapshotError) throw error;
        fail("REJECTED");
      }
      // The inspected attempt binds the retained slot's original attemptId,
      // not a fresh one; the event record still joins this controller's
      // bounded evidence list.
      const attempt: ActiveAttempt = {
        attemptId: ref.attemptId,
        path: validated.path,
        events: [],
      };
      attempts.push(attempt);
      activeAttempt = attempt;
      active = true;
      try {
        const input = lifecycleInput("inspect", validated, ref.attemptId, ref, archived ? {archived: true} : {});
        if (input.byteLength > WINDOWS_HOT_JOURNAL_LIFECYCLE_WIRE_BYTES)
          fail("WIRE_SIZE");
        const dispatched = invoke("inspect", input);
        if (!dispatched.ok) fail("UNKNOWN");
        const r = dispatched.response,
          status = dispatched.status;
        if (r.state !== "INSPECTED") {
          checkEnvelope(r, "inspect", validated.path, ref.attemptId);
          const state = failureState(r, status);
          if (state === "REJECTED") fail("REJECTED");
          fail("UNKNOWN");
        }
        let inspection: WindowsHotJournalSnapshotInspection;
        try {
          const c = record(r, [
            ...baseKeys,
            "profile",
            "slot",
            "fingerprint",
            "inspectionState",
            "evidence",
          ]);
          checkEnvelope(c, "inspect", validated.path, ref.attemptId);
          if (
            c.profile !== profile ||
            status !== 0 ||
            c.slot !== ref.slot ||
            (c.inspectionState !== "REVALIDATED" &&
              c.inspectionState !== "UNKNOWN" &&
              c.inspectionState !== "RELEASED") ||
            (c.inspectionState === "RELEASED" && !archived) ||
            (c.inspectionState === "REVALIDATED" && archived)
          )
            fail("RECEIPT");
          const fingerprint = text(c.fingerprint, HASH);
          const ev = record(c.evidence, [
            "reference",
            "sources",
            "files",
            "directory",
            "slotDirectory",
          ]);
          const nativeReference = record(ev.reference, [
            "attemptId",
            "slot",
            "slotFileId",
            "slotVolumeId",
          ]);
          if (
            nativeReference.attemptId !== ref.attemptId ||
            nativeReference.slot !== ref.slot ||
            !same(nativeReference.slotFileId as string, ref.slotFileId) ||
            !same(nativeReference.slotVolumeId as string, ref.slotVolumeId)
          )
            fail("REFERENCE");
          if (
            !Array.isArray(ev.sources) ||
            (ev.sources.length !== SOURCE_SUFFIXES.length && !(c.inspectionState === "UNKNOWN" && ev.sources.length === 0)) ||
            !Array.isArray(ev.files) ||
            ev.files.length > 16
          )
            fail("EVIDENCE");
          const directory = evidence(
            ev.directory,
            validated.expected,
            validated.parent,
            validated.expected.directoryFileId,
          );
          pinnedSid ??= directory.sid;
          const ready = c.inspectionState !== "UNKNOWN";
          if (ready && ev.slotDirectory === null) fail("EVIDENCE");
          if (ev.sources.length > 0) {
            // An UNKNOWN result can legitimately lack the original main file.
            if (ready || (ev.sources[0] as {present?: unknown})?.present === true)
              manifest(ev.sources, validated.expected, validated.path, validated.fileId);
          }
          const names = new Set<string>();
          for (const file of ev.files) {
            const f = record(file, ["name", "present", "fileId", "volumeId", "byteLength", "sha256"]);
            const name = text(f.name, /^(?:(?:intent|prepared|revalidated|revalidation-failed|captures|release-intent|released|release-capture)\.json|(?:source|snapshot)\.sqlite(?:-journal|-wal|-shm)?)$/);
            if (names.has(name) || f.present !== true || !same(text(f.volumeId, VOLUME_ID), validated.volumeId)) fail("EVIDENCE");
            names.add(name); text(f.fileId, FILE_ID); text(f.sha256, HASH);
            boundedSize(f.byteLength, name.endsWith(".json") ? WINDOWS_HOT_JOURNAL_LIFECYCLE_WIRE_BYTES :
              name.endsWith(".sqlite") ? profileLimits.mainBytes : profileLimits.sidecarBytes);
          }
          if (ready && (["intent.json", "prepared.json", "revalidated.json", "captures.json", "source.sqlite"].some(name => !names.has(name)) ||
              names.has("revalidation-failed.json") || (!archived && (names.has("release-intent.json") || names.has("released.json"))) ||
              (archived && ["release-intent.json", "released.json", "release-capture.json"].some(name => !names.has(name)))))
            fail("EVIDENCE");
          // A released/absent slot reports a null slotDirectory; a present
          // slot must prove the exact pinned slot identity.
          if (ev.slotDirectory !== null)
            evidence(
              ev.slotDirectory,
              validated.expected,
              childOf(
                validated.parent,
                archived ? `${WINDOWS_HOT_JOURNAL_ARCHIVE_PREFIX}${ref.attemptId}` : `${WINDOWS_HOT_JOURNAL_SLOT_PREFIX}${ref.slot}`,
              ),
              ref.slotFileId,
            );
          inspection = Object.freeze({
            reference: Object.freeze({
              attemptId: ref.attemptId,
              slot: ref.slot,
              slotFileId: ref.slotFileId,
              slotVolumeId: ref.slotVolumeId,
            }),
            state: c.inspectionState as "REVALIDATED" | "RELEASED" | "UNKNOWN",
            fingerprint,
            evidence: freezeJson(ev as Json),
          });
        } catch (error) {
          if (error instanceof WindowsHotJournalSnapshotError) throw error;
          fail("UNKNOWN");
        }
        recordEvent("complete", undefined, undefined, "INSPECTED");
        return inspection;
      } catch (error) {
        if (error instanceof WindowsHotJournalSnapshotError && error !== stablePoison && error.evidence === null)
          throw new WindowsHotJournalSnapshotError(error.code, attemptEvidence(attempt));
        throw error;
      } finally {
        activeAttempt = null;
        active = false;
      }
    },
    releaseSnapshot(
      request: WindowsHotJournalSnapshotRequest,
      inspection: WindowsHotJournalSnapshotInspection,
      authority: WindowsHotJournalSnapshotReleaseAuthority,
    ): void {
      if (stablePoison !== undefined) throw stablePoison;
      if (active) throw poison();
      let validated: ValidatedRequest;
      let ref: WindowsHotJournalSnapshotReference;
      let fingerprint: string;
      let auth: { fingerprint: string; assertCurrent(): void };
      try {
        validated = validateRequest(request);
        const i = record(inspection, [
          "reference",
          "state",
          "fingerprint",
          "evidence",
        ]);
        if (i.state !== "REVALIDATED") fail("INSPECTION");
        ref = validateReference(
          i.reference as WindowsHotJournalSnapshotReference,
        );
        if (!same(ref.slotVolumeId, validated.volumeId)) fail("REFERENCE");
        if (consumedReleases.has(`${validated.path}|${ref.attemptId}|${ref.slotFileId}`)) fail("CONSUMED");
        fingerprint = text(i.fingerprint, HASH);
        auth = validateAuthority(authority);
        assertPin();
        if (attempts.length >= WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS)
          fail("CONSUMED");
      } catch (error) {
        if (error instanceof WindowsHotJournalSnapshotError) throw error;
        fail("REJECTED");
      }
      const attempt: ActiveAttempt = {
        attemptId: ref.attemptId,
        path: validated.path,
        events: [],
      };
      attempts.push(attempt);
      activeAttempt = attempt;
      active = true;
      try {
        // The trusted authority re-proves its own current state immediately
        // before native dispatch and again after the response.
        const input = lifecycleInput("release", validated, ref.attemptId, ref, {
          fingerprint,
          authorityFingerprint: auth.fingerprint,
          inspectionState: "REVALIDATED",
        });
        if (input.byteLength > WINDOWS_HOT_JOURNAL_LIFECYCLE_WIRE_BYTES)
          fail("WIRE_SIZE");
        consumedReleases.add(`${validated.path}|${ref.attemptId}|${ref.slotFileId}`);
        const dispatched = invoke("release", input, () => invokeAuthority(auth.assertCurrent));
        if (!dispatched.ok) fail("UNKNOWN");
        const r = dispatched.response,
          status = dispatched.status;
        if (r.state !== "RELEASED") {
          checkEnvelope(r, "release", validated.path, ref.attemptId);
          const state = failureState(r, status);
          if (state === "REJECTED") fail("REJECTED");
          fail("UNKNOWN");
        }
        try {
          const c = record(r, [
            ...baseKeys,
            "profile",
            "slot",
            "archive",
            "fingerprint",
            "directory",
            "slotDirectory",
          ]);
          checkEnvelope(c, "release", validated.path, ref.attemptId);
          if (
            c.profile !== profile ||
            status !== 0 ||
            c.slot !== ref.slot ||
            c.fingerprint !== fingerprint
          )
            fail("RECEIPT");
          const archive = canonical(c.archive, root);
          if (
            !same(
              archive,
              childOf(
                validated.parent,
                `${WINDOWS_HOT_JOURNAL_ARCHIVE_PREFIX}${ref.attemptId}`,
              ),
            )
          )
            fail("ARCHIVE");
          const directory = evidence(c.directory, validated.expected, validated.parent, validated.expected.directoryFileId);
          pinnedSid ??= directory.sid;
          evidence(c.slotDirectory, validated.expected, archive, ref.slotFileId);
        } catch (error) {
          if (error instanceof WindowsHotJournalSnapshotError) throw error;
          fail("UNKNOWN");
        }
        // Post-response authority check: identity loss after the mutation is
        // surfaced, never silently accepted.
        const releaseEvent = attempt.events.find(event => event.phase === "release")!;
        const captured = record(releaseEvent.captured, ["status", "signal", "stdout", "stderr", "requestBase64"], ["captureEncoding"]);
        commitCapture(validated, ref, {
          request: input.toString("base64"),
          response: Buffer.from(captured.stdout as string, "latin1").toString("base64"),
          stderr: Buffer.from(captured.stderr as string, "latin1").toString("base64"),
        });
        invokeAuthority(auth.assertCurrent);
        recordEvent("complete", undefined, undefined, "RELEASED");
      } catch (error) {
        poison(); // No second release dispatch after any uncertain completion.
        if (error instanceof WindowsHotJournalSnapshotError && error !== stablePoison && error.evidence === null)
          throw new WindowsHotJournalSnapshotError(error.code, attemptEvidence(attempt));
        throw error;
      } finally {
        activeAttempt = null;
        active = false;
      }
    },
    commitReleaseEvidence(
      request: WindowsHotJournalSnapshotRequest,
      reference: WindowsHotJournalSnapshotReference,
      captureValue: WindowsHotJournalReleaseCapture,
    ): void {
      if (stablePoison !== undefined) throw stablePoison;
      if (active) throw poison();
      const validated = validateRequest(request), ref = validateReference(reference);
      if (!same(ref.slotVolumeId, validated.volumeId)) fail("REFERENCE");
      if (attempts.length >= WINDOWS_HOT_JOURNAL_SNAPSHOT_SLOTS) fail("CONSUMED");
      const attempt: ActiveAttempt = {attemptId: ref.attemptId, path: validated.path, events: []};
      attempts.push(attempt); activeAttempt = attempt; active = true;
      try { commitCapture(validated, ref, captureValue); }
      catch (error) {
        poison();
        if (error instanceof WindowsHotJournalSnapshotError && error.evidence === null)
          throw new WindowsHotJournalSnapshotError(error.code, attemptEvidence(attempt));
        throw error;
      } finally { active = false; activeAttempt = null; }
    },
  });
}

function pinExecutable(
  fs: WindowsHotJournalSnapshotTestPort["fs"],
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
    const before = stat(),
      bytes = fs.readFile(path),
      after = stat();
    if (
      bytes.byteLength !== before.size ||
      createHash("sha256").update(bytes).digest("hex") !== hash ||
      !samePin(before, after)
    )
      fail("HELPER_UNTRUSTED");
    return after;
  } catch {
    return fail("HELPER_UNTRUSTED");
  }
}
