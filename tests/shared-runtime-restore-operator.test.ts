import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import type { RuntimeBackup } from "../src/collaboration/runtime/backup";
import { canonical } from "../src/collaboration/runtime/canonical";
import { runRestoreOperator } from "../src/collaboration/runtime/restore-operator";
import { runSharedServer } from "../src/collaboration/runtime/server-entry";
import {
  RuntimeStore,
  SHARED_RUNTIME_FILE,
} from "../src/collaboration/runtime/store";
import { durableFs } from "../src/persistence/durable-file";

type Credentials = { token: string; recoveryKey: string };

type Fixture = {
  base: string;
  root: string;
  credentialsPath: string;
  credentials: Credentials;
  backupPath: string;
  backup: RuntimeBackup;
};

type Overrides = Partial<{
  root: string;
  org: string;
  tokenFile: string;
  backup: string;
  destination: string;
  epoch: string;
  device: string;
  credentialsOutput: string;
}>;

const created: string[] = [];

function temporaryDirectory(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-restore-operator-")),
  );
  chmodSync(directory, 0o700);
  created.push(directory);
  return directory;
}

async function fixture(): Promise<Fixture> {
  const base = temporaryDirectory();
  const root = join(base, "authority");
  const credentialsPath = join(base, "credentials.json");
  const handle = await runSharedServer([
    "bootstrap",
    "--root",
    root,
    "--org",
    "org-restore",
    "--user",
    "user-restore",
    "--device",
    "device-restore",
    "--workspace",
    "workspace-restore",
    "--document",
    "document-restore",
    "--credentials-output",
    credentialsPath,
  ]);
  await handle.close();
  const credentials = JSON.parse(
    readFileSync(credentialsPath, "utf8"),
  ) as Credentials;
  const authority = new SharedAuthority(root);
  const backup = authority.backup(credentials.token, "org-restore");
  authority.close();
  const backupPath = join(base, "backup.json");
  writeFileSync(backupPath, canonical(backup), { mode: 0o600 });
  return { base, root, credentialsPath, credentials, backupPath, backup };
}

function restoreArgs(f: Fixture, overrides: Overrides = {}): string[] {
  return [
    "--root",
    overrides.root ?? f.root,
    "--org",
    overrides.org ?? "org-restore",
    "--token-file",
    overrides.tokenFile ?? f.credentialsPath,
    "--backup",
    overrides.backup ?? f.backupPath,
    "--destination",
    overrides.destination ?? join(f.base, "destination"),
    "--epoch",
    overrides.epoch ?? "epoch_restored",
    "--device",
    overrides.device ?? "device-restored",
    "--credentials-output",
    overrides.credentialsOutput ?? join(f.base, "restored-credentials.json"),
  ];
}

function codeOf(work: () => unknown): string | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : undefined;
  }
}

