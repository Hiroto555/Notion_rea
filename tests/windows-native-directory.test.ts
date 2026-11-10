import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import { createWindowsAppPrivate } from "../src/platform/windows/app-private";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeFileStat,
  type WindowsRuntimeFsPort,
} from "../src/platform/windows/runtime-platform";

const ROOT = "C:\\Folio";
const DIRECTORY = "C:\\Folio\\writer-hash-a";
const DATABASE = "C:\\Folio\\writer-hash-a\\shared-runtime.sqlite";
const FILE_ID = "A".repeat(32);
const OTHER_FILE_ID = "D".repeat(32);
const ROOT_FILE_ID = "B".repeat(32);
const CHANGED_ROOT_FILE_ID = "E".repeat(32);
const VOLUME_ID = "C".repeat(16);

function stat(kind: "file" | "directory"): WindowsRuntimeFileStat {
  return {
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => false,
    nlink: 1,
    dev: 1,
    ino: kind === "directory" ? 2 : 3,
    size: 0,
    mtimeMs: 0,
  };
}

function enoent(): NodeJS.ErrnoException {
  const error = new Error("ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

class FakeFs implements WindowsRuntimeFsPort {
  readonly stats = new Map<string, WindowsRuntimeFileStat>();

  lstat(path: string): WindowsRuntimeFileStat {
    const value = this.stats.get(path);
    if (value === undefined) throw enoent();
    return value;
  }

  readFile(): Uint8Array {
    return new Uint8Array();
  }

  openReadWrite(): number {
    return 1;
  }

  fsync(): void {}

  close(): void {}
}

type Evidence = Readonly<{
  canonicalPath: string;
  canonicalRoot: string;
  daclPrivate: true;
  fileId: string;
  linkCount: 1;
  localFilesystem: true;
  ownerSid: string;
  platform: "win32";
  reparsePoint: false;
  rootFileId: string;
  rootVolumeId: string;
  sid: string;
  volumeId: string;
}>;

function evidence(
  path: string,
  root: string,
  fileId: string,
  rootFileId: string,
): Evidence {
  return {
    canonicalPath: path,
    canonicalRoot: root,
    daclPrivate: true,
    fileId,
    linkCount: 1,
    localFilesystem: true,
    ownerSid: "S-1-5-21",
    platform: "win32",
    reparsePoint: false,
    rootFileId,
    rootVolumeId: VOLUME_ID,
    sid: "S-1-5-21",
    volumeId: VOLUME_ID,
  };
}

class FakeProbe {
  directoryCalls = 0;
  directoryFailure: "throw" | undefined;
  targetFileId = FILE_ID;
  rootFileId = ROOT_FILE_ID;
  rootFileIdAfter: string | undefined;

  probe(path: string, root: string): Evidence {
    if (path === root && this.directoryCalls > 0 && this.rootFileIdAfter)
      return evidence(path, root, this.rootFileIdAfter, this.rootFileIdAfter);
    return evidence(
      path,
      root,
      path === root ? this.rootFileId : this.targetFileId,
      this.rootFileId,
    );
  }

  directory(path: string, root: string): Evidence {
    this.directoryCalls += 1;
    if (this.directoryFailure === "throw")
      throw new CollaborationError("WINDOWS_PRIVATE_DIRECTORY_UNKNOWN");
    return evidence(path, root, this.targetFileId, this.rootFileId);
  }
}

function runtime(
  fs: FakeFs,
  probe: FakeProbe,
  databaseName?: string,
): WindowsRuntimePlatform {
  return new WindowsRuntimePlatform({
    root: ROOT,
    systemRoot: "C:\\Windows",
    probeExecutable: "C:\\Windows\\folio-probe.exe",
    databaseName,
    untrustedTestPort: { fs, probe },
  });
}

function setup(): { fs: FakeFs; probe: FakeProbe } {
  const fs = new FakeFs();
  fs.stats.set(ROOT, stat("directory"));
  fs.stats.set(DIRECTORY, stat("directory"));
  fs.stats.set(DATABASE, stat("file"));
  return { fs, probe: new FakeProbe() };
}

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    return error instanceof Error ? error.message : "UNKNOWN";
  }
  return "NO_ERROR";
}

