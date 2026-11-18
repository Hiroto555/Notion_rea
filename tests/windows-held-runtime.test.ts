import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeStorePlatform } from "../src/platform/runtime-store-platform";
import {
  withRuntimeAuthorityLease,
  withRuntimeAuthorityLeaseForTesting,
} from "../src/platform/windows/held-runtime-platform";
import type {
  AcquirePrivateAuthorityLease,
  PrivateAuthorityLease,
} from "../src/platform/windows/authority-lease";

// Explicitly labelled untrusted-test leases over SAB state: synchronous
// ownership-contract evidence only, never Windows OS proof. The test seam is
// minted on this real (non-win32) host; no process.platform simulation is
// needed or used here.
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function dir(): string {
  const root = mkdtempSync(join(tmpdir(), "folio-held-runtime-"));
  roots.push(root);
  return root;
}

function sabLease(
  events: string[],
  overrides: Partial<PrivateAuthorityLease> = {},
) {
  const shared = new SharedArrayBuffer(16);
  const state = new Int32Array(shared);
  const lease: PrivateAuthorityLease = {
    trust: "untrusted-test",
    assertHeld() {
      events.push("held");
      if (Atomics.load(state, 0) !== 1 || Atomics.load(state, 1) !== 0)
        throw new Error("lease lost");
    },
    close() {
      events.push("lease-close");
      Atomics.store(state, 1, 1);
    },
    ...overrides,
  };
  const acquire: AcquirePrivateAuthorityLease = () => {
    events.push("acquire");
    Atomics.store(state, 0, 1);
    return lease;
  };
  return { lease, state, acquire };
}

function platformFixture(
  events: string[],
  extras: Partial<RuntimeStorePlatform> = {},
): RuntimeStorePlatform {
  return {
    bind: vi.fn((d: string) => {
      events.push("bind");
      return d;
    }),
    assertRoot: vi.fn(() => {
      events.push("root");
    }),
    assertDatabase: vi.fn((p: string) => {
      events.push("db");
      if (!lstatSync(p).isFile()) throw new Error("unsafe database");
    }),
    createExclusiveDurably: vi.fn((p: string) => {
      events.push("create");
      if (!existsSync(p)) closeSync(openSync(p, "wx", 0o600));
    }),
    assertEmptyFile: vi.fn((p: string) => {
      events.push("empty");
      if (lstatSync(p).size !== 0) throw new Error("nonempty database");
    }),
    syncCreatedDatabase: vi.fn(() => {
      events.push("sync");
    }),
    close: vi.fn(() => {
      events.push("platform-close");
    }),
    ...extras,
  };
}

