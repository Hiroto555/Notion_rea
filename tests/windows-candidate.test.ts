import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  WINDOWS_CANDIDATE_READY_CODE,
  assertWindowsCandidateEvidence,
  createWindowsCandidate,
  parseWindowsCandidateManifest,
  type WindowsCandidateExpectedPaths,
} from "../src/platform/windows/candidate";
import {
  WindowsRuntimePlatform,
  type WindowsRuntimeFileStat,
  type WindowsRuntimeFsPort,
} from "../src/platform/windows/runtime-platform";
import type { WindowsProbeEvidence } from "../src/platform/windows/path-policy";

const ROOT = "C:\\Folio\\candidate-root-1";
const CLIENT_A = ROOT + "\\clienta";
const CLIENT_B = ROOT + "\\clientb";
const SERVER = ROOT + "\\server";
const OWNERSHIP = ROOT + "\\ownership.nonce";
const NONCE = "nonce_1";
const OWNER = "S-1-5-21-1000";
const VOLUME = "0011223344556677";
const ROOT_FILE = "a".repeat(32);
const CLIENT_A_FILE = "b".repeat(32);
const CLIENT_B_FILE = "c".repeat(32);
const SERVER_FILE = "d".repeat(32);
const OWNERSHIP_FILE = "e".repeat(32);

const EXPECTED: WindowsCandidateExpectedPaths = {
  root: ROOT,
  nonce: NONCE,
  clientA: CLIENT_A,
  clientB: CLIENT_B,
  server: SERVER,
  ownershipPath: OWNERSHIP,
};

function manifest(): Record<string, unknown> {
  return {
    candidate: true,
    code: WINDOWS_CANDIDATE_READY_CODE,
    created: true,
    directories: [
      {
        name: "clienta",
        path: CLIENT_A,
        fileId: CLIENT_A_FILE,
        volumeId: VOLUME,
      },
      {
        name: "clientb",
        path: CLIENT_B,
        fileId: CLIENT_B_FILE,
        volumeId: VOLUME,
      },
      { name: "server", path: SERVER, fileId: SERVER_FILE, volumeId: VOLUME },
    ],
    nonce: NONCE,
    ownerSid: OWNER,
    ownershipFileId: OWNERSHIP_FILE,
    ownershipPath: OWNERSHIP,
    physical: "NOT_RUN",
    root: ROOT,
    rootFileId: ROOT_FILE,
    volumeId: VOLUME,
  };
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof CollaborationError) return error.code;
    throw error;
  }
  return undefined;
}

function evidence(path: string, fileId: string): WindowsProbeEvidence {
  return {
    platform: "win32",
    sid: OWNER,
    ownerSid: OWNER,
    daclPrivate: true,
    reparsePoint: false,
    linkCount: 1,
    localFilesystem: true,
    fileId,
    rootFileId: ROOT_FILE,
    volumeId: VOLUME,
    rootVolumeId: VOLUME,
    canonicalPath: path,
    canonicalRoot: ROOT,
  };
}

function fileStat(
  overrides: Partial<WindowsRuntimeFileStat> = {},
): WindowsRuntimeFileStat {
  return {
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    nlink: 1,
    dev: 7,
    ino: 11,
    size: 4,
    mtimeMs: 101,
    ...overrides,
  };
}

function dirStat(): WindowsRuntimeFileStat {
  return fileStat({
    isFile: () => false,
    isDirectory: () => true,
    nlink: 2,
    size: 0,
  });
}

type FakeFs = Readonly<{
  fs: WindowsRuntimeFsPort;
  setBytes(bytes: Uint8Array): void;
}>;

