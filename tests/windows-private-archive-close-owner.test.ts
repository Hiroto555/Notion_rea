import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PosixPrivatePlatform, type PrivatePlatform } from "../src/sync/private-platform";
import { SyncSqliteGuard } from "../src/sync/sqlite-guard";
import { WindowsPrivatePersistenceJournal } from "../src/platform/windows/private-persistence-journal";
import { WindowsBackupArtifactJournal } from "../src/platform/windows/backup-artifact-journal";
import {
  withPrivateAuthorityLeaseForTesting,
  type PrivateAuthorityLease,
} from "../src/platform/windows/authority-lease";

// Explicitly untrusted contract tests only: disposable POSIX trees and SAB
// leases, never Windows OS acceptance. Fake seams are skipped on real win32.
const roots: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-archive-owner-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

const DIR = "C:\\private\\files";

function frame(header: object, payload: Uint8Array = new Uint8Array()): Buffer {
  const json = Buffer.from(JSON.stringify(header), "ascii"),
    bytes = Buffer.alloc(4 + json.length + payload.length);
  bytes.writeUInt32LE(json.length);
  json.copy(bytes, 4);
  bytes.set(payload, 4 + json.length);
  return bytes;
}

/** Relabelled windows contract adapter over POSIX — contract only, not OS. */
function archivePort(): PrivatePlatform {
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
  return { state, acquire };
}

/** Fresh held port per construction — a cached facade cannot reuse a closed
 * platform object across reopen. The underlying close is wrapped in a spy so
 * ordered release can be observed on the same event stream. */
function heldPort(events: string[]): {
  platform: PrivatePlatform;
  port: PrivatePlatform;
} {
  const base = archivePort();
  const port: PrivatePlatform = {...base, close: vi.fn(() => {
    base.close();
    events.push("platform-close");
  })};
  const { acquire } = sabAcquire(events);
  return {
    platform: withPrivateAuthorityLeaseForTesting(port, acquire),
    port,
  };
}

const ATTEMPT = "a".repeat(32);

