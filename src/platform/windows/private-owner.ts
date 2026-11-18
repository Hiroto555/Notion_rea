import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import { preflightExistingJournal } from "../../sync/journal-preflight";
import { SqliteConnectionOwner, closeSqlitePlatform } from "../../sync/sqlite-connection-owner";
import type { PrivatePlatform } from "../../sync/private-platform";
import type { NativePrivateFilesystemPort } from "../private-persistence";
import { createNativeAuthorityLeaseAcquirer, type PrivateAuthorityLease } from "./authority-lease";
import type { WindowsOperatorConfig } from "./operator-native";
import { asciiCaseFold, validateWindowsPath } from "./path-policy";
import { WindowsRuntimePlatform, type WindowsRuntimeRootIdentity } from "./runtime-platform";
import { createWindowsSourceBindingGuard } from "./source-binding-guard";

export const WINDOWS_PRIVATE_OWNER_DATABASE = "private-owner.sqlite";
export type WindowsPrivateOwner = Readonly<{
  sessionId: string;
  writerId: string;
  assertCurrent(): void;
  close(): void;
}>;
export type WindowsPrivateOwnerOptions = Readonly<{
  enrollExistingSources: boolean;
  expectedRoot?: WindowsRuntimeRootIdentity;
  /** Base session fence only. Must never call the product or this owner. */
  assertCurrent(): void;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BYTES = 8 * 1024 * 1024;
function check(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(`WINDOWS_PRIVATE_OWNER_${code}`);
}
function sync(fn: () => void): void {
  check(typeof fn === "function" && !types.isAsyncFunction(fn) && !types.isGeneratorFunction(fn), "ASYNC");
  const result: unknown = fn();
  if (types.isPromise(result)) Promise.prototype.then.call(result, undefined, () => undefined);
  check(result === undefined, "ACK");
}
type Driver = Readonly<{
  path: string;
  binding: string;
  newlyCreated: boolean;
  platform: PrivatePlatform;
  acquire(): PrivateAuthorityLease;
  assertCurrent(): void;
  close(): void;
}>;
// A failed close retains the actual connection, helper lease, runtime and
// bindings through the common SqliteConnectionOwner reservation (cap 64) —
// ownership, never a PID/liveness registry. The holder lets the owner callback
// reach a lease acquired during preparation.
type LeaseHolder = { lease?: PrivateAuthorityLease };
type PreparedOwner = Readonly<{
  owner: SqliteConnectionOwner;
  holder: LeaseHolder;
}>;

function acquire(
  driver: Driver,
  trust: PrivateAuthorityLease["trust"],
  prepared?: PreparedOwner,
): WindowsPrivateOwner {
  const holder: LeaseHolder = prepared?.holder ?? {};
  const owner =
    prepared?.owner ??
    new SqliteConnectionOwner(() => {
      closeSqlitePlatform(holder.lease);
      closeSqlitePlatform(driver);
    });
  let db: DatabaseSync | undefined;
  let closing = false, closed = false;
  // Presence flag: a thrown `undefined` failure still counts.
  let failedPresent = false, failure: unknown;
  const assertNative = () => {
    sync(driver.assertCurrent);
    check(holder.lease !== undefined, "LEASE");
    sync(() => holder.lease!.assertHeld());
    driver.platform.assertRoot();
    driver.platform.assertFile(driver.path);
    driver.platform.assertSidecars(driver.path);
    check(lstatSync(driver.path).size <= MAX_BYTES, "CAPACITY");
  };
  const schema = (db: DatabaseSync): string => {
    const names = db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    check(names.length === 1 && names[0].name === "private_owner" && names[0].type === "table", "ROLE");
    const columns = db.prepare("PRAGMA table_info(private_owner)").all();
    check(columns.map(row => row.name).join(",") === "version,role,binding,writer_id", "SCHEMA");
    const rows = db.prepare("SELECT * FROM private_owner").all();
    check(rows.length === 1 && rows[0].version === 1 && rows[0].role === "folio-private-owner" &&
      rows[0].binding === driver.binding && typeof rows[0].writer_id === "string" && UUID.test(rows[0].writer_id), "BINDING");
    return rows[0].writer_id;
  };
  const close = (): void => {
    if (closed) return;
    closing = true;
    // No explicit COMMIT: this transaction is an arbitration lock, not a log.
    // Owned ordered cleanup: proven SQLite close first, then lease/runtime —
    // an unconfirmed close keeps the whole graph strongly retained.
    owner.close();
    closed = true;
  };
  try {
    sync(driver.assertCurrent);
    // The raw lease is captured into the holder BEFORE trust/assert so the
    // owner callback can always release it.
    holder.lease = driver.acquire();
    check(holder.lease?.trust === trust, "LEASE_TRUST");
    assertNative();
    const size = lstatSync(driver.path).size;
    if (size !== 0) preflightExistingJournal(driver.path, assertNative, schema, driver.platform, owner);
    else check(driver.newlyCreated, "EMPTY_EXISTING_UNKNOWN");
    db = new DatabaseSync(driver.path);
    owner.opened(db);
    db.exec("PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF");
    check(db.prepare("PRAGMA page_size").get()?.page_size === 4096, "PAGE_SIZE");
    // Role validation above precedes any persistent mode change/recovery.
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=2048");
    db.exec("BEGIN EXCLUSIVE");
    check(db.isOpen && db.isTransaction, "EXCLUSIVE");
    if (size === 0) {
      check(driver.newlyCreated, "CREATE_PROOF");
      assertNative();
      db.exec("CREATE TABLE private_owner(version INTEGER NOT NULL,role TEXT NOT NULL,binding TEXT NOT NULL,writer_id TEXT NOT NULL)");
      db.prepare("INSERT INTO private_owner VALUES(1,'folio-private-owner',?,?)").run(driver.binding, randomUUID());
      schema(db);
      db.exec("COMMIT");
      check(!db.isTransaction, "COMMIT_UNKNOWN");
      db.exec("BEGIN EXCLUSIVE");
    }
    const writerId = schema(db), sessionId = randomUUID();
    const handle = db;
    const assertCurrent = (): void => {
      if (failedPresent) throw failure;
      try {
        check(!closing && !closed && handle.isOpen === true && handle.isTransaction === true, "NOT_HELD");
        assertNative(); // RAW C lease: never the recursive K facade.
        check(handle.isOpen === true && handle.isTransaction === true && schema(handle) === writerId, "INCARNATION");
      } catch (error) { failedPresent = true; failure = error; throw error; }
    };
    assertCurrent();
    return Object.freeze({sessionId, writerId, assertCurrent, close() {
      try { close(); } catch (error) {
        const causes = !failedPresent || failure === error ? [error] : [failure, error];
        failedPresent = true;
        failure = new AggregateError(causes, "WINDOWS_PRIVATE_OWNER_CLOSE_UNKNOWN");
        throw failure;
      }
    }});
  } catch (error) {
    // Constructor cleanup is the owned path only — never the public close,
    // which would retry handles the preflight already attempted.
    return owner.fail(error);
  }
}

/** Product and maintenance CLI MUST acquire this same owner before opening
 * workspace storage. A separate SQLite handle cannot acquire while it is held. */
export function acquireWindowsPrivateOwner(
  config: WindowsOperatorConfig,
  directory: string,
  filesystem: NativePrivateFilesystemPort,
  options: WindowsPrivateOwnerOptions,
): WindowsPrivateOwner {
  check(process.platform === "win32", "PLATFORM");
  check(typeof options.enrollExistingSources === "boolean", "ENROLLMENT");
  sync(options.assertCurrent);
  const root = validateWindowsPath(config.root, config.root).canonical;
  const workspace = validateWindowsPath(directory, root).canonical;
  const path = win32.join(workspace, WINDOWS_PRIVATE_OWNER_DATABASE);
  // One reservation for the WHOLE preparation plus acquisition window: the
  // callback reaches whatever was constructed — the acquired lease (through
  // the shared holder), the binding guard and the runtime — in order.
  const holder: LeaseHolder = {};
  let runtime: WindowsRuntimePlatform | undefined;
  let bindings: ReturnType<typeof createWindowsSourceBindingGuard> | undefined;
  const owner = new SqliteConnectionOwner(() => {
    closeSqlitePlatform(holder.lease);
    closeSqlitePlatform(bindings);
    closeSqlitePlatform(runtime);
  });
  let handedOff = false;
  try {
    runtime = new WindowsRuntimePlatform({...config, root, databaseName: WINDOWS_PRIVATE_OWNER_DATABASE,
      expectedRoot: options.expectedRoot, snapshotProfile: "small-ledger"});
    const boundRuntime = runtime;
    bindings = createWindowsSourceBindingGuard(config, options.enrollExistingSources);
    const boundBindings = bindings;
    boundRuntime.bind(workspace);
    const d = boundRuntime.validatedDirectoryIdentity();
    boundBindings.directory(d);
    let newlyCreated = false;
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      check(options.enrollExistingSources, "NOT_ENROLLED");
      // ENOENT is only a hint to attempt exclusive creation. Enrollment requires
      // the native APPLIED receipt and exact ID readback, never that hint.
      const receipt = filesystem.writeNew(path, new Uint8Array(), 0);
      const id = boundRuntime.validatedFileIdentity(path);
      check(receipt.profile === "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1" && receipt.scope === "PROCESS_CRASH" &&
        receipt.identity.path === path && receipt.identity.bytes === 0 &&
        receipt.identity.sha256 === createHash("sha256").update(new Uint8Array()).digest("hex") &&
        asciiCaseFold(id.fileId) === asciiCaseFold(receipt.identity.fileId) &&
        asciiCaseFold(id.volumeId) === asciiCaseFold(receipt.identity.volumeId), "CREATE_PROOF");
      boundBindings.file(id, true);
      newlyCreated = true;
    }
    const file = boundRuntime.validatedFileIdentity(path);
    boundBindings.file(file); // ordinary restart requires the persisted source ID.
    const binding = JSON.stringify({role: "folio-private-owner", root, workspace,
      rootFileId: d.rootFileId, rootVolumeId: d.rootVolumeId,
      directoryFileId: d.directoryFileId, directoryVolumeId: d.directoryVolumeId,
      fileId: file.fileId, volumeId: file.volumeId});
    const proof = () => {
      sync(options.assertCurrent);
      const current = boundRuntime.validatedDirectoryIdentity();
      boundBindings.directory(current);
      boundBindings.file(boundRuntime.validatedFileIdentity(path));
    };
    const raw = createNativeAuthorityLeaseAcquirer({...config, root,
      expectedRoot: {rootFileId: d.rootFileId, volumeId: d.rootVolumeId},
      identityFor(candidate) {
        check(candidate === path, "PATH");
        proof();
        const current = boundRuntime.validatedDirectoryIdentity(), id = boundRuntime.validatedFileIdentity(path);
        return {directoryFileId: current.directoryFileId, directoryVolumeId: current.directoryVolumeId,
          fileId: id.fileId, volumeId: id.volumeId};
      }});
    const platform: PrivatePlatform = {
      kind: "windows", bind: () => workspace,
      assertRoot: proof,
      assertFile: p => { check(p === path, "PATH"); proof(); },
      assertSidecars: p => boundRuntime.assertSidecars(p),
      createExclusive() { throw new Error("WINDOWS_PRIVATE_OWNER_ALREADY_CREATED"); },
      assertEmptyFile: p => boundRuntime.assertEmptyFile(p),
      withHotJournalSnapshot: (p, callback) => boundRuntime.withHotJournalSnapshot(p, callback),
      close() {},
    };
    handedOff = true;
    return acquire({path, binding, newlyCreated, platform, acquire: () => raw(path), assertCurrent: proof,
      close() { boundBindings.close(); boundRuntime.close(); }}, "native-owned-helper", {owner, holder});
  } catch (error) {
    if (handedOff) throw error;
    // Sole owned constructor cleanup: closes the acquired lease, bindings and
    // runtime in order through the synchronous boundary — retriable, never
    // silently dropped.
    return owner.fail(error);
  }
}

/** Actual Node/SQLite and temp-file contract driver; NOT Windows acceptance.
 * Production never accepts this seam, including on Windows. */
export function acquireWindowsPrivateOwnerForTesting(driver: Driver): WindowsPrivateOwner {
  check(process.platform !== "win32", "TEST_PLATFORM");
  return acquire(driver, "untrusted-test");
}
