import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { syncPath } from "../persistence/durable-file";
import { CollaborationError } from "../collaboration/runtime/contract";
import { requireCondition, SyncError } from "./protocol";
import {
  assertPrivateRoot,
  assertSqliteSidecars,
  pinPrivateRoot,
  type PrivateRootPin,
} from "./m3-private-root";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const PRIVATE_FILE_MODE = 0o600;

/**
 * One basename rule shared by PrivateLedger and the Windows native port:
 * letter first, lowercase/digit/hyphen tail, exactly `.sqlite`, and no Windows
 * reserved device name. Keeping this in one place stops `con.sqlite` from
 * being "valid" in one layer and rejected in another.
 */
const PRIVATE_LEDGER_NAME = /^[a-z][a-z0-9-]{0,60}\.sqlite$/;
const RESERVED_STEMS: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CLOCK$",
  "CONIN$",
  "CONOUT$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export function isValidPrivateLedgerName(value: unknown): value is string {
  if (typeof value !== "string" || !PRIVATE_LEDGER_NAME.test(value)) return false;
  const stem = value.slice(0, value.indexOf(".")).toUpperCase();
  return !RESERVED_STEMS.has(stem);
}

/**
 * Filesystem proof port used by PrivateLedger. Every identity, sidecar and
 * durability decision is delegated to the selected adapter; PrivateLedger must
 * not assume a POSIX uid/mode/fsyncdir model once a Windows adapter is chosen.
 */
export type PrivatePlatform = Readonly<{
  readonly kind: "posix" | "windows";
  /** Bind the containing private root and return its canonical path. */
  bind(directory: string): string;
  /** Re-prove the bound root before use. */
  assertRoot(): void;
  /** Prove (and retain) the volume/file identity of the ledger file. */
  assertFile(path: string): void;
  /** Check database sidecars before SQLite is allowed to open the file. */
  assertSidecars(path: string): void;
  /** Durably create the ledger file if absent; an existing file is accepted. */
  createExclusive(path: string): void;
  /** Prove a newly-created ledger is still byte-empty before schema creation. */
  assertEmptyFile(path: string): void;
  close(): void;
}>;

function fail(code: string, status = 409): never {
  throw new SyncError(code, status);
}

function withinRoot(root: string, path: string): boolean {
  const rest = relative(root, path);
  return (
    rest !== "" &&
    rest !== ".." &&
    !rest.startsWith(".." + sep) &&
    !isAbsolute(rest)
  );
}

/**
 * Production POSIX adapter. It preserves the previous PrivateLedger checks:
 * pinned private root, uid/mode/nlink/file identity, sidecars before SQLite,
 * and an fsynced exclusive create followed by a directory sync.
 */
export class PosixPrivatePlatform implements PrivatePlatform {
  readonly kind = "posix" as const;
  private root: PrivateRootPin | undefined;
  private readonly files = new Map<string, { dev: number; ino: number }>();
  private closed = false;

  constructor(private readonly forbiddenRoots: readonly string[] = []) {}

  bind(directory: string): string {
    this.assertOpen();
    if (this.root !== undefined) fail("private-ledger-platform-bound");
    this.root = pinPrivateRoot(directory, this.forbiddenRoots);
    return this.root.path;
  }

  assertRoot(): void {
    this.assertOpen();
    assertPrivateRoot(this.pinnedRoot());
  }

  assertFile(path: string): void {
    this.assertOpen();
    const root = this.pinnedRoot();
    this.assertRoot();
    this.assertFilePath(root, path);
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch {
      fail("private-ledger-unsafe");
    }
    requireCondition(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.uid === root.uid &&
        (stat.mode & 0o777) === PRIVATE_FILE_MODE &&
        stat.size <= MAX_FILE_BYTES,
      "private-ledger-unsafe",
      409,
    );
    const pin = this.files.get(path);
    if (pin === undefined)
      this.files.set(path, { dev: stat.dev, ino: stat.ino });
    else
      requireCondition(
        stat.dev === pin.dev && stat.ino === pin.ino,
        "private-ledger-changed",
        409,
      );
  }

  assertSidecars(path: string): void {
    this.assertOpen();
    const root = this.pinnedRoot();
    this.assertFilePath(root, path);
    assertSqliteSidecars(path, root.uid);
  }