describe("held runtime platform — production boundary", () => {
  it("rejects a caller-built acquirer instead of rebranding it", () => {
    const events: string[] = [];
    const platform = platformFixture(events);
    const fakeAcquire = (() => ({
      trust: "native-owned-helper",
      assertHeld() {},
      close() {},
    })) as AcquirePrivateAuthorityLease;
    // The brand check is eager: construction itself refuses.
    expect(() => withRuntimeAuthorityLease(platform, fakeAcquire)).toThrow(
      /UNTRUSTED/,
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "held runtime platform — untrusted lease contract",
  () => {
    function heldFixture(extras: Partial<RuntimeStorePlatform> = {}) {
      const events: string[] = [];
      const platform = platformFixture(events, extras);
      const { acquire, state } = sabLease(events);
      const held = withRuntimeAuthorityLeaseForTesting(platform, acquire);
      return { events, platform, state, held };
    }

    it("proves the existing file, acquires once, then re-proves under the hold", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      const f = heldFixture();
      f.held.bind(root);
      f.held.assertDatabase(file);
      expect(f.events).toEqual([
        "bind",
        "db",
        "acquire",
        "held",
        "held",
        "db",
      ]);
      // A repeated assert on the same path does not re-acquire.
      f.held.assertDatabase(file);
      expect(f.events.filter((e) => e === "acquire")).toHaveLength(1);
      f.held.close();
      expect(f.events.slice(-2)).toEqual(["lease-close", "platform-close"]);
    });

    it("orders positive create, empty proof, file proof and acquire", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      const f = heldFixture();
      f.held.bind(root);
      f.held.createExclusiveDurably!(file);
      expect(f.events).toEqual([
        "bind",
        "create",
        "empty",
        "db",
        "acquire",
        "held",
        "held",
        "db",
      ]);
      // No mutation replay: a second positive create is refused outright.
      expect(() => f.held.createExclusiveDurably!(file)).toThrow();
      expect(
        f.events.filter((e) => e === "create"),
      ).toHaveLength(1);
    });

    it("refuses a different path and keeps the poison", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      const other = join(root, "other.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      closeSync(openSync(other, "wx", 0o600));
      const f = heldFixture();
      f.held.bind(root);
      f.held.assertDatabase(file);
      expect(() => f.held.assertDatabase(other)).toThrow();
      expect(() => f.held.assertDatabase(file)).toThrow();
    });

    it("requires the hold before mutation proofs and keeps it across snapshots", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      const snapshot = vi.fn((p: string, callback: (s: string) => void) => {
        callback(join(root, "snapshot.sqlite"));
      });
      const f = heldFixture({ withHotJournalSnapshot: snapshot });
      f.held.bind(root);
      expect(() => f.held.assertEmptyFile!(file)).toThrow(/UNHELD/);
      f.held.assertDatabase(file);
      let inside = 0;
      f.held.withHotJournalSnapshot!(file, () => {
        inside++;
        // Still held inside the callback: assertRoot re-checks the hold.
        f.held.assertRoot();
      });
      expect(inside).toBe(1);
      expect(snapshot).toHaveBeenCalledOnce();
      // The hold is NOT released at snapshot end.
      expect(Atomics.load(f.state, 1)).toBe(0);
      expect(f.events).not.toContain("lease-close");
      f.held.syncCreatedDatabase(file);
      expect(f.events).toContain("sync");
      f.held.close();
      expect(f.events.slice(-2)).toEqual(["lease-close", "platform-close"]);
    });

    it("surfaces the exact callback failure a provider swallowed", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      const sentinel = new Error("validation rejected snapshot");
      const snapshot = vi.fn((p: string, callback: (s: string) => void) => {
        try {
          callback(join(root, "snapshot.sqlite"));
        } catch {}
      });
      const f = heldFixture({ withHotJournalSnapshot: snapshot });
      f.held.bind(root);
      f.held.assertDatabase(file);
      let caught = false;
      let thrown: unknown;
      try {
        f.held.withHotJournalSnapshot!(file, () => {
          throw sentinel;
        });
      } catch (error) {
        caught = true;
        thrown = error;
      }
      expect(caught).toBe(true);
      expect(thrown).toBe(sentinel);
    });

    it("surfaces a swallowed callback that threw undefined", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      const snapshot = vi.fn((p: string, callback: (s: string) => void) => {
        try {
          callback(join(root, "snapshot.sqlite"));
        } catch {}
      });
      const f = heldFixture({ withHotJournalSnapshot: snapshot });
      f.held.bind(root);
      f.held.assertDatabase(file);
      let caught = false;
      try {
        f.held.withHotJournalSnapshot!(file, () => {
          throw undefined;
        });
      } catch (error) {
        caught = true;
        expect(error).toBeUndefined();
      }
      expect(caught).toBe(true);
    });

    it("never calls the mutation proof when the hold was lost", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      const f = heldFixture();
      f.held.bind(root);
      f.held.assertDatabase(file);
      Atomics.store(f.state, 1, 1);
      expect(() => f.held.syncCreatedDatabase(file)).toThrow(/lost/);
      expect(f.events).not.toContain("sync");
      expect(() => f.held.assertEmptyFile!(file)).toThrow();
    });

    it("does not manufacture an absent snapshot capability", () => {
      const f = heldFixture();
      expect(f.held.withHotJournalSnapshot).toBeUndefined();
      expect(f.held.createExclusiveDurably).not.toBeUndefined();
    });

    it("does not manufacture an absent create capability", () => {
      const events: string[] = [];
      const platform = platformFixture(events);
      delete platform.createExclusiveDurably;
      const { acquire } = sabLease(events);
      const held = withRuntimeAuthorityLeaseForTesting(platform, acquire);
      expect(held.createExclusiveDurably).toBeUndefined();
      expect(held.assertEmptyFile).not.toBeUndefined();
    });

    it("rejects a hidden async platform method before it can run", () => {
      const events: string[] = [];
      const platform = platformFixture(events);
      let creates = 0;
      const create = async () => {creates++;};
      platform.createExclusiveDurably = create;
      const { acquire } = sabLease(events);
      expect(() =>
        withRuntimeAuthorityLeaseForTesting(platform, acquire),
      ).toThrow(/SYNCHRONOUS_PORT_UNSUPPORTED/);
      expect(creates).toBe(0);
    });

    it("preserves concrete private-field receivers and extra properties", () => {
      const events: string[] = [];
      const base = platformFixture(events);
      class SecretPlatform implements RuntimeStorePlatform {
        readonly #token = "pinned-secret";
        readonly profile = "small-ledger";
        get marker() {
          return this.#token;
        }
        bind = base.bind;
        assertRoot = base.assertRoot;
        assertDatabase = base.assertDatabase;
        createExclusiveDurably = base.createExclusiveDurably;
        assertEmptyFile = base.assertEmptyFile;
        syncCreatedDatabase = base.syncCreatedDatabase;
        close = base.close;
        describe() {
          return `secret:${this.#token}`;
        }
      }
      const platform = new SecretPlatform();
      const { acquire } = sabLease(events);
      const held = withRuntimeAuthorityLeaseForTesting(platform, acquire);
      expect(held.marker).toBe("pinned-secret");
      expect(held.profile).toBe("small-ledger");
      expect(held.describe()).toBe("secret:pinned-secret");
      held.close();
    });

    it("poisons the runtime when acquisition fails before any writable open", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      const events: string[] = [];
      const platform = platformFixture(events);
      const broken: AcquirePrivateAuthorityLease = () => {
        throw new Error("no helper available");
      };
      const held = withRuntimeAuthorityLeaseForTesting(platform, broken);
      held.bind(root);
      expect(() => held.assertDatabase(file)).toThrow("no helper available");
      expect(() => held.assertDatabase(file)).toThrow("no helper available");
      // The platform still closes through the held wrapper without a lease.
      held.close();
      expect(events.slice(-1)).toEqual(["platform-close"]);
    });

    it("retains the acquired lease when its READY proof fails, closing it on close", () => {
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      const events: string[] = [];
      const platform = platformFixture(events);
      const { acquire } = sabLease(events, {
        assertHeld() {
          events.push("held");
          throw new Error("READY lost");
        },
      });
      const held = withRuntimeAuthorityLeaseForTesting(platform, acquire);
      held.bind(root);
      // Acquisition keeps the lease even though the READY check failed.
      expect(() => held.assertDatabase(file)).toThrow();
      expect(events).not.toContain("platform-close");
      // close() still routes the lease close before the native platform.
      held.close();
      expect(events.slice(-2)).toEqual(["lease-close", "platform-close"]);
    });

    it("keeps lease close before native close and retries a failed lease close", () => {
      const events: string[] = [];
      const platform = platformFixture(events);
      let closeFailures = 1;
      const { acquire } = sabLease(events, {
        close() {
          events.push("lease-close");
          if (closeFailures-- > 0) throw new Error("CLOSE unknown");
        },
      });
      const held = withRuntimeAuthorityLeaseForTesting(platform, acquire);
      const root = dir();
      const file = join(root, "shared-runtime.sqlite");
      closeSync(openSync(file, "wx", 0o600));
      held.bind(root);
      held.assertDatabase(file);
      expect(() => held.close()).toThrow("CLOSE unknown");
      expect(events).not.toContain("platform-close");
      held.close();
      expect(events.slice(-2)).toEqual(["lease-close", "platform-close"]);
    });
  },
);
