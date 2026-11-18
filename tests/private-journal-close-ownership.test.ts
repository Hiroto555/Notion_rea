import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivateLedger } from "../src/sync/private-ledger";
import { SyncTransportJournal } from "../src/sync/transport-journal";
import { BlobTransferJournal } from "../src/sync/blob-transfer-journal";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { SqliteConnectionOwner } from "../src/sync/sqlite-connection-owner";
import { SyncError } from "../src/sync/protocol";
import type { PrivatePlatform } from "../src/sync/private-platform";
import type { RuntimeStorePlatform } from "../src/platform/runtime-store-platform";
import {
  withPrivateAuthorityLeaseForTesting,
  type PrivateAuthorityLease,
} from "../src/platform/windows/authority-lease";
import { withRuntimeAuthorityLeaseForTesting } from "../src/platform/windows/held-runtime-platform";

// Real disposable SQLite + injected proof. Explicitly labelled untrusted-test
// SAB leases: synchronous ownership-contract evidence, never Windows OS proof.
const roots: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platformDescriptor);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-close-ownership-")));
  roots.push(root);
  return root;
}

function nativePort() {
  const port: PrivatePlatform = {
    kind: "windows",
    bind: vi.fn((d: string) => {
      mkdirSync(d, { recursive: true });
      return d;
    }),
    assertRoot: vi.fn(() => {}),
    assertFile: vi.fn(() => {}),
    assertSidecars: vi.fn(() => {}),
    createExclusive: vi.fn((p: string) => {
      if (!existsSync(p)) closeSync(openSync(p, "wx", 0o600));
    }),
    assertEmptyFile: vi.fn((p: string) => {
      if (lstatSync(p).size !== 0) throw new Error("not empty");
    }),
    withHotJournalSnapshot(path: string, callback: (s: string) => void) {
      const snapRoot = mkdtempSync(join(tmpdir(), "folio-close-snap-"));
      roots.push(snapRoot);
      const snapshotPath = join(snapRoot, "snapshot.sqlite");
      copyFileSync(path, snapshotPath);
      callback(snapshotPath);
    },
    close: vi.fn(() => {}),
  };
  return port;
}

function runtimePlatformFixture(events: string[] = []): RuntimeStorePlatform {
  return {
    bind: vi.fn((d: string) => d),
    assertRoot: vi.fn(() => {}),
    assertDatabase: vi.fn((p: string) => {
      if (!lstatSync(p).isFile()) throw new Error("unsafe database");
    }),
    createExclusiveDurably: vi.fn((p: string) => {
      if (!existsSync(p)) closeSync(openSync(p, "wx", 0o600));
    }),
    assertEmptyFile: vi.fn((p: string) => {
      if (lstatSync(p).size !== 0) throw new Error("nonempty database");
    }),
    syncCreatedDatabase: vi.fn(() => {}),
    close: vi.fn(() => {
      events.push("platform-close");
    }),
  };
}

/** Explicitly untrusted SAB lease: held while state[0]===1 and state[1]===0. */
function sabAcquire(): {
  acquire: () => PrivateAuthorityLease;
  lose: () => void;
} {
  const shared = new SharedArrayBuffer(16);
  const state = new Int32Array(shared);
  return {
    acquire: () => {
      Atomics.store(state, 0, 1);
      return {
        trust: "untrusted-test",
        assertHeld() {
          if (Atomics.load(state, 0) !== 1 || Atomics.load(state, 1) !== 0)
            throw new Error("lease lost");
        },
        close() {
          Atomics.store(state, 1, 1);
        },
      };
    },
    lose: () => {
      Atomics.store(state, 1, 1);
    },
  };
}

const transportOptions = (root: string, platform?: PrivatePlatform) => ({
  path: join(root, "transport.sqlite"),
  workspaceId: "ws",
  clientId: "client",
  bindingId: "binding",
  ...(platform ? { platformAdapter: platform } : {}),
});
const blobScope = { scopeHash: "b".repeat(64) };
const blobDescriptor = {
  direction: "download" as const,
  assetId: "asset",
  sha256: "a".repeat(64),
  bytes: 2,
};

