import { CollaborationError } from "../../collaboration/runtime/contract";
import { WindowsPrivatePlatform, type PrivatePlatform } from "../../sync/private-platform";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canonical } from "../../collaboration/runtime/canonical";
import { preflightExistingJournal, type JournalPreflightConnectionOwner } from "../../sync/journal-preflight";
import { SqliteConnectionOwner, closeSqlitePlatform } from "../../sync/sqlite-connection-owner";
import { createNativeAuthorityLeaseAcquirer, withPrivateAuthorityLease } from "./authority-lease";
import { WindowsRuntimePlatform, type WindowsRuntimePreparedDirectory, type WindowsRuntimeFileIdentity } from "./runtime-platform";
import { WindowsSourceBindings, WINDOWS_SOURCE_BINDINGS_DATABASE, type WindowsSourceIdentity } from "./source-bindings";
import type { WindowsAppPrivateConfig } from "./app-private";
import { win32 } from "node:path";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";

export type WindowsSourceBindingConfig = WindowsAppPrivateConfig & Readonly<{
  publicationStateRoot: string;
  publicationStateDirectory: string;
}>;
export type WindowsSourceBindingGuard = Readonly<{
  directory(identity: WindowsRuntimePreparedDirectory, newlyCreated?: boolean): void;
  file(identity: WindowsRuntimeFileIdentity, newlyCreated?: boolean): void;
  stateDirectory(identity: WindowsRuntimePreparedDirectory): void;
  retainedFile(path: string): WindowsRuntimeFileIdentity;
  close(): void;
}>;

/** Enrollment is selected by a trusted create/import entry point. Ordinary
 * reconstructed factories require retained records; a first read never grants
 * permission to establish a replacement identity. New output identities may be
 * enrolled only after the caller has the native exclusive-create receipt. */
