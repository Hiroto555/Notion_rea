import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonical } from "../src/collaboration/runtime/canonical";
import { digest } from "../src/collaboration/runtime/digest";
import { exportSharedBackup } from "../src/main/shared-backup-export";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { restoreBackup, validateRuntimeBackup } from "../src/collaboration/runtime/backup";
import type { BackupDownload } from "../src/collaboration/runtime/backup-port";
import {
  WINDOWS_BACKUP_ARTIFACT_PROFILE,
  type WindowsBackupArtifactPort,
  type WindowsBackupArtifactReceipt,
  type WindowsBackupArtifactRequest,
} from "../src/platform/windows/backup-artifact";

const roots: string[] = [];
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

function tempRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-backup-export-")),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const head = { epoch: "epoch-1", seq: 3, hash: "b".repeat(64) };
  const body = {
    format: "folio-shared-runtime-backup/1" as const,
    head,
    records: [{ namespace: "meta", key: "title", value: { text: "hello" } }],
    blobs: [],
  };
  const hash = digest(body);
  const backup = { ...body, hash };
  const raw = canonical(backup);
  const download: BackupDownload = { raw, head: { ...head }, hash };
  return { backup, raw, head, hash, download };
}

function legalOptions(
  download: () => Promise<BackupDownload>,
  pick: () => Promise<string | null>,
  forbiddenRoots: readonly string[] = [],
) {
  return { download, pick, isAuthorized: () => true, forbiddenRoots };
}

