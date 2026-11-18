import { CollaborationError } from "../../collaboration/runtime/contract";
import type { RuntimeStorePlatform } from "../runtime-store-platform";
import { synchronousRuntimeStorePlatform } from "../synchronous-port";
import type { PrivatePlatform } from "../../sync/private-platform";
import {
  withPrivateAuthorityLease,
  withPrivateAuthorityLeaseForTesting,
  type AcquirePrivateAuthorityLease,
} from "./authority-lease";

function fail(code: string): never {
  throw new CollaborationError(`WINDOWS_RUNTIME_LEASE_${code}`);
}

type LeaseWrap = (
  platform: PrivatePlatform,
  acquire: AcquirePrivateAuthorityLease,
) => PrivatePlatform;

/**
 * Shared held-runtime construction. The returned proxy preserves the concrete
 * platform's receiver-bound properties and methods and adds a single acquired
 * authority hold:
 *
 * - The whole RuntimeStorePlatform surface is proven synchronously callable
 *   up front through `synchronousRuntimeStorePlatform`; a hidden async method
 *   is rejected at construction instead of being turned into a sync call.
 * - `assertDatabase(path)` proves the existing file through the boundary,
 *   acquires the RAW acquirer's hold, then re-proves under it.
 * - `createExclusiveDurably(path)` runs the real positive create, the empty
 *   file proof and the database proof BEFORE acquisition — and is refused
 *   entirely once acquisition was attempted, so a mutation never replays.
 * - Mutating/optional capabilities require the hold, verify it immediately
 *   before the underlying call, and verify again afterwards. The hold is NOT
 *   released at snapshot end.
 * - `close()` always runs through the held wrapper (lease before native
 *   platform), even when acquisition itself failed; the caller must have
 *   closed every SQLite connection first.
 *
 * The bridge into `withPrivateAuthorityLease` is internal and never exposed:
 * its `createExclusive` is a no-op because the actual create and proof are
 * already done by this proxy before the hold is acquired.
 */