function fakeFs(
  probe: (path: string) => WindowsProbeEvidence,
  sidecar?: WindowsRuntimeFileStat,
): FakeFs {
  const executable = "C:\\Folio\\toolchain\\compiledNativeProbe.exe";
  const database = CLIENT_A + "\\shared-runtime.sqlite";
  let bytes = new Uint8Array([1, 2, 3, 4]);
  const files = new Map<string, WindowsRuntimeFileStat>([
    [executable, fileStat()],
    [database, fileStat()],
  ]);
  const directories = new Set([ROOT, CLIENT_A, CLIENT_B, SERVER]);
  if (sidecar !== undefined) files.set(database + "-wal", sidecar);
  const fs: WindowsRuntimeFsPort = {
    lstat: (path: string) => {
      const file = files.get(path);
      if (file !== undefined) return file;
      if (directories.has(path)) return dirStat();
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    readFile: (path: string) => {
      if (path !== executable) throw new Error("unexpected read");
      return bytes;
    },
    openReadWrite: () => 1,
    fsync: () => undefined,
    close: () => undefined,
  };
  return {
    fs,
    setBytes(next: Uint8Array): void {
      bytes = new Uint8Array(next);
    },
  };
}

function probeFor(path: string): WindowsProbeEvidence {
  if (path === CLIENT_A) return evidence(path, CLIENT_A_FILE);
  if (path === CLIENT_B) return evidence(path, CLIENT_B_FILE);
  if (path === SERVER) return evidence(path, SERVER_FILE);
  if (path === ROOT) return evidence(path, ROOT_FILE);
  if (path === CLIENT_A + "\\shared-runtime.sqlite")
    return evidence(path, "9".repeat(32));
  throw new Error("unexpected probe");
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Windows candidate manifest", () => {
  it("accepts the exact create-candidate-root.ps1 manifest shape", () => {
    const parsed = parseWindowsCandidateManifest(manifest(), EXPECTED);
    expect(parsed.root).toBe(ROOT);
    expect(parsed.nonce).toBe(NONCE);
    expect(parsed.directories.map((child) => child.name)).toEqual([
      "clienta",
      "clientb",
      "server",
    ]);
  });

  it("rejects a substituted nonce", () => {
    const substituted = { ...manifest(), nonce: "nonce_2" };
    expect(
      codeOf(() => parseWindowsCandidateManifest(substituted, EXPECTED)),
    ).toBe("WINDOWS_CANDIDATE_NONCE");
    expect(
      codeOf(() =>
        parseWindowsCandidateManifest(manifest(), {
          ...EXPECTED,
          nonce: "nonce_2",
        }),
      ),
    ).toBe("WINDOWS_CANDIDATE_NONCE");
  });

  it("rejects substituted paths, extra fields and duplicate evidence ids", () => {
    const substituted = manifest();
    substituted.root = "C:\\Folio\\other-root";
    expect(
      codeOf(() => parseWindowsCandidateManifest(substituted, EXPECTED)),
    ).toBe("WINDOWS_CANDIDATE_ROOT");

    const extra = { ...manifest(), unexpected: true };
    expect(codeOf(() => parseWindowsCandidateManifest(extra, EXPECTED))).toBe(
      "WINDOWS_CANDIDATE_MANIFEST_INVALID",
    );

    const duplicate = manifest();
    const directories = duplicate.directories as Record<string, unknown>[];
    directories[1].fileId = CLIENT_A_FILE;
    expect(
      codeOf(() => parseWindowsCandidateManifest(duplicate, EXPECTED)),
    ).toBe("WINDOWS_CANDIDATE_CHILD_FILE_ID");
  });

  it("rejects a child path that is not the explicitly expected path", () => {
    const substituted = manifest();
    const directories = substituted.directories as Record<string, unknown>[];
    directories[0].path = SERVER;
    expect(
      codeOf(() => parseWindowsCandidateManifest(substituted, EXPECTED)),
    ).toBe("WINDOWS_CANDIDATE_CHILD_PATH");
  });

  it("matches probe evidence ids against the manifest", () => {
    const parsed = parseWindowsCandidateManifest(manifest(), EXPECTED);
    expect(
      assertWindowsCandidateEvidence(
        parsed,
        CLIENT_A,
        evidence(CLIENT_A, CLIENT_A_FILE),
      ).fileId,
    ).toBe(CLIENT_A_FILE);
    expect(
      codeOf(() =>
        assertWindowsCandidateEvidence(
          parsed,
          CLIENT_A,
          evidence(CLIENT_A, CLIENT_B_FILE),
        ),
      ),
    ).toBe("WINDOWS_CANDIDATE_EVIDENCE_ID");
    expect(
      codeOf(() =>
        assertWindowsCandidateEvidence(parsed, CLIENT_A, {
          ...evidence(CLIENT_A, CLIENT_A_FILE),
          ownerSid: "S-1-5-21-9999",
          sid: "S-1-5-21-9999",
        }),
      ),
    ).toBe("WINDOWS_CANDIDATE_EVIDENCE_OWNER");
  });
});