describe("exportSharedBackup", () => {
  it("exports canonical bytes to a new external file and leaves no staging file", async () => {
    const root = tempRoot();
    const destination = join(root, "backup.json");
    const value = fixture();
    let downloads = 0;
    let picks = 0;

    const result = await exportSharedBackup(
      legalOptions(
        async () => {
          downloads++;
          return value.download;
        },
        async () => {
          picks++;
          return destination;
        },
      ),
    );

    expect(downloads).toBe(1);
    expect(picks).toBe(1);
    expect(result).toEqual({
      state: "EXPORTED",
      path: destination,
      head: value.head,
      hash: value.hash,
    });
    const bytes = readFileSync(destination);
    expect(bytes.toString("utf8")).toBe(value.raw);
    expect(sha256(bytes)).toBe(sha256(value.raw));
    expect(lstatSync(destination).mode & 0o777).toBe(0o600);
    expect(lstatSync(destination).nlink).toBe(1);
    expect(readdirSync(root)).toEqual(["backup.json"]);
  });

  it("verifies and restores the exported POSIX backup into a fresh runtime store", async () => {
    const root = tempRoot();
    const destination = join(root, "backup.json");
    const value = fixture();
    await exportSharedBackup(legalOptions(async () => value.download, async () => destination));
    const parsed = validateRuntimeBackup(JSON.parse(readFileSync(destination, "utf8")));
    const restored = new RuntimeStore(join(root, "restored"));
    try {
      const result = restoreBackup(parsed, restored, "restored-epoch");
      expect(result.oldCut).toEqual(value.head);
      expect(result.hash).toBe(value.hash);
      expect(result.newCut.epoch).toBe("restored-epoch");
      expect(restored.get("meta", "title")).toEqual({ text: "hello" });
    } finally {
      restored.close();
    }
  });

  it("returns CANCELLED without creating any file", async () => {
    const root = tempRoot();
    const value = fixture();
    const result = await exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => null,
      ),
    );
    expect(result).toEqual({ state: "CANCELLED" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses an unreadable or unauthorized session before download", async () => {
    let downloads = 0;
    const promise = exportSharedBackup({
      download: async () => {
        downloads++;
        return fixture().download;
      },
      pick: async () => null,
      isAuthorized: () => false,
      forbiddenRoots: [],
    });
    await expect(promise).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(downloads).toBe(0);
  });

  it("rechecks authorization after download and never opens the picker", async () => {
    const value = fixture();
    let authorizationCalls = 0;
    let picks = 0;
    const promise = exportSharedBackup({
      download: async () => value.download,
      pick: async () => {
        picks++;
        return null;
      },
      isAuthorized: () => ++authorizationCalls <= 1,
      forbiddenRoots: [],
    });
    await expect(promise).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(picks).toBe(0);
  });

  it("rechecks authorization after the picker before touching the filesystem", async () => {
    const root = tempRoot();
    const destination = join(root, "backup.json");
    const value = fixture();
    let authorized = true;
    const promise = exportSharedBackup({
      download: async () => value.download,
      pick: async () => {
        authorized = false;
        return destination;
      },
      isAuthorized: () => authorized,
      forbiddenRoots: [],
    });
    await expect(promise).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects invalid downloads before the picker", async () => {
    const cases: [
      (value: ReturnType<typeof fixture>) => BackupDownload,
      string,
    ][] = [
      [
        (value): BackupDownload => ({
          ...value.download,
          raw: JSON.stringify(JSON.parse(value.raw), null, 2),
        }),
        "NON_CANONICAL_BACKUP",
      ],
      [
        (value): BackupDownload => ({
          ...value.download,
          head: { ...value.head, seq: value.head.seq + 1 },
        }),
        "BACKUP_DOWNLOAD_MISMATCH",
      ],
      [
        (value): BackupDownload => ({
          ...value.download,
          hash: "c".repeat(64),
        }),
        "BACKUP_DOWNLOAD_MISMATCH",
      ],
      [
        (value): BackupDownload => {
          const raw = canonical({ ...value.backup, hash: "c".repeat(64) });
          return { ...value.download, raw, hash: "c".repeat(64) };
        },
        "BACKUP_HASH_MISMATCH",
      ],
    ];
    for (const [mutate, code] of cases) {
      const value = fixture();
      let picks = 0;
      const promise = exportSharedBackup({
        download: async () => mutate(value),
        pick: async () => {
          picks++;
          return null;
        },
        isAuthorized: () => true,
        forbiddenRoots: [],
      });
      await expect(promise).rejects.toMatchObject({ code });
      expect(picks).toBe(0);
    }
  });

  it("rejects a destination nested under a forbidden private root", async () => {
    const root = tempRoot();
    const privateRoot = join(root, "private");
    mkdirSync(privateRoot);
    const destination = join(privateRoot, "backup.json");
    const value = fixture();
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => destination,
        [privateRoot],
      ),
    );
    await expect(promise).rejects.toMatchObject({
      code: "FORBIDDEN_DESTINATION",
    });
    expect(readdirSync(privateRoot)).toEqual([]);
  });

  it("rejects a destination whose parent is an ancestor of a forbidden root", async () => {
    const root = tempRoot();
    const privateRoot = join(root, "private");
    mkdirSync(privateRoot);
    const destination = join(root, "backup.json");
    const value = fixture();
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => destination,
        [privateRoot],
      ),
    );
    await expect(promise).rejects.toMatchObject({
      code: "FORBIDDEN_DESTINATION",
    });
    expect(existsSync(destination)).toBe(false);
  });

  it("does not confuse a sibling path sharing a string prefix with a forbidden root", async () => {
    const root = tempRoot();
    const privateRoot = join(root, "private");
    const sibling = join(root, "private-export");
    mkdirSync(privateRoot);
    mkdirSync(sibling);
    const destination = join(sibling, "backup.json");
    const value = fixture();
    const result = await exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => destination,
        [privateRoot],
      ),
    );
    expect(result.state).toBe("EXPORTED");
    expect(readFileSync(destination, "utf8")).toBe(value.raw);
  });

  it("detects a forbidden root replaced while the picker is open", async () => {
    const root = tempRoot();
    const privateRoot = join(root, "private");
    const output = join(root, "output");
    mkdirSync(privateRoot);
    mkdirSync(output);
    const destination = join(output, "backup.json");
    const value = fixture();
    const promise = exportSharedBackup({
      download: async () => value.download,
      pick: async () => {
        renameSync(privateRoot, join(root, "private-old"));
        mkdirSync(privateRoot);
        return destination;
      },
      isAuthorized: () => true,
      forbiddenRoots: [privateRoot],
    });
    await expect(promise).rejects.toMatchObject({
      code: "FORBIDDEN_ROOT_CHANGED",
    });
    expect(existsSync(destination)).toBe(false);
  });

  it("refuses a hardlink alias to a file inside a forbidden root without changing either name", async () => {
    const root = tempRoot();
    const privateRoot = join(root, "private");
    const output = join(root, "output");
    mkdirSync(privateRoot);
    mkdirSync(output);
    const secret = join(privateRoot, "workspace.sqlite");
    writeFileSync(secret, "SECRET");
    const destination = join(output, "alias.json");
    linkSync(secret, destination);
    const value = fixture();
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => destination,
        [privateRoot],
      ),
    );
    await expect(promise).rejects.toThrow();
    expect(readFileSync(secret, "utf8")).toBe("SECRET");
    expect(readFileSync(destination, "utf8")).toBe("SECRET");
    expect(lstatSync(destination).nlink).toBe(2);
    expect(readdirSync(output)).toEqual(["alias.json"]);
  });

  it("refuses an occupied destination and preserves its contents", async () => {
    const root = tempRoot();
    const destination = join(root, "backup.json");
    writeFileSync(destination, "KEEP");
    const value = fixture();
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => destination,
      ),
    );
    await expect(promise).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(readFileSync(destination, "utf8")).toBe("KEEP");
    expect(readdirSync(root)).toEqual(["backup.json"]);
  });

  it("refuses a symlink destination without touching its target", async () => {
    const root = tempRoot();
    const target = join(root, "target.json");
    const destination = join(root, "backup.json");
    writeFileSync(target, "KEEP");
    symlinkSync(target, destination);
    const value = fixture();
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => destination,
      ),
    );
    await expect(promise).rejects.toMatchObject({ code: "FILE_EXISTS" });
    expect(readFileSync(target, "utf8")).toBe("KEEP");
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
  });

  it("refuses a symlinked parent directory", async () => {
    const root = tempRoot();
    const realDirectory = join(root, "real");
    const linkedParent = join(root, "linked");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedParent);
    const destination = join(linkedParent, "backup.json");
    const value = fixture();
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => destination,
      ),
    );
    await expect(promise).rejects.toMatchObject({ code: "UNSAFE_DESTINATION" });
    expect(readdirSync(realDirectory)).toEqual([]);
  });

  it("refuses a destination under an ancestor containing Folio data markers", async () => {
    const root = tempRoot();
    const output = join(root, "output");
    mkdirSync(output);
    writeFileSync(join(root, "workspace.sqlite"), "DB");
    const destination = join(output, "backup.json");
    const value = fixture();
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => destination,
      ),
    );
    await expect(promise).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(output)).toEqual([]);
  });

  it("refuses Windows reserved names and prefixes", async () => {
    const root = tempRoot();
    const value = fixture();
    for (const name of ["CON.json", "nul.txt", "COM1", "CONIN$.json"]) {
      const destination = join(root, name);
      const promise = exportSharedBackup(
        legalOptions(
          async () => value.download,
          async () => destination,
        ),
      );
      await expect(promise).rejects.toMatchObject({
        code: "RESERVED_WINDOWS_NAME",
      });
      expect(existsSync(destination)).toBe(false);
    }
    const badName = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => join(root, "backup:stream.json"),
      ),
    );
    await expect(badName).rejects.toMatchObject({
      code: "INVALID_DESTINATION",
    });
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => "\\\\?\\C:\\backup.json",
      ),
    );
    await expect(promise).rejects.toMatchObject({
      code: "RESERVED_WINDOWS_PREFIX",
    });
  });
});

