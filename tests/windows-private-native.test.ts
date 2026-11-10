import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import { createWindowsPrivatePlatform, createWindowsPrivatePlatformForTesting } from "../src/platform/windows/private-ledger-native";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeFsPort,
  type WindowsRuntimeProbePort,
  type WindowsRuntimePlatformOptions,
} from "../src/platform/windows/runtime-platform";

const ROOT = "C:\\Private";
const VOLUME = "0123456789ABCDEF";
const ROOT_ID = "A".repeat(32);
const FILE_ID = "B".repeat(32);
const REPLACED_ID = "C".repeat(32);
const CREATED_ID = "D".repeat(32);
const SID = "S-1-5-21-1000";

type Entry = Readonly<{
  kind: "file" | "directory";
  size: number;
  fileId: string;
}>;

function rootEntry(): Entry {
  return { kind: "directory", size: 0, fileId: ROOT_ID };
}

function fileEntry(fileId = FILE_ID, size = 0): Entry {
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

function harness(databaseName?: string) {
  const files = new Map<string, Entry>([[ROOT, rootEntry()]]);
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
    const existing = files.get(path);
    if (existing !== undefined) return evidence(path, root, existing.fileId);
    files.set(path, fileEntry(CREATED_ID));
    return evidence(path, root, CREATED_ID);
  });
  const probePort: WindowsRuntimeProbePort = { create, probe };
  const options: WindowsRuntimePlatformOptions = {
    databaseName,
    probeExecutable: "C:\\Windows\\FolioProbe.exe",
    root: ROOT,
    systemRoot: "C:\\Windows",
    untrustedTestPort: { fs, probe: probePort },
  };
  const platform = new WindowsRuntimePlatform(options);
  platform.bind(ROOT);
  return { create, files, fs, platform, probe };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
  }
}

const DEFAULT_FILE = `${ROOT}\\shared-runtime.sqlite`;
const CONNECTIONS_FILE = `${ROOT}\\connections.sqlite`;

