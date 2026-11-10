import { describe, expect, it } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeFileStat,
  type WindowsRuntimeFsPort,
  type WindowsRuntimePlatformOptions,
  type WindowsRuntimeProbePort,
} from "../src/platform/windows/runtime-platform";

const ROOT = "C:\\Folio";
const DIRECTORY = "C:\\Folio\\runtime";
const DATABASE = "C:\\Folio\\runtime\\shared-runtime.sqlite";
const EXECUTABLE = "C:\\Folio\\bin\\PrivateRootProbe.exe";
const SYSTEM_ROOT = "C:\\Windows";

type Entry = Readonly<{
  kind: "file" | "directory";
  symlink?: boolean;
  nlink?: number;
}>;

function fold(value: string): string {
  return value.replace(/\//g, "\\").toLowerCase();
}

class FakeFs implements WindowsRuntimeFsPort {
  readonly entries = new Map<string, Entry>();
  readonly calls: string[] = [];
  readonly openFds = new Map<number, string>();
  onFsync: ((fd: number) => void) | undefined;
  #nextFd = 1;

  addDirectory(path: string, options: Omit<Entry, "kind"> = {}): void {
    this.entries.set(fold(path), { kind: "directory", ...options });
  }

  addFile(path: string, options: Omit<Entry, "kind"> = {}): void {
    this.entries.set(fold(path), { kind: "file", nlink: 1, ...options });
  }

  lstat(path: string): WindowsRuntimeFileStat {
    this.calls.push(`lstat:${fold(path)}`);
    const entry = this.entries.get(fold(path));
    if (entry === undefined) {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return {
      isFile: () => entry.kind === "file",
      isDirectory: () => entry.kind === "directory",
      isSymbolicLink: () => entry.symlink === true,
      nlink: entry.nlink ?? 1,
      dev: 1,
      ino: 1,
      size: 0,
      mtimeMs: 0,
    };
  }

  readFile(_path: string): Uint8Array {
    return new Uint8Array();
  }

  openReadWrite(path: string): number {
    this.calls.push(`open:${fold(path)}`);
    const descriptor = this.#nextFd++;
    this.openFds.set(descriptor, fold(path));
    return descriptor;
  }

  fsync(descriptor: number): void {
    this.calls.push(`fsync:${descriptor}`);
    this.onFsync?.(descriptor);
  }

  close(descriptor: number): void {
    this.calls.push(`close:${descriptor}`);
    this.openFds.delete(descriptor);
  }
}

type ProbeState = {
  rootFileId: string;
  rootVolumeId: string;
  directoryFileId: string;
  directoryVolumeId: string;
  databaseFileId: string;
  databaseVolumeId: string;
  rootOverrides: Record<string, unknown>;
  directoryOverrides: Record<string, unknown>;
  databaseOverrides: Record<string, unknown>;
  calls: number;
};

function probeState(): ProbeState {
  return {
    rootFileId: "1".repeat(32),
    rootVolumeId: "2".repeat(16),
    directoryFileId: "3".repeat(32),
    directoryVolumeId: "2".repeat(16),
    databaseFileId: "4".repeat(32),
    databaseVolumeId: "2".repeat(16),
    rootOverrides: {},
    directoryOverrides: {},
    databaseOverrides: {},
    calls: 0,
  };
}

function evidence(
  canonicalPath: string,
  canonicalRoot: string,
  fileId: string,
  volumeId: string,
  rootFileId: string,
  rootVolumeId: string,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    platform: "win32",
    sid: "S-1-5-21-1000",
    ownerSid: "S-1-5-21-1000",
    daclPrivate: true,
    reparsePoint: false,
    linkCount: 1,
    localFilesystem: true,
    fileId,
    rootFileId,
    volumeId,
    rootVolumeId,
    canonicalPath,
    canonicalRoot,
    ...overrides,
  };
}

function makeProbe(state: ProbeState): WindowsRuntimeProbePort {
  return {
    probe(path: string, root: string): unknown {
      state.calls++;
      const key = fold(path);
      if (key === fold(ROOT)) {
        return evidence(
          ROOT,
          root,
          state.rootFileId,
          state.rootVolumeId,
          state.rootFileId,
          state.rootVolumeId,
          state.rootOverrides,
        );
      }
      if (key === fold(DIRECTORY)) {
        return evidence(
          DIRECTORY,
          root,
          state.directoryFileId,
          state.directoryVolumeId,
          state.rootFileId,
          state.rootVolumeId,
          state.directoryOverrides,
        );
      }
      if (key === fold(DATABASE)) {
        return evidence(
          DATABASE,
          root,
          state.databaseFileId,
          state.databaseVolumeId,
          state.rootFileId,
          state.rootVolumeId,
          state.databaseOverrides,
        );
      }
      throw new CollaborationError("FAKE_UNKNOWN_PATH");
    },
  };
}

function options(
  fs: FakeFs,
  probe: WindowsRuntimeProbePort,
): WindowsRuntimePlatformOptions {
  return {
    root: ROOT,
    probeExecutable: EXECUTABLE,
    systemRoot: SYSTEM_ROOT,
    untrustedTestPort: { fs, probe },
  };
}

function setup(): {
  fs: FakeFs;
  state: ProbeState;
  probe: WindowsRuntimeProbePort;
  platform: WindowsRuntimePlatform;
} {
  const fs = new FakeFs();
  fs.addDirectory(ROOT);
  fs.addDirectory(DIRECTORY);
  fs.addFile(DATABASE);
  const state = probeState();
  const probe = makeProbe(state);
  const platform = new WindowsRuntimePlatform(options(fs, probe));
  return { fs, state, probe, platform };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationError);
    expect((error as CollaborationError).code).toBe(code);
    return;
  }
  throw new Error(`expected CollaborationError ${code}`);
}