// Contract-only untrusted-test port for the Windows artifact branch; never a
// Windows OS/filesystem simulation claim.
const WIN_TARGET = "C:\\Out\\backup-export.json";

function artifactReceipt(request: WindowsBackupArtifactRequest): WindowsBackupArtifactReceipt {
  return Object.freeze({
    contractVersion: 1,
    profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
    state: "PUBLISHED",
    path: request.path,
    stagingPath: request.stagingPath,
    attemptId: request.attemptId,
    identity: Object.freeze({
      canonicalPath: request.path,
      fileId: "9".repeat(32),
      volumeId: "8".repeat(16),
    }),
    byteLength: request.bytes.byteLength,
    sha256: sha256(Buffer.from(request.bytes)),
    readback: Uint8Array.from(request.bytes),
    stagingDisposition: "RENAMED_TO_FINAL",
    contentFlushed: true,
    namespace: "EXCLUSIVE_NO_REPLACE",
    durability: Object.freeze({
      profile: "WINDOWS_LOCAL_NTFS_FILE_METADATA_FLUSH_V1",
      scope: "PROCESS_CRASH",
    }),
  }) as WindowsBackupArtifactReceipt;
}

type ArtifactOutcome =
  | "publish"
  | "unknown"
  | "exists"
  | "rejected"
  | "throw"
  | "callback-fails";
