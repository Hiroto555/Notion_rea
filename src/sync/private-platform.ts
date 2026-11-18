import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { types } from "node:util";
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
/**
 * Optional hot-journal private snapshot capability. The provider must invoke
 * the callback exactly once synchronously during the call, with a nonempty
 * canonical path to a disposable private working copy that is distinct from
 * the source path, and must return `undefined`. Only a Windows native port
 * can satisfy this contract.
 */
export type HotJournalSnapshot = (
  path: string,
  callback: (snapshotPath: string) => void,
) => void;

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
  /** Optional native hot-journal snapshot; windows-only capability. */
  withHotJournalSnapshot?: HotJournalSnapshot;
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
  /** Optional native hot-journal snapshot capability. */
  withHotJournalSnapshot?: HotJournalSnapshot;
  close(): void;
}>;

export const WINDOWS_PRIVATE_TRUST_BOUNDARY =
  "Injected Windows private platform runtimes are untrusted contract checks, not Windows OS/filesystem acceptance.";

/**
 * Capability layout enforced by the synchronous-call boundary. `stringResult`
 * is the single capability allowed to return a value (a nonempty primitive
 * string); every `proof` capability must return exactly `undefined`; `close`
 * is validated separately so an unrelated broken proof method can never block
 * cleanup.
 */
type SynchronousProviderSpec = Readonly<{
  readonly stringResult: string;
  readonly proof: readonly string[];
  readonly close: string;
  /** Optional snapshot capability, exposed only when present at wrapping. */
  readonly optionalProof?: string;
}>;

const WINDOWS_NATIVE_SYNC_SPEC: SynchronousProviderSpec = {
  stringResult: "bind",
  proof: [
    "assertRoot",
    "assertFile",
    "assertSidecars",
    "createExclusiveDurably",
    "assertEmptyFile",
  ],
  close: "close",
  optionalProof: "withHotJournalSnapshot",
};

const PRIVATE_PLATFORM_SYNC_SPEC: SynchronousProviderSpec = {
  stringResult: "bind",
  proof: [
    "assertRoot",
    "assertFile",
    "assertSidecars",
    "createExclusive",
    "assertEmptyFile",
  ],
  close: "close",
  optionalProof: "withHotJournalSnapshot",
};