function countPrefix(fs: FakeFs, prefix: string): number {
  return fs.calls.filter((call) => call.startsWith(prefix)).length;
}

describe("WindowsRuntimePlatform injected contract", () => {
  it("binds a preprovisioned directory and verifies root and database identity", () => {
    const { fs, state, platform } = setup();
    expect(platform.bind(DIRECTORY)).toBe(DIRECTORY);
    expect(() => platform.assertRoot()).not.toThrow();
    expect(() => platform.assertDatabase(DATABASE)).not.toThrow();
    expect(() => platform.assertDatabase(DATABASE)).not.toThrow();
    expect(state.calls).toBe(4);
    expect(fs.entries.has(fold(DIRECTORY))).toBe(true);
  });

  it("returns the probe canonical directory for a case variant", () => {
    const { platform } = setup();
    expect(platform.bind("c:\\FOLIO\\runtime")).toBe(DIRECTORY);
  });

  it("rejects a missing preprovisioned directory without creating it", () => {
    const fs = new FakeFs();
    fs.addDirectory(ROOT);
    const platform = new WindowsRuntimePlatform(
      options(fs, makeProbe(probeState())),
    );
    expectCode(() => platform.bind(DIRECTORY), "WINDOWS_PRIVATE_ROOT_MISSING");
    expect(fs.entries.has(fold(DIRECTORY))).toBe(false);
  });

  it("rejects a missing root directory", () => {
    const fs = new FakeFs();
    fs.addDirectory(DIRECTORY);
    const platform = new WindowsRuntimePlatform(
      options(fs, makeProbe(probeState())),
    );
    expectCode(() => platform.bind(DIRECTORY), "WINDOWS_ROOT_MISSING");
  });

  it("rejects a directory outside the lexical root without probing", () => {
    const { fs, state, platform } = setup();
    fs.addDirectory("C:\\Other\\runtime");
    expectCode(() => platform.bind("C:\\Other\\runtime"), "OUTSIDE_ROOT");
    expect(state.calls).toBe(0);
  });

  it("rejects a symlinked private directory", () => {
    const fs = new FakeFs();
    fs.addDirectory(ROOT);
    fs.addDirectory(DIRECTORY, { symlink: true });
    fs.addFile(DATABASE);
    const platform = new WindowsRuntimePlatform(
      options(fs, makeProbe(probeState())),
    );
    expectCode(() => platform.bind(DIRECTORY), "WINDOWS_PRIVATE_ROOT_UNSAFE");
  });

  it("rejects a file where the private directory is required", () => {
    const fs = new FakeFs();
    fs.addDirectory(ROOT);
    fs.addFile(DIRECTORY);
    const platform = new WindowsRuntimePlatform(
      options(fs, makeProbe(probeState())),
    );
    expectCode(() => platform.bind(DIRECTORY), "WINDOWS_PRIVATE_ROOT_UNSAFE");
  });

  const adversarialEvidence: ReadonlyArray<
    readonly [string, Record<string, unknown>, string]
  > = [
    ["reparse point", { reparsePoint: true }, "PROBE_REPARSE"],
    ["hard link count", { linkCount: 2 }, "PROBE_LINK_COUNT"],
    ["non-private DACL", { daclPrivate: false }, "PROBE_DACL"],
    ["foreign owner", { ownerSid: "S-1-5-21-2000" }, "PROBE_OWNER"],
    ["foreign platform", { platform: "linux" }, "PROBE_PLATFORM"],
    ["non-local filesystem", { localFilesystem: false }, "PROBE_LOCAL_FS"],
    ["volume mismatch", { volumeId: "9".repeat(16) }, "PROBE_VOLUME_MISMATCH"],
    ["path mismatch", { canonicalPath: ROOT }, "PROBE_PATH_MISMATCH"],
    ["extra field", { unexpected: true }, "PROBE_INVALID"],
  ];

  for (const [name, overrides, code] of adversarialEvidence) {
    it(`rejects probe evidence with ${name}`, () => {
      const fs = new FakeFs();
      fs.addDirectory(ROOT);
      fs.addDirectory(DIRECTORY);
      fs.addFile(DATABASE);
      const state = probeState();
      state.directoryOverrides = overrides;
      const platform = new WindowsRuntimePlatform(
        options(fs, makeProbe(state)),
      );
      expectCode(() => platform.bind(DIRECTORY), code);
    });
  }

  it("rejects missing probe evidence fields", () => {
    const fs = new FakeFs();
    fs.addDirectory(ROOT);
    fs.addDirectory(DIRECTORY);
    fs.addFile(DATABASE);
    const probe: WindowsRuntimeProbePort = {
      probe(): unknown {
        const value = evidence(
          DIRECTORY,
          ROOT,
          "3".repeat(32),
          "2".repeat(16),
          "1".repeat(32),
          "2".repeat(16),
          {},
        );
        delete (value as Record<string, unknown>).fileId;
        return value;
      },
    };
    const platform = new WindowsRuntimePlatform(options(fs, probe));
    expectCode(() => platform.bind(DIRECTORY), "PROBE_INVALID");
  });

  it("converts an untrusted probe exception to PROBE_FAILED", () => {
    const fs = new FakeFs();
    fs.addDirectory(ROOT);
    fs.addDirectory(DIRECTORY);
    fs.addFile(DATABASE);
    const probe: WindowsRuntimeProbePort = {
      probe(): unknown {
        throw new Error("boom");
      },
    };
    const platform = new WindowsRuntimePlatform(options(fs, probe));
    expectCode(() => platform.bind(DIRECTORY), "PROBE_FAILED");
  });

  it("rejects non-object probe output", () => {
    const fs = new FakeFs();
    fs.addDirectory(ROOT);
    fs.addDirectory(DIRECTORY);
    fs.addFile(DATABASE);
    const probe: WindowsRuntimeProbePort = { probe: () => null };
    const platform = new WindowsRuntimePlatform(options(fs, probe));
    expectCode(() => platform.bind(DIRECTORY), "PROBE_INVALID");
  });

  it("rejects assertion before bind", () => {
    const { platform } = setup();
    expectCode(() => platform.assertRoot(), "WINDOWS_ROOT_NOT_BOUND");
    expectCode(
      () => platform.assertDatabase(DATABASE),
      "WINDOWS_ROOT_NOT_BOUND",
    );
    expectCode(
      () => platform.syncCreatedDatabase(DATABASE),
      "WINDOWS_ROOT_NOT_BOUND",
    );
  });

  it("rejects a second bind", () => {
    const { platform } = setup();
    platform.bind(DIRECTORY);
    expectCode(() => platform.bind(DIRECTORY), "WINDOWS_ROOT_ALREADY_BOUND");
  });

  it("detects a replaced bound directory", () => {
    const { state, platform } = setup();
    platform.bind(DIRECTORY);
    state.directoryFileId = "A".repeat(32);
    expectCode(
      () => platform.assertRoot(),
      "WINDOWS_DIRECTORY_IDENTITY_CHANGED",
    );
  });

  it("detects a replaced root", () => {
    const { state, platform } = setup();
    platform.bind(DIRECTORY);
    state.rootFileId = "B".repeat(32);
    expectCode(() => platform.assertRoot(), "WINDOWS_ROOT_IDENTITY_CHANGED");
  });

  it("detects a replaced root volume", () => {
    const { state, platform } = setup();
    platform.bind(DIRECTORY);
    state.rootVolumeId = "C".repeat(16);
    state.directoryVolumeId = "C".repeat(16);
    state.databaseVolumeId = "C".repeat(16);
    expectCode(() => platform.assertRoot(), "WINDOWS_ROOT_IDENTITY_CHANGED");
  });

  it("rejects a database path that is not the exact shared runtime file", () => {
    const { fs, platform } = setup();
    fs.addFile("C:\\Folio\\runtime\\other.sqlite");
    fs.addFile("C:\\Folio\\runtime\\nested\\shared-runtime.sqlite");
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.assertDatabase("C:\\Folio\\runtime\\other.sqlite"),
      "WINDOWS_DATABASE_PATH",
    );
    expectCode(
      () =>
        platform.assertDatabase(
          "C:\\Folio\\runtime\\nested\\shared-runtime.sqlite",
        ),
      "WINDOWS_DATABASE_PATH",
    );
  });

  it("rejects a shared runtime file under a different directory", () => {
    const { platform } = setup();
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.assertDatabase("C:\\Folio\\other\\shared-runtime.sqlite"),
      "OUTSIDE_ROOT",
    );
  });

  it("rejects a missing database", () => {
    const fs = new FakeFs();
    fs.addDirectory(ROOT);
    fs.addDirectory(DIRECTORY);
    const state = probeState();
    const platform = new WindowsRuntimePlatform(options(fs, makeProbe(state)));
    platform.bind(DIRECTORY);
    expectCode(
      () => platform.assertDatabase(DATABASE),
      "WINDOWS_DATABASE_MISSING",
    );
    expect(state.calls).toBe(1);
  });

  it("rejects a symlinked or hard-linked database before probing", () => {
    const symlinkFs = new FakeFs();
    symlinkFs.addDirectory(ROOT);
    symlinkFs.addDirectory(DIRECTORY);
    symlinkFs.addFile(DATABASE, { symlink: true });
    const symlinkState = probeState();
    const symlinkPlatform = new WindowsRuntimePlatform(
      options(symlinkFs, makeProbe(symlinkState)),
    );
    symlinkPlatform.bind(DIRECTORY);
    expectCode(
      () => symlinkPlatform.assertDatabase(DATABASE),
      "WINDOWS_DATABASE_UNSAFE",
    );
    expect(symlinkState.calls).toBe(1);

    const hardlinkFs = new FakeFs();
    hardlinkFs.addDirectory(ROOT);
    hardlinkFs.addDirectory(DIRECTORY);
    hardlinkFs.addFile(DATABASE, { nlink: 2 });
    const hardlinkPlatform = new WindowsRuntimePlatform(
      options(hardlinkFs, makeProbe(probeState())),
    );
    hardlinkPlatform.bind(DIRECTORY);
    expectCode(
      () => hardlinkPlatform.assertDatabase(DATABASE),
      "WINDOWS_DATABASE_UNSAFE",
    );
  });

  it("detects a replaced database file after the first pin", () => {
    const { state, platform } = setup();
    platform.bind(DIRECTORY);
    platform.assertDatabase(DATABASE);
    state.databaseFileId = "D".repeat(32);
    expectCode(
      () => platform.assertDatabase(DATABASE),
      "WINDOWS_DATABASE_IDENTITY_CHANGED",
    );
  });

  it("rejects database probe evidence with a reparse point", () => {
    const { state, platform } = setup();
    platform.bind(DIRECTORY);
    state.databaseOverrides = { reparsePoint: true };
    expectCode(() => platform.assertDatabase(DATABASE), "PROBE_REPARSE");
  });

  it("fsyncs a created database under pre and post identity checks", () => {
    const { fs, state, platform } = setup();
    platform.bind(DIRECTORY);
    platform.syncCreatedDatabase(DATABASE);
    expect(fs.calls).toContain(`open:${fold(DATABASE)}`);
    expect(fs.calls).toContain("fsync:1");
    expect(fs.calls).toContain("close:1");
    expect(fs.openFds.size).toBe(0);
    expect(state.calls).toBe(5);
  });

  it("closes the descriptor and preserves the original fsync failure", () => {
    const { fs, state, platform } = setup();
    platform.bind(DIRECTORY);
    const failure = new Error("fsync failed");
    fs.onFsync = () => {
      throw failure;
    };
    expect(() => platform.syncCreatedDatabase(DATABASE)).toThrow(failure);
    expect(fs.calls).toContain("close:1");
    expect(fs.openFds.size).toBe(0);
    expect(state.calls).toBe(3);
  });

  it("rejects a database replacement detected after fsync", () => {
    const { fs, state, platform } = setup();
    platform.bind(DIRECTORY);
    fs.onFsync = () => {
      state.databaseFileId = "E".repeat(32);
    };
    expectCode(
      () => platform.syncCreatedDatabase(DATABASE),
      "WINDOWS_DATABASE_IDENTITY_CHANGED",
    );
    expect(fs.calls).toContain("close:1");
    expect(fs.openFds.size).toBe(0);
  });

  it("fails closed after close and is idempotent", () => {
    const { platform } = setup();
    platform.bind(DIRECTORY);
    platform.close();
    platform.close();
    expectCode(() => platform.bind(DIRECTORY), "WINDOWS_PLATFORM_CLOSED");
    expectCode(() => platform.assertRoot(), "WINDOWS_PLATFORM_CLOSED");
    expectCode(
      () => platform.assertDatabase(DATABASE),
      "WINDOWS_PLATFORM_CLOSED",
    );
    expectCode(
      () => platform.syncCreatedDatabase(DATABASE),
      "WINDOWS_PLATFORM_CLOSED",
    );
  });

  it("rejects malformed constructor options", () => {
    const fs = new FakeFs();
    const probe = makeProbe(probeState());
    expectCode(
      () =>
        new WindowsRuntimePlatform(
          null as unknown as WindowsRuntimePlatformOptions,
        ),
      "INVALID_WINDOWS_RUNTIME_OPTIONS",
    );
    expectCode(
      () =>
        new WindowsRuntimePlatform({
          ...options(fs, probe),
          root: "runtime",
        }),
      "INVALID_WINDOWS_ROOT",
    );
    expectCode(
      () =>
        new WindowsRuntimePlatform({
          ...options(fs, probe),
          systemRoot: "Windows",
        }),
      "INVALID_SYSTEM_ROOT",
    );
    expectCode(
      () =>
        new WindowsRuntimePlatform({
          ...options(fs, probe),
          probeExecutable: "C:\\Folio\\bin\\PrivateRootProbe.dll",
        }),
      "INVALID_PROBE_EXECUTABLE",
    );
  });

  it("rejects an incomplete untrusted test port", () => {
    const base = {
      root: ROOT,
      probeExecutable: EXECUTABLE,
      systemRoot: SYSTEM_ROOT,
    };
    expectCode(
      () =>
        new WindowsRuntimePlatform({
          ...base,
          untrustedTestPort: {
            fs: {} as unknown as WindowsRuntimeFsPort,
          },
        }),
      "INVALID_WINDOWS_TEST_PORT",
    );
    expectCode(
      () =>
        new WindowsRuntimePlatform({
          ...base,
          untrustedTestPort: {
            probe: {} as unknown as WindowsRuntimeProbePort,
          },
        }),
      "INVALID_WINDOWS_TEST_PORT",
    );
  });

  if (process.platform !== "win32") {
    it("requires actual win32 without the explicit untrusted test port", () => {
      expectCode(
        () =>
          new WindowsRuntimePlatform({
            root: ROOT,
            probeExecutable: EXECUTABLE,
            systemRoot: SYSTEM_ROOT,
          }),
        "NATIVE_PLATFORM_MISMATCH",
      );
    });
  }
});
