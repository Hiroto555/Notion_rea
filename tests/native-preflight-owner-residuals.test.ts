import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import { SyncSqliteGuard } from "../src/sync/sqlite-guard";
import {
  withPrivateAuthorityLeaseForTesting,
  type PrivateAuthorityLease,
} from "../src/platform/windows/authority-lease";
import { WindowsPrivateTransferJournal } from "../src/platform/windows/private-transfer-journal";
import { WindowsRecoveryArchive } from "../src/platform/windows/recovery-archive";
import { withNativeTransferLock } from "../src/platform/windows/private-transfer";
import { startCheckpointServer } from "../src/sync/checkpoint-server";
import type {
  NativePrivateFile,
  NativePrivateFilesystemPort,
  NativePrivateIdentity,
} from "../src/platform/private-persistence";
import { NativePrivatePersistenceError } from "../src/platform/windows/private-persistence";

// Explicitly untrusted contract tests only: disposable POSIX trees, SAB leases
// and a stubbed HTTP server — never Windows OS acceptance. No real sockets.
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-preflight-owner-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

const flattened = (error: unknown): unknown[] => {
  if (error === null || typeof error !== "object") return [error];
  const out: unknown[] = [error];
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) out.push(...flattened(cause));
  if (error instanceof AggregateError)
    for (const inner of error.errors) out.push(...flattened(inner));
  return out;
};

/** Relabelled windows contract adapter over POSIX — contract only, not OS. */
function contractPort(snapshot = false): PrivatePlatform {
  const inner = new PosixPrivatePlatform();
  return {
    kind: "windows",
    bind: (d: string) => inner.bind(d),
    assertRoot: () => inner.assertRoot(),
    assertFile: (p: string) => {
      inner.assertRoot();
      const stat = lstatSync(p);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw new Error("untrusted-file-proof");
    },
    assertSidecars: (p: string) => inner.assertSidecars(p),
    createExclusive: (p: string) => inner.createExclusive(p),
    assertEmptyFile: (p: string) => inner.assertEmptyFile(p),
    close: () => inner.close(),
    ...(snapshot
      ? {
          withHotJournalSnapshot: (path: string, callback: (s: string) => void) => {
            const snap = path + ".snapshot";
            copyFileSync(path, snap);
            callback(snap);
          },
        }
      : {}),
  };
}

function sabAcquire(events: string[]) {
  const shared = new SharedArrayBuffer(16);
  const state = new Int32Array(shared);
  const acquire = () => {
    events.push("acquire");
    Atomics.store(state, 0, 1);
    const lease: PrivateAuthorityLease = {
      trust: "untrusted-test",
      assertHeld() {
        if (Atomics.load(state, 0) !== 1 || Atomics.load(state, 1) !== 0)
          throw new Error("lease lost");
      },
      close() {
        events.push("lease-close");
        Atomics.store(state, 1, 1);
      },
    };
    return lease;
  };
  return acquire;
}

function heldPort(events: string[], snapshot = false) {
  const base = contractPort(snapshot);
  const port: PrivatePlatform = {...base, close: vi.fn(() => {base.close(); events.push("platform-close");})};
  return { platform: withPrivateAuthorityLeaseForTesting(port, sabAcquire(events)), port };
}

// POSIX-backed native filesystem double: fileId = inode as 32-hex, fixed volume.
const VOLUME = "a1b2c3d4e5f6a7b8";
const identityOf = (path: string): NativePrivateIdentity => {
  const stat = lstatSync(path);
  return { path, fileId: stat.ino.toString(16).padStart(32, "0").slice(-32), volumeId: VOLUME };
};
const fileOf = (path: string, max: number): NativePrivateFile => {
  const bytes = readFileSync(path);
  if (bytes.byteLength > max) throw new NativePrivatePersistenceError("REJECTED", "CAP");
  return { ...identityOf(path), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
};

function fakeFilesystem(): NativePrivateFilesystemPort {
  return {
    platform: "win32",
    version: 1,
    synchronous: true,
    inspectDirectory(path) {
      try {
        if (!lstatSync(path).isDirectory()) throw 0;
        return identityOf(path);
      } catch {
        throw new NativePrivatePersistenceError("REJECTED", "DIR");
      }
    },
    inspectFile(path, maxBytes) {
      try {
        return fileOf(path, maxBytes);
      } catch (e) {
        if (e instanceof NativePrivatePersistenceError) throw e;
        throw new NativePrivatePersistenceError("REJECTED", "FILE");
      }
    },
    inspectFileIdentity(path) {
      try {
        if (lstatSync(path).isDirectory()) throw 0;
        return identityOf(path);
      } catch {
        throw new NativePrivatePersistenceError("REJECTED", "ID");
      }
    },
    read() {
      throw new NativePrivatePersistenceError("REJECTED", "UNUSED");
    },
    writeNew() {
      throw new NativePrivatePersistenceError("REJECTED", "UNUSED");
    },
    copyNew() {
      throw new NativePrivatePersistenceError("REJECTED", "UNUSED");
    },
    renameNew() {
      throw new NativePrivatePersistenceError("REJECTED", "UNUSED");
    },
    unlinkExact() {
      throw new NativePrivatePersistenceError("REJECTED", "UNUSED");
    },
    proveSync() {
      throw new NativePrivatePersistenceError("REJECTED", "UNUSED");
    },
    createDirectory(path) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return identityOf(path);
    },
    snapshotSqlite() {
      throw new NativePrivatePersistenceError("REJECTED", "UNUSED");
    },
  };
}