export function createWindowsSourceBindingGuard(
  config: WindowsSourceBindingConfig,
  enrollExisting = false,
): WindowsSourceBindingGuard {
  if (process.platform !== "win32") throw new CollaborationError("WINDOWS_SOURCE_BINDING_UNSUPPORTED_PLATFORM");
  const root = validateWindowsPath(config.root, config.root).canonical;
  const stateRoot = validateWindowsPath(config.publicationStateRoot, config.publicationStateRoot).canonical;
  const stateDirectory = validateWindowsPath(config.publicationStateDirectory, stateRoot).canonical;
  const a = asciiCaseFold(root).replace(/\\$/, ""), b = asciiCaseFold(stateRoot).replace(/\\$/, "");
  if (a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\")) throw new CollaborationError("WINDOWS_SOURCE_BINDING_STATE_OVERLAP");
  let bindings: WindowsSourceBindings | undefined;
  let owned: PrivatePlatform | undefined;
  let base: PrivatePlatform | undefined;
  let runtime: WindowsRuntimePlatform | undefined;
  let sourceRuntime: WindowsRuntimePlatform | undefined;
  // Lazily reserved at the START of first use — before any runtime/bind or
  // SQLite — and retained across hidden preflight readers and the child
  // PrivateLedger. Its callback strongly holds the outer lease wrapper, the
  // raw runtimes and this guard state.
  let bootstrapOwner: SqliteConnectionOwner | undefined;
  const bootstrapReaders = new Set<DatabaseSync>();
  let ledgerStarted = false;
  // Records only that the verified ordered cleanup completed — never a
  // substitute for the raw `isOpen` proofs that precede it.
  let bootstrapReleased = false;
  // Presence flag: a thrown `undefined` failure still counts.
  let failedPresent = false;
  let failed: unknown;
  let closing = false;
  let closed = false;
  const use = (): WindowsSourceBindings => {
    if (closed || closing) throw new CollaborationError("WINDOWS_SOURCE_BINDING_CLOSED");
    if (failedPresent) throw failed;
    if (bindings) return bindings;
    if (bootstrapOwner === undefined) {
      bootstrapOwner = new SqliteConnectionOwner(() => {
        closeSqlitePlatform(owned ?? base ?? runtime);
        closeSqlitePlatform(sourceRuntime);
        bootstrapReleased = true;
      });
    }
    // Hidden bootstrap readers are admitted to the SAME owner so a preflight
    // close failure is observed, retained and never retried.
    const preflightOwner: JournalPreflightConnectionOwner = {
      opened(db) {
        bootstrapReaders.add(db);
        bootstrapOwner!.opened(db);
      },
      closeConnection(db, primary) {
        bootstrapOwner!.closeConnection(db, primary);
      },
    };
    try {
      runtime = new WindowsRuntimePlatform({root: stateRoot, probeExecutable: config.probeExecutable,
        expectedHash: config.expectedHash, systemRoot: config.systemRoot, databaseName: WINDOWS_SOURCE_BINDINGS_DATABASE});
      const stateRuntime = runtime;
      stateRuntime.bind(stateDirectory);
      const directory = stateRuntime.validatedDirectoryIdentity();
      sourceRuntime = new WindowsRuntimePlatform({...config, root});
      // The raw root proof runtime stays owned until ordered cleanup; it has
      // no SQLite and the owner callback releases it once, synchronously.
      sourceRuntime.bind(root);
      const source = sourceRuntime.validatedDirectoryIdentity();
      const sourceIdentity: WindowsSourceIdentity = {kind: "root", canonicalPath: root,
        fileId: source.rootFileId, volumeId: source.rootVolumeId};
      const path = win32.join(stateDirectory, WINDOWS_SOURCE_BINDINGS_DATABASE);
      // Explicit provider so the child ledger's bind never re-binds the
      // already-bound runtime (WindowsRuntimePlatform.bind rejects a second
      // bind): the provider validates the path against the bound directory
      // and returns the real canonical path while the runtime keeps its
      // native proofs.
      base = new WindowsPrivatePlatform({
        bind(p) {
          if (asciiCaseFold(validateWindowsPath(p, stateRoot).canonical) !== asciiCaseFold(directory.canonicalPath))
            throw new CollaborationError("WINDOWS_SOURCE_BINDING_PATH");
          stateRuntime.assertRoot();
          return directory.canonicalPath;
        },
        assertRoot: () => stateRuntime.assertRoot(),
        assertFile: p => stateRuntime.assertFile(p),
        assertSidecars: p => stateRuntime.assertSidecars(p),
        createExclusiveDurably: p => stateRuntime.createExclusiveDurably(p),
        assertEmptyFile: p => stateRuntime.assertEmptyFile(p),
        withHotJournalSnapshot: (p, cb) => stateRuntime.withHotJournalSnapshot(p, cb),
        close: () => stateRuntime.close(),
      });
      const heldBase = base;
      let checked = false;
      const inner: PrivatePlatform = {
        kind: "windows", bind: p => {
          const result = heldBase.bind(p);
          if (!enrollExisting) stateRuntime.validatedFileIdentity(path);
          return result;
        },
        createExclusive(p) {
          if (p !== path) throw new CollaborationError("WINDOWS_SOURCE_BINDING_PATH");
          stateRuntime.createExclusiveDurablyWithReceipt(p);
        },
        assertRoot: () => heldBase.assertRoot(),
        assertFile(p) {
          heldBase.assertFile(p);
          if (p !== path) throw new CollaborationError("WINDOWS_SOURCE_BINDING_PATH");
          if (!checked) {
            const d = stateRuntime.validatedDirectoryIdentity(), f = stateRuntime.validatedFileIdentity(path);
            if (lstatSync(path).size === 0) {
              if (!enrollExisting) throw new CollaborationError("WINDOWS_SOURCE_BINDING_REQUIRED");
            } else preflightExistingJournal(path, () => {
              stateRuntime.validatedDirectoryIdentity(); stateRuntime.validatedFileIdentity(path);
            }, db => {
              for (const identity of [
                {kind: "root", canonicalPath: stateRoot, fileId: d.rootFileId, volumeId: d.rootVolumeId},
                {kind: "directory", canonicalPath: stateDirectory, fileId: d.directoryFileId, volumeId: d.directoryVolumeId},
                {...f, kind: "file"},
                sourceIdentity,
              ]) {
                const value = {...identity, canonicalPath: asciiCaseFold(identity.canonicalPath),
                  fileId: asciiCaseFold(identity.fileId), volumeId: asciiCaseFold(identity.volumeId)};
                const key = `source:${value.kind}:${createHash("sha256").update(value.canonicalPath).digest("hex")}`;
                const row = db.prepare("SELECT value FROM m3_private_records WHERE key=?").get(key);
                if (!row || row.value !== canonical(value)) throw new CollaborationError("WINDOWS_SOURCE_BINDING_CHANGED");
              }
            }, inner, preflightOwner);
            checked = true;
          }
        },
        assertSidecars: p => heldBase.assertSidecars(p), assertEmptyFile: p => heldBase.assertEmptyFile(p),
        close: () => heldBase.close(),
        ...(heldBase.withHotJournalSnapshot ? {withHotJournalSnapshot: heldBase.withHotJournalSnapshot.bind(heldBase)} : {}),
      };
      owned = withPrivateAuthorityLease(inner, createNativeAuthorityLeaseAcquirer({
        ...config, root: stateRoot,
        expectedRoot: {rootFileId: directory.rootFileId, volumeId: directory.rootVolumeId},
        identityFor(p) {
          if (p !== path) throw new CollaborationError("WINDOWS_SOURCE_BINDING_PATH");
          const d = stateRuntime.validatedDirectoryIdentity(), f = stateRuntime.validatedFileIdentity(path);
          return {directoryFileId: d.directoryFileId, directoryVolumeId: d.directoryVolumeId, fileId: f.fileId, volumeId: f.volumeId};
        },
      }));
      const held = owned;
      // The child's T2 owner reaches this close ONLY after its own databases
      // are confirmed closed. The hidden bootstrap readers are proven closed
      // here first — never a second raw close — then the reserved bootstrap
      // owner orders its own cleanup and the lease/platform release.
      const ledgerPlatform: PrivatePlatform = {
        ...held,
        bind(p) { ledgerStarted = true; return held.bind(p); },
        close() {
          for (const db of bootstrapReaders) {
            if (db.isOpen !== false)
              throw new Error("UNKNOWN: source-binding bootstrap reader still owned");
          }
          bootstrapOwner!.close();
        },
      };
      const candidate = new WindowsSourceBindings(stateDirectory, ledgerPlatform, [root]);
      // Enrollment state is checked AFTER the child constructor owns its own
      // database: assign bindings first so a later close can finish ordered
      // cleanup through the composed chain.
      bindings = candidate;
      const id = stateRuntime.validatedDirectoryIdentity();
      const stateIdentities: WindowsSourceIdentity[] = [
        {kind: "root", canonicalPath: stateRoot, fileId: id.rootFileId, volumeId: id.rootVolumeId},
        {kind: "directory", canonicalPath: id.canonicalPath, fileId: id.directoryFileId, volumeId: id.directoryVolumeId},
        {...stateRuntime.validatedFileIdentity(win32.join(stateDirectory, WINDOWS_SOURCE_BINDINGS_DATABASE)), kind: "file"},
        sourceIdentity,
      ];
      for (const identity of stateIdentities) enrollExisting ? candidate.enroll(identity) : candidate.assert(identity);
      return candidate;
    } catch (error) {
      failedPresent = true; failed = error;
      // Before the child constructor's bind there is no hidden main DB: the
      // bootstrap owner fails once through the owned path. Afterwards the
      // child's own T2 owner already made the only allowed close attempt, so
      // this catch records and rethrows only — never releases C.
      if (!ledgerStarted) bootstrapOwner!.fail(error);
      throw error;
    }
  };
  const check = (identity: WindowsSourceIdentity, newlyCreated: boolean): void => {
    const db = use();
    if (enrollExisting || newlyCreated) db.enroll(identity); else db.assert(identity);
  };
  return Object.freeze({
    directory(id: WindowsRuntimePreparedDirectory, newlyCreated = false) {
      check({kind: "root", canonicalPath: root, fileId: id.rootFileId, volumeId: id.rootVolumeId}, false);
      check({kind: "directory", canonicalPath: id.canonicalPath, fileId: id.directoryFileId, volumeId: id.directoryVolumeId}, newlyCreated);
    },
    file(id: WindowsRuntimeFileIdentity, newlyCreated = false) { check({...id, kind: "file"}, newlyCreated); },
    stateDirectory(id: WindowsRuntimePreparedDirectory) {
      if (asciiCaseFold(id.canonicalPath) !== asciiCaseFold(stateDirectory))
        throw new CollaborationError("WINDOWS_SOURCE_BINDING_STATE_DIRECTORY");
      check({kind: "root", canonicalPath: stateRoot, fileId: id.rootFileId, volumeId: id.rootVolumeId}, false);
      check({kind: "directory", canonicalPath: id.canonicalPath, fileId: id.directoryFileId, volumeId: id.directoryVolumeId}, false);
    },
    retainedFile(path: string) {
      let allowed = false;
      try { allowed = validateWindowsPath(path, root).canonical === path; } catch { /* state authority below */ }
      if (!allowed) {
        const canonicalPath = validateWindowsPath(path, stateRoot).canonical;
        if (canonicalPath !== path || asciiCaseFold(win32.dirname(path)) !== asciiCaseFold(stateDirectory))
          throw new CollaborationError("WINDOWS_SOURCE_BINDING_STATE_PATH");
      }
      const id = use().retainedIdentity("file", path);
      return {canonicalPath: path, fileId: id.fileId, volumeId: id.volumeId};
    },
    close() {
      if (closed) return;
      closing = true;
      // A hidden child constructor that failed after bind may still retain
      // its own raw main DB — there is no returned owner to retry through, so
      // this close surfaces the recorded failure instead of releasing C. If
      // the ordered cleanup already completed (a post-close proof failure
      // after the raw handle was actually closed), nothing remains to retry.
      if (failedPresent && !bindings && ledgerStarted) {
        if (bootstrapReleased) {
          closed = true;
          return;
        }
        throw failed;
      }
      // Composed cleanup order: child's owned SQLite -> proven bootstrap
      // readers -> bootstrap owner -> authority lease -> runtimes.
      if (bindings) bindings.close();
      else if (!ledgerStarted) bootstrapOwner?.close();
      closed = true;
    },
  });
}
