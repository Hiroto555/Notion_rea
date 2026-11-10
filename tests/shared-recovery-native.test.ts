import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SharedRecoveryError,
  SharedRecoveryIndex,
  type SharedRecoveryFileIdentity,
  type SharedRecoveryFilesystemProof,
} from "../src/main/shared-recovery-index";
import { SHARED_RUNTIME_FILE } from "../src/collaboration/runtime/store";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "folio-recovery-native-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/**
 * Injected proof used only as a contract check on the host OS. It deliberately
 * does not claim to prove Windows filesystem safety.
 */
function fakeProof() {
  const calls: string[] = [];
  const proof: SharedRecoveryFilesystemProof = Object.freeze({
    ensureRoot(root: string): void {
      calls.push("ensureRoot");
      mkdirSync(root, { recursive: true, mode: 0o700 });
    },
    assertRoot(root: string): void {
      calls.push("assertRoot");
      if (!existsSync(root)) throw new Error("ROOT_MISSING");
    },
    assertDirectory(directory: string, _root: string): void {
      calls.push("assertDirectory");
      if (!existsSync(directory)) throw new Error("DIRECTORY_MISSING");
    },
    assertFile(path: string, _root: string): void {
      calls.push("assertFile");
      if (!existsSync(path)) throw new Error("FILE_MISSING");
    },
    createIndex(path: string, _root: string): void {
      calls.push("createIndex");
      writeFileSync(path, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
    },
    identity(path: string, _root: string): SharedRecoveryFileIdentity {
      calls.push("identity");
      return Object.freeze({
        fileId: Buffer.from(path).toString("hex").padEnd(32, "0").slice(0, 32),
        volumeId: "0000000000000001",
      });
    },
  });
  return { proof, calls };
}

function filter() {
  return { origin: "origin-main", orgId: "org-main", userId: "user-main" };
}

describe("SharedRecoveryIndex native proof port", () => {
  it("keeps the POSIX default non-creating for a missing root", () => {
    const root = join(tempRoot(), "missing");
    const index = new SharedRecoveryIndex(root);
    expect(index.list(filter())).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(() => index.read("rec_" + "0".repeat(64), filter())).toThrow(
      SharedRecoveryError,
    );
  });

  it("rejects a malformed injected proof", () => {
    expect(
      () =>
        new SharedRecoveryIndex(tempRoot(), {
          filesystemProof: { ensureRoot: () => undefined } as never,
        }),
    ).toThrow(SharedRecoveryError);
  });

  it("uses the port for root, directory, index creation and identity", () => {
    const { proof, calls } = fakeProof();
    const root = tempRoot();
    const directory = join(root, "writer");
    mkdirSync(directory, { mode: 0o700 });
    const index = new SharedRecoveryIndex(root, { filesystemProof: proof });

    const entryId = index.remember({
      ...filter(),
      writerId: "writer-main",
      directory,
      kind: "document",
    });

    expect(entryId).toMatch(/^rec_[0-9a-f]{64}$/);
    expect(calls).toContain("ensureRoot");
    expect(calls).toContain("assertRoot");
    expect(calls).toContain("assertDirectory");
    expect(calls).toContain("createIndex");
    expect(calls).toContain("assertFile");
    expect(calls).toContain("identity");

    const listed = index.list(filter());
    expect(listed).toHaveLength(1);
    expect(listed[0].entryId).toBe(entryId);
    expect(listed[0].status).toBe("MISSING");
    expect(() => index.read(entryId, filter())).toThrow(SharedRecoveryError);
  });

  it("does not create or inspect an index for a missing root", () => {
    const { proof, calls } = fakeProof();
    const root = join(tempRoot(), "missing");
    const index = new SharedRecoveryIndex(root, { filesystemProof: proof });
    expect(index.list(filter())).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("does not create the index on read-only list when it is absent", () => {
    const { proof, calls } = fakeProof();
    const root = tempRoot();
    const index = new SharedRecoveryIndex(root, { filesystemProof: proof });
    expect(index.list(filter())).toEqual([]);
    expect(calls).toContain("assertRoot");
    expect(calls).not.toContain("createIndex");
  });

  it("does not create a writer store while remembering metadata", () => {
    const { proof } = fakeProof();
    const root = tempRoot();
    const directory = join(root, "writer");
    mkdirSync(directory, { mode: 0o700 });
    const index = new SharedRecoveryIndex(root, { filesystemProof: proof });

    index.remember({
      ...filter(),
      writerId: "writer-main",
      directory,
      kind: "resource",
    });

    expect(existsSync(join(directory, SHARED_RUNTIME_FILE))).toBe(false);
    expect(existsSync(join(directory, SHARED_RUNTIME_FILE + "-wal"))).toBe(
      false,
    );
  });

  it("keeps current user/org filtering with the port", () => {
    const { proof } = fakeProof();
    const root = tempRoot();
    const directory = join(root, "writer");
    mkdirSync(directory, { mode: 0o700 });
    const index = new SharedRecoveryIndex(root, { filesystemProof: proof });
    index.remember({
      ...filter(),
      writerId: "writer-main",
      directory,
      kind: "document",
    });

    expect(
      index.list({
        origin: "origin-main",
        orgId: "org-main",
        userId: "user-other",
      }),
    ).toEqual([]);
    expect(
      index.list({
        origin: "origin-main",
        orgId: "org-other",
        userId: "user-main",
      }),
    ).toEqual([]);
  });
});