describe.skipIf(process.platform === "win32")(
  "SqliteConnectionOwner family — normal lifecycle",
  () => {
  it("creates, writes, closes and reopens a private ledger byte-identically", () => {
    const root = dir();
    const ledger = new PrivateLedger(root, "connections.sqlite", "main");
    ledger.transaction(() => ledger.write("host", "value"));
    ledger.close();
    ledger.close();
    const reopened = new PrivateLedger(root, "connections.sqlite", "main");
    try {
      expect(reopened.read("host")).toBe("value");
    } finally {
      reopened.close();
    }
  });

  it("creates, uses, closes and reopens a transport journal", () => {
    const root = dir();
    const journal = new SyncTransportJournal(transportOptions(root));
    journal.bindServer("epoch");
    journal.close();
    journal.close();
    const reopened = new SyncTransportJournal(transportOptions(root));
    try {
      expect(reopened.status().serverEpoch).toBe("epoch");
    } finally {
      reopened.close();
    }
  });

  it("creates, records, closes and reopens a blob transfer journal", () => {
    const root = dir();
    const journal = new BlobTransferJournal(root, blobScope);
    const record = journal.begin(blobDescriptor);
    journal.close();
    journal.close();
    const reopened = new BlobTransferJournal(root, blobScope);
    try {
      expect(reopened.get(record.key)?.state).toBe("active");
    } finally {
      reopened.close();
    }
  });

  it("creates, stores, closes and reopens a runtime store", () => {
    const root = dir();
    const store = new RuntimeStore(root);
    store.transaction(() => store.set("meta", "key", "value"));
    store.close();
    store.close();
    const reopened = new RuntimeStore(root);
    try {
      expect(reopened.get("meta", "key")).toBe("value");
    } finally {
      reopened.close();
    }
  });
  },
);

