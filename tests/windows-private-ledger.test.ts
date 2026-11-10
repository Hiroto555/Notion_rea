import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateLedger } from "../src/sync/private-ledger";
import {
  defaultPrivatePlatform,
  PosixPrivatePlatform,
  WindowsPrivatePlatform,
  type WindowsPrivateNativeRuntime,
} from "../src/sync/private-platform";
import { SyncError } from "../src/sync/protocol";

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-private-ledger-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

function expectCode(work: () => unknown, code: string): void {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

type FakeWindowsRuntime = {
  runtime: WindowsPrivateNativeRuntime;
  calls: string[];
};

function fakeWindowsRuntime(
  overrides: Partial<WindowsPrivateNativeRuntime> = {},
): FakeWindowsRuntime {
  const calls: string[] = [];
  const pinned = new Map<string, { dev: number; ino: number }>();
  const base: WindowsPrivateNativeRuntime = {
    bind(directory) {
      calls.push("bind");
      return directory;
    },
    assertRoot() {
      calls.push("assertRoot");
    },
    assertFile(path) {
      calls.push("assertFile");
      const stat = lstatSync(path);
      const pin = pinned.get(path);
      if (pin === undefined) pinned.set(path, { dev: stat.dev, ino: stat.ino });
      else if (stat.dev !== pin.dev || stat.ino !== pin.ino)
        throw new SyncError("windows-private-file-changed", 409);
    },
    assertSidecars(path) {
      calls.push(`assertSidecars:${path.endsWith(".sqlite-wal")}`);
    },
    createExclusiveDurably(path) {
      calls.push("createExclusiveDurably");
      try {
        writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      chmodSync(path, 0o600);
    },
    assertEmptyFile(path) {
      calls.push("assertEmptyFile");
      if (lstatSync(path).size !== 0)
        throw new SyncError("windows-private-file-not-empty", 409);
    },
    close() {
      calls.push("close");
    },
  };
  return { runtime: { ...base, ...overrides }, calls };
}

describe("PrivateLedger POSIX preservation (real temp directory)", () => {
  it.skipIf(process.platform === "win32")(
    "creates, writes, reads and reopens with the pinned POSIX port",
    () => {
      const root = tempRoot();
      const ledger = new PrivateLedger(
        root,
        "connections.sqlite",
        "connections",
      );
      ledger.transaction(() => ledger.write("conn:one", "ciphertext"));
      expect(ledger.read("conn:one")).toBe("ciphertext");
      ledger.close();

      const reopened = new PrivateLedger(
        root,
        "connections.sqlite",
        "connections",
      );
      expect(reopened.read("conn:one")).toBe("ciphertext");
      expect(reopened.entries("conn:")).toEqual([
        { key: "conn:one", value: "ciphertext" },
      ]);
      reopened.close();
    },
  );

  it.skipIf(process.platform === "win32")(
    "still rejects a writable private root",
    () => {
      const root = tempRoot();
      chmodSync(root, 0o755);
      expectCode(
        () => new PrivateLedger(root, "connections.sqlite", "connections"),
        "m3-private-root-unsafe",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects unsafe database sidecars before SQLite opens",
    () => {
      const root = tempRoot();
      const sidecar = join(root, "connections.sqlite-wal");
      writeFileSync(sidecar, "x", { mode: 0o600 });
      chmodSync(sidecar, 0o666);
      expectCode(
        () => new PrivateLedger(root, "connections.sqlite", "connections"),
        "m3-private-root-unsafe",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "detects a replaced ledger file using retained dev/ino identity",
    () => {
      const root = tempRoot();
      const ledger = new PrivateLedger(
        root,
        "connections.sqlite",
        "connections",
      );
      ledger.transaction(() => ledger.write("conn:one", "ciphertext"));
      const path = join(root, "connections.sqlite");
      renameSync(path, `${path}.moved`);
      writeFileSync(path, "x", { mode: 0o600 });
      chmodSync(path, 0o600);
      try {
        expectCode(() => ledger.read("conn:one"), "private-ledger-changed");
      } finally {
        try {
          ledger.close();
        } catch {}
      }
    },
  );
});

describe("PrivateLedger injected Windows platform (contract only, not OS acceptance)", () => {
  it("routes bind/create/assert/sidecar/empty/close through the injected port", () => {
    const root = tempRoot();
    const fake = fakeWindowsRuntime();
    const platform = new WindowsPrivatePlatform(fake.runtime);
    const ledger = new PrivateLedger(
      root,
      "connections.sqlite",
      "connections",
      [],
      platform,
    );
    expect(fake.calls).toContain("bind");
    expect(fake.calls).toContain("createExclusiveDurably");
    expect(fake.calls).toContain("assertEmptyFile");
    expect(
      fake.calls.filter((call) => call.startsWith("assertSidecars:")).length,
    ).toBeGreaterThanOrEqual(1);

    fake.calls.length = 0;
    ledger.transaction(() => ledger.write("conn:one", "ciphertext"));
    expect(ledger.read("conn:one")).toBe("ciphertext");
    const assertRoots = fake.calls.filter((call) => call === "assertRoot");
    const assertFiles = fake.calls.filter((call) => call === "assertFile");
    expect(assertRoots.length).toBeGreaterThanOrEqual(2);
    expect(assertFiles.length).toBeGreaterThanOrEqual(2);
    ledger.close();
    expect(fake.calls).toContain("close");
  });

  it("propagates a sidecar proof failure before SQLite and closes", () => {
    const root = tempRoot();
    const fake = fakeWindowsRuntime({
      assertSidecars() {
        throw new SyncError("windows-private-sidecar-unsafe", 409);
      },
    });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    expectCode(
      () =>
        new PrivateLedger(
          root,
          "connections.sqlite",
          "connections",
          [],
          platform,
        ),
      "windows-private-sidecar-unsafe",
    );
    expect(fake.calls).toContain("close");
  });

  it("propagates an uncertain exclusive create without retrying or faking success", () => {
    const root = tempRoot();
    const fake = fakeWindowsRuntime({
      createExclusiveDurably(path) {
        writeFileSync(path, "", { mode: 0o600 });
        throw new SyncError("windows-private-create-uncertain", 503);
      },
    });
    const platform = new WindowsPrivatePlatform(fake.runtime);
    expectCode(
      () =>
        new PrivateLedger(
          root,
          "connections.sqlite",
          "connections",
          [],
          platform,
        ),
      "windows-private-create-uncertain",
    );
    expect(fake.calls).toContain("close");
  });

  it("rejects a replaced ledger file through the injected identity proof", () => {
    const root = tempRoot();
    const fake = fakeWindowsRuntime();
    const ledger = new PrivateLedger(
      root,
      "connections.sqlite",
      "connections",
      [],
      new WindowsPrivatePlatform(fake.runtime),
    );
    ledger.transaction(() => ledger.write("conn:one", "ciphertext"));
    const path = join(root, "connections.sqlite");
    renameSync(path, `${path}.moved`);
    writeFileSync(path, "x", { mode: 0o600 });
    chmodSync(path, 0o600);
    try {
      expectCode(() => ledger.read("conn:one"), "windows-private-file-changed");
    } finally {
      try {
        ledger.close();
      } catch {}
    }
  });

  it("fails closed when an explicit native capability is missing", () => {
    expectCode(
      () => new WindowsPrivatePlatform({} as WindowsPrivateNativeRuntime),
      "private-ledger-platform-invalid",
    );

  });
});

describe("default platform selection", () => {
  it("selects POSIX outside win32 and fails closed on win32", () => {
    expect(defaultPrivatePlatform("darwin")).toBeInstanceOf(
      PosixPrivatePlatform,
    );
    expectCode(() => defaultPrivatePlatform("win32"), "private-ledger-platform-required");
  });

  it("constructs POSIX on this host without an injected platform", () => {
    if (process.platform === "win32") return;
    const root = tempRoot();
    const ledger = new PrivateLedger(root, "connections.sqlite", "connections");
    ledger.close();
  });
});