/** Injected first-close modes for the readonly preflight reader. */
type CloseFault = "throw-before" | "silent-noop" | "throw-after";
function injectFirstClose(fault: CloseFault, events: string[], mark = "db-close") {
  let retained: DatabaseSync | undefined;
  const sentinel = new Error(`preflight ${fault}`);
  const original = DatabaseSync.prototype.close;
  const spy = vi
    .spyOn(DatabaseSync.prototype, "close")
    .mockImplementationOnce(function (this: DatabaseSync) {
      retained = this;
      if (fault === "throw-before") throw sentinel;
      if (fault === "silent-noop") return;
      original.call(this);
      events.push(mark);
      throw sentinel;
    });
  return { sentinel, spy, getRetained: () => retained, original };
}

describe.skipIf(process.platform === "win32")(
  "native preflight owner residuals — all four owner-integrated callers",
  () => {
    /** Seed an existing journal/lock/db at `make.dbPath`, then reopen with the
     * first preflight-reader close faulted. Each caller family supplies its
     * own construction + release-event names. */
    type Family = {
      name: string;
      seed(directory: string, events: string[]): Promise<unknown> | unknown;
      reopen(directory: string, events: string[]): Promise<{ close(): unknown }>;
      dbPath(directory: string): string;
      // platform close event is always "platform-close"; lease "lease-close".
    };

    const transfer: Family = {
      name: "WindowsPrivateTransferJournal",
      dbPath: (d) => join(d, "private-transfer-v1.sqlite"),
      seed: (d, events) => {
        const j = new WindowsPrivateTransferJournal(
          d,
          heldPort(events).platform,
          "binding:transfer",
          () => {},
          ["C:\\forbidden"],
        );
        j.close();
      },
      reopen: async (d, events) => {
        const j = new WindowsPrivateTransferJournal(
          d,
          heldPort(events).platform,
          "binding:transfer",
          () => {},
          ["C:\\forbidden"],
        );
        return j;
      },
    };

    const archive: Family = {
      name: "WindowsRecoveryArchive",
      dbPath: (d) => join(d, "windows-recovery-v3.sqlite"),
      seed: (d, events) => {
        const a = new WindowsRecoveryArchive(
          d,
          heldPort(events).platform,
          "binding:archive",
          ["C:\\forbidden"],
        );
        a.close();
      },
      reopen: async (d, events) => {
        const a = new WindowsRecoveryArchive(
          d,
          heldPort(events).platform,
          "binding:archive",
          ["C:\\forbidden"],
        );
        return a;
      },
    };

    const lock: Family = {
      name: "withNativeTransferLock",
      dbPath: (d) => join(d, "transfer-lock.sqlite"),
      seed: async (d, events) => {
        await withNativeTransferLock(
          d,
          () => undefined,
          { privatePlatformFactory: () => heldPort(events).platform },
          { nativePrivateFilesystem: fakeFilesystem() },
        );
      },
      reopen: async (d, events) => {
        await withNativeTransferLock(
          d,
          () => "done",
          { privatePlatformFactory: () => heldPort(events).platform },
          { nativePrivateFilesystem: fakeFilesystem() },
        );
        return { close: () => undefined };
      },
    };

    for (const family of [transfer, archive, lock]) {
      for (const fault of ["throw-before", "silent-noop"] as const) {
        it(`${family.name}: preflight close ${fault} keeps lease+platform held`, async () => {
          const directory = dir();
          const events: string[] = [];
          await family.seed(directory, events);
          events.length = 0;
          const before = readFileSync(family.dbPath(directory));
          const injection = injectFirstClose(fault, events);
          let failure: unknown;
          try {
            await family.reopen(directory, events);
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeDefined();
          if (fault === "throw-before")
            expect(flattened(failure)).toContain(injection.sentinel);
          // One close attempt on the raw preflight reader; nothing released.
          expect(injection.spy).toHaveBeenCalledOnce();
          expect(events).toContain("acquire");
          expect(events).not.toContain("lease-close");
          expect(events).not.toContain("platform-close");
          const retained = injection.getRetained();
          expect(retained).toBeDefined();
          expect(retained!.isOpen).toBe(true);
          expect(readFileSync(family.dbPath(directory))).toEqual(before);
          vi.restoreAllMocks();
          if (retained !== undefined) injection.original.call(retained);
        });
      }

      it(`${family.name}: preflight close throwing after actual releases in order`, async () => {
        const directory = dir();
        const events: string[] = [];
        await family.seed(directory, events);
        events.length = 0;
        const before = readFileSync(family.dbPath(directory));
        const injection = injectFirstClose("throw-after", events);
        let failure: unknown;
        try {
          await family.reopen(directory, events);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        expect(flattened(failure)).toContain(injection.sentinel);
        expect(injection.spy).toHaveBeenCalledOnce();
        for (const marker of ["db-close", "lease-close", "platform-close"])
          expect(events).toContain(marker);
        expect(events.indexOf("db-close")).toBeLessThan(events.indexOf("lease-close"));
        expect(events.indexOf("lease-close")).toBeLessThan(
          events.indexOf("platform-close"),
        );
        expect(injection.getRetained()!.isOpen).toBe(false);
        expect(readFileSync(family.dbPath(directory))).toEqual(before);
      });
    }

    // No real sockets: createServer is stubbed to an EventEmitter that never
    // accepts connections.
    vi.mock("node:http", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:http")>();
      const { EventEmitter } = await import("node:events");
      class FakeServer extends EventEmitter {
        listening = false;
        requestTimeout = 0;
        headersTimeout = 0;
        listen(_port?: number, _host?: string, cb?: () => void) {
          this.listening = true;
          if (cb) queueMicrotask(cb);
          return this;
        }
        address() {
          return { port: 18234 };
        }
        close(cb?: (e?: Error) => void) {
          this.listening = false;
          if (cb) queueMicrotask(() => cb());
          return this;
        }
        closeAllConnections() {}
      }
      return { ...actual, createServer: () => new FakeServer() };
    });

    const serverOptions = (dbPath: string, events: string[]) => {
        // The host contract requires the database file to already exist —
        // createExclusive tolerates EEXIST and the metadata-only identity
        // inspection runs before any writable open.
        if (!existsSync(dbPath)) closeSync(openSync(dbPath, "wx", 0o600));
        const { platform } = heldPort(events);
        platform.bind(dirname(dbPath));
        const filesystem = fakeFilesystem();
        let released = false;
        const lifetime = {
          platform,
          validateCurrent() {
            // Real filesystem proof, independent of the lease (which is only
            // acquired at createExclusive).
            const id = filesystem.inspectDirectory(dirname(dbPath));
            if (!/^[0-9a-f]{32}$/.test(id.fileId))
              throw new Error("native-proof");
          },
          scope<T>(work: () => T): T {
            // A released lifetime's scope is disposed — post-release work
            // must bypass it rather than re-enter.
            if (released) throw new Error("lifetime scope released");
            return work();
          },
          backup(): never {
            throw new Error("backup unused in tests");
          },
          close() {
            events.push("factory-close");
            platform.close();
            released = true;
          },
        };
        return {
          databasePath: dbPath,
          capabilities: [
            { workspaceId: "w1", ownerId: "o1", token: "t".repeat(40) },
          ],
          validateCheckpoint: () => true,
          nativePrivateFilesystem: filesystem,
          nativeLifetime: lifetime,
        };
      };

    describe("checkpoint server", () => {
      it("seeds, closes, and reopens through the owner chain", async () => {
        const directory = dir();
        const dbPath = join(directory, "server.sqlite");
        const events: string[] = [];
        const first = await startCheckpointServer(serverOptions(dbPath, events));
        const epoch1 = first.serverEpoch;
        await first.close();
        expect(events).toContain("lease-close");
        const second = await startCheckpointServer(serverOptions(dbPath, events));
        expect(second.serverEpoch).toBe(epoch1);
        await second.close();
        expect(events.filter((e) => e === "lease-close")).toHaveLength(2);
      });

      for (const fault of ["throw-before", "silent-noop"] as const) {
        it(`preflight close ${fault} keeps the native lifetime held`, async () => {
          const directory = dir();
          const dbPath = join(directory, "server.sqlite");
          const events: string[] = [];
          const first = await startCheckpointServer(serverOptions(dbPath, events));
          await first.close();
          events.length = 0;
          const before = readFileSync(dbPath);
          const injection = injectFirstClose(fault, events);
          let failure: unknown;
          try {
            await startCheckpointServer(serverOptions(dbPath, events));
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeDefined();
          if (fault === "throw-before")
            expect(flattened(failure)).toContain(injection.sentinel);
          expect(injection.spy).toHaveBeenCalledOnce();
          expect(events).toContain("acquire");
          expect(events).not.toContain("lease-close");
          expect(events).not.toContain("factory-close");
          const retained = injection.getRetained();
          expect(retained!.isOpen).toBe(true);
          expect(readFileSync(dbPath)).toEqual(before);
          vi.restoreAllMocks();
          if (retained !== undefined) injection.original.call(retained);
        });
      }

      it("preflight close throwing after actual releases lifetime in order", async () => {
        const directory = dir();
        const dbPath = join(directory, "server.sqlite");
        const events: string[] = [];
        const first = await startCheckpointServer(serverOptions(dbPath, events));
        await first.close();
        events.length = 0;
        const before = readFileSync(dbPath);
        const injection = injectFirstClose("throw-after", events);
        let failure: unknown;
        try {
          await startCheckpointServer(serverOptions(dbPath, events));
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        expect(flattened(failure)).toContain(injection.sentinel);
        for (const marker of ["db-close", "factory-close", "lease-close", "platform-close"])
          expect(events).toContain(marker);
        expect(events.indexOf("db-close")).toBeLessThan(events.indexOf("factory-close"));
        expect(events.indexOf("factory-close")).toBeLessThan(events.indexOf("lease-close"));
        expect(events.indexOf("lease-close")).toBeLessThan(events.indexOf("platform-close"));
        expect(injection.getRetained()!.isOpen).toBe(false);
        expect(readFileSync(dbPath)).toEqual(before);
      });
    });

    describe("guard-constructor faults keep native protector held", () => {
      const runCtorFault = async (
        make: (platform: PrivatePlatform) => unknown,
        events: string[],
      ) => {
        const ctorError = new Error("guard constructor state unavailable");
        vi.spyOn(SyncSqliteGuard.prototype, "assertUsable").mockImplementationOnce(
          () => {
            throw ctorError;
          },
        );
        let retained: DatabaseSync | undefined;
        const original = DatabaseSync.prototype.close;
        const closeSpy = vi
          .spyOn(DatabaseSync.prototype, "close")
          .mockImplementationOnce(function (this: DatabaseSync) {
            retained = this;
            throw new Error("internal close failed");
          });
        let failure: unknown;
        try {
          await make(heldPort(events).platform);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        expect(flattened(failure)).toContain(ctorError);
        expect(closeSpy).toHaveBeenCalledOnce();
        expect(events).not.toContain("lease-close");
        expect(events).not.toContain("platform-close");
        vi.restoreAllMocks();
        if (retained !== undefined) original.call(retained);
      };

      it("transfer journal ctor fault holds the lease", async () => {
        const events: string[] = [];
        await runCtorFault(
          (platform) =>
            new WindowsPrivateTransferJournal(
              dir(), platform, "binding:transfer", () => {}, ["C:\\forbidden"],
            ),
          events,
        );
      });

      it("recovery archive ctor fault holds the lease", async () => {
        const events: string[] = [];
        await runCtorFault(
          (platform) =>
            new WindowsRecoveryArchive(dir(), platform, "binding:archive", ["C:\\forbidden"]),
          events,
        );
      });

      it("checkpoint ctor fault holds the native lifetime", async () => {
        const directory = dir();
        const dbPath = join(directory, "server.sqlite");
        const events: string[] = [];
        const ctorError = new Error("guard constructor state unavailable");
        vi.spyOn(SyncSqliteGuard.prototype, "assertUsable").mockImplementationOnce(
          () => {
            throw ctorError;
          },
        );
        let retained: DatabaseSync | undefined;
        const original = DatabaseSync.prototype.close;
        const closeSpy = vi
          .spyOn(DatabaseSync.prototype, "close")
          .mockImplementationOnce(function (this: DatabaseSync) {
            retained = this;
            throw new Error("internal close failed");
          });
        let failure: unknown;
        try {
          await startCheckpointServer(serverOptions(dbPath, events));
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        expect(flattened(failure)).toContain(ctorError);
        expect(closeSpy).toHaveBeenCalledOnce();
        expect(events).not.toContain("lease-close");
        vi.restoreAllMocks();
        if (retained !== undefined) original.call(retained);
      });
    });

    it("lock: a failed post-work close runs work exactly once and keeps the lease", async () => {
      const directory = dir();
      const events: string[] = [];
      const { platform } = heldPort(events);
      let workCount = 0;
      let retained: DatabaseSync | undefined;
      const original = DatabaseSync.prototype.close;
      const sentinel = new Error("post-work close-cut");
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementationOnce(function (this: DatabaseSync) {
          retained = this;
          throw sentinel;
        });
      let failure: unknown;
      try {
        await withNativeTransferLock(
          directory,
          () => {
            workCount++;
            return "ok";
          },
          { privatePlatformFactory: () => platform },
          { nativePrivateFilesystem: fakeFilesystem() },
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(flattened(failure)).toContain(sentinel);
      expect(workCount).toBe(1);
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(retained!.isOpen).toBe(true);
      expect(events).not.toContain("lease-close");
      expect(events).not.toContain("platform-close");
      vi.restoreAllMocks();
      if (retained !== undefined) original.call(retained);
    });

    it("explicit close retry releases the transfer journal after a failed first close", async () => {
      const directory = dir();
      const events: string[] = [];
      const { platform, port } = heldPort(events);
      const journal = new WindowsPrivateTransferJournal(
        directory,
        platform,
        "binding:transfer",
        () => {},
        ["C:\\forbidden"],
      );
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementationOnce(() => {
          throw new Error("close-cut");
        });
      expect(() => journal.close()).toThrow();
      expect(events).not.toContain("lease-close");
      closeSpy.mockRestore();
      journal.close();
      expect(vi.mocked(port.close)).toHaveBeenCalledOnce();
      expect(events.indexOf("lease-close")).toBeLessThan(
        events.indexOf("platform-close"),
      );
    });

    it("legitimate reopen: transfer listAttempts stable, archive schema retained, lock work once", async () => {
      const directory = dir();
      const events: string[] = [];
      // Transfer journal: seed then reopen — no attempts, identity retained.
      const first = new WindowsPrivateTransferJournal(
        directory, heldPort(events).platform, "binding:transfer", () => {},
        ["C:\\forbidden"],
      );
      first.close();
      const second = new WindowsPrivateTransferJournal(
        directory, heldPort(events).platform, "binding:transfer", () => {},
        ["C:\\forbidden"],
      );
      expect(second.listAttempts()).toEqual([]);
      second.close();

      // Recovery archive: seed then reopen — head list and schema retained.
      const adir = dir();
      const afirst = new WindowsRecoveryArchive(
        adir, heldPort(events).platform, "binding:archive", ["C:\\forbidden"],
      );
      afirst.close();
      const asecond = new WindowsRecoveryArchive(
        adir, heldPort(events).platform, "binding:archive", ["C:\\forbidden"],
      );
      asecond.close();

      // Native lock: work runs exactly once per open, identity row retained.
      const ldir = dir();
      let count = 0;
      await withNativeTransferLock(
        ldir,
        () => {
          count++;
        },
        { privatePlatformFactory: () => heldPort(events).platform },
        { nativePrivateFilesystem: fakeFilesystem() },
      );
      await withNativeTransferLock(
        ldir,
        () => {
          count++;
        },
        { privatePlatformFactory: () => heldPort(events).platform },
        { nativePrivateFilesystem: fakeFilesystem() },
      );
      expect(count).toBe(2);
    });

    it("explicit close retry releases the archive after a failed first close", async () => {
      const directory = dir();
      const events: string[] = [];
      const { platform, port } = heldPort(events);
      const archive = new WindowsRecoveryArchive(
        directory,
        platform,
        "binding:archive",
        ["C:\\forbidden"],
      );
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementationOnce(() => {
          throw new Error("close-cut");
        });
      expect(() => archive.close()).toThrow();
      expect(events).not.toContain("lease-close");
      closeSpy.mockRestore();
      archive.close();
      expect(vi.mocked(port.close)).toHaveBeenCalledOnce();
      expect(events.indexOf("lease-close")).toBeLessThan(
        events.indexOf("platform-close"),
      );
    });

    it("checkpoint handle.close retries after a failed first close", async () => {
      const directory = dir();
      const dbPath = join(directory, "server.sqlite");
      const events: string[] = [];
      const handle = await startCheckpointServer(serverOptions(dbPath, events));
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementationOnce(() => {
          throw new Error("close-cut");
        });
      await expect(handle.close()).rejects.toThrow();
      expect(events).not.toContain("lease-close");
      closeSpy.mockRestore();
      await handle.close();
      expect(events).toContain("lease-close");
      expect(events.indexOf("lease-close")).toBeLessThan(
        events.indexOf("platform-close"),
      );
    });

    it("checkpoint retry after a post-actual close error bypasses the released scope", async () => {
      const directory = dir();
      const dbPath = join(directory, "server.sqlite");
      const events: string[] = [];
      const handle = await startCheckpointServer(serverOptions(dbPath, events));
      const sentinel = new Error("post-actual close sentinel");
      const original = DatabaseSync.prototype.close;
      let closes = 0;
      vi.spyOn(DatabaseSync.prototype, "close")
        .mockImplementation(function (this: DatabaseSync) {
          closes++;
          original.call(this);
          if (closes === 1) throw sentinel;
        });
      await expect(handle.close()).rejects.toThrow(sentinel);
      // The proven-closed DB allowed the owner to release the native lifetime
      // exactly once — lease and platform already closed.
      expect(closes).toBe(1);
      for (const marker of ["factory-close", "lease-close", "platform-close"])
        expect(events.filter((e) => e === marker)).toHaveLength(1);
      // Retry must not re-enter the disposed lifetime scope and must not
      // replay either the raw or the native close.
      await handle.close();
      expect(closes).toBe(1);
      for (const marker of ["factory-close", "lease-close", "platform-close"])
        expect(events.filter((e) => e === marker)).toHaveLength(1);
    });

    it("native hot working-copy: faulted working reader keeps protector and original bytes", async () => {
      const directory = dir();
      const events: string[] = [];
      // Seed a real archive, then reopen with the readonly SELECT forced to
      // SQLITE_READONLY_ROLLBACK so preflight falls back to the private
      // working copy; the SECOND close (the working reader) is faulted.
      const seed = new WindowsRecoveryArchive(
        directory,
        heldPort(events).platform,
        "binding:archive",
        ["C:\\forbidden"],
      );
      seed.close();
      events.length = 0;
      const dbPath = join(directory, "windows-recovery-v3.sqlite");
      const before = readFileSync(dbPath);
      const rollback = { errcode: 776 };
      vi.spyOn(DatabaseSync.prototype, "prepare")
        .mockImplementationOnce(() => {
          throw rollback;
        });
      let calls = 0;
      let working: DatabaseSync | undefined;
      const original = DatabaseSync.prototype.close;
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementation(function (this: DatabaseSync) {
          calls++;
          if (calls === 2) {
            working = this;
            throw new Error("working-reader close-cut");
          }
          original.call(this);
        });
      const { platform } = heldPort(events, true);
      let failure: unknown;
      try {
        new WindowsRecoveryArchive(directory, platform, "binding:archive", ["C:\\forbidden"]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      expect(closeSpy).toHaveBeenCalledTimes(2);
      expect(events).not.toContain("lease-close");
      expect(events).not.toContain("platform-close");
      // The faulted working reader is still open on its disposable snapshot;
      // the original journal is byte-identical. Close only the captured test
      // handle — the production retained owner intentionally stays.
      expect(working).toBeDefined();
      expect(working!.isOpen).toBe(true);
      expect(existsSync(dbPath + ".snapshot")).toBe(true);
      expect(readFileSync(dbPath)).toEqual(before);
      vi.restoreAllMocks();
      if (working !== undefined) original.call(working);
    });
  },
);
