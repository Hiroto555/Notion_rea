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
import { afterEach, describe, expect, it } from "vitest";
import { canonical } from "../src/collaboration/runtime/canonical";
import { digest } from "../src/collaboration/runtime/digest";
import { exportSharedBackup } from "../src/main/shared-backup-export";
import type { BackupDownload } from "../src/collaboration/runtime/backup-port";

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-backup-export-")),
  );
  roots.push(root);
  return root;
}

afterEach(() => {
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