describe("shared runtime restore operator", () => {
  afterEach(() => {
    for (const directory of created.splice(0)) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Cleanup must not mask the assertion that failed.
      }
    }
    vi.restoreAllMocks();
  });

  it("restores a canonical backup into a new realm and writes fresh credentials", async () => {
    const f = await fixture();
    const destination = join(f.base, "destination");
    const output = join(f.base, "restored-credentials.json");

    const handle = await runSharedServer(["restore", ...restoreArgs(f)]);
    expect(handle.state).toBe("restored");
    await handle.close();

    expect(lstatSync(destination).mode & 0o777).toBe(0o700);
    expect(lstatSync(output).mode & 0o777).toBe(0o600);
    const restored = JSON.parse(readFileSync(output, "utf8")) as Credentials;
    expect(Object.keys(restored).sort()).toEqual(["recoveryKey", "token"]);
    expect(restored.token).not.toBe(f.credentials.token);
    expect(restored.recoveryKey).not.toBe(f.credentials.recoveryKey);

    const reopened = new SharedAuthority(destination);
    try {
      expect(reopened.head()).toMatchObject({
        epoch: "epoch_restored",
        seq: 0,
      });
      expect(() => reopened.verify()).not.toThrow();
      const session = reopened.session(restored.token, "org-restore");
      expect(session.userId).toBe("user-restore");
      expect(session.deviceId).toBe("device-restored");
      const workspaces = reopened.workspaces(restored.token, "org-restore");
      expect(
        workspaces.some(
          (workspace) => workspace.workspaceId === "workspace-restore",
        ),
      ).toBe(true);
      expect(
        codeOf(() => reopened.session(f.credentials.token, "org-restore")),
      ).toBe("TOKEN_INVALID");
      const recovered = reopened.recover(
        "org-restore",
        restored.recoveryKey,
        "device-second",
      );
      expect(recovered.auth.userId).toBe("user-restore");
      expect(() => reopened.verify()).not.toThrow();
      expect(
        codeOf(() =>
          reopened.recover(
            "org-restore",
            f.credentials.recoveryKey,
            "device-third",
          ),
        ),
      ).toBe("RECOVERY_INVALID");
    } finally {
      reopened.close();
    }

    const source = new SharedAuthority(f.root);
    try {
      expect(() => source.verify()).not.toThrow();
      expect(source.head().epoch).not.toBe("epoch_restored");
      expect(source.session(f.credentials.token, "org-restore").userId).toBe(
        "user-restore",
      );
    } finally {
      source.close();
    }
  });

  it("accepts a token file without the optional recovery key", async () => {
    const f = await fixture();
    const tokenOnly = join(f.base, "token-only.json");
    writeFileSync(tokenOnly, JSON.stringify({ token: f.credentials.token }), {
      mode: 0o600,
    });
    const handle = await runRestoreOperator(
      restoreArgs(f, { tokenFile: tokenOnly }),
    );
    expect(handle.state).toBe("restored");
    await handle.close();
  });

  it("rejects malformed, repeated, positional, URL and token/key arguments", async () => {
    const f = await fixture();
    const destination = join(f.base, "destination");
    const cases: string[][] = [
      [],
      [...restoreArgs(f), "positional"],
      [...restoreArgs(f), "--unknown", "value"],
      [...restoreArgs(f), "--org", "org-other"],
      [...restoreArgs(f), "--token", "secret"],
      restoreArgs(f).slice(0, -2),
      restoreArgs(f, { backup: "https://example.invalid/backup.json" }),
      restoreArgs(f, { destination: "relative-destination" }),
    ];
    for (const args of cases) {
      await expect(runRestoreOperator(args)).rejects.toThrow(
        "INVALID_ARGUMENT",
      );
    }
    expect(existsSync(destination)).toBe(false);
  });

  it("never creates an absent source authority", async () => {
    const f = await fixture();
    const missing = join(f.base, "missing-authority");
    await expect(
      runRestoreOperator(restoreArgs(f, { root: missing })),
    ).rejects.toThrow("ROOT_MISSING");
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects an empty private source root without creating the runtime database", async () => {
    const f = await fixture();
    const empty = join(f.base, "empty-authority");
    mkdirSync(empty, { mode: 0o700 });
    chmodSync(empty, 0o700);
    await expect(
      runRestoreOperator(restoreArgs(f, { root: empty })),
    ).rejects.toThrow("NOT_BOOTSTRAPPED");
    expect(existsSync(join(empty, SHARED_RUNTIME_FILE))).toBe(false);
  });

  it("rejects a foreign SQLite file and a non-authority role before opening", async () => {
    const f = await fixture();
    const foreign = join(f.base, "foreign-authority");
    mkdirSync(foreign, { mode: 0o700 });
    chmodSync(foreign, 0o700);
    writeFileSync(join(foreign, SHARED_RUNTIME_FILE), "not sqlite", {
      mode: 0o600,
    });
    await expect(
      runRestoreOperator(restoreArgs(f, { root: foreign })),
    ).rejects.toThrow("NOT_SHARED_RUNTIME_FORMAT");

    const client = join(f.base, "client-authority");
    const store = new RuntimeStore(client);
    try {
      store.transaction(() => store.set("meta", "role", "client"));
    } finally {
      store.close();
    }
    chmodSync(client, 0o700);
    await expect(
      runRestoreOperator(restoreArgs(f, { root: client })),
    ).rejects.toThrow("WRONG_STORE_ROLE");
  });

  it("rejects an existing destination even when it is empty", async () => {
    const f = await fixture();
    const destination = join(f.base, "existing-destination");
    mkdirSync(destination, { mode: 0o700 });
    chmodSync(destination, 0o700);
    writeFileSync(join(destination, "keep"), "keep", { mode: 0o600 });
    await expect(
      runRestoreOperator(restoreArgs(f, { destination })),
    ).rejects.toThrow("DESTINATION_EXISTS");
    expect(readFileSync(join(destination, "keep"), "utf8")).toBe("keep");
  });

  it("rejects an existing credentials output before creating the destination", async () => {
    const f = await fixture();
    const destination = join(f.base, "destination");
    const output = join(f.base, "existing-credentials.json");
    writeFileSync(output, "keep", { mode: 0o600 });
    await expect(
      runRestoreOperator(restoreArgs(f, { credentialsOutput: output })),
    ).rejects.toThrow("CREDENTIALS_EXIST");
    expect(readFileSync(output, "utf8")).toBe("keep");
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects destination and credentials aliases inside the source or destination", async () => {
    const f = await fixture();
    const destination = join(f.base, "destination");
    await expect(
      runRestoreOperator(
        restoreArgs(f, { destination: join(f.root, "nested-destination") }),
      ),
    ).rejects.toThrow("DESTINATION_INSIDE_ROOT");
    await expect(
      runRestoreOperator(
        restoreArgs(f, {
          credentialsOutput: join(f.root, "inside-source.json"),
        }),
      ),
    ).rejects.toThrow("CREDENTIALS_INSIDE_ROOT");
    await expect(
      runRestoreOperator(
        restoreArgs(f, {
          credentialsOutput: join(destination, "inside-destination.json"),
        }),
      ),
    ).rejects.toThrow("CREDENTIALS_INSIDE_DESTINATION");
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects symlinked, mis-moded and structurally loose token files", async () => {
    const f = await fixture();
    const linked = join(f.base, "linked-token.json");
    symlinkSync(f.credentialsPath, linked);
    await expect(
      runRestoreOperator(restoreArgs(f, { tokenFile: linked })),
    ).rejects.toThrow("INVALID_TOKEN_FILE");

    const loose = join(f.base, "loose-token.json");
    writeFileSync(
      loose,
      JSON.stringify({
        token: f.credentials.token,
        recoveryKey: f.credentials.recoveryKey,
        extra: true,
      }),
      { mode: 0o600 },
    );
    await expect(
      runRestoreOperator(restoreArgs(f, { tokenFile: loose })),
    ).rejects.toThrow("INVALID_TOKEN_FILE");

    const publicMode = join(f.base, "public-token.json");
    writeFileSync(publicMode, JSON.stringify({ token: f.credentials.token }), {
      mode: 0o644,
    });
    chmodSync(publicMode, 0o644);
    await expect(
      runRestoreOperator(restoreArgs(f, { tokenFile: publicMode })),
    ).rejects.toThrow("INVALID_TOKEN_FILE");

    const missingToken = join(f.base, "missing-token.json");
    writeFileSync(
      missingToken,
      JSON.stringify({ recoveryKey: f.credentials.recoveryKey }),
      { mode: 0o600 },
    );
    await expect(
      runRestoreOperator(restoreArgs(f, { tokenFile: missingToken })),
    ).rejects.toThrow("INVALID_TOKEN_FILE");
  });

  it("rejects non-canonical, tampered and symlinked backup files", async () => {
    const f = await fixture();
    const pretty = join(f.base, "pretty-backup.json");
    writeFileSync(pretty, JSON.stringify(f.backup, null, 2), { mode: 0o600 });
    await expect(
      runRestoreOperator(restoreArgs(f, { backup: pretty })),
    ).rejects.toThrow("INVALID_BACKUP_FILE");

    const tampered = join(f.base, "tampered-backup.json");
    writeFileSync(tampered, canonical({ ...f.backup, hash: "0".repeat(64) }), {
      mode: 0o600,
    });
    await expect(
      runRestoreOperator(restoreArgs(f, { backup: tampered })),
    ).rejects.toThrow("BACKUP_HASH_MISMATCH");

    const linked = join(f.base, "linked-backup.json");
    symlinkSync(f.backupPath, linked);
    await expect(
      runRestoreOperator(restoreArgs(f, { backup: linked })),
    ).rejects.toThrow("INVALID_BACKUP_FILE");
  });

  it("rejects a non-fresh epoch and a non-admin organization before creating the destination", async () => {
    const f = await fixture();
    const destination = join(f.base, "destination");
    await expect(
      runRestoreOperator(restoreArgs(f, { epoch: f.backup.head.epoch })),
    ).rejects.toThrow("EPOCH_NOT_FRESH");
    await expect(
      runRestoreOperator(restoreArgs(f, { org: "org-other" })),
    ).rejects.toThrow("AUTH_SCOPE_MISMATCH");
    expect(existsSync(destination)).toBe(false);
  });

  it("removes the credentials file when durability verification fails", async () => {
    const f = await fixture();
    const output = join(f.base, "restored-credentials.json");
    const spy = vi.spyOn(durableFs, "fsyncSync").mockImplementation(() => {
      throw new Error("fsync failed");
    });
    try {
      await expect(runRestoreOperator(restoreArgs(f))).rejects.toThrow(
        "CREDENTIALS_WRITE_FAILED",
      );
      expect(existsSync(output)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("retains the published diagnostic output when post-publication readback differs", async () => {
    const f = await fixture();
    const output = join(f.base, "restored-credentials.json");
    const original = durableFs.writeFileSync;
    const spy = vi.spyOn(durableFs, "writeFileSync").mockImplementation(((
      descriptor: number,
    ) => {
      original(descriptor, "truncated");
    }) as never);
    try {
      await expect(runRestoreOperator(restoreArgs(f))).rejects.toThrow(
        "RESTORE_UNKNOWN",
      );
      expect(readFileSync(output, "utf8")).toBe("truncated");
    } finally {
      spy.mockRestore();
    }
  });
  it("retains live credentials and the new realm after a commit acknowledgement fault", async () => {
    const f = await fixture();
    const destination = join(f.base, "destination");
    const output = join(f.base, "restored-credentials.json");
    const original = RuntimeStore.prototype.transaction;
    let injected = false;
    const spy = vi
      .spyOn(RuntimeStore.prototype, "transaction")
      .mockImplementation(function <T>(this: RuntimeStore, work: () => T): T {
        const outer = !this.db.isTransaction;
        const result = original.call(this, work) as T;
        if (
          outer &&
          !injected &&
          this.path === join(destination, SHARED_RUNTIME_FILE) &&
          this.get("meta", "head") !== null
        ) {
          injected = true;
          throw new Error("UNKNOWN");
        }
        return result;
      });
    try {
      await expect(runRestoreOperator(restoreArgs(f))).rejects.toThrow(
        "RESTORE_UNKNOWN",
      );
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(existsSync(output)).toBe(true);
    const credentials = JSON.parse(readFileSync(output, "utf8")) as Credentials;
    const reopened = new SharedAuthority(destination);
    try {
      expect(reopened.session(credentials.token, "org-restore").userId).toBe(
        "user-restore",
      );
      reopened.verify();
    } finally {
      reopened.close();
    }
  });
});
