import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPrivateRoot,
  pinPrivateRoot,
} from "../src/sync/m3-private-root";
import { SyncError } from "../src/sync/protocol";

const created: string[] = [];

function makeBase(): string {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "folio-m3-private-"));
  created.push(base);
  return base;
}

function makeRoot(base: string, name = "root"): string {
  const root = join(base, name);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

function expectUnsafe(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError);
    const syncError = error as SyncError;
    expect(syncError.code).toBe("m3-private-root-unsafe");
    expect(syncError.status).toBe(409);
    expect(syncError.message).toBe("m3-private-root-unsafe");
    return;
  }
  throw new Error("expected SyncError");
}

afterEach(() => {
  while (created.length > 0) {
    const directory = created.pop()!;
    try {
      chmodSync(directory, 0o700);
    } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("private root policy", () => {
  it("pins and rechecks a canonical 0700 directory without writing", () => {
    const base = makeBase();
    const root = makeRoot(base);
    const before = readdirSync(root);
    const pin = pinPrivateRoot(root);
    const stat = lstatSync(root);
    expect(pin).toEqual({
      path: root,
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
    });
    expect(readdirSync(root)).toEqual(before);
    expect(() => assertPrivateRoot(pin)).not.toThrow();
  });

  it("rejects a directory whose mode is not exactly 0700", () => {
    const base = makeBase();
    const root = makeRoot(base);
    chmodSync(root, 0o600);
    expectUnsafe(() => pinPrivateRoot(root));
  });

  it("rejects a pinned root whose mode changed", () => {
    const base = makeBase();
    const root = makeRoot(base);
    const pin = pinPrivateRoot(root);
    chmodSync(root, 0o750);
    expectUnsafe(() => assertPrivateRoot(pin));
  });

  it("rejects symlink ancestors and symlink leaves", () => {
    const base = makeBase();
    const actual = makeRoot(base, "actual");
    const linked = join(base, "linked");
    symlinkSync(actual, linked, "dir");
    const through = join(linked, "root");
    mkdirSync(through, { mode: 0o700 });
    chmodSync(through, 0o700);
    expectUnsafe(() => pinPrivateRoot(through));
    const leaf = join(base, "leaf");
    symlinkSync(actual, leaf, "dir");
    expectUnsafe(() => pinPrivateRoot(leaf));
  });

  it("rejects forbidden ancestors and descendants", () => {
    const base = makeBase();
    const root = makeRoot(base);
    expectUnsafe(() => pinPrivateRoot(root, [base]));
    const child = join(root, "child");
    mkdirSync(child, { mode: 0o700 });
    chmodSync(child, 0o700);
    expectUnsafe(() => pinPrivateRoot(root, [child]));
    expectUnsafe(() => pinPrivateRoot(root, [root]));
  });

  it("rejects a pinned root that was renamed or replaced", () => {
    const base = makeBase();
    const root = makeRoot(base);
    const pin = pinPrivateRoot(root);
    renameSync(root, join(base, "moved"));
    expectUnsafe(() => assertPrivateRoot(pin));
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    expectUnsafe(() => assertPrivateRoot(pin));
  });
});
