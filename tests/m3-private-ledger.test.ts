import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateLedger } from "../src/sync/private-ledger";

const base = realpathSync(tmpdir());
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot(): string {
  const root = mkdtempSync(join(base, "m3-ledger-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

function codeOf(fn: () => unknown): unknown {
  return (errorOf(fn) as { code?: unknown }).code;
}

type ExecMode = "before" | "after" | "noop" | "begin";

function armExec(mode: ExecMode) {
  const original = DatabaseSync.prototype.exec;
  return vi
    .spyOn(DatabaseSync.prototype, "exec")
    .mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = String(sql);
      if (mode === "begin") {
        if (statement.includes("BEGIN")) return;
        return original.call(this, sql);
      }
      if (!statement.includes("COMMIT")) return original.call(this, sql);
      if (mode === "before") throw new Error("inject-before-commit");
      if (mode === "after") {
        original.call(this, sql);
        throw new Error("inject-after-commit");
      }
      return;
    });
}

describe("PrivateLedger", () => {
  it("requires a private 0700 root and rejects forbidden roots", () => {
    const root = privateRoot();
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    const ledger = new PrivateLedger(root, "root.sqlite", "alpha");
    expect(lstatSync(join(root, "root.sqlite")).mode & 0o777).toBe(0o600);
    ledger.transaction(() => ledger.write("k", "v"));
    expect(ledger.read("k")).toBe("v");
    ledger.close();

    const workspace = join(root, "workspace");
    mkdirSync(workspace, { mode: 0o700 });
    const directory = join(workspace, "private");
    mkdirSync(directory, { mode: 0o700 });
    expect(
      codeOf(() => new PrivateLedger(directory, "a.sqlite", "alpha", [workspace])),
    ).toBe("m3-private-root-unsafe");
    expect(
      codeOf(() => new PrivateLedger(workspace, "b.sqlite", "alpha", [directory])),
    ).toBe("m3-private-root-unsafe");
  });

  it("commits multi-row writes and deletes atomically and rolls back on throw", () => {
    const root = privateRoot();
    const ledger = new PrivateLedger(root, "atomic.sqlite", "alpha");
    ledger.transaction(() => {
      ledger.write("a", "A1");
      ledger.write("b", "B1");
      ledger.write("c", "C1");
    });
    expect(ledger.read("a")).toBe("A1");
    expect(codeOf(() => ledger.write("d", "D1"))).toBe(
      "private-ledger-transaction-required",
    );
    expect(
      () =>
        ledger.transaction(() => {
          ledger.write("a", "A2");
          ledger.write("b", null);
          ledger.write("d", "D2");
          expect(ledger.read("a")).toBe("A2");
          expect(ledger.read("b")).toBeNull();
          throw new Error("rollback");
        }),
    ).toThrow("rollback");
    expect(ledger.read("a")).toBe("A1");
    expect(ledger.read("b")).toBe("B1");
    expect(ledger.read("d")).toBeNull();
    ledger.transaction(() => {
      ledger.write("a", "A3");
      ledger.write("b", null);
      ledger.write("c", "C3");
    });
    expect(ledger.read("a")).toBe("A3");
    expect(ledger.read("b")).toBeNull();
    expect(ledger.entries("c").map((entry) => entry.key)).toEqual(["c"]);
    ledger.close();
  });

  it("reopens committed rows and ignores rolled back changes", () => {
    const root = privateRoot();
    const ledger = new PrivateLedger(root, "reopen.sqlite", "alpha");
    ledger.transaction(() => {
      ledger.write("keep", "v1");
      ledger.write("gone", "v2");
    });
    expect(() =>
      ledger.transaction(() => {
        ledger.write("keep", "v3");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    ledger.close();
    const again = new PrivateLedger(root, "reopen.sqlite", "alpha");
    expect(again.read("keep")).toBe("v1");
    expect(again.read("gone")).toBe("v2");
    again.close();
  });

  it("rejects a wrong role and a foreign database schema", () => {
    const root = privateRoot();
    const first = new PrivateLedger(root, "role.sqlite", "alpha");
    first.close();
    expect(codeOf(() => new PrivateLedger(root, "role.sqlite", "beta"))).toBe(
      "private-ledger-invalid",
    );

    const foreign = join(root, "foreign.sqlite");
    const db = new DatabaseSync(foreign);
    db.exec("CREATE TABLE unrelated(value TEXT)");
    db.close();
    chmodSync(foreign, 0o600);
    expect(
      codeOf(() => new PrivateLedger(root, "foreign.sqlite", "alpha")),
    ).toBe("private-ledger-invalid");
  });

  it("rejects symlink and hardlink replacement", () => {
    const root = privateRoot();
    const path = join(root, "link.sqlite");
    const ledger = new PrivateLedger(root, "link.sqlite", "alpha");
    ledger.transaction(() => ledger.write("k", "v"));
    const target = join(root, "target.sqlite");
    writeFileSync(target, "target", { mode: 0o600 });
    unlinkSync(path);
    symlinkSync(target, path);
    expect(codeOf(() => ledger.read("k"))).toBe("private-ledger-unsafe");
    ledger.close();

    const second = join(root, "hard.sqlite");
    const other = join(root, "other.sqlite");
    const hard = new PrivateLedger(root, "hard.sqlite", "alpha");
    hard.transaction(() => hard.write("k", "v"));
    writeFileSync(other, "other", { mode: 0o600 });
    unlinkSync(second);
    linkSync(other, second);
    expect(codeOf(() => hard.read("k"))).toBe("private-ledger-unsafe");
    hard.close();
  });

  it("rejects replacement of the database inode", () => {
    const root = privateRoot();
    const path = join(root, "inode.sqlite");
    const ledger = new PrivateLedger(root, "inode.sqlite", "alpha");
    ledger.transaction(() => ledger.write("k", "v"));
    const original = lstatSync(path).ino;
    unlinkSync(path);
    writeFileSync(path, "", { mode: 0o600 });
    expect(lstatSync(path).ino).not.toBe(original);
    expect(codeOf(() => ledger.read("k"))).toBe("private-ledger-changed");
    ledger.close();
  });

  it("rejects replacement of the private root inode", () => {
    const root = privateRoot();
    const ledger = new PrivateLedger(root, "root-inode.sqlite", "alpha");
    ledger.transaction(() => ledger.write("k", "v"));
    const moved = root + "-moved";
    renameSync(root, moved);
    roots.push(moved);
    mkdirSync(root, { mode: 0o700 });
    expect(codeOf(() => ledger.read("k"))).toBe("m3-private-root-unsafe");
    ledger.close();
  });

  it("enforces the 64KiB value, 8MiB and 4096 row caps", () => {
    const root = privateRoot();
    const ledger = new PrivateLedger(root, "caps.sqlite", "alpha");
    const big = "x".repeat(64 * 1024);
    ledger.transaction(() => {
      for (let index = 0; index < 128; index++) {
        ledger.write(`k${String(index).padStart(3, "0")}`, big);
      }
    });
    expect(
      codeOf(() => ledger.transaction(() => ledger.write("k128", big))),
    ).toBe("private-ledger-limit");
    expect(
      codeOf(() =>
        ledger.transaction(() => ledger.write("oversize", big + "x")),
      ),
    ).toBe("private-ledger-invalid");
    expect(ledger.entries("k").length).toBe(128);
    ledger.close();

    const rows = new PrivateLedger(root, "rows.sqlite", "alpha");
    rows.transaction(() => {
      for (let index = 0; index < 4096; index++) {
        rows.write(`r${String(index).padStart(4, "0")}`, "x");
      }
    });
    expect(rows.read("r4095")).toBe("x");
    expect(
      codeOf(() => rows.transaction(() => rows.write("r4096", "x"))),
    ).toBe("private-ledger-limit");
    rows.close();
  });

  it("rolls back and poisons when COMMIT fails before reaching SQLite", () => {
    const root = privateRoot();
    const ledger = new PrivateLedger(root, "before.sqlite", "alpha");
    ledger.transaction(() => {
      ledger.write("k", "old");
      ledger.write("unrelated", "keep");
    });
    armExec("before");
    expect(
      codeOf(() => ledger.transaction(() => ledger.write("k", "new"))),
    ).toBe("sync-storage-unavailable");
    vi.restoreAllMocks();
    expect(codeOf(() => ledger.read("k"))).toBe("sync-storage-unavailable");
    ledger.close();
    const again = new PrivateLedger(root, "before.sqlite", "alpha");
    expect(again.read("k")).toBe("old");
    expect(again.read("unrelated")).toBe("keep");
    again.close();
  });

  it("keeps a real COMMIT and reports an unknown outcome when exec fails after it", () => {
    const root = privateRoot();
    const ledger = new PrivateLedger(root, "after.sqlite", "alpha");
    ledger.transaction(() => {
      ledger.write("k", "old");
      ledger.write("unrelated", "keep");
    });
    armExec("after");
    expect(
      codeOf(() =>
        ledger.transaction(() => {
          ledger.write("k", "new");
          ledger.write("added", "yes");
        }),
      ),
    ).toBe("sync-storage-unavailable");
    vi.restoreAllMocks();
    expect(codeOf(() => ledger.read("k"))).toBe("sync-storage-unavailable");
    ledger.close();
    const again = new PrivateLedger(root, "after.sqlite", "alpha");
    expect(again.read("k")).toBe("new");
    expect(again.read("added")).toBe("yes");
    expect(again.read("unrelated")).toBe("keep");
    again.close();
  });

  it("does not report success when COMMIT leaves transaction state unknown", () => {
    const root = privateRoot();
    const ledger = new PrivateLedger(root, "unknown-commit.sqlite", "alpha");
    ledger.transaction(() => ledger.write("k", "old"));
    armExec("noop");
    expect(
      codeOf(() =>
        ledger.transaction(() => {
          ledger.write("k", "new");
          return "ok";
        }),
      ),
    ).toBe("sync-storage-unavailable");
    vi.restoreAllMocks();
    expect(codeOf(() => ledger.read("k"))).toBe("sync-storage-unavailable");
    ledger.close();
    const again = new PrivateLedger(root, "unknown-commit.sqlite", "alpha");
    expect(again.read("k")).toBe("old");
    again.close();
  });

  it("does not run work or report success when BEGIN state is unknown", () => {
    const root = privateRoot();
    const ledger = new PrivateLedger(root, "unknown-begin.sqlite", "alpha");
    ledger.transaction(() => ledger.write("k", "old"));
    armExec("begin");
    let ran = false;
    expect(
      codeOf(() =>
        ledger.transaction(() => {
          ran = true;
          ledger.write("k", "new");
        }),
      ),
    ).toBe("sync-storage-unavailable");
    expect(ran).toBe(false);
    vi.restoreAllMocks();
    expect(codeOf(() => ledger.read("k"))).toBe("sync-storage-unavailable");
    ledger.close();
    const again = new PrivateLedger(root, "unknown-begin.sqlite", "alpha");
    expect(again.read("k")).toBe("old");
    again.close();
  });
});