  createExclusive(path: string): void {
    this.assertOpen();
    const root = this.pinnedRoot();
    this.assertFilePath(root, path);
    try {
      let descriptor: number;
      try {
        descriptor = openSync(
          path,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          PRIVATE_FILE_MODE,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
        return fail("private-ledger-unavailable", 503);
      }
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      syncPath(root.path);
    } catch (error) {
      if (error instanceof SyncError) throw error;
      fail("private-ledger-unavailable", 503);
    }
  }

  assertEmptyFile(path: string): void {
    this.assertOpen();
    const root = this.pinnedRoot();
    this.assertFilePath(root, path);
    let size: number;
    try {
      size = lstatSync(path).size;
    } catch {
      fail("private-ledger-invalid");
    }
    requireCondition(size === 0, "private-ledger-invalid", 409);
  }

  close(): void {
    this.closed = true;
    this.files.clear();
    this.root = undefined;
  }

  private assertOpen(): void {
    requireCondition(!this.closed, "private-ledger-closed", 409);
  }

  private pinnedRoot(): PrivateRootPin {
    const root = this.root;
    if (root === undefined) fail("private-ledger-platform-unbound");
    return root;
  }

  private assertFilePath(root: PrivateRootPin, path: string): void {
    const absolute = resolve(path);
    requireCondition(
      withinRoot(root.path, absolute) &&
        dirname(absolute) === root.path &&
        !path.includes("\0"),
      "private-ledger-unsafe",
      409,
    );
  }
}

/**
 * The exact native capabilities a generalized Windows private-ledger port must
 * provide. `createExclusiveDurably` is create-or-open: a missing file is created
 * and proven empty/durable; an existing ledger is explicitly reopened, flushed
 * and identity-read back rather than assumed durable.
 */
export type WindowsPrivateNativeRuntime = Readonly<{
  bind(directory: string): string;
  assertRoot(): void;
  assertFile(path: string): void;
  assertSidecars(path: string): void;
  createExclusiveDurably(path: string): void;
  assertEmptyFile(path: string): void;
  close(): void;
}>;

export const WINDOWS_PRIVATE_TRUST_BOUNDARY =
  "Injected Windows private platform runtimes are untrusted contract checks, not Windows OS/filesystem acceptance.";

const NATIVE_METHODS = [
  "bind",
  "assertRoot",
  "assertFile",
  "assertSidecars",
  "createExclusiveDurably",
  "assertEmptyFile",
  "close",
] as const;

function nativeRuntime(value: unknown): WindowsPrivateNativeRuntime {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("private-ledger-platform-invalid", 503);
  const runtime = value as Record<string, unknown>;
  for (const method of NATIVE_METHODS)
    if (typeof runtime[method] !== "function")
      fail("private-ledger-platform-invalid", 503);
  return value as WindowsPrivateNativeRuntime;
}

const UNCERTAIN_NATIVE_CODES: ReadonlySet<string> = new Set([
  "WINDOWS_PRIVATE_CREATE_UNKNOWN",
  "WINDOWS_PRIVATE_CREATE_RACE",
  "WINDOWS_PRIVATE_OPEN_UNKNOWN",
  "PROBE_EXEC_FAILED",
  "PROBE_TIMEOUT",
  "PROBE_OUTPUT_LIMIT",
  "PROBE_SIGNAL",
  "PROBE_EXIT",
  "PROBE_FAILED",
  "NATIVE_PLATFORM_MISMATCH",
]);

/** Keep the stable native code for UI mapping, but join the SyncError contract. */
function nativeFailure(error: unknown): never {
  if (error instanceof SyncError) throw error;
  if (error instanceof CollaborationError)
    throw new SyncError(
      error.code,
      UNCERTAIN_NATIVE_CODES.has(error.code) ? 503 : 409,
    );
  throw new SyncError("windows-private-platform-failed", 503);
}

function runNative<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    return nativeFailure(error);
  }
}

/**
 * Windows adapter. It performs no uid/mode or POSIX fsyncdir emulation: all
 * proof and durability must arrive through the native runtime port. Construction
 * fails closed when a capability is absent.
 */
export class WindowsPrivatePlatform implements PrivatePlatform {
  readonly kind = "windows" as const;
  private readonly runtime: WindowsPrivateNativeRuntime;
  private bound = false;
  private closed = false;

  constructor(runtime: WindowsPrivateNativeRuntime) {
    this.runtime = nativeRuntime(runtime);
  }

  bind(directory: string): string {
    this.assertOpen();
    requireCondition(!this.bound, "private-ledger-platform-bound", 409);
    requireCondition(
      typeof directory === "string" && directory.length > 0,
      "private-ledger-platform-invalid",
      503,
    );
    const canonical = runNative(() => this.runtime.bind(directory));
    requireCondition(
      typeof canonical === "string" && canonical.length > 0,
      "private-ledger-platform-invalid",
      503,
    );
    this.bound = true;
    return canonical;
  }

  assertRoot(): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.runtime.assertRoot());
  }

  assertFile(path: string): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.runtime.assertFile(path));
  }

  assertSidecars(path: string): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.runtime.assertSidecars(path));
  }

  createExclusive(path: string): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.runtime.createExclusiveDurably(path));
  }

  assertEmptyFile(path: string): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.runtime.assertEmptyFile(path));
  }

  close(): void {
    if (this.closed) return;
    runNative(() => this.runtime.close());
    this.closed = true;
  }

  private assertOpen(): void {
    requireCondition(!this.closed, "private-ledger-closed", 409);
  }
}

/**
 * The default remains POSIX-only. A Windows process must inject an explicit
 * native port; there is no process.platform win32 fallback that could pretend
 * to provide SID/DACL/volume+fileID proof.
 */
export function defaultPrivatePlatform(
  platform: NodeJS.Platform = process.platform,
  forbiddenRoots: readonly string[] = [],
): PrivatePlatform {
  requireCondition(
    platform !== "win32",
    "private-ledger-platform-required",
    503,
  );
  return new PosixPrivatePlatform(forbiddenRoots);
}

/** Canonical path helper shared by POSIX tests and callers. */
export function canonicalPrivateDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return fail("private-ledger-unavailable", 503);
  }
}