function fakeArtifactPort(
  outcome: ArtifactOutcome,
  trust: "native-helper" | "untrusted-test" = "untrusted-test",
) {
  const requests: WindowsBackupArtifactRequest[] = [];
  const port: WindowsBackupArtifactPort = {
    contractVersion: 1,
    profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
    platform: "win32",
    trust,
    async publishNew(request) {
      requests.push(request);
      if (outcome === "throw") throw new Error("helper lost");
      if (outcome === "unknown" || outcome === "callback-fails") {
        if (outcome === "callback-fails") {
          try {
            await request.beforePublish(Uint8Array.from(request.bytes));
          } catch {
            // fall through to the preserved UNKNOWN
          }
        }
        return Object.freeze({
          contractVersion: 1,
          profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
          state: "UNKNOWN" as const,
          path: request.path,
          stagingPath: request.stagingPath,
          attemptId: request.attemptId,
          reason: "BACKUP_ARTIFACT_UNCONFIRMED",
          preserve: true as const,
        });
      }
      if (outcome === "exists")
        return Object.freeze({
          contractVersion: 1,
          profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
          state: "EXISTS" as const,
          path: request.path,
          stagingPath: request.stagingPath,
          attemptId: request.attemptId,
          reason: "BACKUP_ARTIFACT_EXISTS",
          preserve: true as const,
        });
      if (outcome === "rejected")
        return Object.freeze({
          contractVersion: 1,
          profile: WINDOWS_BACKUP_ARTIFACT_PROFILE,
          state: "REJECTED" as const,
          path: request.path,
          reason: "BACKUP_ARTIFACT_REJECTED",
          preserve: true as const,
        });
      await request.beforePublish(Uint8Array.from(request.bytes));
      return artifactReceipt(request);
    },
  };
  return { port, requests };
}

function nativeOptions(
  download: () => Promise<BackupDownload>,
  outcome: ArtifactOutcome = "publish",
  extra: Record<string, unknown> = {},
) {
  const { port, requests } = fakeArtifactPort(outcome);
  return {
    options: {
      download,
      pick: async () => WIN_TARGET,
      isAuthorized: () => true,
      forbiddenRoots: ["C:\\Private\\data"],
      nativeBackup: port,
      revalidateSource: async () => {},
      ...extra,
    },
    requests,
    port,
  };
}

