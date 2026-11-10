import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { CollaborationError } from "../../collaboration/runtime/contract";
import { isValidPrivateLedgerName } from "../../sync/private-platform";
import type { RuntimeStorePlatform } from "../runtime-store-platform";
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

export const WINDOWS_RUNTIME_FILE = "shared-runtime.sqlite";
export const WINDOWS_RUNTIME_TRUST_BOUNDARY =
  "Injected filesystem and probe ports are untrusted contract checks, not proof of Windows filesystem safety.";

const EXE_PATTERN = /\.exe$/i;
const ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const FILE_ID_PATTERN = /^[0-9A-Fa-f]{32}$/;
const VOLUME_ID_PATTERN = /^[0-9A-Fa-f]{16}$/;
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

export type WindowsRuntimeFileStat = Readonly<{
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  nlink: number;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}>;

export type WindowsRuntimeFsPort = Readonly<{
  lstat(path: string): WindowsRuntimeFileStat;
  readFile(path: string): Uint8Array;
  openReadWrite(path: string): number;
  fsync(fd: number): void;
  close(fd: number): void;
}>;

export type WindowsRuntimeRootIdentity = Readonly<{
  rootFileId: string;
  volumeId: string;
}>;

export type WindowsRuntimeDirectoryIdentity = Readonly<{
  fileId: string;
  volumeId: string;
}>;

export type WindowsRuntimeProbePort = Readonly<{
  probe(path: string, root: string): unknown;
  create?(path: string, root: string): unknown;
  open?(path: string, root: string): unknown;
  directory?(path: string, root: string): unknown;
}>;

export type WindowsRuntimeUntrustedTestPort = Readonly<{
  fs?: WindowsRuntimeFsPort;
  probe?: WindowsRuntimeProbePort;
}>;

export type WindowsRuntimePlatformOptions = Readonly<{
  root: string;
  probeExecutable: string;
  systemRoot: string;
  databaseName?: string;
  expectedHash?: string;
  expectedRoot?: WindowsRuntimeRootIdentity;
  expectedDirectory?: WindowsRuntimeDirectoryIdentity;
  untrustedTestPort?: WindowsRuntimeUntrustedTestPort;
}>;

type ExecutablePin = Readonly<{
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  expectedHash: string | undefined;
}>;

type RootPin = Readonly<{
  directory: string;
  root: string;
  directoryFileId: string;
  directoryVolumeId: string;
  rootFileId: string;
  rootVolumeId: string;
}>;

type DatabasePin = Readonly<{
  canonicalPath: string;
  fileId: string;
  volumeId: string;
}>;

export type WindowsRuntimePreparedDirectory = Readonly<{
  canonicalPath: string;
  directoryFileId: string;
  directoryVolumeId: string;
  rootFileId: string;
  rootVolumeId: string;
}>;

export type WindowsRuntimeFileIdentity = Readonly<{
  canonicalPath: string;
  fileId: string;
  volumeId: string;
}>;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as NodeJS.ErrnoException).code;
  return typeof value === "string" ? value : undefined;
}

function canonicalAbsolute(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !ABSOLUTE_PATTERN.test(value)
  )
    fail(code);
  try {
    return validateWindowsPath(value, `${value[0].toUpperCase()}:\\`).canonical;
  } catch (error) {
    if (error instanceof CollaborationError) fail(code);
    throw error;
  }
}

function canonicalRoot(value: unknown, code: string): string {
  const canonical = canonicalAbsolute(value, code);
  try {
    return validateWindowsPath(canonical, canonical).canonical;
  } catch {
    fail(code);
  }
}

const NODE_FS: WindowsRuntimeFsPort = Object.freeze({
  lstat: (path: string): Stats => lstatSync(path),
  readFile: (path: string): Uint8Array => readFileSync(path),
  openReadWrite: (path: string): number => openSync(path, "r+"),
  fsync: (fd: number): void => fsyncSync(fd),
  close: (fd: number): void => closeSync(fd),
});

type SpawnResult = Readonly<{
  error?: Error;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | Buffer | null;
  stderr: string | Buffer | null;
}>;

