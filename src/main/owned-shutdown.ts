import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { types } from "node:util";
import { canonical } from "../collaboration/runtime/canonical";
import { shutdownNativeDirectoryProof, type ShutdownNativeDirectoryIdentity } from "./owned-shutdown-native";
// @ts-ignore - the shared owned-shutdown core is an untyped ESM module; it is
// imported for the fixed monitor source constant and the session API only.
// No import.meta path lookup is performed at runtime, so the bundle is safe.
import { startOwnedShutdownSession } from "../../scripts/gui-owned-shutdown.mjs";

export const OWNED_SHUTDOWN_OPT_IN_ENV = "FOLIO_GUI_TEST_OPT_IN";
export const OWNED_SHUTDOWN_OPT_IN_VALUE = "1";
export const OWNED_SHUTDOWN_REQUEST_ENV = "FOLIO_OWNED_SHUTDOWN_REQUEST";
export const OWNED_SHUTDOWN_DATA_DIR_ENV = "FOLIO_DATA_DIR";

/** Minimal lifecycle port: Electron's App satisfies it; tests may fake it. */
export type ProductShutdownLifecycle = Readonly<{
  once(event: "quit", listener: () => void): unknown;
}>;

export type ProductOwnedShutdownStatus = "ARMED" | "NOT_RUN" | "REJECTED";

export type ProductOwnedShutdownHandle = Readonly<{
  status: ProductOwnedShutdownStatus;
  code: string;
  reason: string;
  /** Session observation promise, or null when no session was started. */
  observation(): Promise<unknown> | null;
}>;

type DataDirIdentity = Readonly<{
  realpath: string;
  dev: number;
  ino: number;
  nativeIdentity?: string;
}>;

type Lstat = (path: string) => {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid?: number;
  mode: number;
  dev: number;
  ino: number;
};

export type ProductOwnedShutdownOptions = Readonly<{
  env: NodeJS.ProcessEnv;
  /** Named simulation seams only; never OS proof. */
  untrustedTest?: Readonly<{
    startSession?: (request: unknown) => {
      acceptedQuit(): void;
      observation(): Promise<unknown>;
    };
    realpath?: (path: string) => string;
    lstat?: Lstat;
    tmpdir?: () => string;
    now?: () => number;
    platform?: NodeJS.Platform;
    nativeDirectoryProof?: (path: string) => ShutdownNativeDirectoryIdentity;
  }>;
}>;

function handle(
  status: ProductOwnedShutdownStatus,
  code: string,
  reason: string,
): ProductOwnedShutdownHandle {
  return Object.freeze({
    status,
    code,
    reason,
    observation() {
      return null;
    },
  });
}

function codeOf(error: unknown): string {
  const candidate = (error as { code?: unknown })?.code;
  return typeof candidate === "string" ? candidate : "INSTALL_FAILED";
}

// The data root must be a private, owner-only directory strictly inside the
// approved temporary parent — lstat identity is captured so the quit-time
// revalidation can prove it is still the same directory. POSIX mode/uid are
// checked on POSIX; Windows requires a separate native proof of this exact
// directory and compares its full File ID again at accepted quit.
function privateDataDir(
  dataDir: string,
  tmpBase: string,
  realpath: (path: string) => string,
  lstat: Lstat,
  platform: NodeJS.Platform,
  nativeProof?: (path: string) => ShutdownNativeDirectoryIdentity,
): DataDirIdentity | "CONTAINMENT" | "PRIVATE" {
  let actual: string;
  try {
    actual = realpath(dataDir);
  } catch {
    return "PRIVATE";
  }
  const rel = relative(tmpBase, actual);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep))
    return "CONTAINMENT";
  let stat;
  try {
    stat = lstat(actual);
  } catch {
    return "PRIVATE";
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return "PRIVATE";
  if (
    platform !== "win32" &&
    ((stat.mode & 0o077) !== 0 ||
      (typeof stat.uid === "number" && (typeof process.getuid !== "function" || stat.uid !== process.getuid())))
  )
    return "PRIVATE";
  let nativeIdentity: string | undefined;
  if (platform === "win32") {
    if (typeof nativeProof !== "function" || types.isAsyncFunction(nativeProof) || types.isGeneratorFunction(nativeProof)) return "PRIVATE";
    try {
      const raw: unknown = nativeProof(actual);
      if (types.isPromise(raw)) {Promise.prototype.then.call(raw, undefined, () => undefined); return "PRIVATE";}
      const proof = JSON.parse(canonical(raw, 4096)) as ShutdownNativeDirectoryIdentity;
      if (!proof || Object.keys(proof).sort().join() !== "canonicalPath,fileId,volumeId" ||
          typeof proof.canonicalPath !== "string" || proof.canonicalPath.toLowerCase() !== actual.toLowerCase() ||
          !/^[a-fA-F0-9]{32}$/.test(proof.fileId) || !/^[a-fA-F0-9]{16}$/.test(proof.volumeId)) return "PRIVATE";
      nativeIdentity = proof.fileId.toLowerCase() + ":" + proof.volumeId.toLowerCase();
    } catch {return "PRIVATE";}
  }
  return Object.freeze({ realpath: actual, dev: stat.dev, ino: stat.ino, ...(nativeIdentity ? {nativeIdentity} : {}) });
}

