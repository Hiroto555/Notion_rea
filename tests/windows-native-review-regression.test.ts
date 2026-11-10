import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { mkdtempSync, realpathSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  createWindowsPrivatePlatform,
  createWindowsPrivatePlatformForTesting,
} from "../src/platform/windows/private-ledger-native";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeFsPort,
  type WindowsRuntimePlatformOptions,
  type WindowsRuntimeProbePort,
} from "../src/platform/windows/runtime-platform";
import {
  isValidPrivateLedgerName,
  WindowsPrivatePlatform,
  type WindowsPrivateNativeRuntime,
} from "../src/sync/private-platform";
import { PrivateLedger } from "../src/sync/private-ledger";
import { SyncError } from "../src/sync/protocol";

const ROOT = "C:\\Private";
const VOLUME = "0123456789ABCDEF";
const ROOT_ID = "A".repeat(32);
const SID = "S-1-5-21-1000";
const FILE = `${ROOT}\\connections.sqlite`;

type Entry = Readonly<{ kind: "file" | "directory"; size: number; fileId: string }>;

function rootEntry(): Entry {
  return { kind: "directory", size: 0, fileId: ROOT_ID };
}

function fileEntry(fileId: string, size = 0): Entry {
  return { kind: "file", size, fileId };
}

function evidence(path: string, root: string, fileId: string): unknown {
  return {
    canonicalPath: path,
    canonicalRoot: root,
    daclPrivate: true,
    fileId,
    linkCount: 1,
    localFilesystem: true,
    ownerSid: SID,
    platform: "win32",
    reparsePoint: false,
    rootFileId: ROOT_ID,
    rootVolumeId: VOLUME,
    sid: SID,
    volumeId: VOLUME,
  };
}

function statOf(entry: Entry, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    dev: 1,
    ino: 1,
    isDirectory: () => entry.kind === "directory",
    isFile: () => entry.kind === "file",
    isSymbolicLink: () => false,
    mtimeMs: 0,
    nlink: 1,
    size: entry.size,
    ...overrides,
  };
}

function missing(): Error {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" });
}

function harness(files: Map<string, Entry> = new Map([[ROOT, rootEntry()]])) {
  const fs: WindowsRuntimeFsPort = {
    close: vi.fn(),
    fsync: vi.fn(),
    lstat: vi.fn((path: string) => {
      const entry = files.get(path);
      if (entry === undefined) throw missing();
      return statOf(entry) as never;
    }),
    openReadWrite: vi.fn(() => 1),
    readFile: vi.fn(() => {
      throw new Error("unexpected executable read");
    }),
  };
  const probe = vi.fn((path: string, root: string) => {
    const entry = files.get(path);
    return evidence(path, root, entry?.fileId ?? ROOT_ID);
  });
  const create = vi.fn((path: string, root: string) => {
    if (files.has(path)) throw new CollaborationError("WINDOWS_PRIVATE_CREATE_RACE");
    files.set(path, fileEntry("D".repeat(32)));
    return evidence(path, root, "D".repeat(32));
  });
  const open = vi.fn((path: string, root: string) => {
    const entry = files.get(path);
    if (entry === undefined) throw new CollaborationError("WINDOWS_PRIVATE_OPEN_UNKNOWN");
    return evidence(path, root, entry.fileId);
  });
  const probePort: WindowsRuntimeProbePort = { create, open, probe };
  const options: WindowsRuntimePlatformOptions = {
    databaseName: "connections.sqlite",
    probeExecutable: "C:\\Windows\\FolioProbe.exe",
    root: ROOT,
    systemRoot: "C:\\Windows",
    untrustedTestPort: { fs, probe: probePort },
  };
  const platform = new WindowsRuntimePlatform(options);
  platform.bind(ROOT);
  return { create, files, fs, open, platform, probe };
}

function expectCode(
  run: () => unknown,
  code: string,
  ErrorType: typeof CollaborationError | typeof SyncError = CollaborationError,
): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ErrorType);
    expect((error as { code?: string }).code).toBe(code);
  }
}

const roots: string[] = [];
function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-c15-")));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    try {
      rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {}
  }
});

describe("F1/F2 native helper source", () => {
  const source = readFileSync(
    new URL(
      "../scripts/platform/windows/PrivateRootProbeProgram.cs",
      import.meta.url,
    ),
    "utf8",
  );

  it("captures FILE_ID_INFO from the same create handle", () => {
    expect(source).toContain("GetFileInformationByHandleEx");
    expect(source).toContain("FILE_ID_INFO");
    expect(source).toContain("FileIdInfoClass");
    expect(source).toContain("stream.SafeFileHandle");
    expect(source).toContain("HandleIdentity(stream.SafeFileHandle");
  });

  it("separates create/open and reports uncertain publication as UNKNOWN", () => {
    expect(source).toContain('mode=="create"');
    expect(source).toContain('mode=="open"');
    expect(source).toContain('return Uncertain(args[0],"EXISTS")');
    expect(source).toContain("state=\"UNKNOWN\"");
    expect(source).toContain("FileMode.CreateNew");
    expect(source).toContain("FileMode.Open");
    expect(source).toContain("stream.Flush(true)");
    expect(source).not.toContain("Delete(");
  });
});