function readResult(result: SpawnResult): unknown {
  if (result.error !== undefined) {
    const code = errorCode(result.error);
    if (code === "ETIMEDOUT") fail("PROBE_TIMEOUT");
    if (code === "ENOBUFS") fail("PROBE_OUTPUT_LIMIT");
    fail("PROBE_EXEC_FAILED");
  }
  if (result.status !== 0) fail("PROBE_EXIT");
  if (result.signal !== null) fail("PROBE_SIGNAL");
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (stderr !== "") fail("PROBE_STDERR");
  if (stdout.length === 0) fail("PROBE_OUTPUT");
  if (
    new TextEncoder().encode(stdout).byteLength > WINDOWS_PROBE_MAX_OUTPUT_BYTES
  )
    fail("PROBE_OUTPUT_LIMIT");
  try {
    return JSON.parse(stdout);
  } catch {
    fail("PROBE_JSON");
  }
}

function spawnCompiledProbe(
  executable: string,
  systemRoot: string,
  path: string,
  root: string,
  mode?: "create" | "open" | "directory",
): SpawnResult {
  const args = mode === undefined ? [path, root] : [path, root, mode];
  return spawnSync(executable, args, {
    cwd: systemRoot,
    env: {
      SystemRoot: systemRoot,
      windir: systemRoot,
      TEMP: `${systemRoot}\\Temp`,
      TMP: `${systemRoot}\\Temp`,
    },
    timeout: WINDOWS_PROBE_TIMEOUT_MS,
    maxBuffer: WINDOWS_PROBE_MAX_OUTPUT_BYTES,
    windowsHide: true,
    shell: false,
    encoding: "utf8",
  });
}

function invokeCompiledProbe(
  executable: string,
  systemRoot: string,
  path: string,
  root: string,
): unknown {
  return readResult(spawnCompiledProbe(executable, systemRoot, path, root));
}

function identityHex(value: unknown, pattern: RegExp, code: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(code);
  return value as string;
}

const EVIDENCE_KEYS = [
  "canonicalPath",
  "canonicalRoot",
  "daclPrivate",
  "fileId",
  "linkCount",
  "localFilesystem",
  "ownerSid",
  "platform",
  "reparsePoint",
  "rootFileId",
  "rootVolumeId",
  "sid",
  "volumeId",
] as const;

function evidenceSubset(record: Record<string, unknown>): unknown {
  const evidence: Record<string, unknown> = {};
  for (const key of EVIDENCE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      fail("PROBE_INVALID");
    evidence[key] = descriptor.value;
  }
  return evidence;
}

/**
 * Create/open results carry the evidence plus a typed state. An UNKNOWN create
 * is a distinct outcome from an ordinary probe failure and must stay visible.
 */
function readCreateOrOpenResult(result: SpawnResult): Record<string, unknown> {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (stdout.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).state === "UNKNOWN"
    ) {
      const reason = (parsed as Record<string, unknown>).reason;
      if (reason === "EXISTS") fail("WINDOWS_PRIVATE_CREATE_RACE");
      fail("WINDOWS_PRIVATE_CREATE_UNKNOWN");
    }
  }
  const raw = readResult(result);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    fail("PROBE_INVALID");
  return raw as Record<string, unknown>;
}

function readDirectoryResult(result: SpawnResult): Record<string, unknown> {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  if (stdout.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).state === "UNKNOWN"
    )
      fail("WINDOWS_PRIVATE_DIRECTORY_UNKNOWN");
  }
  return readCreateOrOpenResult(result);
}