describe("WindowsRuntimePlatform.prepareDirectory", () => {
  it("invokes the directory helper then binds only the prepared identity", () => {
    const { fs, probe } = setup();
    const platform = runtime(fs, probe);
    platform.prepareDirectory(DIRECTORY);
    expect(probe.directoryCalls).toBe(1);
    expect(platform.bind(DIRECTORY)).toBe(DIRECTORY);
    platform.close();
  });

  it("rejects a bind whose prepared directory identity was swapped", () => {
    const { fs, probe } = setup();
    const platform = runtime(fs, probe);
    platform.prepareDirectory(DIRECTORY);
    probe.targetFileId = OTHER_FILE_ID;
    expect(codeOf(() => platform.bind(DIRECTORY))).toBe(
      "WINDOWS_PREPARED_DIRECTORY_MISMATCH",
    );
    platform.close();
  });

  it("fails closed when the helper reports the prepared root changed", () => {
    const { fs, probe } = setup();
    probe.rootFileIdAfter = CHANGED_ROOT_FILE_ID;
    const platform = runtime(fs, probe);
    expect(codeOf(() => platform.prepareDirectory(DIRECTORY))).toBe(
      "WINDOWS_ROOT_IDENTITY_CHANGED",
    );
    platform.close();
  });

  it("preserves a directory UNKNOWN failure without retry or deletion", () => {
    const { fs, probe } = setup();
    probe.directoryFailure = "throw";
    const platform = runtime(fs, probe);
    expect(codeOf(() => platform.prepareDirectory(DIRECTORY))).toBe(
      "WINDOWS_PRIVATE_DIRECTORY_UNKNOWN",
    );
    expect(probe.directoryCalls).toBe(1);
    platform.close();
  });

  it("maps a missing file through the same non-creating probe path", () => {
    const { fs, probe } = setup();
    const platform = runtime(fs, probe);
    platform.prepareDirectory(DIRECTORY);
    platform.bind(DIRECTORY);
    fs.stats.delete(DATABASE);
    expect(codeOf(() => platform.assertFile(DATABASE))).toBe(
      "WINDOWS_DATABASE_MISSING",
    );
    platform.close();
  });
});

describe("WindowsRuntimePlatform.validatedFileIdentity", () => {
  it("returns the native file id bound to the validated database", () => {
    const { fs, probe } = setup();
    const platform = runtime(fs, probe);
    platform.prepareDirectory(DIRECTORY);
    platform.bind(DIRECTORY);
    expect(platform.validatedFileIdentity(DATABASE)).toEqual({
      canonicalPath: DATABASE,
      fileId: FILE_ID,
      volumeId: VOLUME_ID,
    });
    platform.close();
  });
});

describe("native helper source contract", () => {
  const source = readFileSync(
    new URL(
      "../scripts/platform/windows/PrivateRootProbeProgram.cs",
      import.meta.url,
    ),
    "utf8",
  );

  it("compiles managed parent handles with no DELETE sharing", () => {
    expect(source).toContain("OpenDirectoryHandle");
    expect(source).toContain("FileFlagBackupSemantics");
    expect(source).toContain("FileFlagOpenReparsePoint");
    expect(source).toContain("FileShareReadWrite");
    expect(source).toContain("System.IO.Directory.CreateDirectory(child)");
    expect(source).toContain('mode!="directory"');
  });

  it("reports created-then-failed directory preparation as UNKNOWN", () => {
    expect(source).toContain("DIRECTORY_UNCONFIRMED");
    expect(source).not.toContain("Directory.Delete");
  });
});

describe("Windows app-private config", () => {
  it("requires an expected helper hash", () => {
    expect(
      codeOf(() =>
        createWindowsAppPrivate({
          root: ROOT,
          probeExecutable: "C:\\Windows\\folio-probe.exe",
          expectedHash: "",
          systemRoot: "C:\\Windows",
        }),
      ),
    ).toBe("INVALID_PROBE_HASH");
  });
});