describe.skipIf(process.platform === "win32")(
  "private archive close-owner — K/J untrusted lease contract",
  () => {
    const openK = (
      authority: string,
      data: string,
      platform: PrivatePlatform,
      binding = "fixture",
    ) =>
      new WindowsPrivatePersistenceJournal(
        authority,
        platform,
        binding,
        () => {},
        [data],
      );
    const openJ = (
      directory: string,
      platform: PrivatePlatform,
      binding = "binding:test",
    ) => new WindowsBackupArtifactJournal(directory, platform, binding, []);

    it("K: reserves exact original/wire, closes, reopens without rewriting or dispatch rights", () => {
      const root = dir();
      const authority = join(root, "authority"), data = join(root, "data");
      mkdirSync(authority, { mode: 0o700 });
      mkdirSync(data, { mode: 0o700 });
      const events: string[] = [];
      const original = Buffer.from("immutable original");
      const first = openK(authority, data, heldPort(events).platform);
      first.reserve({
        attemptId: ATTEMPT,
        targetKey: "test",
        wire: frame({ attemptId: ATTEMPT, path: DIR + "\\unknown" }, original),
        payload: original,
        maxCaptureBytes: 1024,
      });
      first.capture(ATTEMPT, {
        stdout: Buffer.from([0, 255, 1]),
        stderr: Buffer.from("exact error"),
        status: null,
        signal: null,
      });
      first.terminal(ATTEMPT, "UNKNOWN", "receipt missing");
      first.close();
      expect(events).toContain("lease-close");
      const target = join(authority, "private-persistence-v1.sqlite");
      const before = readFileSync(target);
      const reopened = openK(
        authority,
        data,
        heldPort(events).platform,
      );
      // Reopen performs no write and grants no dispatch rights.
      expect(() =>
        reopened.capture(ATTEMPT, {
          stdout: original,
          stderr: original,
          status: 0,
          signal: null,
        }),
      ).toThrow();
      reopened.close();
      expect(readFileSync(target)).toEqual(before);
      const probe = new DatabaseSync(target, { readOnly: true });
      try {
        expect(
          Buffer.from(
            probe
              .prepare("SELECT bytes FROM blobs WHERE id=? AND kind='original'")
              .get(ATTEMPT)!.bytes as Uint8Array,
          ),
        ).toEqual(original);
      } finally {
        probe.close();
      }
    });

    it("J: reserves original, closes, reopens retained bytes without dispatch rights", () => {
      const directory = dir();
      const events: string[] = [];
      const first = openJ(directory, heldPort(events).platform);
      first.reserve({
        attemptId: ATTEMPT,
        targetKey: "target:a",
        metadata: { attemptId: ATTEMPT, path: "C:\\Out\\a.bin" },
        original: new Uint8Array(4),
      });
      first.close();
      expect(events).toContain("lease-close");
      const target = join(directory, "windows-backup-artifact-v1.sqlite");
      const before = readFileSync(target);
      const reopened = openJ(directory, heldPort(events).platform);
      // Retained bytes are readable; the reopened instance holds no dispatch
      // rights for the prior attempt and never rewrites.
      expect(
        Buffer.from(reopened.readBlob(ATTEMPT, "original")!),
      ).toEqual(Buffer.alloc(4));
      expect(() =>
        reopened.record(ATTEMPT, "evidence:callback", new Uint8Array([1])),
      ).toThrow();
      reopened.close();
      expect(readFileSync(target)).toEqual(before);
    });

    const families = [
      {
        name: "WindowsPrivatePersistenceJournal",
        make(authority: string, data: string, platform: PrivatePlatform, binding = "fixture") {
          const j = openK(authority, data, platform, binding);
          return { close: () => j.close() };
        },
        database: (authority: string) =>
          join(authority, "private-persistence-v1.sqlite"),
        dir: (root: string) => {
          const authority = join(root, "authority"), data = join(root, "data");
          mkdirSync(authority, { mode: 0o700 });
          mkdirSync(data, { mode: 0o700 });
          return { authority, data };
        },
      },
      {
        name: "WindowsBackupArtifactJournal",
        make(authority: string, _data: string, platform: PrivatePlatform, binding = "binding:test") {
          const j = openJ(authority, platform, binding);
          return { close: () => j.close() };
        },
        database: (authority: string) =>
          join(authority, "windows-backup-artifact-v1.sqlite"),
        dir: (root: string) => {
          const authority = join(root, "authority"), data = join(root, "data");
          mkdirSync(authority, { mode: 0o700 });
          mkdirSync(data, { mode: 0o700 });
          return { authority, data };
        },
      },
    ];

    for (const family of families) {
      it(`${family.name}: close before actual keeps lease+platform held`, () => {
        const root = dir();
        const { authority, data } = family.dir(root);
        const events: string[] = [];
        const { platform, port } = heldPort(events);
        const handle = family.make(authority, data, platform);
        const spy = vi
          .spyOn(DatabaseSync.prototype, "close")
          .mockImplementationOnce(() => {
            throw new Error("close-cut");
          });
        expect(() => handle.close()).toThrow();
        expect(vi.mocked(port.close)).not.toHaveBeenCalled();
        expect(events).not.toContain("lease-close");
        spy.mockRestore();
        handle.close();
        expect(events).toContain("lease-close");
        expect(vi.mocked(port.close)).toHaveBeenCalledOnce();
      });

      it(`${family.name}: close after actual keeps error identity and releases in order`, () => {
        const root = dir();
        const { authority, data } = family.dir(root);
        const events: string[] = [];
        const { platform, port } = heldPort(events);
        const handle = family.make(authority, data, platform);
        const original = DatabaseSync.prototype.close;
        const late = new Error("late close report");
        vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(
          function (this: DatabaseSync) {
            original.call(this);
            events.push("db-close");
            throw late;
          },
        );
        expect(() => handle.close()).toThrow(late);
        // Ordered release: proven db close -> lease -> native platform.
        expect(events.indexOf("db-close")).toBeLessThan(
          events.indexOf("lease-close"),
        );
        expect(events.indexOf("lease-close")).toBeLessThan(
          events.indexOf("platform-close"),
        );
        expect(vi.mocked(port.close)).toHaveBeenCalledOnce();
        handle.close();
        expect(vi.mocked(port.close)).toHaveBeenCalledOnce();
      });

      it(`${family.name}: no-op close fails UNKNOWN and never releases`, () => {
        const root = dir();
        const { authority, data } = family.dir(root);
        const events: string[] = [];
        const { platform, port } = heldPort(events);
        const handle = family.make(authority, data, platform);
        const spy = vi
          .spyOn(DatabaseSync.prototype, "close")
          .mockImplementationOnce(() => {});
        expect(() => handle.close()).toThrow();
        expect(events).not.toContain("lease-close");
        expect(vi.mocked(port.close)).not.toHaveBeenCalled();
        spy.mockRestore();
        handle.close();
        expect(vi.mocked(port.close)).toHaveBeenCalledOnce();
      });

      // The post-close-getter-failure → retry-without-second-raw-close case is
      // covered on a real DatabaseSync via the per-instance proof Proxy in
      // tests/private-journal-close-ownership.test.ts ("settles a
      // proven-closed handle on retry without a second raw close"). DatabaseSync
      // instances expose own nonconfigurable isOpen/isTransaction accessors;
      // no prototype getter exists to spy on.
    }

    const flattened = (error: unknown): unknown[] =>
      error instanceof AggregateError
        ? error.errors.flatMap(flattened)
        : [error];

    for (const family of families) {
      it(`${family.name}: preflight close failure retains semantic+cleanup causes and the live reader`, () => {
        const root = dir();
        const { authority, data } = family.dir(root);
        const seed = family.make(authority, data, heldPort([]).platform);
        seed.close();
        const events: string[] = [];
        const { platform, port } = heldPort(events);
        let retained: DatabaseSync | undefined;
        const original = DatabaseSync.prototype.close;
        const closeSpy = vi
          .spyOn(DatabaseSync.prototype, "close")
          .mockImplementationOnce(function (this: DatabaseSync) {
            retained = this;
            throw new Error("preflight close failed");
          });
        const before = readFileSync(family.database(authority));
        let failure: unknown;
        try {
          family.make(authority, data, platform, "different-binding");
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        // The hold WAS acquired — positive create precedes the preflight — so
        // the lease must remain held while the raw reader's close is unknown.
        expect(events).toContain("acquire");
        const causes = flattened(failure);
        // Both the original semantic cause and the cleanup cause are retained.
        expect(
          causes.some(
            (cause) => cause instanceof Error && /BINDING/.test(cause.message),
          ),
        ).toBe(true);
        expect(
          causes.some(
            (cause) =>
              cause instanceof Error &&
              cause.message === "preflight close failed",
          ),
        ).toBe(true);
        expect(closeSpy).toHaveBeenCalledOnce();
        expect(vi.mocked(port.close)).not.toHaveBeenCalled();
        expect(events).not.toContain("lease-close");
        // The retained raw probe never authorized a writable open or mutation.
        expect(readFileSync(family.database(authority))).toEqual(before);
        vi.restoreAllMocks();
        if (retained !== undefined) original.call(retained);
      });

      it(`${family.name}: preflight close after actual releases lease+platform and keeps the error`, () => {
        const root = dir();
        const { authority, data } = family.dir(root);
        const seed = family.make(authority, data, heldPort([]).platform);
        seed.close();
        const events: string[] = [];
        const { platform, port } = heldPort(events);
        const sentinel = new Error("post-close report");
        const original = DatabaseSync.prototype.close;
        const closeSpy = vi
          .spyOn(DatabaseSync.prototype, "close")
          .mockImplementationOnce(function (this: DatabaseSync) {
            original.call(this);
            events.push("db-close");
            throw sentinel;
          });
        const before = readFileSync(family.database(authority));
        // Same binding: semantic validation succeeds, then the raw close
        // throws AFTER the handle actually closed — ordered release is legal.
        expect(() => family.make(authority, data, platform)).toThrow(sentinel);
        expect(events.indexOf("db-close")).toBeLessThan(
          events.indexOf("lease-close"),
        );
        expect(events.indexOf("lease-close")).toBeLessThan(
          events.indexOf("platform-close"),
        );
        expect(closeSpy).toHaveBeenCalledOnce();
        expect(readFileSync(family.database(authority))).toEqual(before);
        expect(vi.mocked(port.close)).toHaveBeenCalledOnce();
      });

      it(`${family.name}: guard constructor failure records one close attempt and retains the lease`, () => {
        const root = dir();
        const { authority, data } = family.dir(root);
        const events: string[] = [];
        const { platform, port } = heldPort(events);
        // The ctor fault goes through SyncSqliteGuard.assertUsable —
        // DatabaseSync instances expose own nonconfigurable
        // isOpen/isTransaction accessors; no prototype getter exists to spy
        // on, so the constructor state proof is faulted at the guard level.
        const ctorError = new Error("guard constructor state unavailable");
        vi.spyOn(SyncSqliteGuard.prototype, "assertUsable")
          .mockImplementationOnce(() => {
            throw ctorError;
          });
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
          family.make(authority, data, platform);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeDefined();
        expect(flattened(failure)).toContain(ctorError);
        expect(events).toContain("acquire");
        // The guard's own internal close ran once; constructor cleanup never
        // runs a second raw close or releases the lease.
        expect(closeSpy).toHaveBeenCalledOnce();
        expect(events).not.toContain("lease-close");
        expect(vi.mocked(port.close)).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        if (retained !== undefined) original.call(retained);
      });
    }
  },
);

describe.skipIf(process.platform === "win32")(
  "source-binding guard — composed bootstrap close chain",
  () => {
    const SOURCE_ROOT_ID = "1".repeat(32);
    const STATE_ROOT_ID = "2".repeat(32);
    const STATE_DIR_ID = "3".repeat(32);
    const FILE_ID = "4".repeat(32);
    const VOLUME = "a".repeat(16);
    const STATE_DIR = "C:\\State\\bindings";
    const DB_PATH = STATE_DIR + "\\source-bindings.sqlite";
    const sourceProof = () => ({
      canonicalPath: "C:\\Source",
      rootFileId: SOURCE_ROOT_ID,
      rootVolumeId: VOLUME,
      directoryFileId: SOURCE_ROOT_ID,
      directoryVolumeId: VOLUME,
    });

    // Scoped module mocks must be undone even on failure — restoreAllMocks
    // alone does not clear doMock registrations.
    afterEach(() => {
      for (const moduleName of [
        "../src/platform/windows/runtime-platform",
        "../src/platform/windows/authority-lease",
        "node:fs",
        "node:sqlite",
        "node:path",
      ])
        vi.doUnmock(moduleName);
      vi.resetModules();
    });

    /** Physical mapping for the simulated C:\ tree: every win32-looking path
     * lands inside a disposable root while real SQLite opens real files. */
    function mappedHarness() {
      const host = dir();
      const physical = (p: string) =>
        join(host, p.replace(/^[A-Za-z]:[\\/]/, "").split(/[\\/]/).join("/"));
      const isWinPath = (p: unknown): p is string =>
        typeof p === "string" && /^[A-Za-z]:[\\/]/.test(p);
      const events: string[] = [];

      class FakeRuntime {
        private boundPath: string | undefined;
        closed = false;
        constructor(private readonly options: { root: string }) {}
        private assertOpen(): void {
          if (this.closed) throw new Error("runtime closed");
        }
        bind(directory: string): string {
          this.assertOpen();
          if (this.boundPath !== undefined)
            throw new Error("WINDOWS_ROOT_ALREADY_BOUND");
          mkdirSync(physical(directory), { recursive: true });
          this.boundPath = directory;
          events.push(`bind:${directory}`);
          return directory;
        }
        validatedDirectoryIdentity() {
          this.assertOpen();
          if (this.boundPath === undefined) throw new Error("unbound");
          const isSource = this.options.root === "C:\\Source";
          return {
            canonicalPath: this.boundPath,
            rootFileId: isSource ? SOURCE_ROOT_ID : STATE_ROOT_ID,
            rootVolumeId: VOLUME,
            directoryFileId: isSource ? SOURCE_ROOT_ID : STATE_DIR_ID,
            directoryVolumeId: VOLUME,
          };
        }
        validatedFileIdentity(p: string) {
          this.assertOpen();
          if (!lstatSync(physical(p)).isFile())
            throw new Error("missing file identity");
          return { canonicalPath: p, fileId: FILE_ID, volumeId: VOLUME };
        }
        assertRoot(): void {
          this.assertOpen();
          if (this.boundPath === undefined) throw new Error("unbound");
        }
        assertFile(p: string): void {
          this.assertOpen();
          if (!lstatSync(physical(p)).isFile()) throw new Error("unsafe file");
        }
        assertSidecars(): void {
          this.assertOpen();
        }
        createExclusiveDurably(p: string): void {
          this.assertOpen();
          if (!existsSync(physical(p)))
            closeSync(openSync(physical(p), "wx", 0o600));
        }
        createExclusiveDurablyWithReceipt(p: string) {
          const existed = existsSync(physical(p));
          this.createExclusiveDurably(p);
          return {
            state: existed ? "EXISTING" : "CREATED",
            identity: { canonicalPath: p, fileId: FILE_ID, volumeId: VOLUME },
          };
        }
        assertEmptyFile(p: string): void {
          this.assertOpen();
          if (lstatSync(physical(p)).size !== 0)
            throw new Error("nonempty file");
        }
        withHotJournalSnapshot(p: string, callback: (s: string) => void): void {
          this.assertOpen();
          const snap = physical(p) + ".snapshot";
          copyFileSync(physical(p), snap);
          callback(p + ".snapshot");
        }
        close(): void {
          if (this.closed) return;
          this.closed = true;
          events.push(`runtime-close:${this.options.root}`);
        }
      }

      // A NEW shared buffer per acquire: a closed lease can never be revived
      // by the next acquisition.
      const sabLease = () => {
        events.push("acquire");
        const shared = new SharedArrayBuffer(16);
        const state = new Int32Array(shared);
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
      return { host, physical, isWinPath, events, FakeRuntime, sabLease };
    }

    async function importGuard(h: ReturnType<typeof mappedHarness>) {
      vi.resetModules();
      const runtimes: InstanceType<typeof h.FakeRuntime>[] = [];
      const RuntimeClass = class extends h.FakeRuntime {
        constructor(options: { root: string }) {
          super(options);
          runtimes.push(this as InstanceType<typeof h.FakeRuntime>);
        }
      };
      vi.doMock("../src/platform/windows/runtime-platform", async (importOriginal) => {
        const actual = await importOriginal<
          typeof import("../src/platform/windows/runtime-platform")
        >();
        return { ...actual, WindowsRuntimePlatform: RuntimeClass };
      });
      vi.doMock("../src/platform/windows/authority-lease", async (importOriginal) => {
        const actual = await importOriginal<
          typeof import("../src/platform/windows/authority-lease")
        >();
        return {
          ...actual,
          // The mocked factory still runs the supplied identityFor proof and
          // checks the expected state-root IDs before minting the untrusted
          // lease — only the wrapper is delegated to the REAL ForTesting.
          createNativeAuthorityLeaseAcquirer: (options: {
            expectedRoot: { rootFileId: string; volumeId: string };
            identityFor(p: string): unknown;
          }) => {
            return (p: string) => {
              if (
                options.expectedRoot.rootFileId !== STATE_ROOT_ID ||
                options.expectedRoot.volumeId !== VOLUME
              )
                throw new Error("expected root mismatch");
              options.identityFor(p);
              return h.sabLease();
            };
          },
          withPrivateAuthorityLease: actual.withPrivateAuthorityLeaseForTesting,
        };
      });
      // win32-looking paths map into the disposable physical tree for the
      // fs and sqlite layers while real SQLite stays fully functional.
      vi.doMock("node:fs", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:fs")>();
        const map = (p: unknown) => (h.isWinPath(p) ? h.physical(p) : p);
        return {
          ...actual,
          lstatSync: (p: unknown, ...rest: unknown[]) =>
            (actual.lstatSync as (...a: unknown[]) => unknown)(map(p), ...rest),
          statSync: (p: unknown, ...rest: unknown[]) =>
            (actual.statSync as (...a: unknown[]) => unknown)(map(p), ...rest),
          existsSync: (p: unknown) => actual.existsSync(map(p) as string),
          mkdirSync: (p: unknown, ...rest: unknown[]) =>
            (actual.mkdirSync as (...a: unknown[]) => unknown)(map(p), ...rest),
          openSync: (p: unknown, ...rest: unknown[]) =>
            (actual.openSync as (...a: unknown[]) => unknown)(map(p), ...rest),
          realpathSync: (p: unknown, ...rest: unknown[]) =>
            (actual.realpathSync as (...a: unknown[]) => unknown)(map(p), ...rest),
        };
      });
      vi.doMock("node:sqlite", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:sqlite")>();
        const Mapped = class extends actual.DatabaseSync {
          constructor(path: string | URL, ...rest: unknown[]) {
            super(
              (h.isWinPath(path) ? h.physical(path) : path) as string,
              ...(rest as []),
            );
          }
        };
        return { ...actual, DatabaseSync: Mapped };
      });
      vi.doMock("node:path", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:path")>();
        return {
          ...actual,
          join: (...parts: string[]) =>
            h.isWinPath(parts[0]) ? actual.win32.join(...parts) : actual.join(...parts),
        };
      });
      const module = await import("../src/platform/windows/source-binding-guard");
      return { createWindowsSourceBindingGuard: module.createWindowsSourceBindingGuard, runtimes };
    }

    const config = () => ({
      root: "C:\\Source",
      probeExecutable: "C:\\probe.exe",
      expectedHash: "0".repeat(64),
      systemRoot: "C:\\Windows",
      publicationStateRoot: "C:\\State",
      publicationStateDirectory: STATE_DIR,
    });

    /** The production win32 gate is simulated ONLY for the factory call; the
     * untrusted test wrapper must still see the real offhost platform when
     * guard methods run. */
    function withFactoryGate<T>(work: () => T): T {
      Object.defineProperty(process, "platform", {
        ...platformDescriptor,
        value: "win32",
      });
      try {
        return work();
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }

    it("binds once, enrolls, closes in order and strictly reopens without re-enrolling", async () => {
      const h = mappedHarness();
      mkdirSync(h.physical(STATE_DIR), { recursive: true });
      const { createWindowsSourceBindingGuard, runtimes } = await importGuard(h);
      const first = withFactoryGate(() =>
        createWindowsSourceBindingGuard(config(), true),
      );
      first.directory(sourceProof());
      first.close();
      const dbPath = h.physical(DB_PATH);
      const before = readFileSync(dbPath);
      // Strict reopen: a fresh guard with fresh runtime/lease; the same
      // native IDs must satisfy the persisted records without any re-enroll.
      const second = withFactoryGate(() =>
        createWindowsSourceBindingGuard(config(), false),
      );
      second.directory(sourceProof());
      const retained = second.retainedFile(DB_PATH);
      expect(retained.fileId).toBe(FILE_ID);
      second.close();
      expect(readFileSync(dbPath)).toEqual(before);
      // One lease-close per open; every created runtime was released.
      expect(h.events.filter((e) => e === "lease-close")).toHaveLength(2);
      expect(runtimes.length).toBeGreaterThan(0);
      expect(runtimes.every((r) => r.closed)).toBe(true);
    });

    it("a failed bootstrap readonly close keeps C held and poisons guard.close", async () => {
      const h = mappedHarness();
      mkdirSync(h.physical(STATE_DIR), { recursive: true });
      const { createWindowsSourceBindingGuard } = await importGuard(h);
      const first = withFactoryGate(() =>
        createWindowsSourceBindingGuard(config(), true),
      );
      first.directory(sourceProof());
      first.close();
      const before = readFileSync(h.physical(DB_PATH));
      // Discard seed-open events so fault-path assertions see only this open.
      h.events.length = 0;
      let retained: DatabaseSync | undefined;
      const original = DatabaseSync.prototype.close;
      const sentinel = new Error("bootstrap close-cut");
      // First close after reopen is the bootstrap readonly preflight reader.
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementationOnce(function (this: DatabaseSync) {
          retained = this;
          throw sentinel;
        });
      const second = withFactoryGate(() =>
        createWindowsSourceBindingGuard(config(), false),
      );
      expect(() => second.directory(sourceProof())).toThrow();
      expect(h.events.filter((e) => e === "acquire")).toHaveLength(1);
      expect(h.events).not.toContain("lease-close");
      expect(() => second.close()).toThrow();
      // No second raw close, no C release, file untouched.
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(h.events).not.toContain("runtime-close:C:\\State");
      expect(readFileSync(h.physical(DB_PATH))).toEqual(before);
      vi.restoreAllMocks();
      if (retained !== undefined) original.call(retained);
    });

    it("a bootstrap close throwing after actual close completes ordered release", async () => {
      const h = mappedHarness();
      mkdirSync(h.physical(STATE_DIR), { recursive: true });
      const { createWindowsSourceBindingGuard } = await importGuard(h);
      const first = withFactoryGate(() =>
        createWindowsSourceBindingGuard(config(), true),
      );
      first.directory(sourceProof());
      first.close();
      const before = readFileSync(h.physical(DB_PATH));
      h.events.length = 0;
      const sentinel = new Error("post-close report");
      const original = DatabaseSync.prototype.close;
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(
        function (this: DatabaseSync) {
          original.call(this);
          h.events.push("db-close");
          throw sentinel;
        },
      );
      const second = withFactoryGate(() =>
        createWindowsSourceBindingGuard(config(), false),
      );
      expect(() => second.directory(sourceProof())).toThrow(sentinel);
      // The reader actually closed: the bootstrap owner completes its ordered
      // release — db proof, lease, state runtime, source runtime — so
      // guard.close is a verified no-op, not an infinite poison. Every marker
      // must be present (indexOf returning -1 would false-positive).
      for (const marker of [
        "db-close",
        "lease-close",
        "runtime-close:C:\\State",
        "runtime-close:C:\\Source",
      ])
        expect(h.events).toContain(marker);
      expect(h.events.indexOf("db-close")).toBeLessThan(
        h.events.indexOf("lease-close"),
      );
      expect(h.events.indexOf("lease-close")).toBeLessThan(
        h.events.indexOf("runtime-close:C:\\State"),
      );
      expect(h.events.indexOf("runtime-close:C:\\State")).toBeLessThan(
        h.events.indexOf("runtime-close:C:\\Source"),
      );
      second.close();
      second.close();
      expect(h.events.filter((e) => e === "lease-close")).toHaveLength(1);
      expect(readFileSync(h.physical(DB_PATH))).toEqual(before);
    });

    it("a child guard-constructor close failure protects C through both owners", async () => {
      const h = mappedHarness();
      mkdirSync(h.physical(STATE_DIR), { recursive: true });
      const { createWindowsSourceBindingGuard } = await importGuard(h);
      // Import the SAME module-registry SyncSqliteGuard the mocked modules
      // resolve to — assertUsable is the child guard-ctor's first call.
      const { SyncSqliteGuard: ChildGuard } = await import(
        "../src/sync/sqlite-guard"
      );
      const first = withFactoryGate(() =>
        createWindowsSourceBindingGuard(config(), true),
      );
      first.directory(sourceProof());
      first.close();
      const before = readFileSync(h.physical(DB_PATH));
      h.events.length = 0;
      // Bootstrap and child role preflights close normally; the LAST close
      // attempt (the child's guard-constructor internal close) captures the
      // raw main handle and fails once.
      let armed = false;
      let failedAttempts = 0;
      let retained: DatabaseSync | undefined;
      const original = DatabaseSync.prototype.close;
      const closeSpy = vi
        .spyOn(DatabaseSync.prototype, "close")
        .mockImplementation(function (this: DatabaseSync) {
          if (armed) {
            failedAttempts++;
            retained = this;
            throw new Error("child internal close failed");
          }
          original.call(this);
        });
      const ctorError = new Error("guard constructor state unavailable");
      vi.spyOn(ChildGuard.prototype, "assertUsable").mockImplementationOnce(
        () => {
          armed = true;
          throw ctorError;
        },
      );
      const second = withFactoryGate(() =>
        createWindowsSourceBindingGuard(config(), false),
      );
      expect(() => second.directory(sourceProof())).toThrow();
      expect(h.events.filter((e) => e === "acquire")).toHaveLength(1);
      expect(retained).toBeDefined();
      expect(retained!.isOpen).toBe(true);
      // Exactly one failed close attempt on the child main handle; total
      // close calls include the successful readonly preflights.
      expect(failedAttempts).toBe(1);
      const attemptsAtClose = closeSpy.mock.calls.length;
      expect(attemptsAtClose).toBeGreaterThan(failedAttempts);
      // The child's T2 owner retains its raw main handle; guard.close must
      // surface the failure without a second close attempt or C release.
      expect(() => second.close()).toThrow();
      expect(failedAttempts).toBe(1);
      expect(closeSpy.mock.calls.length).toBe(attemptsAtClose);
      expect(h.events).not.toContain("runtime-close:C:\\State");
      expect(h.events).not.toContain("lease-close");
      expect(readFileSync(h.physical(DB_PATH))).toEqual(before);
      vi.restoreAllMocks();
      if (retained !== undefined) original.call(retained);
    });
  },
);