describe("Windows helper hash pin", () => {
  it("rejects a wrong expected hash before any probe runs", () => {
    const fake = fakeFs(probeFor);
    let probed = false;
    expect(
      codeOf(
        () =>
          new WindowsRuntimePlatform({
            root: ROOT,
            probeExecutable: "C:\\Folio\\toolchain\\compiledNativeProbe.exe",
            systemRoot: "C:\\Windows",
            expectedHash: "0".repeat(64),
            untrustedTestPort: {
              fs: fake.fs,
              probe: {
                probe: (path: string) => {
                  probed = true;
                  return probeFor(path);
                },
              },
            },
          }),
      ),
    ).toBe("WINDOWS_PROBE_EXECUTABLE_HASH");
    expect(probed).toBe(false);
  });

  it("revalidates bytes on every helper call and pins the initial file identity", () => {
    const fake = fakeFs(probeFor);
    const initial = new Uint8Array([1, 2, 3, 4]);
    const platform = new WindowsRuntimePlatform({
      root: ROOT,
      probeExecutable: "C:\\Folio\\toolchain\\compiledNativeProbe.exe",
      systemRoot: "C:\\Windows",
      expectedHash: hash(initial),
      expectedRoot: { rootFileId: ROOT_FILE, volumeId: VOLUME },
      expectedDirectory: { fileId: CLIENT_A_FILE, volumeId: VOLUME },
      untrustedTestPort: {
        fs: fake.fs,
        probe: { probe: probeFor },
      },
    });
    expect(platform.bind(CLIENT_A)).toBe(CLIENT_A);
    fake.setBytes(new Uint8Array([5, 6, 7, 8]));
    expect(codeOf(() => platform.assertRoot())).toBe(
      "WINDOWS_PROBE_EXECUTABLE_HASH",
    );
    platform.close();
  });

  it("rejects probe evidence that disagrees with the parent manifest root id", () => {
    const fake = fakeFs(probeFor);
    expect(
      codeOf(() => {
        const platform = new WindowsRuntimePlatform({
          root: ROOT,
          probeExecutable: "C:\\Folio\\toolchain\\compiledNativeProbe.exe",
          systemRoot: "C:\\Windows",
          expectedHash: hash(new Uint8Array([1, 2, 3, 4])),
          expectedRoot: { rootFileId: "f".repeat(32), volumeId: VOLUME },
          untrustedTestPort: {
            fs: fake.fs,
            probe: { probe: probeFor },
          },
        });
        platform.bind(CLIENT_A);
      }),
    ).toBe("WINDOWS_ROOT_IDENTITY_MISMATCH");
  });

  it("fails closed on an unsafe database sidecar", () => {
    const fake = fakeFs(probeFor, fileStat({ isSymbolicLink: () => true }));
    const platform = new WindowsRuntimePlatform({
      root: ROOT,
      probeExecutable: "C:\\Folio\\toolchain\\compiledNativeProbe.exe",
      systemRoot: "C:\\Windows",
      expectedHash: hash(new Uint8Array([1, 2, 3, 4])),
      untrustedTestPort: {
        fs: fake.fs,
        probe: { probe: probeFor },
      },
    });
    expect(platform.bind(CLIENT_A)).toBe(CLIENT_A);
    expect(
      codeOf(() =>
        platform.assertDatabase(CLIENT_A + "\\shared-runtime.sqlite"),
      ),
    ).toBe("WINDOWS_DATABASE_SIDECAR_UNSAFE");
    platform.close();
  });

  it("does not start the native production adapter off Windows", () => {
    if (process.platform === "win32") return;
    expect(
      codeOf(
        () =>
          new WindowsRuntimePlatform({
            root: ROOT,
            probeExecutable: "C:\\Folio\\toolchain\\compiledNativeProbe.exe",
            systemRoot: "C:\\Windows",
            expectedHash: hash(new Uint8Array([1, 2, 3, 4])),
          }),
      ),
    ).toBe("NATIVE_PLATFORM_MISMATCH");
  });
});

describe("Windows candidate factory evidence trust", () => {
  const options = {
    systemRoot: "C:\\Windows",
    probeExecutable: "C:\\Folio\\toolchain\\compiledNativeProbe.exe",
    expectedHash: hash(new Uint8Array([1, 2, 3, 4])),
    platform: "win32" as const,
  };

  it("cannot turn injected probe evidence into Windows PASS", async () => {
    const result = await createWindowsCandidate(manifest(), EXPECTED, {
      ...options,
      untrustedProbe: { probe: probeFor },
    });
    if (result.status !== "NOT_RUN") throw new Error("expected NOT_RUN");
    expect(result.physical).toBe("NOT_RUN");
    expect(result.code).toBe("WINDOWS_CANDIDATE_EVIDENCE_UNTRUSTED");
  });

  it("rejects injected evidence with a substituted file id", async () => {
    await expect(
      createWindowsCandidate(manifest(), EXPECTED, {
        ...options,
        untrustedProbe: {
          probe: (path: string) =>
            path === CLIENT_A ? evidence(path, CLIENT_B_FILE) : probeFor(path),
        },
      }),
    ).rejects.toMatchObject({ code: "WINDOWS_CANDIDATE_EVIDENCE_ID" });
  });

  it("does not open stores off Windows and never reports physical PASS", async () => {
    if (process.platform === "win32") return;
    const result = await createWindowsCandidate(manifest(), EXPECTED, {
      ...options,
      platform: undefined,
    });
    if (result.status !== "NOT_RUN") throw new Error("expected NOT_RUN");
    expect(result.physical).toBe("NOT_RUN");
    expect(result.code).toBe("NATIVE_PLATFORM_MISMATCH");
  });
});
