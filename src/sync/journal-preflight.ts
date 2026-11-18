import {chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeSync, type Stats} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { synchronousPrivatePlatform, type PrivatePlatform } from "./private-platform";
import {closeStartupConnection} from "../persistence/startup-connection-owner";

/** The journal's owner retains every preflight connection with its native
 * protector. Open/close callbacks are synchronous, internal ownership hooks. */
export type JournalPreflightConnectionOwner = Readonly<{
  opened(db: DatabaseSync): void;
  closeConnection(db: DatabaseSync, primary?: Readonly<{error: unknown}>): void;
}>;
function closePreflight(db: DatabaseSync, owner: JournalPreflightConnectionOwner | undefined,
  failed: boolean, failure: unknown): void {
  const primary = failed ? {error: failure} : undefined;
  if (owner) owner.closeConnection(db, primary);
  else closeStartupConnection(db, undefined, primary);
}

/** Semantic role/binding checks must precede persistent journal-mode changes.
 * Readonly inspection preserves foreign and wrong-bound databases. */
function readonlyPreflight(
  path: string,
  assertPath: () => void,
  validate: (db: DatabaseSync) => void,
  owner?: JournalPreflightConnectionOwner,
): void {
  assertPath();
  const db = new DatabaseSync(path, { readOnly: true });
  let failed = false;
  let failure: unknown;
  try {
    owner?.opened(db);
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
    // Force a real SQLite read before calling the semantic validator. PRAGMA
    // setup alone need not touch the hot journal; even a validator that throws
    // immediately must run on the recovered private copy in that case.
    db.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    validate(db);
    assertPath();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    closePreflight(db, owner, failed, failure);
  }
  assertPath();
}

// A hot rollback journal cannot be read through a readonly SQLite handle.
// Recover only a bounded, private disposable copy to establish semantic role
// and binding BEFORE allowing SQLite to recover the actual owned journal.
// Native Windows private-copy capability is not provided by this POSIX path.
function preflightHotCopy(path: string, assertPath: () => void, validate: (db: DatabaseSync) => void, platform?: PrivatePlatform,
  owner?: JournalPreflightConnectionOwner): void {
  if (platform !== undefined) {
    const wrapped = synchronousPrivatePlatform(platform);
    // An injected windows platform without the snapshot capability must fail
    // closed; it can never fall back to the POSIX copy on any host.
    if (wrapped.kind === "windows") {
      preflightNativeSnapshot(path, assertPath, validate, wrapped, owner);
      return;
    }
  }
  if (process.platform === "win32") throw new Error("Windows hot-journal private copy is unavailable");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-journal-preflight-")));
  const versions = new Map<string, Stats>();
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  let db: DatabaseSync | undefined;
  let failed = false, failure: unknown;
  try {
    chmodSync(root, 0o700); assertPath();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const source = path + suffix;
      let stat: Stats;
      try {stat = lstatSync(source);} catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e;}
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 * 1024) throw new Error("Unsafe journal snapshot");
      versions.set(source, stat);
      const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let output: number | undefined;
      try {
        if (!same(stat, fstatSync(input))) throw new Error("Changed journal snapshot");
        output = openSync(join(root, "snapshot.sqlite" + suffix), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        const buffer = Buffer.alloc(64 * 1024); let offset = 0;
        while (offset < stat.size) {
          const count = readSync(input, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (count <= 0) throw new Error("Short journal snapshot");
          let written = 0;
          while (written < count) {const n = writeSync(output, buffer, written, count - written); if (n <= 0) throw new Error("Short snapshot write"); written += n;}
          offset += count;
        }
        if (!same(stat, fstatSync(input)) || !same(stat, lstatSync(source))) throw new Error("Changed journal snapshot");
      } finally {try {if (output !== undefined) closeSync(output);} finally {closeSync(input);}}
    }
    db = new DatabaseSync(join(root, "snapshot.sqlite"));
    owner?.opened(db);
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
    validate(db);
    assertPath();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      const source = path + suffix, before = versions.get(source);
      try {const after = lstatSync(source); if (!before || !same(before, after)) throw new Error("Changed journal snapshot");}
      catch (e) {if ((e as NodeJS.ErrnoException).code === "ENOENT" && !before) continue; throw e;}
    }
  } catch (error) {failed = true; failure = error; throw error;}
  finally {
    try {if (db) closePreflight(db, owner, failed, failure);}
    finally {
      // A still-open/unknown working reader keeps its files and owning graph.
      if (!db || db.isOpen === false) rmSync(root, {recursive: true, force: true});
    }
  }
}

/**
 * Recover semantic proof on the native private working copy only. The
 * capability must already exist on the wrapped windows platform — there is
 * no POSIX fallback and no writable open of the original inside preflight.
 * The callback opens only the disposable snapshot path, applies the same
 * query_only/trusted_schema/busy_timeout hardening, validates role/binding,
 * and closes preserving both the semantic and the close error causes.
 */
function preflightNativeSnapshot(
  path: string,
  assertPath: () => void,
  validate: (db: DatabaseSync) => void,
  platform: PrivatePlatform,
  owner?: JournalPreflightConnectionOwner,
): void {
  const snapshot = platform.withHotJournalSnapshot;
  if (snapshot === undefined)
    throw new Error("Windows hot-journal private copy is unavailable");
  assertPath();
  snapshot.call(platform, path, (snapshotPath: string) => {
    const db = new DatabaseSync(snapshotPath);
    let failed = false;
    let failure: unknown;
    try {
      owner?.opened(db);
      db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0");
      validate(db);
      assertPath();
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      closePreflight(db, owner, failed, failure);
    }
  });
  assertPath();
}

export function preflightExistingJournal(path: string, assertPath: () => void, validate: (db: DatabaseSync) => void, platform?: PrivatePlatform,
  owner?: JournalPreflightConnectionOwner): void {
  try {readonlyPreflight(path, assertPath, validate, owner);}
  catch (error) {
    // SQLITE_READONLY_ROLLBACK: no other failure grants recovery authority.
    if (error === null || typeof error !== "object" || (error as {errcode?: number}).errcode !== 776) throw error;
    preflightHotCopy(path, assertPath, validate, platform, owner);
  }
}

/** Constructor failure must retain every owned cleanup cause. */
export function throwAfterJournalCleanup(primary: unknown, cleanup: readonly (() => void)[]): never {
  const errors = [primary];
  for (const action of cleanup) try {action();} catch (error) {errors.push(error);}
  if (errors.length > 1) throw new AggregateError(errors, "Journal initialization and cleanup failed");
  throw primary;
}