const UNCERTAIN_NATIVE_CODES: ReadonlySet<string> = new Set([
  "WINDOWS_PRIVATE_CREATE_UNKNOWN",
  "WINDOWS_PRIVATE_CREATE_RACE",
  "WINDOWS_PRIVATE_OPEN_UNKNOWN",
  "WINDOWS_PRIVATE_DIRECTORY_UNKNOWN",
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

const NATIVE_PROMISE_THEN = Promise.prototype.then;
const IGNORE_NATIVE_RESULT = (): void => {};

/**
 * Consume a real native Promise result through the captured intrinsic so a
 * later rejection cannot surface as unhandled. Arbitrary thenables are never
 * touched: no `.then` lookup or invocation happens for non-Promise values.
 * Any failure while inspecting is swallowed so the UNKNOWN classification
 * below always survives.
 */
function quietlyConsumeNativePromise(result: unknown): void {
  try {
    if (types.isPromise(result))
      Reflect.apply(NATIVE_PROMISE_THEN, result, [
        IGNORE_NATIVE_RESULT,
        IGNORE_NATIVE_RESULT,
      ]);
  } catch {}
}

/**
 * A throw is uncertain — and must therefore poison proof reuse — when it is a
 * 503 SyncError, a native CollaborationError carrying an uncertain code, or
 * anything else whose provenance cannot prove the operation did not partially
 * run.
 */
function isUncertainProviderError(error: unknown): boolean {
  if (error instanceof SyncError) return error.status === 503;
  if (error instanceof CollaborationError)
    return UNCERTAIN_NATIVE_CODES.has(error.code);
  return true;
}

/**
 * Synchronous-call boundary shared by the Windows native port and the exported
 * PrivatePlatform wrapper. Providers are untrusted objects (class instances
 * allowed): every capability must currently be a plain callable — never an
 * async or generator function — and is re-proven before each call because a
 * mutable provider can replace a method after binding. Invocation uses the
 * validated reference with the original provider as receiver, and the result
 * must match the capability contract exactly: a nonempty primitive string
 * from `stringResult`, `undefined` from everything else. A malformed or
 * asynchronous result permanently poisons proof calls with one stable
 * SyncError so a repaired provider cannot authorize a retry; cleanup is kept
 * separate and never resets that poison.
 */
class SynchronousPlatformGuard {
  private readonly provider: Record<string, unknown>;
  private readonly optionalName: string | undefined;
  private stableFailure: SyncError | undefined;
  private cleanupSettled = false;
  private cleanupFailure: SyncError | undefined;
  private snapshotActive = false;
  private snapshotEstablished = false;

  constructor(
    provider: unknown,
    private readonly spec: SynchronousProviderSpec,
  ) {
    if (
      typeof provider !== "object" ||
      provider === null ||
      Array.isArray(provider)
    )
      fail("private-ledger-platform-invalid", 503);
    this.provider = provider as Record<string, unknown>;
    this.capability(spec.stringResult);
    for (const name of spec.proof) this.capability(name);
    this.capability(spec.close);
    // The optional capability is captured once: an absent capability stays
    // absent (never falls back), and a present-but-invalid capability fails
    // wrapping before any bind. A provider mutated after wrapping is
    // re-proven before every call.
    if (spec.optionalProof !== undefined) {
      let candidate: unknown;
      try {
        candidate = this.provider[spec.optionalProof];
      } catch {
        fail("private-ledger-platform-invalid", 503);
      }
      if (candidate !== undefined) {
        this.capability(spec.optionalProof);
        this.optionalName = spec.optionalProof;
      }
    }
  }

  private capability(name: string): (...args: unknown[]) => unknown {
    let fn: unknown;
    try {
      fn = this.provider[name];
    } catch {
      fail("private-ledger-platform-invalid", 503);
    }
    if (typeof fn !== "function")
      fail("private-ledger-platform-invalid", 503);
    if (types.isAsyncFunction(fn) || types.isGeneratorFunction(fn))
      fail("private-ledger-platform-unsupported", 503);
    return fn as (...args: unknown[]) => unknown;
  }

  private poison(): SyncError {
    if (this.stableFailure === undefined)
      this.stableFailure = new SyncError(
        "private-ledger-platform-unknown",
        503,
      );
    return this.stableFailure;
  }

  assertUsable(): void {
    if (this.stableFailure !== undefined) throw this.stableFailure;
  }

  /** Whether the optional snapshot capability existed (and was valid) at wrap. */
  hasOptionalProof(): boolean {
    return this.optionalName !== undefined;
  }

  private *capabilityNames(): Generator<string> {
    const spec = this.spec;
    yield spec.stringResult;
    yield* spec.proof;
    yield spec.close;
    if (this.optionalName !== undefined) yield this.optionalName;
  }

  /**
   * Invoke a noncleanup capability. Every capability (including close) is
   * re-validated before the call, so an unrelated method turned asynchronous
   * rejects the call before the provider body runs.
   */
  invoke(name: string, args: readonly unknown[]): unknown {
    this.assertUsable();
    let target: ((...args: unknown[]) => unknown) | undefined;
    try {
      for (const candidate of this.capabilityNames()) {
        const fn = this.capability(candidate);
        if (candidate === name) target = fn;
      }
    } catch (error) {
      if (this.optionalName !== undefined) this.poison();
      throw error;
    }
    if (target === undefined)
      fail("private-ledger-platform-invalid", 503);
    let result: unknown;
    try {
      result = Reflect.apply(target, this.provider, args);
    } catch (error) {
      if (isUncertainProviderError(error) || this.snapshotActive || this.snapshotEstablished) this.poison();
      throw error;
    }
    const acceptable =
      name === this.spec.stringResult
        ? typeof result === "string" && result.length > 0
        : result === undefined;
    if (acceptable) return result;
    quietlyConsumeNativePromise(result);
    throw this.poison();
  }

  /**
   * Invoke the optional snapshot capability. The provider and the callback
   * must both be plain synchronous callables. The callback wrapper enforces
   * the whole contract: exactly one synchronous invocation during the
   * provider call, a nonempty snapshot path distinct from the source, and an
   * `undefined` acknowledgement from both sides. A missing, duplicate, late
   * or malformed callback — and any Promise, thenable, iterator or other
   * non-undefined provider result — permanently poisons this provider with
   * the same stable SyncError used by the other proofs. A semantic callback
   * failure keeps its identity (it is never poison-swallowed, even when the
   * provider catches it), and a callback that fires after the provider
   * returns can never run semantic work.
   */
  invokeSnapshot(
    path: string,
    callback: (snapshotPath: string) => void,
  ): void {
    this.assertUsable();
    if (this.snapshotActive) throw this.poison();
    const optionalName = this.optionalName;
    if (optionalName === undefined)
      fail("private-ledger-platform-unsupported", 503);
    let target: ((...args: unknown[]) => unknown) | undefined;
    try {
      for (const candidate of this.capabilityNames()) {
        const fn = this.capability(candidate);
        if (candidate === optionalName) target = fn;
      }
    } catch (error) {
      // A provider whose snapshot capability was mutated after wrapping can
      // never again authorize a snapshot.
      this.poison();
      throw error;
    }
    if (target === undefined) {
      this.poison();
      throw this.poison();
    }
    if (
      typeof callback !== "function" ||
      types.isAsyncFunction(callback) ||
      types.isGeneratorFunction(callback)
    ) {
      this.poison();
      fail("private-ledger-platform-invalid", 503);
    }
    let returned = false;
    let called = 0;
    let callbackDone = false;
    let callbackFailed = false;
    let callbackError: unknown;
    const snapshotCallback = (snapshotPath: unknown): void => {
      called++;
      const violation =
        returned ||
        called !== 1 ||
        typeof snapshotPath !== "string" ||
        snapshotPath.length === 0 ||
        snapshotPath.includes("\0") ||
        (!isAbsolute(snapshotPath) && !/^[a-z]:[\\/]/i.test(snapshotPath)) ||
        (/^[a-z]:[\\/]/i.test(path)
          ? win32.resolve(snapshotPath).toLowerCase() === win32.resolve(path).toLowerCase()
          : resolve(snapshotPath) === resolve(path));
      if (violation) {
        const stable = this.poison();
        if (!callbackFailed) { callbackFailed = true; callbackError = stable; }
        throw stable;
      }
      try {
        const result = (callback as (value: string) => unknown)(
          snapshotPath as string,
        );
        if (result !== undefined) {
          // A Promise is consumed through the captured intrinsic only; any
          // other thenable, iterator or malformed ack is simply not undefined.
          quietlyConsumeNativePromise(result);
          const stable = this.poison();
          callbackFailed = true;
          callbackError = stable;
          throw stable;
        }
        callbackDone = true;
      } catch (error) {
        if (!callbackFailed) { callbackFailed = true; callbackError = error; }
        throw error;
      }
    };
    let result: unknown;
    this.snapshotActive = true;
    try {
      result = Reflect.apply(target, this.provider, [path, snapshotCallback]);
    } catch (error) {
      if (callbackFailed) {
        // The semantic callback failure is the meaningful outcome; a provider
        // that also misbehaved while propagating it is still poisoned.
        if (error !== callbackError)
          this.poison();
        // A provider may report a cleanup failure alongside the callback.
        // Preserve that aggregate rather than dropping its additional causes.
        if (error instanceof AggregateError && error.errors.includes(callbackError))
          throw error;
        throw callbackError;
      }
      // Source/identity proof loss is not a retry grant, even if the provider
      // classified it as a 409 rather than an unknown-status exception.
      this.poison();
      throw error;
    } finally {
      returned = true;
      this.snapshotActive = false;
    }
    if (result !== undefined) {
      quietlyConsumeNativePromise(result);
      this.poison();
      if (callbackFailed) throw callbackError;
      throw this.poison();
    }
    if (callbackFailed) throw callbackError;
    this.assertUsable();
    if (called !== 1 || !callbackDone) throw this.poison();
    this.snapshotEstablished = true;
  }

  /**
   * Run cleanup at most once. Only `close` is validated so an invalid or
   * asynchronous proof method cannot block it, while a known asynchronous
   * close is still rejected before it executes. A synchronous throw keeps its
   * identity and stays retriable; a malformed result is UNKNOWN, settles
   * cleanup permanently to avoid overlapping cleanup, and keeps reporting
   * that failure rather than pretending cleanup succeeded.
   */
  cleanup(): void {
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
    if (this.cleanupSettled) return;
    const fn = this.capability(this.spec.close);
    let result: unknown;
    try {
      result = Reflect.apply(fn, this.provider, []);
    } catch (error) {
      if (isUncertainProviderError(error)) this.poison();
      throw error;
    }
    if (result !== undefined) {
      quietlyConsumeNativePromise(result);
      this.cleanupSettled = true;
      this.cleanupFailure = this.poison();
      throw this.cleanupFailure;
    }
    this.cleanupSettled = true;
  }
}

/**
 * Windows adapter. It performs no uid/mode or POSIX fsyncdir emulation: all
 * proof and durability must arrive through the native runtime port. Construction
 * fails closed when a capability is absent.
 */
export class WindowsPrivatePlatform implements PrivatePlatform {
  readonly kind = "windows" as const;
  readonly withHotJournalSnapshot?: HotJournalSnapshot;
  private readonly guard: SynchronousPlatformGuard;
  private bound = false;
  private closed = false;

  constructor(runtime: WindowsPrivateNativeRuntime) {
    this.guard = new SynchronousPlatformGuard(
      runtime,
      WINDOWS_NATIVE_SYNC_SPEC,
    );
    // The capability is exposed only when the runtime provided a valid
    // synchronous implementation at wrapping; an absent capability stays
    // absent so callers cannot silently fall back to a POSIX copy.
    if (this.guard.hasOptionalProof()) {
      this.withHotJournalSnapshot = (path, callback) => {
        this.assertOpen();
        requireCondition(
          this.bound,
          "private-ledger-platform-unbound",
          409,
        );
        // Pass the actual callback, including its runtime return value/type,
        // through the guard. Preserve native raw evidence and cleanup causes.
        this.guard.invokeSnapshot(path, callback);
      };
    }
  }

  bind(directory: string): string {
    this.assertOpen();
    requireCondition(!this.bound, "private-ledger-platform-bound", 409);
    requireCondition(
      typeof directory === "string" && directory.length > 0,
      "private-ledger-platform-invalid",
      503,
    );
    const canonical = runNative(() => this.guard.invoke("bind", [directory]));
    this.bound = true;
    return canonical as string;
  }

  assertRoot(): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.guard.invoke("assertRoot", []));
  }

  assertFile(path: string): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.guard.invoke("assertFile", [path]));
  }

  assertSidecars(path: string): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.guard.invoke("assertSidecars", [path]));
  }

  createExclusive(path: string): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.guard.invoke("createExclusiveDurably", [path]));
  }

  assertEmptyFile(path: string): void {
    this.assertOpen();
    requireCondition(this.bound, "private-ledger-platform-unbound", 409);
    runNative(() => this.guard.invoke("assertEmptyFile", [path]));
  }

  close(): void {
    if (this.closed) return;
    runNative(() => this.guard.cleanup());
    this.closed = true;
  }

  private assertOpen(): void {
    requireCondition(!this.closed, "private-ledger-closed", 409);
    this.guard.assertUsable();
  }
}