describe("F2 runtime create-or-open", () => {
  it("reopens an existing ledger through the open port instead of create", () => {
    const files = new Map<string, Entry>([
      [ROOT, rootEntry()],
      [FILE, fileEntry("E".repeat(32), 12)],
    ]);
    const { create, open, platform } = harness(files);
    expect(() => platform.createExclusiveDurably(FILE)).not.toThrow();
    expect(open).toHaveBeenCalledWith(FILE, ROOT);
    expect(create).not.toHaveBeenCalled();
  });

  it("propagates an uncertain create without retrying or accepting EEXIST", () => {
    const { files, platform } = harness();
    files.set(FILE, fileEntry("F".repeat(32)));
    const create = vi.fn(() => {
      throw new CollaborationError("WINDOWS_PRIVATE_CREATE_RACE");
    });
    const probePort: WindowsRuntimeProbePort = {
      create,
      probe: vi.fn((path: string, root: string) => evidence(path, root, "F".repeat(32))),
    };
    const runtime = new WindowsRuntimePlatform({
      databaseName: "connections.sqlite",
      probeExecutable: "C:\\Windows\\FolioProbe.exe",
      root: ROOT,
      systemRoot: "C:\\Windows",
      untrustedTestPort: {
        fs: {
          close: vi.fn(),
          fsync: vi.fn(),
          lstat: vi.fn((path: string) => {
            const entry = files.get(path);
            if (entry === undefined) throw missing();
            return statOf(entry) as never;
          }),
          openReadWrite: vi.fn(() => 1),
          readFile: vi.fn(),
        },
        probe: probePort,
      },
    });
    runtime.bind(ROOT);
    // Existing files take the open branch, so force the absent branch first.
    files.delete(FILE);
    expectCode(() => runtime.createExclusiveDurably(FILE), "WINDOWS_PRIVATE_CREATE_RACE");
    expect(create).toHaveBeenCalledTimes(1);
    expect(platform).toBeDefined();
  });
});

describe("F5 stable identity and sidecar pins", () => {
  it("pins a sidecar, clears it when absent and accepts a recreated journal", () => {
    const { files, platform } = harness();
    files.set(FILE, fileEntry("1".repeat(32)));
    expect(() => platform.assertSidecars(FILE)).not.toThrow();

    const wal = `${FILE}-wal`;
    files.set(wal, fileEntry("2".repeat(32), 4));
    expect(() => platform.assertSidecars(FILE)).not.toThrow();

    files.delete(wal);
    expect(() => platform.assertSidecars(FILE)).not.toThrow();

    files.set(wal, fileEntry("3".repeat(32), 4));
    expect(() => platform.assertSidecars(FILE)).not.toThrow();
  });

  it("rejects a sidecar replaced without an intervening absence", () => {
    const { files, platform } = harness();
    const wal = `${FILE}-wal`;
    files.set(FILE, fileEntry("1".repeat(32)));
    files.set(wal, fileEntry("2".repeat(32), 4));
    expect(() => platform.assertSidecars(FILE)).not.toThrow();
    files.set(wal, fileEntry("3".repeat(32), 4));
    expectCode(
      () => platform.assertSidecars(FILE),
      "WINDOWS_DATABASE_SIDECAR_IDENTITY_CHANGED",
    );
  });

  it("binds emptiness to the stable post-probe stat", () => {
    const { files, platform } = harness();
    files.set(FILE, fileEntry("4".repeat(32), 0));
    expect(() => platform.assertEmptyFile(FILE)).not.toThrow();
    files.set(FILE, fileEntry("4".repeat(32), 3));
    expectCode(() => platform.assertEmptyFile(FILE), "WINDOWS_DATABASE_NOT_EMPTY");
  });
});

