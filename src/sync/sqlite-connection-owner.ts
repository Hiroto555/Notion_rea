import { DatabaseSync } from "node:sqlite";
import { SyncSqliteGuard } from "./sqlite-guard";
import type { JournalPreflightConnectionOwner } from "./journal-preflight";
import { synchronousPort } from "../platform/synchronous-port";

const MAX_OWNERS = 64;

/**
 * Live owner reservations. An owner is added BEFORE any filesystem or native
 * acquisition and removed only after every registered connection is provably
 * closed AND the ordered platform cleanup completed. An unknown constructor
 * failure keeps the entire owner/platform/connection graph strongly reachable
 * here, and the cap counts unresolved reservations so cleanup cannot queue an
 * unbounded set of retained graphs.
 */
const reserved = new Set<SqliteConnectionOwner>();
const uncertainFailures = new WeakSet<object>();
/** Main can recognize the original retained owner before IPC serialization.
 * The brand grants no cleanup/replay capability. */
export function sqliteOwnerRetainsPlatform(error: unknown): boolean {
  return typeof error === "object" && error !== null && uncertainFailures.has(error);
}
function markUncertain(error: unknown): unknown {
  const failure = typeof error === "object" && error !== null ? error :
    new AggregateError([error], "UNKNOWN: SQLite owner retains unconfirmed cleanup");
  uncertainFailures.add(failure);
  return failure;
}

/** Close-only synchronous contract: known-async cleanup is rejected before
 * execution and a malformed/deferred result is pinned so it can never be
 * replayed as success on a later call. */
const CLEANUP = {
  close: { result: "void", cleanup: true },
} as const;

/**
 * Owned platform release for journal/store constructors. The supplied raw
 * platform is wrapped in the close-only synchronous contract, so an
 * asynchronous or malformed cleanup throws instead of silently detaching the
 * owner graph. Facades are cached per provider, keeping a pinned failure.
 */
export function closeSqlitePlatform(
  platform: { close(): void } | null | undefined,
): void {
  if (platform) synchronousPort(platform, CLEANUP).close();
}

type ConnectionRecord = {
  readonly db: DatabaseSync;
  /** A raw close was attempted exactly once (by owner or inside the guard). */
  attempted: boolean;
  /** Only a direct `isOpen === false` observation is proof of closure. */
  closed: boolean;
  /** Historical failure retained for diagnostics on kept owners. */
  failure?: unknown;
};

/**
 * One synchronous owner of every DatabaseSync handle a journal/store touches
 * plus the native platform that must outlive them. `db.close()` returning is
 * never treated as proof: only `isOpen === false` settles a record. A close
 * that throws, returns without closing, or cannot be proven leaves the record
 * unresolved; constructor cleanup (`fail`) never retries an already-attempted
 * close and skips the platform release while any handle is unconfirmed, while
 * explicit `close()` is the owned retry path that resolves remaining handles
 * before releasing the platform exactly once.
 */
export class SqliteConnectionOwner implements JournalPreflightConnectionOwner {
  private readonly records = new Map<DatabaseSync, ConnectionRecord>();
  /** Every primary/cleanup/proof cause this owner has surfaced, strongly held
   * for as long as the owner itself is retained. */
  private readonly failures = new Set<unknown>();
  /** Latest failure object actually thrown, retained with the owner. */
  private lastFailure: unknown;
  private readonly release: { close(): void };
  private platformClosed = false;

  constructor(closePlatform: () => void) {
    // Wrap BEFORE reserving: a non-callable or known-async cleanup must fail
    // construction without leaving a reservation behind. The boundary also
    // guarantees a deferred/malformed cleanup result is pinned, never replayed
    // as success.
    const boundary = synchronousPort({ close: closePlatform }, CLEANUP);
    this.release = boundary;
    if (reserved.size >= MAX_OWNERS)
      throw new Error("UNKNOWN: SQLite owner capacity reached");
    // The boundary strongly retains the platform/guard graph for the whole
    // reservation lifetime.
    reserved.add(this);
  }

  private retain(failure: unknown): void {
    this.failures.add(failure);
    this.lastFailure = failure;
  }

  /** Record a raw handle the moment DatabaseSync returns it. */
  opened(db: DatabaseSync): void {
    if (!this.records.has(db))
      this.records.set(db, { db, attempted: false, closed: false });
  }

  /**
   * One close attempt on a record: raw `close` once, then ALWAYS an
   * `isOpen === false` proof — even when close threw. On explicit retry a
   * prior close may already have settled the handle before its state getter
   * failed, so prove first and skip a second raw close; a still-throwing
   * getter preserves its proof cause and the close is attempted anyway.
   */
  private attemptClose(
    record: ConnectionRecord,
    failures: unknown[],
    reprobe: boolean,
  ): void {
    if (reprobe) {
      let known = false;
      try {
        known = record.db.isOpen === false;
      } catch (proof) {
        failures.push(proof);
        this.retain(proof);
      }
      if (known) {
        record.closed = true;
        return;
      }
    }
    record.attempted = true;
    try {
      record.db.close();
    } catch (cleanup) {
      failures.push(cleanup);
      this.retain(cleanup);
    }
    try {
      record.closed = record.db.isOpen === false;
    } catch (proof) {
      failures.push(proof);
      this.retain(proof);
    }
  }