describe("WindowsRuntimePlatform private ledger capabilities", () => {
  it("keeps the shared-runtime.sqlite default and accepts file/database assertions", () => {
    const { files, platform } = harness();
    files.set(DEFAULT_FILE, fileEntry());
    expect(() => platform.assertFile(DEFAULT_FILE)).not.toThrow();
    expect(() => platform.assertDatabase(DEFAULT_FILE)).not.toThrow();
    expect(() => platform.assertEmptyFile(DEFAULT_FILE)).not.toThrow();
  });

  it("accepts an explicit private database basename and rejects other names", () => {
    const { files, platform } = harness("connections.sqlite");
    files.set(CONNECTIONS_FILE, fileEntry());
    expect(() => platform.assertFile(CONNECTIONS_FILE)).not.toThrow();
    expectCode(
      () => platform.assertFile(DEFAULT_FILE),
      "WINDOWS_DATABASE_PATH",
    );
  });

  it("fails an empty-file assertion when bytes are present", () => {
    const { files, platform } = harness("connections.sqlite");
    files.set(CONNECTIONS_FILE, fileEntry(FILE_ID, 1));
    expectCode(
      () => platform.assertEmptyFile(CONNECTIONS_FILE),
      "WINDOWS_DATABASE_NOT_EMPTY",
    );
  });

  it("proves existing sidecars and ignores absent ones", () => {
    const { files, platform, probe } = harness("connections.sqlite");
    files.set(CONNECTIONS_FILE, fileEntry());
    expect(() => platform.assertSidecars(CONNECTIONS_FILE)).not.toThrow();

    files.set(`${CONNECTIONS_FILE}-wal`, fileEntry("E".repeat(32), 4));
    expect(() => platform.assertSidecars(CONNECTIONS_FILE)).not.toThrow();
    expect(probe).toHaveBeenCalledWith(`${CONNECTIONS_FILE}-wal`, ROOT);
  });

  it("rejects an unsafe sidecar instead of following it", () => {
    const { files, fs, platform } = harness("connections.sqlite");
    files.set(CONNECTIONS_FILE, fileEntry());
    files.set(`${CONNECTIONS_FILE}-wal`, fileEntry());
    (fs.lstat as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (path: string) => {
        const entry = files.get(path);
        if (entry === undefined) throw missing();
        return path.endsWith("-wal")
          ? statOf(entry, { isSymbolicLink: () => true })
          : statOf(entry);
      },
    );
    expectCode(
      () => platform.assertSidecars(CONNECTIONS_FILE),
      "WINDOWS_DATABASE_SIDECAR_UNSAFE",
    );
  });

  it("fails cached proof when the file is replaced", () => {
    const { files, platform } = harness("connections.sqlite");
    files.set(CONNECTIONS_FILE, fileEntry(FILE_ID));
    expect(() => platform.assertFile(CONNECTIONS_FILE)).not.toThrow();
    files.set(CONNECTIONS_FILE, fileEntry(REPLACED_ID));
    expectCode(
      () => platform.assertFile(CONNECTIONS_FILE),
      "WINDOWS_DATABASE_IDENTITY_CHANGED",
    );
  });

  it("creates exclusively through the native create invocation port", () => {
    const { create, files, platform } = harness("connections.sqlite");
    expect(() => platform.createExclusiveDurably(CONNECTIONS_FILE)).not.toThrow();
    expect(create).toHaveBeenCalledWith(CONNECTIONS_FILE, ROOT);
    expect(files.get(CONNECTIONS_FILE)?.size).toBe(0);
    expect(() => platform.assertEmptyFile(CONNECTIONS_FILE)).not.toThrow();
  });

  it("does not fall back when no create port is injected", () => {
    const { files, fs, platform } = harness("connections.sqlite");
    const noCreate = new WindowsRuntimePlatform({
      databaseName: "connections.sqlite",
      probeExecutable: "C:\\Windows\\FolioProbe.exe",
      root: ROOT,
      systemRoot: "C:\\Windows",
      untrustedTestPort: {
        fs,
        probe: { probe: vi.fn((path: string) => evidence(path, ROOT, path === ROOT ? ROOT_ID : FILE_ID)) },
      },
    });
    noCreate.bind(ROOT);
    expectCode(
      () => noCreate.createExclusiveDurably(CONNECTIONS_FILE),
      "PROBE_CREATE_UNAVAILABLE",
    );
    expect(platform).toBeDefined();
  });

  it("rejects an invalid database basename", () => {
    expectCode(
      () =>
        new WindowsRuntimePlatform({
          databaseName: "..\\connections.sqlite",
          probeExecutable: "C:\\Windows\\FolioProbe.exe",
          root: ROOT,
          systemRoot: "C:\\Windows",
          untrustedTestPort: {
            fs: {} as WindowsRuntimeFsPort,
            probe: { probe: vi.fn() },
          },
        }),
      "INVALID_DATABASE_NAME",
    );
  });
});

describe("createWindowsPrivatePlatform", () => {
  const base = {
    databaseName: "connections.sqlite",
    probeExecutable: "C:\\Windows\\FolioProbe.exe",
    root: ROOT,
    systemRoot: "C:\\Windows",
  } as const;

  it("requires an expected hash for production construction", () => {
    expectCode(
      () => createWindowsPrivatePlatform({ ...base }),
      "WINDOWS_PRIVATE_EXPECTED_HASH_REQUIRED",
    );
  });

  it("allows an explicitly labelled injected test port", () => {
    const files = new Map<string, Entry>([[ROOT, rootEntry()]]);
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
    const platform = createWindowsPrivatePlatformForTesting({
      ...base,
      untrustedTestPort: {
        fs,
        probe: {
          probe: vi.fn((path: string, root: string) =>
            evidence(path, root, files.get(path)?.fileId ?? ROOT_ID),
          ),
        },
      },
    });
    expect(platform.kind).toBe("windows");
    expect(platform.bind(ROOT)).toBe(ROOT);
    files.set(CONNECTIONS_FILE, fileEntry());
    expect(() => platform.assertFile(CONNECTIONS_FILE)).not.toThrow();
  });

  it("rejects unknown options and invalid database names", () => {
    expectCode(
      () =>
        createWindowsPrivatePlatform({
          ...base,
          databaseName: "Connections.sqlite",
          expectedHash: "a".repeat(64),
        } as never),
      "INVALID_DATABASE_NAME",
    );
    expectCode(
      () =>
        createWindowsPrivatePlatform({
          ...base,
          extra: true,
        } as never),
      "INVALID_WINDOWS_PRIVATE_PLATFORM_OPTIONS",
    );
  });
});