describe("F4 shared names and SyncError translation", () => {
  it("uses one strict, reserved-name-aware basename rule", () => {
    expect(isValidPrivateLedgerName("connections.sqlite")).toBe(true);
    expect(isValidPrivateLedgerName("con.sqlite")).toBe(false);
    expect(isValidPrivateLedgerName("1connections.sqlite")).toBe(false);
    expect(isValidPrivateLedgerName("connections_x.sqlite")).toBe(false);
    expectCode(
      () => new PrivateLedger("/tmp", "con.sqlite", "connections"),
      "private-ledger-invalid",
      SyncError,
    );
  });

  it("translates native CollaborationError into SyncError and keeps the code", () => {
    const runtime: WindowsPrivateNativeRuntime = {
      bind() {
        throw new CollaborationError("WINDOWS_DATABASE_PATH");
      },
      assertRoot: vi.fn(),
      assertFile: vi.fn(),
      assertSidecars: vi.fn(),
      createExclusiveDurably: vi.fn(),
      assertEmptyFile: vi.fn(),
      close: vi.fn(),
    };
    const platform = new WindowsPrivatePlatform(runtime);
    expectCode(
      () => platform.bind("C:\\Private"),
      "WINDOWS_DATABASE_PATH",
      SyncError,
    );
    try {
      platform.bind("C:\\Private");
    } catch (error) {
      expect((error as SyncError).status).toBe(409);
    }

    const uncertain: WindowsPrivateNativeRuntime = {
      ...runtime,
      bind() {
        throw new CollaborationError("WINDOWS_PRIVATE_CREATE_UNKNOWN");
      },
    };
    try {
      new WindowsPrivatePlatform(uncertain).bind("C:\\Private");
    } catch (error) {
      expect(error).toBeInstanceOf(SyncError);
      expect((error as SyncError).status).toBe(503);
    }
  });

  it("removed the stale port-gap constant", () => {
    const source = readFileSync(
      new URL("../src/sync/private-platform.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("WINDOWS_PRIVATE_PORT_GAP");
  });
});

describe("F3 production vs testing factory", () => {
  const base = {
    databaseName: "connections.sqlite",
    probeExecutable: "C:\\Windows\\FolioProbe.exe",
    root: ROOT,
    systemRoot: "C:\\Windows",
  } as const;

  const files = new Map<string, Entry>([[ROOT, rootEntry()]]);
  const port = {
    fs: {
      close: vi.fn(),
      fsync: vi.fn(),
      lstat: vi.fn((path: string) => {
        const entry = files.get(path);
        if (entry === undefined) throw missing();
        return statOf(entry) as never;
      }),
      openReadWrite: vi.fn(() => 1),
      readFile: vi.fn(),
    },
    probe: {
      probe: vi.fn((path: string, root: string) =>
        evidence(path, root, files.get(path)?.fileId ?? ROOT_ID),
      ),
    },
  } as const;

  it("rejects an injected port in the production factory", () => {
    expectCode(
      () =>
        createWindowsPrivatePlatform({
          ...base,
          expectedHash: "a".repeat(64),
          untrustedTestPort: port,
        }),
      "WINDOWS_PRIVATE_TEST_PORT_FORBIDDEN",
    );
  });

  it("still requires a hash when no port is supplied", () => {
    expectCode(
      () => createWindowsPrivatePlatform({ ...base }),
      "WINDOWS_PRIVATE_EXPECTED_HASH_REQUIRED",
    );
  });

  it("allows the explicitly named testing factory off win32", () => {
    if (process.platform === "win32") return;
    const platform = createWindowsPrivatePlatformForTesting({
      ...base,
      untrustedTestPort: port,
    });
    expect(platform.kind).toBe("windows");
    expectCode(
      () => createWindowsPrivatePlatformForTesting({ ...base }),
      "WINDOWS_PRIVATE_TEST_PORT_REQUIRED",
    );
  });
});

describe("F5 ledger sidecar checks at transaction boundaries", () => {
  function fakeRuntime(): WindowsPrivateNativeRuntime {
    return {
      bind: (directory) => directory,
      assertRoot: vi.fn(),
      assertFile: vi.fn(),
      assertSidecars: vi.fn(),
      createExclusiveDurably(path) {
        writeFileSync(path, "", { mode: 0o600 });
        chmodSync(path, 0o600);
      },
      assertEmptyFile: vi.fn(),
      close: vi.fn(),
    };
  }

  it("checks sidecars after COMMIT and surfaces a post-commit failure", () => {
    const root = tempRoot();
    const runtime = fakeRuntime();
    const ledger = new PrivateLedger(
      root,
      "connections.sqlite",
      "connections",
      [],
      new WindowsPrivatePlatform(runtime),
    );
    const assertSidecars = runtime.assertSidecars as unknown as ReturnType<typeof vi.fn>;
    const before = assertSidecars.mock.calls.length;
    ledger.transaction(() => ledger.write("conn:one", "ciphertext"));
    // Pre-work, post-work and post-COMMIT boundaries all re-check sidecars.
    expect(assertSidecars.mock.calls.length - before).toBeGreaterThanOrEqual(3);

    assertSidecars.mockImplementation(() => {
      throw new SyncError("windows-private-sidecar-changed", 409);
    });
    expectCode(
      () => ledger.transaction(() => ledger.write("conn:two", "ciphertext")),
      "windows-private-sidecar-changed",
      SyncError,
    );
    try {
      ledger.close();
    } catch {}
  });
});