  /**
   * Register the raw handle, then construct the guard. A failed guard
   * constructor has already attempted its own close internally: observe the
   * outcome only, never attempt a second close here.
   */
  guarded(db: DatabaseSync): SyncSqliteGuard {
    this.opened(db);
    try {
      return new SyncSqliteGuard(db);
    } catch (error) {
      const record = this.records.get(db)!;
      record.attempted = true;
      const failures: unknown[] = [error];
      try {
        record.closed = db.isOpen === false;
      } catch (proof) {
        failures.push(proof);
      }
      if (!record.closed)
        failures.push(
          new Error("UNKNOWN: SQLite guard constructor close unconfirmed"),
        );
      const failure =
        failures.length === 1
          ? error
          : new AggregateError(failures, "UNKNOWN: SQLite guard initialization");
      record.failure = failure;
      for (const cause of failures) this.retain(cause);
      this.retain(failure);
      throw failure;
    }
  }

  /**
   * One owned close attempt for preflight/validation handles. The primary
   * semantic failure is propagated even when the close itself is clean; the
   * primary-presence wrapper distinguishes a thrown `undefined` value.
   */
  closeConnection(
    db: DatabaseSync,
    primary?: Readonly<{ error: unknown }>,
  ): void {
    this.opened(db);
    const record = this.records.get(db)!;
    const failures: unknown[] = primary ? [primary.error] : [];
    if (!record.closed) {
      if (!record.attempted) this.attemptClose(record, failures, false);
      if (!record.closed) {
        const failure = new AggregateError(
          [
            ...failures,
            new Error("UNKNOWN: SQLite connection close unconfirmed"),
          ],
          "UNKNOWN: SQLite connection close outcome unknown",
        );
        record.failure = failure;
        for (const cause of failures) this.retain(cause);
        this.retain(failure);
        throw markUncertain(failure);
      }
    }
    for (const cause of failures) this.retain(cause);
    if (failures.length === 1) {
      this.retain(failures[0]);
      throw failures[0];
    }
    if (failures.length > 1) {
      const failure = new AggregateError(
        failures,
        "UNKNOWN: SQLite operation and connection close failed",
      );
      this.retain(failure);
      throw failure;
    }
  }

  private pending(): boolean {
    for (const record of this.records.values())
      if (!record.closed) return true;
    return false;
  }

  private releaseReservation(): void {
    if (this.pending()) return;
    if (!this.platformClosed) return;
    reserved.delete(this);
  }

  private closePlatformOnce(failures: unknown[]): void {
    if (this.platformClosed) return;
    try {
      this.release.close();
      this.platformClosed = true;
    } catch (cleanup) {
      failures.push(cleanup);
      this.retain(cleanup);
    }
  }

  /**
   * Constructor cleanup. Handles never attempted are closed once; handles the
   * preflight or the guard constructor already tried are never retried. Any
   * unconfirmed connection skips platform release and retains this owner.
   */
  fail(primary: unknown): never {
    const failures: unknown[] = [primary];
    this.retain(primary);
    for (const record of this.records.values()) {
      if (record.closed || record.attempted) continue;
      this.attemptClose(record, failures, false);
    }
    if (this.pending()) {
      const failure = new AggregateError(
        [
          ...failures,
          new Error("UNKNOWN: SQLite owner retains unconfirmed connections"),
        ],
        "UNKNOWN: SQLite initialization failed; owner retained",
      );
      for (const cause of failures) this.retain(cause);
      this.retain(failure);
      throw markUncertain(failure);
    }
    this.closePlatformOnce(failures);
    this.releaseReservation();
    if (failures.length === 1) {
      this.retain(failures[0]);
      throw failures[0];
    }
    const failure = new AggregateError(
      failures,
      "UNKNOWN: SQLite initialization and cleanup failed",
    );
    this.retain(failure);
    throw this.platformClosed ? failure : markUncertain(failure);
  }

  /**
   * Explicit owned cleanup: retries every unconfirmed connection, then runs
   * platform cleanup once all handles are proven closed. A silent close that
   * leaves the handle open, a throw, or an unprovable state all fail here —
   * never a silent success — while keeping the remaining work explicit so a
   * later call can finish.
   */
  close(): void {
    const failures: unknown[] = [];
    for (const record of this.records.values()) {
      if (record.closed) continue;
      this.attemptClose(record, failures, true);
    }
    const pending = this.pending();
    if (!pending) this.closePlatformOnce(failures);
    this.releaseReservation();
    if (pending && failures.length === 0)
      failures.push(
        new Error("UNKNOWN: SQLite connection close unconfirmed"),
      );
    for (const cause of failures) this.retain(cause);
    if (failures.length === 1) {
      const failure = pending || !this.platformClosed ? markUncertain(failures[0]) : failures[0];
      this.retain(failure);
      throw failure;
    }
    if (failures.length > 1) {
      const failure = new AggregateError(
        failures,
        "UNKNOWN: SQLite owner cleanup incomplete",
      );
      this.retain(failure);
      throw pending || !this.platformClosed ? markUncertain(failure) : failure;
    }
  }
}