function sameStat(
  left: WindowsRuntimeFileStat,
  right: WindowsRuntimeFileStat,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export class WindowsRuntimePlatform implements RuntimeStorePlatform {
  readonly #fs: WindowsRuntimeFsPort;
  readonly #probePort: WindowsRuntimeProbePort | undefined;
  readonly #executable: string;
  readonly #systemRoot: string;
  readonly #root: string;
  readonly databaseName: string;
  readonly #requireDatabaseName: boolean;
  readonly #expectedHash: string | undefined;
  readonly #expectedRoot: WindowsRuntimeRootIdentity | undefined;
  readonly #expectedDirectory: WindowsRuntimeDirectoryIdentity | undefined;
  #executablePin: ExecutablePin | undefined;
  #rootPin: RootPin | undefined;
  #preparedDirectory: WindowsRuntimePreparedDirectory | undefined;
  readonly #filePins = new Map<string, DatabasePin>();
  readonly #sidecarPins = new Map<string, DatabasePin>();
  #closed = false;

  constructor(options: WindowsRuntimePlatformOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    )
      fail("INVALID_WINDOWS_RUNTIME_OPTIONS");
    this.#root = canonicalRoot(options.root, "INVALID_WINDOWS_ROOT");
    this.#systemRoot = canonicalRoot(options.systemRoot, "INVALID_SYSTEM_ROOT");
    const databaseName =
      options.databaseName !== undefined
        ? options.databaseName
        : WINDOWS_RUNTIME_FILE;
    if (!isValidPrivateLedgerName(databaseName)) fail("INVALID_DATABASE_NAME");
    this.databaseName = databaseName as string;
    // The default name is still shared-runtime.sqlite, and the bound runtime is
    // always restricted to its configured basename so no per-call name can
    // escape the prepared private directory contract.
    this.#requireDatabaseName = true;
    const executable = canonicalAbsolute(
      options.probeExecutable,
      "INVALID_PROBE_EXECUTABLE",
    );
    if (!EXE_PATTERN.test(executable)) fail("INVALID_PROBE_EXECUTABLE");
    this.#executable = executable;
    if (options.expectedHash !== undefined) {
      if (
        typeof options.expectedHash !== "string" ||
        !HASH_PATTERN.test(options.expectedHash)
      )
        fail("INVALID_PROBE_HASH");
      this.#expectedHash = options.expectedHash;
    } else {
      this.#expectedHash = undefined;
    }
    if (options.expectedRoot !== undefined) {
      if (
        typeof options.expectedRoot !== "object" ||
        options.expectedRoot === null ||
        Array.isArray(options.expectedRoot)
      )
        fail("INVALID_EXPECTED_ROOT");
      this.#expectedRoot = Object.freeze({
        rootFileId: identityHex(
          options.expectedRoot.rootFileId,
          FILE_ID_PATTERN,
          "INVALID_EXPECTED_ROOT",
        ),
        volumeId: identityHex(
          options.expectedRoot.volumeId,
          VOLUME_ID_PATTERN,
          "INVALID_EXPECTED_ROOT",
        ),
      });
    } else {
      this.#expectedRoot = undefined;
    }
    if (options.expectedDirectory !== undefined) {
      if (
        typeof options.expectedDirectory !== "object" ||
        options.expectedDirectory === null ||
        Array.isArray(options.expectedDirectory)
      )
        fail("INVALID_EXPECTED_DIRECTORY");
      this.#expectedDirectory = Object.freeze({
        fileId: identityHex(
          options.expectedDirectory.fileId,
          FILE_ID_PATTERN,
          "INVALID_EXPECTED_DIRECTORY",
        ),
        volumeId: identityHex(
          options.expectedDirectory.volumeId,
          VOLUME_ID_PATTERN,
          "INVALID_EXPECTED_DIRECTORY",
        ),
      });
    } else {
      this.#expectedDirectory = undefined;
    }

    const untrusted = options.untrustedTestPort;
    if (untrusted !== undefined) {
      if (
        typeof untrusted !== "object" ||
        untrusted === null ||
        Array.isArray(untrusted)
      )
        fail("INVALID_WINDOWS_TEST_PORT");
      if (untrusted.fs !== undefined) {
        if (
          typeof untrusted.fs !== "object" ||
          untrusted.fs === null ||
          Array.isArray(untrusted.fs)
        )
          fail("INVALID_WINDOWS_TEST_PORT");
        const fs = untrusted.fs as Record<string, unknown>;
        for (const key of [
          "lstat",
          "readFile",
          "openReadWrite",
          "fsync",
          "close",
        ])
          if (typeof fs[key] !== "function") fail("INVALID_WINDOWS_TEST_PORT");
      }
      if (untrusted.probe !== undefined) {
        if (
          typeof untrusted.probe !== "object" ||
          untrusted.probe === null ||
          Array.isArray(untrusted.probe) ||
          typeof untrusted.probe.probe !== "function"
        )
          fail("INVALID_WINDOWS_TEST_PORT");
        for (const key of ["create", "open", "directory"]) {
          const method = (untrusted.probe as Record<string, unknown>)[key];
          if (method !== undefined && typeof method !== "function")
            fail("INVALID_WINDOWS_TEST_PORT");
        }
      }
      this.#fs = untrusted.fs ?? NODE_FS;
      this.#probePort = untrusted.probe;
      if (this.#expectedHash !== undefined) {
        if (untrusted.fs === undefined) fail("INVALID_WINDOWS_TEST_PORT");
        this.#executablePin = this.#readExecutablePin();
      }
      return;
    }

    if (process.platform !== "win32") fail("NATIVE_PLATFORM_MISMATCH");
    this.#fs = NODE_FS;
    this.#probePort = undefined;
    this.#executablePin = this.#readExecutablePin();
  }

  #lstatExecutable(): WindowsRuntimeFileStat {
    let stat: WindowsRuntimeFileStat;
    try {
      stat = this.#fs.lstat(this.#executable);
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        fail("WINDOWS_PROBE_EXECUTABLE_MISSING");
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      fail("WINDOWS_PROBE_EXECUTABLE_UNSAFE");
    return stat;
  }

  #hashExecutable(): string {
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.#fs.readFile(this.#executable);
    } catch (error) {
      if (errorCode(error) === "ENOENT")
        fail("WINDOWS_PROBE_EXECUTABLE_MISSING");
      fail("WINDOWS_PROBE_EXECUTABLE_READ");
    }
    if (!(bytes instanceof Uint8Array)) fail("WINDOWS_PROBE_EXECUTABLE_READ");
    return createHash("sha256").update(bytes).digest("hex");
  }

  #readExecutablePin(): ExecutablePin {
    const stat = this.#lstatExecutable();
    const expectedHash = this.#expectedHash;
    if (expectedHash !== undefined && this.#hashExecutable() !== expectedHash)
      fail("WINDOWS_PROBE_EXECUTABLE_HASH");
    return Object.freeze({
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      expectedHash,
    });
  }

  #assertExecutable(): void {
    const pin = this.#executablePin;
    if (pin === undefined) return;
    const stat = this.#lstatExecutable();
    if (
      stat.dev !== pin.dev ||
      stat.ino !== pin.ino ||
      stat.size !== pin.size ||
      stat.mtimeMs !== pin.mtimeMs
    )
      fail("WINDOWS_PROBE_EXECUTABLE_CHANGED");
    if (
      pin.expectedHash !== undefined &&
      this.#hashExecutable() !== pin.expectedHash
    )
      fail("WINDOWS_PROBE_EXECUTABLE_HASH");
  }

  #assertOpen(): void {
    if (this.#closed) fail("WINDOWS_PLATFORM_CLOSED");
  }

  #lstat(path: string): WindowsRuntimeFileStat {
    return this.#fs.lstat(path);
  }

  #lstatDirectory(path: string, missingCode: string): WindowsRuntimeFileStat {
    let stat: WindowsRuntimeFileStat;
    try {
      stat = this.#lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") fail(missingCode);
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail("WINDOWS_PRIVATE_ROOT_UNSAFE");
    return stat;
  }

  #lstatFile(path: string): WindowsRuntimeFileStat {
    let stat: WindowsRuntimeFileStat;
    try {
      stat = this.#lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") fail("WINDOWS_DATABASE_MISSING");
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
      fail("WINDOWS_DATABASE_UNSAFE");
    return stat;
  }

  #probe(path: string, root: string): WindowsProbeEvidence {
    this.#assertExecutable();
    const target = validateWindowsPath(path, root);
    const canonicalRoot = validateWindowsPath(root, root).canonical;
    const expectation = Object.freeze({
      canonicalPath: target.canonical,
      canonicalRoot,
    });
    let raw: unknown;
    try {
      if (this.#probePort === undefined) {
        raw = invokeCompiledProbe(
          this.#executable,
          this.#systemRoot,
          target.canonical,
          canonicalRoot,
        );
      } else {
        raw = this.#probePort.probe(target.canonical, canonicalRoot);
      }
    } catch (error) {
      if (error instanceof CollaborationError) throw error;
      fail("PROBE_FAILED");
    }
    assertWindowsProbe(raw, expectation);
    return raw as WindowsProbeEvidence;
  }

  #assertExpectedRoot(evidence: WindowsProbeEvidence): void {
    const expectedRoot = this.#expectedRoot;
    if (
      expectedRoot !== undefined &&
      (asciiCaseFold(evidence.rootFileId) !==
        asciiCaseFold(expectedRoot.rootFileId) ||
        asciiCaseFold(evidence.volumeId) !==
          asciiCaseFold(expectedRoot.volumeId) ||
        asciiCaseFold(evidence.rootVolumeId) !==
          asciiCaseFold(expectedRoot.volumeId))
    )
      fail("WINDOWS_ROOT_IDENTITY_MISMATCH");
  }

  #invokeDirectory(canonicalPath: string): WindowsProbeEvidence {
    this.#assertExecutable();
    const expectation = Object.freeze({
      canonicalPath,
      canonicalRoot: this.#root,
    });
    let raw: unknown;
    try {
      if (this.#probePort === undefined) {
        const record = readDirectoryResult(
          spawnCompiledProbe(
            this.#executable,
            this.#systemRoot,
            canonicalPath,
            this.#root,
            "directory",
          ),
        );
        if (record.state !== "CREATED" && record.state !== "OPEN")
          fail("WINDOWS_PRIVATE_DIRECTORY_UNKNOWN");
        const subset = evidenceSubset(record);
        const evidence = subset as WindowsProbeEvidence;
        if (
          typeof record.handleFileId !== "string" ||
          typeof record.handleVolumeId !== "string" ||
          asciiCaseFold(record.handleFileId) !==
            asciiCaseFold(evidence.fileId) ||
          asciiCaseFold(record.handleVolumeId) !==
            asciiCaseFold(evidence.volumeId)
        )
          fail("WINDOWS_PRIVATE_DIRECTORY_UNKNOWN");
        raw = subset;
      } else {
        const directory = this.#probePort.directory;
        if (directory === undefined)
          fail("PROBE_DIRECTORY_UNAVAILABLE");
        raw = directory.call(this.#probePort, canonicalPath, this.#root);
      }
    } catch (error) {
      if (error instanceof CollaborationError) throw error;
      fail("PROBE_FAILED");
    }
    assertWindowsProbe(raw, expectation);
    return raw as WindowsProbeEvidence;
  }

  /**
   * Create only missing descendants of the existing private root with the
   * pinned helper. The helper holds non-delete parent handles for the whole
   * walk, and this method proves root identity before and after the call. The
   * prepared directory/root identities are then mandatory for bind().
   */
  prepareDirectory(directory: string): void {
    this.#assertOpen();
    if (this.#rootPin !== undefined) fail("WINDOWS_ROOT_ALREADY_BOUND");
    if (this.#preparedDirectory !== undefined)
      fail("WINDOWS_DIRECTORY_ALREADY_PREPARED");
    const validated = validateWindowsPath(directory, this.#root);
    if (
      asciiCaseFold(validated.canonical) === asciiCaseFold(this.#root)
    )
      fail("WINDOWS_DIRECTORY_NOT_CHILD");
    this.#lstatDirectory(this.#root, "WINDOWS_ROOT_MISSING");
    const rootBefore = this.#probe(this.#root, this.#root);
    this.#assertExpectedRoot(rootBefore);
    const evidence = this.#invokeDirectory(validated.canonical);
    const rootAfter = this.#probe(this.#root, this.#root);
    this.#assertExpectedRoot(rootAfter);
    if (
      asciiCaseFold(evidence.canonicalPath) !==
        asciiCaseFold(validated.canonical) ||
      asciiCaseFold(evidence.canonicalRoot) !== asciiCaseFold(this.#root) ||
      asciiCaseFold(rootBefore.rootFileId) !==
        asciiCaseFold(rootAfter.rootFileId) ||
      asciiCaseFold(rootBefore.volumeId) !== asciiCaseFold(rootAfter.volumeId) ||
      asciiCaseFold(rootBefore.rootFileId) !==
        asciiCaseFold(evidence.rootFileId) ||
      asciiCaseFold(rootBefore.volumeId) !==
        asciiCaseFold(evidence.rootVolumeId)
    )
      fail("WINDOWS_ROOT_IDENTITY_CHANGED");
    const expectedDirectory = this.#expectedDirectory;
    if (
      expectedDirectory !== undefined &&
      (asciiCaseFold(evidence.fileId) !==
        asciiCaseFold(expectedDirectory.fileId) ||
        asciiCaseFold(evidence.volumeId) !==
          asciiCaseFold(expectedDirectory.volumeId))
    )
      fail("WINDOWS_DIRECTORY_IDENTITY_MISMATCH");
    this.#preparedDirectory = Object.freeze({
      canonicalPath: evidence.canonicalPath,
      directoryFileId: evidence.fileId,
      directoryVolumeId: evidence.volumeId,
      rootFileId: rootAfter.rootFileId,
      rootVolumeId: rootAfter.rootVolumeId,
    });
  }

  #pin(): RootPin {
    const pin = this.#rootPin;
    if (pin === undefined) fail("WINDOWS_ROOT_NOT_BOUND");
    return pin;
  }

  #assertRootPin(evidence: WindowsProbeEvidence, pin: RootPin): void {
    if (
      asciiCaseFold(evidence.canonicalRoot) !== asciiCaseFold(pin.root) ||
      evidence.rootFileId !== pin.rootFileId ||
      evidence.rootVolumeId !== pin.rootVolumeId
    )
      fail("WINDOWS_ROOT_IDENTITY_CHANGED");
  }

  bind(directory: string): string {
    this.#assertOpen();
    if (this.#rootPin !== undefined) fail("WINDOWS_ROOT_ALREADY_BOUND");
    const validated = validateWindowsPath(directory, this.#root);
    this.#lstatDirectory(this.#root, "WINDOWS_ROOT_MISSING");
    this.#lstatDirectory(validated.canonical, "WINDOWS_PRIVATE_ROOT_MISSING");
    const evidence = this.#probe(validated.canonical, this.#root);
    const expectedRoot = this.#expectedRoot;
    if (
      expectedRoot !== undefined &&
      (asciiCaseFold(evidence.rootFileId) !==
        asciiCaseFold(expectedRoot.rootFileId) ||
        asciiCaseFold(evidence.volumeId) !==
          asciiCaseFold(expectedRoot.volumeId) ||
        asciiCaseFold(evidence.rootVolumeId) !==
          asciiCaseFold(expectedRoot.volumeId))
    )
      fail("WINDOWS_ROOT_IDENTITY_MISMATCH");
    const expectedDirectory = this.#expectedDirectory;
    if (
      expectedDirectory !== undefined &&
      (asciiCaseFold(evidence.fileId) !==
        asciiCaseFold(expectedDirectory.fileId) ||
        asciiCaseFold(evidence.volumeId) !==
          asciiCaseFold(expectedDirectory.volumeId))
    )
      fail("WINDOWS_DIRECTORY_IDENTITY_MISMATCH");
    const prepared = this.#preparedDirectory;
    if (
      prepared !== undefined &&
      (asciiCaseFold(evidence.canonicalPath) !==
        asciiCaseFold(prepared.canonicalPath) ||
        evidence.fileId !== prepared.directoryFileId ||
        evidence.volumeId !== prepared.directoryVolumeId ||
        evidence.rootFileId !== prepared.rootFileId ||
        evidence.rootVolumeId !== prepared.rootVolumeId)
    )
      fail("WINDOWS_PREPARED_DIRECTORY_MISMATCH");
    const pin: RootPin = Object.freeze({
      directory: evidence.canonicalPath,
      root: evidence.canonicalRoot,
      directoryFileId: evidence.fileId,
      directoryVolumeId: evidence.volumeId,
      rootFileId: evidence.rootFileId,
      rootVolumeId: evidence.rootVolumeId,
    });
    this.#rootPin = pin;
    return pin.directory;
  }

  assertRoot(): void {
    this.#assertOpen();
    const pin = this.#pin();
    const evidence = this.#probe(pin.directory, pin.root);
    this.#assertRootPin(evidence, pin);
    if (
      asciiCaseFold(evidence.canonicalPath) !== asciiCaseFold(pin.directory) ||
      evidence.fileId !== pin.directoryFileId ||
      evidence.volumeId !== pin.directoryVolumeId
    )
      fail("WINDOWS_DIRECTORY_IDENTITY_CHANGED");
  }

  #assertNamedPath(path: string, pin: RootPin): string {
    const validated = validateWindowsPath(path, pin.directory);
    const relative = validated.relative;
    if (
      relative.length === 0 ||
      relative.includes("\\") ||
      relative.includes("/")
    )
      fail("WINDOWS_DATABASE_PATH");
    if (
      this.#requireDatabaseName &&
      asciiCaseFold(relative) !== asciiCaseFold(this.databaseName)
    )
      fail("WINDOWS_DATABASE_PATH");
    if (!isValidPrivateLedgerName(relative)) fail("WINDOWS_DATABASE_PATH");
    return validated.canonical;
  }

  #recordFileEvidence(evidence: WindowsProbeEvidence): void {
    const key = asciiCaseFold(evidence.canonicalPath);
    const existing = this.#filePins.get(key);
    if (existing === undefined) {
      this.#filePins.set(
        key,
        Object.freeze({
          canonicalPath: evidence.canonicalPath,
          fileId: evidence.fileId,
          volumeId: evidence.volumeId,
        }),
      );
      return;
    }
    if (
      evidence.fileId !== existing.fileId ||
      evidence.volumeId !== existing.volumeId
    )
      fail("WINDOWS_DATABASE_IDENTITY_CHANGED");
  }

  #assertFileAt(
    canonicalPath: string,
    pin: RootPin,
  ): WindowsRuntimeFileStat {
    const before = this.#lstatFile(canonicalPath);
    const evidence = this.#probe(canonicalPath, pin.root);
    const after = this.#lstatFile(canonicalPath);
    if (!sameStat(before, after)) fail("WINDOWS_DATABASE_CHANGED");
    this.#assertRootPin(evidence, pin);
    if (asciiCaseFold(evidence.canonicalPath) !== asciiCaseFold(canonicalPath))
      fail("WINDOWS_DATABASE_IDENTITY_CHANGED");
    this.#recordFileEvidence(evidence);
    return after;
  }

  #fileExists(path: string): boolean {
    let stat: WindowsRuntimeFileStat;
    try {
      stat = this.#lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
      fail("WINDOWS_DATABASE_UNSAFE");
    return true;
  }

  #probeMode(
    canonicalPath: string,
    pin: RootPin,
    mode: "create" | "open",
  ): WindowsProbeEvidence {
    this.#assertExecutable();
    const expectation = Object.freeze({
      canonicalPath,
      canonicalRoot: pin.root,
    });
    let raw: unknown;
    try {
      if (this.#probePort === undefined) {
        raw = readCreateOrOpenResult(
          spawnCompiledProbe(
            this.#executable,
            this.#systemRoot,
            canonicalPath,
            pin.root,
            mode,
          ),
        );
      } else if (mode === "create") {
        const create = this.#probePort.create;
        if (create === undefined) fail("PROBE_CREATE_UNAVAILABLE");
        raw = create.call(this.#probePort, canonicalPath, pin.root);
      } else {
        const open = this.#probePort.open;
        raw =
          open === undefined
            ? this.#probePort.probe(canonicalPath, pin.root)
            : open.call(this.#probePort, canonicalPath, pin.root);
      }
    } catch (error) {
      if (error instanceof CollaborationError) throw error;
      fail("PROBE_FAILED");
    }
    let evidence: unknown = raw;
    if (this.#probePort === undefined) {
      const record = raw as Record<string, unknown>;
      const expectedState = mode === "create" ? "CREATED" : "OPEN";
      if (record.state !== expectedState)
        fail(
          mode === "create"
            ? "WINDOWS_PRIVATE_CREATE_UNKNOWN"
            : "WINDOWS_PRIVATE_OPEN_UNKNOWN",
        );
      const handleFileId = record.handleFileId;
      const handleVolumeId = record.handleVolumeId;
      evidence = evidenceSubset(record);
      const subset = evidence as WindowsProbeEvidence;
      if (
        typeof handleFileId !== "string" ||
        typeof handleVolumeId !== "string" ||
        asciiCaseFold(handleFileId) !== asciiCaseFold(subset.fileId) ||
        asciiCaseFold(handleVolumeId) !== asciiCaseFold(subset.volumeId)
      )
        fail(
          mode === "create"
            ? "WINDOWS_PRIVATE_CREATE_UNKNOWN"
            : "WINDOWS_PRIVATE_OPEN_UNKNOWN",
        );
    }
    assertWindowsProbe(evidence, expectation);
    return evidence as WindowsProbeEvidence;
  }

  assertFile(path: string): void {
    this.#assertOpen();
    const pin = this.#pin();
    this.#assertFileAt(this.#assertNamedPath(path, pin), pin);
  }

  validatedFileIdentity(path: string): WindowsRuntimeFileIdentity {
    this.#assertOpen();
    const pin = this.#pin();
    const canonicalPath = this.#assertNamedPath(path, pin);
    this.#assertFileAt(canonicalPath, pin);
    const recorded = this.#filePins.get(asciiCaseFold(canonicalPath));
    if (recorded === undefined) fail("WINDOWS_DATABASE_IDENTITY_CHANGED");
    return Object.freeze({
      canonicalPath: recorded.canonicalPath,
      fileId: recorded.fileId,
      volumeId: recorded.volumeId,
    });
  }

  /** Read-only proof for a named attachment/credential, never a SQLite bypass. */
  validatedPrivateFileIdentity(path: string): WindowsRuntimeFileIdentity {
    this.#assertOpen(); this.assertRoot();
    const pin = this.#pin(); const target = validateWindowsPath(path, pin.directory);
    if (!target.relative || target.relative.includes("\\") || target.relative.includes("/")) fail("WINDOWS_PRIVATE_FILE_PATH");
    this.#assertFileAt(target.canonical, pin);
    const proof = this.#filePins.get(asciiCaseFold(target.canonical));
    if (!proof) fail("WINDOWS_DATABASE_IDENTITY_CHANGED");
    return Object.freeze({...proof});
  }
  assertDatabase(path: string): void {
    this.#assertOpen();
    const pin = this.#pin();
    const canonicalPath = this.#assertNamedPath(path, pin);
    this.#assertFileAt(canonicalPath, pin);
    this.#assertSidecars(canonicalPath, pin);
  }

  assertSidecars(path: string): void {
    this.#assertOpen();
    const pin = this.#pin();
    const canonicalPath = this.#assertNamedPath(path, pin);
    this.assertRoot();
    this.#assertSidecars(canonicalPath, pin);
  }

  assertEmptyFile(path: string): void {
    this.#assertOpen();
    const pin = this.#pin();
    const canonicalPath = this.#assertNamedPath(path, pin);
    // The size comes from the post-probe stable stat, so it is bound to the same
    // identity window as the recorded native file id (not an earlier lstat).
    const stat = this.#assertFileAt(canonicalPath, pin);
    if (stat.size !== 0) fail("WINDOWS_DATABASE_NOT_EMPTY");
  }

  createExclusiveDurably(path: string): void {
    this.#assertOpen();
    const pin = this.#pin();
    const canonicalPath = this.#assertNamedPath(path, pin);
    this.assertRoot();
    const existing = this.#fileExists(canonicalPath);
    const evidence = this.#probeMode(
      canonicalPath,
      pin,
      existing ? "open" : "create",
    );
    this.#assertRootPin(evidence, pin);
    if (asciiCaseFold(evidence.canonicalPath) !== asciiCaseFold(canonicalPath))
      fail("WINDOWS_DATABASE_IDENTITY_CHANGED");
    this.#recordFileEvidence(evidence);
    const stat = this.#assertFileAt(canonicalPath, pin);
    if (!existing && stat.size !== 0) fail("WINDOWS_DATABASE_NOT_EMPTY");
    this.assertRoot();
  }

  #recordSidecarEvidence(
    sidecar: string,
    evidence: WindowsProbeEvidence,
  ): void {
    const key = asciiCaseFold(sidecar);
    const existing = this.#sidecarPins.get(key);
    if (existing === undefined) {
      this.#sidecarPins.set(
        key,
        Object.freeze({
          canonicalPath: evidence.canonicalPath,
          fileId: evidence.fileId,
          volumeId: evidence.volumeId,
        }),
      );
      return;
    }
    if (
      evidence.fileId !== existing.fileId ||
      evidence.volumeId !== existing.volumeId
    )
      fail("WINDOWS_DATABASE_SIDECAR_IDENTITY_CHANGED");
  }

  #assertSidecars(databasePath: string, pin: RootPin): void {
    for (const suffix of SIDECARS) {
      const sidecar = databasePath + suffix;
      const key = asciiCaseFold(sidecar);
      let before: WindowsRuntimeFileStat;
      try {
        before = this.#lstat(sidecar);
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          // Legitimate SQLite journals are deleted per transaction and may be
          // recreated with a new identity; clearing the pin permits that.
          this.#sidecarPins.delete(key);
          continue;
        }
        throw error;
      }
      if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
        fail("WINDOWS_DATABASE_SIDECAR_UNSAFE");
      const evidence = this.#probe(sidecar, pin.root);
      const after = this.#lstat(sidecar);
      if (!sameStat(before, after)) fail("WINDOWS_DATABASE_SIDECAR_CHANGED");
      this.#assertRootPin(evidence, pin);
      if (asciiCaseFold(evidence.canonicalPath) !== asciiCaseFold(sidecar))
        fail("WINDOWS_DATABASE_SIDECAR_IDENTITY_CHANGED");
      this.#recordSidecarEvidence(sidecar, evidence);
    }
  }

  syncCreatedDatabase(path: string): void {
    this.#assertOpen();
    this.assertRoot();
    this.assertDatabase(path);

    const descriptor = this.#fs.openReadWrite(path);
    let failure: unknown;
    try {
      this.#fs.fsync(descriptor);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        this.#fs.close(descriptor);
      } catch (closeError) {
        if (failure !== undefined)
          throw new AggregateError(
            [failure, closeError],
            "UNKNOWN: database fsync and close failed",
          );
        throw closeError;
      }
    }

    this.assertRoot();
    this.assertDatabase(path);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rootPin = undefined;
    this.#preparedDirectory = undefined;
    this.#filePins.clear();
    this.#sidecarPins.clear();
  }
}