/**
 * Arms the owned shutdown monitor for this product instance.
 *
 * Parses ONLY the exact FOLIO_GUI_TEST_OPT_IN=1 opt-in plus the
 * FOLIO_OWNED_SHUTDOWN_REQUEST JSON, then revalidates the request's current
 * expiry and the actual FOLIO_DATA_DIR private temporary identity before
 * starting one session. Exactly one listener is registered on the
 * non-vetoable "quit" event; a held/vetoed quit (finishWorkspaceQuit "held")
 * never reaches it, so live resources stay untouched. On "quit" the current
 * expiry, the unchanged request env, and the same data-directory identity are
 * revalidated; a mismatch skips the notification (retained as UNKNOWN) and
 * never closes resources, vetoes, or reissues quit.
 *
 * Parent integration (src/main/index.ts, owned by the parent) — call once
 * inside the single-instance else block before app.whenReady():
 *
 *   import { installProductOwnedShutdown } from "./owned-shutdown";
 *   const ownedShutdown = installProductOwnedShutdown(app, { env: process.env });
 *
 * Retain the handle if the observation should be surfaced in diagnostics.
 * When the request env is absent the install is a no-op (NOT_RUN, no spawn).
 */
export function installProductOwnedShutdown(
  lifecycle: ProductShutdownLifecycle,
  options: ProductOwnedShutdownOptions,
): ProductOwnedShutdownHandle {
  const env = options?.env ?? {};
  const test = options?.untrustedTest;
  try {
    if (env[OWNED_SHUTDOWN_OPT_IN_ENV] !== OWNED_SHUTDOWN_OPT_IN_VALUE)
      return handle(
        "NOT_RUN",
        "OPT_IN_MISSING",
        "Owned shutdown requires the exact GUI batch opt-in",
      );
    const raw = env[OWNED_SHUTDOWN_REQUEST_ENV];
    if (typeof raw !== "string" || raw.length === 0)
      return handle(
        "NOT_RUN",
        "REQUEST_ABSENT",
        "No owned shutdown request; monitor stays disabled",
      );
    let request: unknown;
    try {
      request = JSON.parse(raw);
    } catch {
      return handle(
        "REJECTED",
        "REQUEST_JSON",
        "Owned shutdown request is not valid JSON",
      );
    }
    const now = test?.now ?? (() => Date.now());
    const expiresAt = Date.parse(
      (request as { expiresAt?: unknown })?.expiresAt as string,
    );
    if (!Number.isFinite(expiresAt))
      return handle(
        "REJECTED",
        "REQUEST_EXPIRY",
        "Owned shutdown request has no parseable expiresAt",
      );
    if (expiresAt <= now())
      return handle(
        "REJECTED",
        "REQUEST_EXPIRED",
        "Owned shutdown request authorization window has passed",
      );
    const dataDir = env[OWNED_SHUTDOWN_DATA_DIR_ENV];
    if (typeof dataDir !== "string" || !isAbsolute(dataDir))
      return handle(
        "REJECTED",
        "DATA_DIR",
        "Owned shutdown requires an absolute FOLIO_DATA_DIR",
      );
    const realpath = test?.realpath ?? realpathSync;
    const lstat = test?.lstat ?? (lstatSync as unknown as Lstat);
    const platform = test?.platform ?? process.platform;
    const nativeProof = test?.nativeDirectoryProof ?? shutdownNativeDirectoryProof(env);
    const base = realpath((test?.tmpdir ?? tmpdir)());
    const identity = privateDataDir(dataDir, base, realpath, lstat, platform, nativeProof);
    if (identity === "CONTAINMENT")
      return handle(
        "REJECTED",
        "DATA_DIR_CONTAINMENT",
        "FOLIO_DATA_DIR must stay inside the approved temporary parent",
      );
    if (identity === "PRIVATE")
      return handle(
        "REJECTED",
        "DATA_DIR_PRIVATE",
        "FOLIO_DATA_DIR must be a private owner-only directory",
      );
    const start =
      test?.startSession ??
      ((value: unknown) => startOwnedShutdownSession(value));
    const session = start(request);
    // Authorization state captured at arm time; the non-vetoable quit
    // listener revalidates all of it before the single notification.
    const armed = Object.freeze({ raw, expiresAt, dataDir, identity });
    lifecycle.once("quit", () => {
      try {
        const current = privateDataDir(
          armed.dataDir,
          base,
          realpath,
          lstat,
          platform,
          nativeProof,
        );
        const stillValid =
          armed.expiresAt > now() &&
          env[OWNED_SHUTDOWN_REQUEST_ENV] === armed.raw &&
          typeof current === "object" &&
          current.realpath === armed.identity.realpath &&
          current.dev === armed.identity.dev &&
          current.ino === armed.identity.ino;
        const sameNative = typeof current === "object" && current.nativeIdentity === armed.identity.nativeIdentity;
        if (!stillValid || !sameNative) return; // Retain UNKNOWN; never close or reissue.
        session.acceptedQuit();
      } catch {
        /* A postdispatch failure is retained on the session observation. */
      }
    });
    return Object.freeze({
      status: "ARMED",
      code: "SESSION_STARTED",
      reason: "Owned shutdown monitor session started",
      observation() {
        return session.observation();
      },
    });
  } catch (error) {
    return handle(
      "REJECTED",
      codeOf(error),
      "Owned shutdown rejected before the monitor was armed",
    );
  }
}