const synchronousPlatformFacades = new WeakMap<object, PrivatePlatform>();

/**
 * Wrap any PrivatePlatform in the same synchronous-call boundary used for the
 * Windows native port. The provider is proven synchronously callable once at
 * wrapping — before any `bind` — and again before every call; results must
 * match the contract exactly (`bind` returns a nonempty primitive string,
 * every other method returns `undefined`). A malformed result or uncertain
 * throw permanently poisons proof calls while a synchronous `close` stays
 * available for cleanup. Synchronous errors are rethrown with their identity
 * preserved rather than remapped. Wrapping is cached so the same provider
 * always returns the same frozen facade and a facade wraps to itself,
 * avoiding double guards or reopened poison.
 */
export function synchronousPrivatePlatform(
  platform: PrivatePlatform,
): PrivatePlatform {
  const cached = synchronousPlatformFacades.get(platform);
  if (cached !== undefined) return cached;
  let kind: unknown;
  try {
    kind = (platform as { kind?: unknown } | null | undefined)?.kind;
  } catch {
    fail("private-ledger-platform-invalid", 503);
  }
  requireCondition(
    kind === "posix" || kind === "windows",
    "private-ledger-platform-invalid",
    503,
  );
  const guard = new SynchronousPlatformGuard(
    platform,
    PRIVATE_PLATFORM_SYNC_SPEC,
  );
  let closed = false;
  const proof = (name: string, args: readonly unknown[]): unknown => {
    requireCondition(!closed, "private-ledger-closed", 409);
    return guard.invoke(name, args);
  };
  const members: Record<string, unknown> = {
    kind: kind as "posix" | "windows",
    bind(directory: string): string {
      return proof("bind", [directory]) as string;
    },
    assertRoot(): void {
      proof("assertRoot", []);
    },
    assertFile(path: string): void {
      proof("assertFile", [path]);
    },
    assertSidecars(path: string): void {
      proof("assertSidecars", [path]);
    },
    createExclusive(path: string): void {
      proof("createExclusive", [path]);
    },
    assertEmptyFile(path: string): void {
      proof("assertEmptyFile", [path]);
    },
    close(): void {
      if (closed) return;
      guard.cleanup();
      closed = true;
    },
  };
  // The optional snapshot capability is exposed only when it was captured at
  // wrapping; the facade never manufactures one for a provider that lacks it.
  if (guard.hasOptionalProof()) {
    members.withHotJournalSnapshot = (
      path: string,
      callback: (snapshotPath: string) => void,
    ): void => {
      requireCondition(!closed, "private-ledger-closed", 409);
      guard.invokeSnapshot(path, callback);
    };
  }
  const facade = Object.freeze(members) as unknown as PrivatePlatform;
  synchronousPlatformFacades.set(platform, facade);
  synchronousPlatformFacades.set(facade, facade);
  return facade;
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