describe("exportSharedBackup windows artifact port (untrusted-test seam)", () => {
  it("exports canonical bytes through the artifact port and revalidates once", async () => {
    const value = fixture();
    let revalidated = 0;
    const { options, requests } = nativeOptions(async () => value.download, "publish", {
      revalidateSource: async (backup: Readonly<BackupDownload>) => {
        revalidated++;
        expect(backup.raw).toBe(value.raw);
        expect(canonical(backup.head)).toBe(canonical(value.head));
        expect(backup.hash).toBe(value.hash);
      },
    });
    const result = await exportSharedBackup(options);
    expect(result).toEqual({
      state: "EXPORTED",
      path: WIN_TARGET,
      head: value.head,
      hash: value.hash,
    });
    expect(revalidated).toBe(1);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.path).toBe(WIN_TARGET);
    expect(request.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(request.stagingPath).toBe(`C:\\Out\\.folio-backup-${request.attemptId}.tmp`);
    expect(Buffer.from(request.bytes).toString("utf8")).toBe(value.raw);
    expect(request.source.hash).toBe(value.hash);
    expect(canonical(request.source.head)).toBe(canonical(value.head));
    expect(request.forbiddenRoots).toEqual(["C:\\Private\\data"]);
  });

  it("maps a port UNKNOWN to an UNKNOWN export result", async () => {
    const value = fixture();
    const { options } = nativeOptions(async () => value.download, "unknown");
    const result = await exportSharedBackup(options);
    expect(result).toEqual({
      state: "UNKNOWN",
      path: WIN_TARGET,
      head: value.head,
      hash: value.hash,
    });
  });

  it("fails FILE_EXISTS when the native commit reports a collision", async () => {
    const value = fixture();
    const { options } = nativeOptions(async () => value.download, "exists");
    await expect(exportSharedBackup(options)).rejects.toMatchObject({
      code: "FILE_EXISTS",
    });
  });

  it("fails closed when the port rejects", async () => {
    const value = fixture();
    const { options } = nativeOptions(async () => value.download, "rejected");
    await expect(exportSharedBackup(options)).rejects.toMatchObject({
      code: "NATIVE_EXPORT_REJECTED",
    });
  });

  it("maps a throwing port to UNKNOWN", async () => {
    const value = fixture();
    const { options } = nativeOptions(async () => value.download, "throw");
    const result = await exportSharedBackup(options);
    expect(result.state).toBe("UNKNOWN");
  });

  it("maps a failing revalidateSource callback to UNKNOWN", async () => {
    const value = fixture();
    const { options } = nativeOptions(async () => value.download, "callback-fails", {
      revalidateSource: async () => {
        throw new Error("stale head");
      },
    });
    const result = await exportSharedBackup(options);
    expect(result.state).toBe("UNKNOWN");
  });

  it("maps authorization revoked inside the callback to UNKNOWN", async () => {
    const value = fixture();
    let authorized = true;
    const { options } = nativeOptions(async () => value.download, "callback-fails", {
      isAuthorized: () => authorized,
      revalidateSource: async () => {
        authorized = false;
      },
    });
    const result = await exportSharedBackup(options);
    expect(result.state).toBe("UNKNOWN");
  });

  it("requires revalidateSource when a native port is present", async () => {
    const value = fixture();
    const { options } = nativeOptions(async () => value.download);
    delete (options as Record<string, unknown>).revalidateSource;
    await expect(exportSharedBackup(options)).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
    });
  });

  it("rejects a port claiming native-helper trust off Windows", async () => {
    const value = fixture();
    if (process.platform === "win32") return;
    const { options } = nativeOptions(async () => value.download);
    const helper = fakeArtifactPort("publish", "native-helper");
    (options as Record<string, unknown>).nativeBackup = helper.port;
    await expect(exportSharedBackup(options)).rejects.toMatchObject({
      code: "INVALID_NATIVE_PORT",
    });
  });

  it("fails closed without a port on Windows (simulated platform)", async () => {
    if (process.platform === "win32") return;
    Object.defineProperty(process, "platform", { ...originalPlatformDescriptor, value: "win32" });
    const value = fixture();
    const promise = exportSharedBackup(
      legalOptions(
        async () => value.download,
        async () => WIN_TARGET,
      ),
    );
    await expect(promise).rejects.toMatchObject({
      code: "WINDOWS_EXPORT_UNSUPPORTED",
    });
  });

  it("rejects an untrusted-test port on real Windows (simulated platform)", async () => {
    if (process.platform === "win32") return;
    Object.defineProperty(process, "platform", { ...originalPlatformDescriptor, value: "win32" });
    const value = fixture();
    const { options } = nativeOptions(async () => value.download);
    await expect(exportSharedBackup(options)).rejects.toMatchObject({
      code: "INVALID_NATIVE_PORT",
    });
  });
});
