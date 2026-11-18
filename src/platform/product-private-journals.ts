import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { throwAfterJournalCleanup } from "../sync/journal-preflight";
import {
  synchronousPrivatePlatform,
  type PrivatePlatform,
} from "../sync/private-platform";
import { requireCondition, SyncError } from "../sync/protocol";

/**
 * Product code hands journal constructors a factory, never an open port, so
 * every ledger/blob open receives a fresh owner. The Windows adapter supplies
 * `windowsPrivate.ledgerPlatform`; POSIX callers leave it absent and keep the
 * existing default adapter (which still fails closed on a real win32 host).
 */
export type ProductPrivatePlatformFactory = (
  directory: string,
  name: string,
) => PrivatePlatform;

export type ProductPrivateJournalOptions = Readonly<{
  privatePlatformFactory?: ProductPrivatePlatformFactory;
}>;

/**
 * Async-local context so unowned intermediate layers (for example
 * WorkspaceSync.transferOptions) reach the product-configured factory without
 * a cast or monkey patch. There is deliberately no process-global factory:
 * only an explicit per-call options object or this scoped context can
 * select one, and explicit options always win over the inherited context.
 */
const context = new AsyncLocalStorage<ProductPrivateJournalOptions>();

/**
 * Every port this module has ever issued. A port's identity proof belongs to
 * the single journal that received it, so reissuing the same raw provider or
 * its canonical facade — even after close — is rejected for the life of the
 * process rather than attaching a second owner to a stale binding. The raw
 * object is tracked too so an unwrapped repeat is caught by the same set.
 */
const issued = new WeakSet<object>();

function invalid(cause?: unknown): SyncError {
  const error = new SyncError("product-private-platform-invalid", 503);
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * The single cleanup attempt allowed for a port that failed validation
 * before ownership transferred. Only a readable, plainly synchronous close
 * may run — anything else contributes an explicit cause instead of letting
 * "no safe close" pass as completed cleanup. A synchronous throw keeps its
 * identity, an unreadable member contributes the getter's own exception, and
 * a nonvoid result (Promise, thenable, or any value) is classified UNKNOWN
 * after a native Promise is observed so its rejection cannot go unhandled.
 */
function closeRejected(provider: PrivatePlatform): () => void {
  let close: unknown;
  try {
    close = provider.close;
  } catch (error) {
    return () => {
      throw error;
    };
  }
  if (
    typeof close !== "function" ||
    types.isAsyncFunction(close) ||
    types.isGeneratorFunction(close)
  )
    return () => {
      throw new SyncError(
        "product-private-platform-cleanup-unsupported",
        503,
      );
    };
  const fn = close as () => unknown;
  return () => {
    const result = Reflect.apply(fn, provider, []);
    if (result === undefined) return;
    try {
      if (types.isPromise(result))
        Promise.prototype.then.call(result, undefined, () => undefined);
    } catch {
      /* Observation failure must never replace the UNKNOWN classification. */
    }
    throw new SyncError("product-private-platform-cleanup-unknown", 503);
  };
}

/**
 * Scope private-journal port selection for the duration of `work`, including
 * every async continuation scheduled inside it. `undefined` runs `work`
 * directly and inherits the ambient context; a supplied options object
 * replaces it for the nested scope only.
 */
export function withProductPrivateJournals<T>(
  options: ProductPrivateJournalOptions | undefined,
  work: () => T,
): T {
  if (options === undefined) return work();
  requireCondition(
    options !== null && typeof options === "object" && !Array.isArray(options),
    "product-private-platform-invalid",
    503,
  );
  return context.run(options, work);
}

/**
 * Allocate a fresh private platform port for one journal open. Returns
 * `undefined` when no factory is configured so journals keep their POSIX
 * default (and fail closed on a real win32 host). A configured factory must
 * synchronously produce a valid port: async/generator factories are rejected
 * before invocation, Promise/thenable/malformed results are rejected with no
 * fallback (a native rejected Promise is observed so it cannot surface as an
 * unhandled rejection), and a synchronous throw keeps its identity. A port
 * that fails validation is closed only through a synchronous close, retaining
 * both causes; a valid port's ownership transfers to the journal immediately
 * and is never closed here.
 */
export function createProductPrivatePlatform(
  directory: string,
  name: string,
  options?: ProductPrivateJournalOptions,
): PrivatePlatform | undefined {
  const selected = options !== undefined ? options : context.getStore();
  // Only an absent value means "no configuration". An explicit null, array,
  // or primitive is an invalid configuration, never a POSIX fallback.
  if (selected === undefined) return undefined;
  requireCondition(
    selected !== null &&
      typeof selected === "object" &&
      !Array.isArray(selected),
    "product-private-platform-invalid",
    503,
  );
  const factory = selected.privatePlatformFactory;
  if (factory === undefined) return undefined;
  requireCondition(
    typeof factory === "function" &&
      !types.isAsyncFunction(factory) &&
      !types.isGeneratorFunction(factory),
    "product-private-platform-invalid",
    503,
  );
  const raw: unknown = factory(directory, name);
  if (types.isPromise(raw)) {
    try {
      Promise.prototype.then.call(raw, undefined, () => undefined);
    } catch {
      /* Only the invalid classification below is allowed to surface. */
    }
    throw invalid();
  }
  let thenable = false;
  try {
    thenable =
      raw !== null &&
      (typeof raw === "object" || typeof raw === "function") &&
      typeof (raw as { then?: unknown }).then === "function";
  } catch {
    thenable = true;
  }
  requireCondition(
    !thenable &&
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw),
    "product-private-platform-invalid",
    503,
  );
  const provider = raw as PrivatePlatform;
  let port: PrivatePlatform;
  try {
    port = synchronousPrivatePlatform(provider);
  } catch (primary) {
    // Validation failed before ownership transferred, so this port is not
    // issued: exactly one proven-synchronous close attempt runs and every
    // cause — including "no safe cleanup existed" — is retained.
    throwAfterJournalCleanup(invalid(primary), [closeRejected(provider)]);
  }
  requireCondition(
    !issued.has(port) && !issued.has(provider),
    "product-private-platform-reused",
    503,
  );
  issued.add(port);
  issued.add(provider);
  return port;
}