function heldRuntime<T extends RuntimeStorePlatform>(
  platform: T,
  acquire: AcquirePrivateAuthorityLease,
  wrap: LeaseWrap,
): T {
  if (platform === null || typeof platform !== "object") fail("ACQUIRE");
  const boundary = synchronousRuntimeStorePlatform(platform);
  const bridge: PrivatePlatform = {
    kind: "windows",
    bind: (directory: string) => boundary.bind(directory),
    assertRoot: () => boundary.assertRoot(),
    assertFile: (path: string) => boundary.assertDatabase(path),
    // assertDatabase already includes the sidecar proof for this runtime.
    assertSidecars: () => {},
    // The real exclusive create + proofs run in the proxy override BEFORE the
    // held wrapper is asked to acquire.
    createExclusive: () => {},
    assertEmptyFile: (path: string) => {
      if (boundary.assertEmptyFile === undefined) fail("CAPABILITY");
      boundary.assertEmptyFile(path);
    },
    close: () => boundary.close(),
    ...(boundary.withHotJournalSnapshot === undefined
      ? {}
      : {
          withHotJournalSnapshot: (
            path: string,
            callback: (snapshotPath: string) => void,
          ) => boundary.withHotJournalSnapshot!(path, callback),
        }),
  };
  // Eager wrap: the acquirer brand/test-host rule is validated at construction
  // and the lease-owning wrapper is retained for the entire lifetime — a
  // lease that was acquired then failed its READY proof stays reachable.
  const held = wrap(bridge, acquire);
  let acquireAttempted = false;
  let acquired = false;
  let acquiredPath: string | undefined;
  // Presence flag: a thrown `undefined` poison can never look unset.
  let poisonedPresent = false;
  let poisoned: unknown;
  let closeStarted = false;
  let closeDone = false;

  const poison = (error: unknown): never => {
    if (!poisonedPresent) {
      poisonedPresent = true;
      poisoned = error;
    }
    throw poisoned;
  };

  /**
   * Acquire the hold for `path` exactly once. The caller has already run the
   * real native create/proof; the path is stored BEFORE the attempt so a
   * half-failed acquisition can never silently retarget. A different path or
   * any replay poisons instead of re-leasing.
   */
  const ensure = (path: string): void => {
    if (poisonedPresent) throw poisoned;
    if (closeStarted) fail("CLOSED");
    if (acquired) {
      if (path !== acquiredPath)
        poison(new CollaborationError("WINDOWS_RUNTIME_LEASE_PATH"));
      return;
    }
    if (acquireAttempted)
      poison(new CollaborationError("WINDOWS_RUNTIME_LEASE_ACQUIRE"));
    acquireAttempted = true;
    acquiredPath = path;
    try {
      held.createExclusive(path);
      acquired = true;
    } catch (error) {
      poison(error);
    }
  };

  /**
   * The hold must be present, verified live right now, and bound to the exact
   * acquired path before any mutating or proof call may touch the resource.
   */
  const requireHeld = (path: string): PrivatePlatform => {
    if (poisonedPresent) throw poisoned;
    if (closeStarted) fail("CLOSED");
    if (!acquired) fail("UNHELD");
    if (path !== acquiredPath)
      poison(new CollaborationError("WINDOWS_RUNTIME_LEASE_PATH"));
    try {
      held.assertRoot();
    } catch (error) {
      poison(error);
    }
    return held;
  };

  /** Post-call re-proof of the hold plus file identity. */
  const recheck = (path: string): void => {
    try {
      held.assertFile(path);
    } catch (error) {
      poison(error);
    }
  };

  const overrides: Record<PropertyKey, unknown> = {
    bind(directory: string): string {
      if (poisonedPresent) throw poisoned;
      if (closeStarted) fail("CLOSED");
      // Delegates the real bind; no bound-directory identity is valid yet.
      return boundary.bind(directory);
    },
    assertRoot(): void {
      if (poisonedPresent) throw poisoned;
      if (closeStarted) fail("CLOSED");
      if (!acquired) {
        boundary.assertRoot();
        return;
      }
      try {
        held.assertRoot();
      } catch (error) {
        poison(error);
      }
    },
    assertDatabase(path: string): void {
      if (poisonedPresent) throw poisoned;
      if (closeStarted) fail("CLOSED");
      // Prove the existing file through the real boundary first, then take
      // the hold, then re-prove under it — before any SQLite preflight.
      boundary.assertDatabase(path);
      ensure(path);
      recheck(path);
    },
    syncCreatedDatabase(path: string): void {
      requireHeld(path);
      boundary.syncCreatedDatabase(path);
      recheck(path);
    },
    close(): void {
      closeStarted = true;
      if (closeDone) return;
      // ALWAYS the held wrapper — a failed acquisition still owes its lease
      // close; the raw platform is never released around it.
      held.close();
      closeDone = true;
    },
  };
  if (boundary.createExclusiveDurably !== undefined) {
    overrides.createExclusiveDurably = (path: string): void => {
      if (poisonedPresent) throw poisoned;
      if (closeStarted) fail("CLOSED");
      // No mutation replay: once acquisition was attempted a second positive
      // create is refused before touching the filesystem.
      if (acquireAttempted)
        poison(new CollaborationError("WINDOWS_RUNTIME_LEASE_ACQUIRE"));
      // An empty-file proof is mandatory before any create can acquire.
      if (boundary.assertEmptyFile === undefined) fail("CAPABILITY");
      boundary.createExclusiveDurably!(path);
      boundary.assertEmptyFile!(path);
      boundary.assertDatabase(path);
      ensure(path);
      recheck(path);
    };
  }
  if (boundary.assertEmptyFile !== undefined) {
    overrides.assertEmptyFile = (path: string): void => {
      requireHeld(path);
      boundary.assertEmptyFile!(path);
      recheck(path);
    };
  }
  if (boundary.withHotJournalSnapshot !== undefined) {
    const snapshot = boundary.withHotJournalSnapshot;
    overrides.withHotJournalSnapshot = (
      path: string,
      callback: (snapshotPath: string) => void,
    ): void => {
      requireHeld(path);
      recheck(path);
      // Presence flag: a callback that threw `undefined` still counts.
      let callbackFailed = false;
      let callbackFailure: unknown;
      try {
        snapshot.call(boundary, path, (snapshotPath: string) => {
          recheck(path);
          try {
            callback(snapshotPath);
          } catch (error) {
            callbackFailed = true;
            callbackFailure = error;
            try {
              recheck(path);
            } catch (after) {
              callbackFailure = new AggregateError(
                [error, after],
                "UNKNOWN: snapshot validation and held proof failed",
              );
            }
            throw callbackFailure;
          }
          recheck(path);
        });
        // Re-prove the hold after the entire native call, not just inside
        // the callback; the hold is NOT released at snapshot end.
        recheck(path);
        // A provider that swallowed the callback's throw can never turn a
        // validation failure into a successful snapshot.
        if (callbackFailed) throw callbackFailure;
      } catch (error) {
        if (callbackFailed && error !== callbackFailure)
          throw new AggregateError(
            [callbackFailure, error],
            "UNKNOWN: snapshot validation and native call failed",
          );
        if (callbackFailed) throw callbackFailure;
        throw error;
      }
    };
  }

  // Reflect on the real target so concrete class fields, getters and
  // private-field methods keep their original receiver — never a spread of
  // the instance or a partial cast.
  return new Proxy(platform, {
    get(target, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key))
        return overrides[key];
      const member = Reflect.get(target, key, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

/**
 * Production wrapper: only the ORIGINAL acquirer minted by
 * `createNativeAuthorityLeaseAcquirer` satisfies the brand check inside
 * `withPrivateAuthorityLease`; a caller-built function can never stand in.
 */
export function withRuntimeAuthorityLease<T extends RuntimeStorePlatform>(
  platform: T,
  acquire: AcquirePrivateAuthorityLease,
): T {
  return heldRuntime(platform, acquire, withPrivateAuthorityLease);
}

/**
 * Explicit untrusted contract-testing seam: the fake hold is tagged
 * `untrusted-test` and is forbidden on a real win32 host.
 */
export function withRuntimeAuthorityLeaseForTesting<
  T extends RuntimeStorePlatform,
>(platform: T, acquire: AcquirePrivateAuthorityLease): T {
  return heldRuntime(platform, acquire, withPrivateAuthorityLeaseForTesting);
}