describe.skipIf(process.platform === "win32")(
  "SqliteConnectionOwner — close fault ownership",
  () => {
  it("keeps the native port open while a raw close cannot be proven", () => {
    const port = nativePort();
    const ledger = new PrivateLedger(
      dir(),
      "connections.sqlite",
      "main",
      [],
      port,
    );
    const dbError = new Error("close refused");
    const spy = vi
      .spyOn(DatabaseSync.prototype, "close")
      .mockImplementationOnce(() => {
        throw dbError;
      });
    let failure: unknown;
    try {
      ledger.close();
    } catch (error) {
      failure = error;
    }
    // The handle stayed open: the native platform must NOT be released.
    expect(failure).toBe(dbError);
    expect(port.close).not.toHaveBeenCalled();
    spy.mockRestore();
    // Explicit owned retry closes the DB first, then the native port once.
    ledger.close();
    expect(port.close).toHaveBeenCalledOnce();
    ledger.close();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("fails a silent close that returns while the handle stays open", () => {
    const port = nativePort();
    const ledger = new PrivateLedger(
      dir(),
      "connections.sqlite",
      "main",
      [],
      port,
    );
    const closeSpy = vi
      .spyOn(DatabaseSync.prototype, "close")
      .mockImplementationOnce(() => {});
    expect(() => ledger.close()).toThrow(/UNKNOWN/);
    // A returned close without isOpen===false is never a success.
    expect(port.close).not.toHaveBeenCalled();
    closeSpy.mockRestore();
    ledger.close();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("keeps the thrown identity and still releases the native port when the handle is proven closed", () => {
    const port = nativePort();
    const ledger = new PrivateLedger(
      dir(),
      "connections.sqlite",
      "main",
      [],
      port,
    );
    const original = DatabaseSync.prototype.close;
    const late = new Error("late close report");
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(
      function (this: DatabaseSync) {
        original.call(this);
        throw late;
      },
    );
    expect(() => ledger.close()).toThrow(late);
    expect(port.close).toHaveBeenCalledOnce();
    // Everything completed: a later close is a no-op.
    ledger.close();
    expect(port.close).toHaveBeenCalledOnce();
  });

  // node:sqlite owns non-configurable per-instance state accessors. Proxy
  // only those proof observations; all SQL/close operations use real SQLite.
  function proofProxy(db: DatabaseSync, state: (key: PropertyKey) => unknown): DatabaseSync {
    return new Proxy(db, {get(target, key) {
      if (key === "isOpen" || key === "isTransaction") return state(key);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }});
  }

  it("settles a proven-closed handle on retry without a second raw close", () => {
    const port = nativePort(), owner = new SqliteConnectionOwner(() => port.close());
    const db = new DatabaseSync(join(dir(), "proof.sqlite"));
    let hideClosed = true;
    const getterError = new Error("state getter unavailable after close");
    const proxy = proofProxy(db, key => {
      if (key === "isOpen" && !db.isOpen && hideClosed) {hideClosed = false; throw getterError;}
      return Reflect.get(db, key, db);
    });
    owner.opened(proxy);
    const closeSpy = vi.spyOn(db, "close");
    expect(() => owner.close()).toThrow(getterError);
    expect(port.close).not.toHaveBeenCalled();
    owner.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("retains the owner without native release when the open-state proof is unavailable", () => {
    const port = nativePort(), owner = new SqliteConnectionOwner(() => port.close());
    const db = new DatabaseSync(join(dir(), "unknown.sqlite"));
    let unavailable = true;
    const proxy = proofProxy(db, key => {
      if (key === "isOpen" && unavailable) throw new Error("state getter unavailable");
      return Reflect.get(db, key, db);
    });
    owner.opened(proxy);
    const closeSpy = vi.spyOn(db, "close").mockImplementationOnce(() => {throw new Error("close outcome unknown");});
    expect(() => owner.close()).toThrow();
    expect(db.isOpen).toBe(true); expect(port.close).not.toHaveBeenCalled();
    unavailable = false; closeSpy.mockRestore(); owner.close();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("never retries the guard constructor's internal close and retains the platform", () => {
    const port = nativePort(), owner = new SqliteConnectionOwner(() => port.close());
    const db = new DatabaseSync(join(dir(), "guard.sqlite"));
    const proxy = proofProxy(db, key => key === "isTransaction" ? "not-a-boolean" : db.isOpen);
    owner.opened(proxy);
    const closeSpy = vi.spyOn(db, "close").mockImplementationOnce(() => {throw new Error("internal close failed");});
    let failure: unknown;
    try {owner.guarded(proxy);} catch (error) {failure = error;}
    expect(failure).toBeInstanceOf(AggregateError);
    expect(() => owner.fail(failure)).toThrow();
    expect(closeSpy).toHaveBeenCalledOnce(); expect(port.close).not.toHaveBeenCalled();
    closeSpy.mockRestore(); owner.close(); expect(port.close).toHaveBeenCalledOnce();
  });

  it("never retries a failed preflight close, never opens writable, and preserves the file", () => {
    const root = dir();
    const first = new PrivateLedger(root, "connections.sqlite", "main");
    first.close();
    const port = nativePort();
    const target = join(root, "connections.sqlite");
    const before = readFileSync(target);
    let retained: DatabaseSync | undefined;
    const original = DatabaseSync.prototype.close;
    const closeSpy = vi
      .spyOn(DatabaseSync.prototype, "close")
      .mockImplementationOnce(function (this: DatabaseSync) {
        retained = this;
        throw new Error("preflight close failed");
      });
    let failure: unknown;
    try {
      // The semantic role mismatch makes the readonly preflight fail; its
      // close failure stays unconfirmed, so no writable open follows.
      new PrivateLedger(root, "connections.sqlite", "other", [], port);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const causes = (failure as AggregateError).errors.flatMap((cause) =>
      cause instanceof AggregateError ? cause.errors : [cause],
    );
    expect(
      causes.some(
        (cause) =>
          cause instanceof SyncError &&
          cause.code === "private-ledger-invalid",
      ),
    ).toBe(true);
    expect(
      causes.some(
        (cause) =>
          cause instanceof Error && cause.message === "preflight close failed",
      ),
    ).toBe(true);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(port.close).not.toHaveBeenCalled();
    // The retained raw probe never authorized a writable open or a mutation.
    expect(readFileSync(target)).toEqual(before);
    vi.restoreAllMocks();
    if (retained !== undefined) original.call(retained);
  });

  it("preserves both identities when a synchronous facade wrap fails and native close fails", () => {
    const port = nativePort();
    (port as unknown as Record<string, unknown>).assertRoot =
      async () => undefined;
    const closeError = new Error("native close failed");
    vi.mocked(port.close).mockImplementationOnce(() => {
      throw closeError;
    });
    let failure: unknown;
    try {
      new PrivateLedger(dir(), "connections.sqlite", "main", [], port);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const causes = (failure as AggregateError).errors;
    expect(causes[0]).toBeInstanceOf(SyncError);
    expect(causes[1]).toBe(closeError);
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("rejects a promise-returning cleanup once and never replays it", () => {
    const port = nativePort();
    let calls = 0;
    vi.mocked(port.close).mockImplementation(() => {
      calls++;
      return Promise.resolve() as unknown as void;
    });
    const ledger = new PrivateLedger(
      dir(),
      "connections.sqlite",
      "main",
      [],
      port,
    );
    expect(() => ledger.close()).toThrow();
    expect(() => ledger.close()).toThrow();
    // The deferred cleanup result is pinned by the synchronous boundary:
    // reported once as UNKNOWN and never invoked again.
    expect(calls).toBe(1);
  });

  it("caps live owner reservations and releases them only after owned cleanup", async () => {
    // Earlier cases intentionally retain owners; a fresh module instance
    // keeps this capacity check isolated without any production reset API.
    vi.resetModules();
    const { SqliteConnectionOwner: FreshOwner } = await import(
      "../src/sync/sqlite-connection-owner"
    );
    const owners: InstanceType<typeof FreshOwner>[] = [];
    try {
      for (let index = 0; index < 64; index++)
        owners.push(new FreshOwner(() => {}));
      expect(() => new FreshOwner(() => {})).toThrow(/capacity/);
    } finally {
      for (const owner of owners.splice(0)) owner.close();
    }
    // Capacity is released only because every owned cleanup completed.
    new FreshOwner(() => {}).close();
  });
  },
);

describe.skipIf(process.platform === "win32")(
  "held owner families — untrusted SAB lease",
  () => {
    type Handle = Readonly<{ close(): void; read(): unknown }>;
    type Family = Readonly<{
      name: string;
      platform(): { platform: PrivatePlatform | RuntimeStorePlatform; native: { close(): void } };
      make(root: string, platform: never, initialize?: boolean): Handle;
    }>;

    const heldPort = () => {
      const port = nativePort();
      const { acquire } = sabAcquire();
      return {
        platform: withPrivateAuthorityLeaseForTesting(port, acquire),
        native: port,
      };
    };
    const heldRuntime = () => {
      const platform = runtimePlatformFixture();
      const { acquire } = sabAcquire();
      return {
        platform: withRuntimeAuthorityLeaseForTesting(platform, acquire),
        native: platform,
      };
    };

    const families: Family[] = [
      {
        name: "PrivateLedger",
        platform: heldPort,
        make: (root, platform: PrivatePlatform, initialize = true) => {
          const ledger = new PrivateLedger(
            root,
            "connections.sqlite",
            "main",
            [],
            platform,
          );
          if (initialize)
            ledger.transaction(() => ledger.write("host", "value"));
          return {
            close: () => ledger.close(),
            read: () => ledger.read("host"),
          };
        },
      },
      {
        name: "SyncTransportJournal",
        platform: heldPort,
        make: (root, platform: PrivatePlatform, initialize = true) => {
          const journal = new SyncTransportJournal(
            transportOptions(root, platform),
          );
          if (initialize) journal.bindServer("epoch");
          return {
            close: () => journal.close(),
            read: () => journal.status().serverEpoch,
          };
        },
      },
      {
        name: "BlobTransferJournal",
        platform: heldPort,
        make: (root, platform: PrivatePlatform, initialize = true) => {
          const journal = new BlobTransferJournal(
            root,
            blobScope,
            {},
            platform,
          );
          // On reopen the record must come from the persisted inventory —
          // nothing is written again.
          const record = initialize
            ? journal.begin(blobDescriptor)
            : journal.inventory()[0];
          expect(record).toBeDefined();
          return {
            close: () => journal.close(),
            read: () => journal.get(record.key)?.state,
          };
        },
      },
      {
        name: "RuntimeStore",
        platform: heldRuntime,
        make: (root, platform: RuntimeStorePlatform, initialize = true) => {
          // The production win32 gate is simulated ONLY for construction;
          // the test seam itself is minted offhost above.
          Object.defineProperty(process, "platform", {
            ...platformDescriptor,
            value: "win32",
          });
          let store: RuntimeStore;
          try {
            store = new RuntimeStore(root, { platformAdapter: platform });
          } finally {
            Object.defineProperty(process, "platform", platformDescriptor);
          }
          if (initialize)
            store.transaction(() => store.set("meta", "key", "value"));
          return {
            close: () => store.close(),
            read: () => store.get("meta", "key"),
          };
        },
      },
    ];

    for (const family of families) {
      it(`${family.name}: creates, uses, closes and reopens exact private records`, () => {
        const root = dir();
        const first = family.platform();
        const expected =
          family.name === "SyncTransportJournal"
            ? "epoch"
            : family.name === "BlobTransferJournal"
              ? "active"
              : "value";
        const handle = family.make(root, first.platform as never);
        expect(handle.read()).toBe(expected);
        handle.close();
        handle.close();
        const second = family.platform();
        const reopened = family.make(root, second.platform as never, false);
        try {
          expect(reopened.read()).toBe(expected);
        } finally {
          reopened.close();
        }
      });

      it(`${family.name}: native/lease release waits for a proven DB close`, () => {
        const root = dir();
        const { platform, native } = family.platform();
        const handle = family.make(root, platform as never);
        const spy = vi
          .spyOn(DatabaseSync.prototype, "close")
          .mockImplementationOnce(() => {
            throw new Error("close refused");
          });
        expect(() => handle.close()).toThrow();
        expect(vi.mocked(native.close as () => void)).not.toHaveBeenCalled();
        spy.mockRestore();
        handle.close();
        expect(vi.mocked(native.close as () => void)).toHaveBeenCalledOnce();
      });

      it(`${family.name}: silent close returning with open handle fails UNKNOWN`, () => {
        const root = dir();
        const { platform, native } = family.platform();
        const handle = family.make(root, platform as never);
        const spy = vi
          .spyOn(DatabaseSync.prototype, "close")
          .mockImplementationOnce(() => {});
        expect(() => handle.close()).toThrow(/UNKNOWN/);
        expect(vi.mocked(native.close as () => void)).not.toHaveBeenCalled();
        spy.mockRestore();
        handle.close();
        expect(vi.mocked(native.close as () => void)).toHaveBeenCalledOnce();
      });

      it(`${family.name}: close throwing after a real close keeps identity and releases native`, () => {
        const root = dir();
        const { platform, native } = family.platform();
        const handle = family.make(root, platform as never);
        const original = DatabaseSync.prototype.close;
        const late = new Error("late close report");
        vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(
          function (this: DatabaseSync) {
            original.call(this);
            throw late;
          },
        );
        expect(() => handle.close()).toThrow(late);
        expect(vi.mocked(native.close as () => void)).toHaveBeenCalledOnce();
      });


    }
  },
);
