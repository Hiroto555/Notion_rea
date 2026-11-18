import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeStorePlatform } from "../src/platform/runtime-store-platform";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import type { RuntimeBackup } from "../src/collaboration/runtime/backup";
import { canonical } from "../src/collaboration/runtime/canonical";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import { runMaintenanceOperator } from "../src/collaboration/runtime/maintenance-operator";
import {
  type SharedOperatorFilePort,
  type SharedOperatorPorts,
  createSharedOperatorContext,
} from "../src/collaboration/runtime/operator-files";
import { runSharedServer } from "../src/collaboration/runtime/server-entry";
import { runRecoveryOperator } from "../src/collaboration/runtime/recovery-operator";
import { runRestoreOperator } from "../src/collaboration/runtime/restore-operator";
import {
  RuntimeStore,
  SHARED_RUNTIME_FILE,
  type RuntimeStoreOptions,
} from "../src/collaboration/runtime/store";

/**
 * POSIX helpers must never run under the injected native path. These wrappers
 * forward on a real POSIX platform and throw once process.platform reports
 * win32, so any silent fallback inside the operators fails loudly.
 */
vi.mock("../src/sync/m3-private-root", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/sync/m3-private-root")>();
  const guard =
    (name: string) =>
    <F extends (...args: never[]) => unknown>(fn: F): F =>
      ((...args: unknown[]) => {
        if (process.platform === "win32")
          throw new Error(`POSIX ${name} must not run under the native path`);
        return (fn as unknown as (...args: unknown[]) => unknown)(...args);
      }) as unknown as F;
  return {
    ...actual,
    pinPrivateRoot: guard("pinPrivateRoot")(actual.pinPrivateRoot),
    assertPrivateRoot: guard("assertPrivateRoot")(actual.assertPrivateRoot),
    assertSqliteSidecars: guard("assertSqliteSidecars")(
      actual.assertSqliteSidecars,
    ),
  };
});

vi.mock("../src/persistence/durable-file", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/persistence/durable-file")>();
  const guard =
    (name: string) =>
    <F extends (...args: never[]) => unknown>(fn: F): F =>
      ((...args: unknown[]) => {
        if (process.platform === "win32")
          throw new Error(`POSIX ${name} must not run under the native path`);
        return (fn as unknown as (...args: unknown[]) => unknown)(...args);
      }) as unknown as F;
  return {
    ...actual,
    durableFs: {
      openSync: guard("durableFs.openSync")(actual.durableFs.openSync),
      writeFileSync: guard("durableFs.writeFileSync")(
        actual.durableFs.writeFileSync,
      ),
      fsyncSync: guard("durableFs.fsyncSync")(actual.durableFs.fsyncSync),
      closeSync: guard("durableFs.closeSync")(actual.durableFs.closeSync),
      unlinkSync: guard("durableFs.unlinkSync")(actual.durableFs.unlinkSync),
      syncPath: guard("durableFs.syncPath")(actual.durableFs.syncPath),
    },
    syncPath: guard("syncPath")(actual.syncPath),
    writeNewFileDurably: guard("writeNewFileDurably")(
      actual.writeNewFileDurably,
    ),
  };
});

const roots: string[] = [];

function temporaryDirectory(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-operator-native-")),
  );
  chmodSync(directory, 0o700);
  roots.push(directory);
  return directory;
}

const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
) as PropertyDescriptor;

/**
 * Synthetic platform selection for these contract tests only. It flips the
 * process.platform gate the operators branch on; it never claims that this
 * POSIX host proves Windows filesystem or durability semantics.
 */
function useSyntheticWindowsPlatform(): void {
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", platformDescriptor);
}

afterEach(() => {
  restorePlatform();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

type Boot = ReturnType<SharedAuthority["bootstrap"]>;

type Fixture = {
  base: string;
  root: string;
  secrets: string;
  keyFile: string;
  backupFile: string;
  boot: Boot;
  cut: { epoch: string; seq: number; hash: string };
  backup: RuntimeBackup;
};

function fixture(): Fixture {
  const base = temporaryDirectory();
  const root = join(base, "server");
  const secrets = join(base, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  const authority = new SharedAuthority(root);
  const boot = authority.bootstrap({
    orgId: "org",
    userId: "owner",
    deviceId: "original",
    workspaceId: "ws",
    documentId: "page",
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p" },
          content: [{ type: "text", text: "KEEP" }],
        },
      ],
    },
  });
  const cut = authority.head();
  const backup = authority.backup(boot.token, "org");
  authority.close();
  const keyFile = join(secrets, "key.json");
  writeFileSync(
    keyFile,
    JSON.stringify({ token: boot.token, recoveryKey: boot.recoveryKey }),
    { mode: 0o600 },
  );
  const backupFile = join(secrets, "backup.json");
  writeFileSync(backupFile, canonical(backup), { mode: 0o600 });
  return { base, root, secrets, keyFile, backupFile, boot, cut, backup };
}

/**
 * Test-only runtime adapter implementing the platform contract through POSIX
 * lstat checks. It proves call shape, once-bound binding and existence
 * preflight only; it makes no Windows security or durability claim.
 */
class TestStoreAdapter implements RuntimeStorePlatform {
  bound: string | undefined;
  closed = false;
  bindCount = 0;
  bind(directory: string): string {
    if (this.closed) throw new Error("WINDOWS_PLATFORM_CLOSED");
    if (this.bound !== undefined) throw new Error("WINDOWS_ROOT_ALREADY_BOUND");
    let stat;
    try {
      stat = lstatSync(directory);
    } catch {
      throw new Error("WINDOWS_PRIVATE_ROOT_MISSING");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("WINDOWS_PRIVATE_ROOT_UNSAFE");
    this.bound = realpathSync(directory);
    this.bindCount++;
    return this.bound;
  }
  assertRoot(): void {
    if (this.closed || this.bound === undefined)
      throw new Error("WINDOWS_PLATFORM_CLOSED");
    const stat = lstatSync(this.bound);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("WINDOWS_ROOT_IDENTITY_CHANGED");
  }
  assertDatabase(path: string): void {
    if (this.closed || this.bound === undefined)
      throw new Error("WINDOWS_PLATFORM_CLOSED");
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      throw new Error("WINDOWS_DATABASE_MISSING");
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
      throw new Error("WINDOWS_DATABASE_UNSAFE");
  }
  syncCreatedDatabase(path: string): void {
    // Contract only: the created file must be regular; no OS durability claim.
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("WINDOWS_DATABASE_UNSAFE");
  }
  createExclusiveDurably(path: string): void {
    // Injected contract only. Real Windows creation uses the compiled helper.
    this.assertRoot();
    if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
    this.assertDatabase(path);
  }
  assertEmptyFile(path: string): void {
    this.assertDatabase(path);
    if (lstatSync(path).size !== 0) throw new Error("WINDOWS_DATABASE_NOT_EMPTY");
  }
  close(): void {
    this.closed = true;
  }
}

function insidePath(parent: string, candidate: string): boolean {
  if (parent === candidate) return true;
  const rest = relative(parent, candidate);
  return (
    rest !== "" &&
    rest !== ".." &&
    !rest.startsWith(".." + sep) &&
    !isAbsolute(rest)
  );
}

/** Test-only private read: regular file, bounded complete read, no secrets. */
function safePrivateRead(path: string, maxBytes: number): Buffer {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size <= 0 ||
    stat.size > maxBytes
  )
    throw new CollaborationError("INVALID_PRIVATE_FILE");
  return readFileSync(path);
}

function safePrivatePublish(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}

type FileOverrides = Partial<{
  assertDirectory(path: string): string;
  assertNewFile(path: string, forbiddenRoots: readonly string[]): string;
  assertNewDirectory(path: string, forbiddenRoots: readonly string[]): string;
  createDirectory(path: string): void;
  readPrivateFile(path: string, maxBytes: number): Buffer;
  publishNewFile(path: string, bytes: Buffer): void;
}>;

/** POSIX contract implementation of the native port plus vi.fn call spies. */
function nativeFiles(overrides: FileOverrides = {}): SharedOperatorFilePort {
  return {
    kind: "windows",
    assertDirectory: vi.fn(
      overrides.assertDirectory ??
        ((path: string): string => {
          const stat = lstatSync(path);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new CollaborationError("UNSAFE_ROOT");
          return realpathSync(path);
        }),
    ),
    assertNewFile: vi.fn(
      overrides.assertNewFile ??
        ((path: string, forbiddenRoots: readonly string[]): string => {
          const target = resolve(path);
          for (const root of forbiddenRoots)
            if (insidePath(root, target) || insidePath(target, root))
              throw new CollaborationError("FORBIDDEN_TARGET");
          const parent = dirname(target);
          const stat = lstatSync(parent);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new CollaborationError("UNSAFE_CREDENTIALS_PATH");
          if (existsSync(target))
            throw new CollaborationError("CREDENTIALS_EXIST");
          return target;
        }),
    ),
    assertNewDirectory: vi.fn(
      overrides.assertNewDirectory ??
        ((path: string, forbiddenRoots: readonly string[]): string => {
          const target = resolve(path);
          for (const root of forbiddenRoots)
            if (insidePath(root, target) || insidePath(target, root))
              throw new CollaborationError("DESTINATION_INSIDE_ROOT");
          const parent = dirname(target);
          const stat = lstatSync(parent);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new CollaborationError("UNSAFE_DESTINATION_PARENT");
          if (existsSync(target))
            throw new CollaborationError("DESTINATION_EXISTS");
          return target;
        }),
    ),
    createDirectory: vi.fn(
      overrides.createDirectory ??
        ((path: string): void => {
          mkdirSync(path, { mode: 0o700 });
        }),
    ),
    readPrivateFile: vi.fn(overrides.readPrivateFile ?? safePrivateRead),
    publishNewFile: vi.fn(overrides.publishNewFile ?? safePrivatePublish),
  };
}

type FactoryCall = {
  directory: string;
  adapter: TestStoreAdapter;
  options: RuntimeStoreOptions;
};

/** Factory contract: a fresh adapter object and options on every call. */
function nativePorts(
  files: SharedOperatorFilePort,
  shared?: { adapter: TestStoreAdapter },
): { ports: SharedOperatorPorts; calls: FactoryCall[] } {
  const calls: FactoryCall[] = [];
  const ports: SharedOperatorPorts = {
    privateFiles: files,
    runtimeStoreOptions(directory: string): RuntimeStoreOptions {
      const adapter = shared?.adapter ?? new TestStoreAdapter();
      const options: RuntimeStoreOptions = { platformAdapter: adapter };
      calls.push({ directory, adapter, options });
      return options;
    },
  };
  return { ports, calls };
}

/** Opens a real authority on the native path without touching factory counts. */
function verificationAuthority(root: string): SharedAuthority {
  return new SharedAuthority(root, {
    platformAdapter: new TestStoreAdapter(),
  });
}

function recoveryArgs(f: Fixture, output: string, key = f.keyFile): string[] {
  return [
    "--root",
    f.root,
    "--org",
    "org",
    "--recovery-key-file",
    key,
    "--device",
    "replacement",
    "--credentials-output",
    output,
  ];
}

type RestoreOverrides = Partial<{
  root: string;
  org: string;
  tokenFile: string;
  backup: string;
  destination: string;
  epoch: string;
  device: string;
  credentialsOutput: string;
}>;

function restoreArgs(f: Fixture, overrides: RestoreOverrides = {}): string[] {
  return [
    "--root",
    overrides.root ?? f.root,
    "--org",
    overrides.org ?? "org",
    "--token-file",
    overrides.tokenFile ?? f.keyFile,
    "--backup",
    overrides.backup ?? f.backupFile,
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

function maintenanceArgs(
  f: Fixture,
  action: string,
  extra: string[] = [],
): string[] {
  return [
    "--root",
    f.root,
    "--org",
    "org",
    "--token-file",
    f.keyFile,
    "--action",
    action,
    ...extra,
  ];
}

describe("shared operators on the injected native file port", () => {
  it("connects bootstrap and serve through the public server entry without POSIX fallback", async () => {
    const f = fixture(), root = join(f.base, "new-server"), output = join(f.secrets, "new-credentials.json");
    const files = nativeFiles(), { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const created = await runSharedServer(["bootstrap", "--root", root, "--org", "new-org", "--user", "new-owner", "--device", "new-device", "--workspace", "new-workspace", "--document", "new-document", "--credentials-output", output], ports);
    await created.close();
    expect(files.publishNewFile).toHaveBeenCalledOnce();
    const credentials = JSON.parse(readFileSync(output, "utf8")) as {token: string};
    const server = await runSharedServer(["serve", "--root", root, "--host", "127.0.0.1", "--port", "0", "--loopback-http"], ports);
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      const response = await fetch(server.url + "/v1/session", {method: "POST", headers: {authorization: "Bearer " + credentials.token, "content-type": "application/json"}, body: canonical({orgId: "new-org"})});
      expect(response.status).toBe(200);
    } finally { await server.close(); }
  });

  it("forwards the private-file port and fresh-adapter factory through server-entry recovery", async () => {
    const f = fixture(), output = join(f.secrets, "entry-recovered.json");
    const files = nativeFiles(), { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const handle = await runSharedServer(["recover", ...recoveryArgs(f, output)], ports);
    try { expect(handle.state).toBe("recovered"); expect(files.publishNewFile).toHaveBeenCalledOnce(); }
    finally { await handle.close(); }
  });

  it("rejects known asynchronous publication and factory capabilities before private I/O", () => {
    const files = nativeFiles(), { ports } = nativePorts(files);
    files.publishNewFile = async () => undefined;
    expect(() => createSharedOperatorContext(ports, "UNSUPPORTED")).toThrow("SYNCHRONOUS_PORT_UNSUPPORTED");
    expect(files.assertDirectory).not.toHaveBeenCalled();
    const second = nativeFiles();
    const factory = async () => ({platformAdapter: new TestStoreAdapter()});
    expect(() => createSharedOperatorContext({ privateFiles: second, runtimeStoreOptions: factory as unknown as SharedOperatorPorts["runtimeStoreOptions"] }, "UNSUPPORTED")).toThrow("SYNCHRONOUS_PORT_UNSUPPORTED");
    expect(second.assertDirectory).not.toHaveBeenCalled();
  });

  it("does not commit recovery when a visible publication returns deferred durability", async () => {
    const f = fixture(), output = join(f.secrets, "deferred.json");
    const files = nativeFiles({ publishNewFile(path, bytes) { safePrivatePublish(path, bytes); return Promise.resolve() as unknown as void; } });
    const { ports } = nativePorts(files); useSyntheticWindowsPlatform();
    await expect(runRecoveryOperator(recoveryArgs(f, output), ports)).rejects.toThrow("RECOVERY_UNKNOWN");
    expect(existsSync(output)).toBe(true);
    const authority = verificationAuthority(f.root);
    try { expect(() => authority.recoveryStatus(f.boot.token, "org")).not.toThrow(); }
    finally { authority.close(); }
  });

  it("recovers through native port proofs, bounded reads and fresh adapters", async () => {
    const f = fixture();
    const sequence: string[] = [];
    const files = nativeFiles({
      readPrivateFile: (path, maxBytes) => {
        sequence.push(`read:${maxBytes}`);
        return safePrivateRead(path, maxBytes);
      },
    });
    const { ports, calls } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const output = join(f.secrets, "recovered.json");
    const handle = await runRecoveryOperator(recoveryArgs(f, output), ports, {
      beforeCommit: () => sequence.push("beforeCommit"),
      afterCommit: () => sequence.push("afterCommit"),
    });
    try {
      expect(handle.state).toBe("recovered");
      expect(Object.keys(handle)).toEqual(["state", "close"]);
      // Two source factory calls: existence-guarded probe plus authority reopen.
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        expect(call.directory).toBe(f.root);
        expect(call.adapter.bindCount).toBe(1);
      }
      expect(calls[0].adapter).not.toBe(calls[1].adapter);
      const newFileCalls = vi.mocked(files.assertNewFile).mock.calls;
      expect(newFileCalls.length).toBeGreaterThanOrEqual(2);
      expect(newFileCalls[0]).toEqual([resolve(output), [f.root]]);
      const publishCalls = vi.mocked(files.publishNewFile).mock.calls;
      expect(publishCalls).toHaveLength(1);
      expect(publishCalls[0][0]).toBe(resolve(output));
      const published = publishCalls[0][1];
      expect(Buffer.isBuffer(published)).toBe(true);
      expect(published.toString("utf8")).toBe(readFileSync(output, "utf8"));
      expect(sequence).toEqual([
        "read:8192", // recovery key file
        "read:8192", // published proof inside the transaction
        "beforeCommit",
        "read:8192", // pre-commit proof
        "afterCommit",
        "read:8192", // post-commit proof
      ]);
      const issued = JSON.parse(readFileSync(output, "utf8")) as {
        token: string;
        recoveryKey: string;
      };
      expect(issued.token).not.toBe(f.boot.token);
      expect(issued.recoveryKey).not.toBe(f.boot.recoveryKey);
      const reopened = verificationAuthority(f.root);
      try {
        expect(reopened.session(issued.token, "org")).toMatchObject({
          userId: "owner",
          deviceId: "replacement",
        });
        expect(() => reopened.session(f.boot.token, "org")).toThrow();
        expect(
          reopened.snapshot(issued.token, f.boot.scope).state.document
            .content?.[0].content?.[0].text,
        ).toBe("KEEP");
        reopened.verify();
      } finally {
        reopened.close();
      }
    } finally {
      await handle.close();
      await handle.close();
    }
    for (const call of calls) expect(call.adapter.closed).toBe(true);
  });

  it("restores a canonical backup through the native port into a new realm", async () => {
    const f = fixture();
    const files = nativeFiles();
    const { ports, calls } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const destination = join(f.base, "destination");
    const output = join(f.base, "restored-credentials.json");
    const handle = await runRestoreOperator(
      restoreArgs(f, { destination, credentialsOutput: output }),
      ports,
    );
    try {
      expect(handle.state).toBe("restored");
      // Probe + authority on the source, plus one destination adapter.
      expect(calls).toHaveLength(3);
      expect(calls[0].directory).toBe(f.root);
      expect(calls[1].directory).toBe(f.root);
      expect(calls[2].directory).toBe(resolve(destination));
      expect(calls[2].adapter).not.toBe(calls[0].adapter);
      for (const call of calls) expect(call.adapter.bindCount).toBe(1);
      const reads = vi.mocked(files.readPrivateFile).mock.calls;
      expect(
        reads.some(([path, max]) => path === f.keyFile && max === 8192),
      ).toBe(true);
      expect(
        reads.some(
          ([path, max]) => path === f.backupFile && max === 268435456,
        ),
      ).toBe(true);
      expect(vi.mocked(files.assertNewDirectory).mock.calls[0]).toEqual([
        resolve(destination),
        [f.root],
      ]);
      expect(vi.mocked(files.assertNewFile).mock.calls[0]).toEqual([
        resolve(output),
        [f.root, resolve(destination)],
      ]);
      const credentials = JSON.parse(readFileSync(output, "utf8")) as {
        token: string;
        recoveryKey: string;
      };
      expect(credentials.token).not.toBe(f.boot.token);
      const restored = verificationAuthority(destination);
      try {
        expect(restored.head()).toMatchObject({
          epoch: "epoch_restored",
          seq: 0,
        });
        const authorization = restored.store.get(
          "meta",
          "restore-authorization",
        ) as Record<string, unknown>;
        expect(authorization.completedRecovery).toBe(true);
        expect(authorization.operatorUserId).toBe("owner");
        expect(restored.session(credentials.token, "org").userId).toBe(
          "owner",
        );
        expect(() => restored.session(f.boot.token, "org")).toThrow();
        restored.verify();
      } finally {
        restored.close();
      }
    } finally {
      await handle.close();
    }
    for (const call of calls) expect(call.adapter.closed).toBe(true);
  });

  it("previews and verifies a canonical backup through the native port", async () => {
    const f = fixture();
    const files = nativeFiles();
    const { ports, calls } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const preview = await runMaintenanceOperator(
      maintenanceArgs(f, "preview"),
      ports,
    );
    try {
      expect(preview.state).toBe("maintained");
      const result = preview.result as {
        cut: { seq: number; hash: string };
        overview: { documents: number };
      };
      expect(result.cut.seq).toBeGreaterThan(0);
      expect(result.cut.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(result.overview.documents).toBe(1);
    } finally {
      await preview.close();
    }
    // Preview uses only the two source opens; no destination adapter.
    expect(calls).toHaveLength(2);
    calls.length = 0;

    const destination = join(f.base, "verify-destination");
    const verify = await runMaintenanceOperator(
      maintenanceArgs(f, "verify", [
        "--destination",
        destination,
        "--epoch",
        "epoch_verify",
        "--backup",
        f.backupFile,
      ]),
      ports,
    );
    try {
      expect(verify.state).toBe("maintained");
      const proof = verify.result as {
        v: number;
        backupHash: string;
        restoreEpoch: string;
        cut: { seq: number };
      };
      expect(proof.v).toBe(1);
      expect(proof.backupHash).toBe(f.backup.hash);
      expect(proof.restoreEpoch).toBe("epoch_verify");
      expect(proof.cut.seq).toBeGreaterThan(0);
      expect(calls).toHaveLength(3);
      expect(calls[2].directory).toBe(resolve(destination));
      const reads = vi.mocked(files.readPrivateFile).mock.calls;
      expect(
        reads.some(([path, max]) => path === f.keyFile && max === 8192),
      ).toBe(true);
      expect(
        reads.some(
          ([path, max]) => path === f.backupFile && max === 268435456,
        ),
      ).toBe(true);
    } finally {
      await verify.close();
    }
  });

  it("rejects missing or malformed native ports before any private file I/O", async () => {
    const f = fixture();
    useSyntheticWindowsPlatform();
    const output = join(f.secrets, "recovered.json");
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), {}),
    ).rejects.toThrow("WINDOWS_RECOVERY_OPERATOR_UNSUPPORTED");
    await expect(
      runMaintenanceOperator(maintenanceArgs(f, "preview"), {}),
    ).rejects.toThrow("WINDOWS_MAINTENANCE_OPERATOR_UNSUPPORTED");
    await expect(
      runMaintenanceOperator(maintenanceArgs(f, "preview"), {
        platformAdapter: new TestStoreAdapter(),
      }),
    ).rejects.toThrow("WINDOWS_MAINTENANCE_OPERATOR_UNSUPPORTED");

    const files = nativeFiles();
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), { privateFiles: files }),
    ).rejects.toThrow("WINDOWS_RECOVERY_OPERATOR_UNSUPPORTED");
    expect(vi.mocked(files.assertDirectory)).not.toHaveBeenCalled();
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), {
        privateFiles: { kind: "windows" } as unknown as SharedOperatorFilePort,
        runtimeStoreOptions: () => ({}),
      }),
    ).rejects.toThrow("WINDOWS_RECOVERY_OPERATOR_UNSUPPORTED");
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), {
        privateFiles: files,
        runtimeStoreOptions: () => ({}),
      }),
    ).rejects.toThrow("WINDOWS_RECOVERY_OPERATOR_UNSUPPORTED");
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), {
        privateFiles: files,
        runtimeStoreOptions: () => ({
          platformAdapter: {} as RuntimeStorePlatform,
        }),
      }),
    ).rejects.toThrow("WINDOWS_RECOVERY_OPERATOR_UNSUPPORTED");
    expect(vi.mocked(files.assertDirectory)).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  it("lets an explicit windows port select the native branch on POSIX first", async () => {
    const f = fixture();
    // The real platform stays POSIX: the explicit kind must reach the port
    // before any OS mismatch could be reported.
    const files = nativeFiles({
      assertDirectory: () => {
        throw new CollaborationError("SENTINEL_DIRECTORY");
      },
    });
    const { ports } = nativePorts(files);
    await expect(
      runRecoveryOperator(
        recoveryArgs(f, join(f.secrets, "recovered.json")),
        ports,
      ),
    ).rejects.toThrow("SENTINEL_DIRECTORY");
    expect(vi.mocked(files.assertDirectory)).toHaveBeenCalled();
  });

  it("rejects existing and forbidden targets without mutating the source", async () => {
    const f = fixture();
    const files = nativeFiles();
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const output = join(f.secrets, "existing.json");
    writeFileSync(output, "DO NOT TOUCH", { mode: 0o600 });
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), ports),
    ).rejects.toThrow("CREDENTIALS_EXIST");
    expect(readFileSync(output, "utf8")).toBe("DO NOT TOUCH");

    const existingDestination = join(f.base, "existing-destination");
    mkdirSync(existingDestination, { mode: 0o700 });
    await expect(
      runRestoreOperator(
        restoreArgs(f, { destination: existingDestination }),
        ports,
      ),
    ).rejects.toThrow("DESTINATION_EXISTS");

    const freshDestination = join(f.base, "fresh-destination");
    const existingCredentials = join(f.base, "existing-credentials.json");
    writeFileSync(existingCredentials, "DO NOT TOUCH", { mode: 0o600 });
    await expect(
      runRestoreOperator(
        restoreArgs(f, {
          destination: freshDestination,
          credentialsOutput: existingCredentials,
        }),
        ports,
      ),
    ).rejects.toThrow("CREDENTIALS_EXIST");
    expect(readFileSync(existingCredentials, "utf8")).toBe("DO NOT TOUCH");
    expect(existsSync(freshDestination)).toBe(false);

    await expect(
      runRestoreOperator(
        restoreArgs(f, { destination: join(f.root, "nested") }),
        ports,
      ),
    ).rejects.toThrow("DESTINATION_INSIDE_ROOT");
    await expect(
      runRestoreOperator(
        restoreArgs(f, {
          destination: freshDestination,
          credentialsOutput: join(f.root, "inside.json"),
        }),
        ports,
      ),
    ).rejects.toThrow("FORBIDDEN_TARGET");
    await expect(
      runRestoreOperator(
        restoreArgs(f, {
          destination: freshDestination,
          credentialsOutput: join(freshDestination, "inside.json"),
        }),
        ports,
      ),
    ).rejects.toThrow("FORBIDDEN_TARGET");
    expect(existsSync(freshDestination)).toBe(false);

    const reopened = verificationAuthority(f.root);
    try {
      expect(reopened.head()).toEqual(f.cut);
      expect(reopened.session(f.boot.token, "org").userId).toBe("owner");
    } finally {
      reopened.close();
    }
  });

  it("reports RECOVERY_UNKNOWN and retains bytes when publication fails after writing", async () => {
    const f = fixture();
    const files = nativeFiles({
      publishNewFile: (path, bytes) => {
        safePrivatePublish(path, bytes);
        throw new Error("publication failed");
      },
    });
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const output = join(f.secrets, "recovered.json");
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), ports),
    ).rejects.toThrow("RECOVERY_UNKNOWN");
    expect(existsSync(output)).toBe(true);
    const reopened = verificationAuthority(f.root);
    try {
      // The transaction rolled back: the old session remains valid.
      expect(reopened.head()).toEqual(f.cut);
      expect(reopened.session(f.boot.token, "org").userId).toBe("owner");
    } finally {
      reopened.close();
    }
  });

  it("keeps published credentials but reports RECOVERY_UNKNOWN on beforeCommit failure", async () => {
    const f = fixture();
    const files = nativeFiles();
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const output = join(f.secrets, "recovered.json");
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), ports, {
        beforeCommit() {
          throw new Error("stop before commit");
        },
      }),
    ).rejects.toThrow("RECOVERY_UNKNOWN");
    expect(existsSync(output)).toBe(true);
    const issued = JSON.parse(readFileSync(output, "utf8")) as {
      token: string;
    };
    const reopened = verificationAuthority(f.root);
    try {
      expect(reopened.head()).toEqual(f.cut);
      expect(reopened.session(f.boot.token, "org").userId).toBe("owner");
      expect(() => reopened.session(issued.token, "org")).toThrow();
    } finally {
      reopened.close();
    }
  });

  it("keeps newly valid secrets when the commit acknowledgement is lost", async () => {
    const f = fixture();
    const files = nativeFiles();
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const output = join(f.secrets, "recovered.json");
    await expect(
      runRecoveryOperator(recoveryArgs(f, output), ports, {
        afterCommit() {
          throw new Error("lost acknowledgement");
        },
      }),
    ).rejects.toThrow("RECOVERY_UNKNOWN");
    const issued = JSON.parse(readFileSync(output, "utf8")) as {
      token: string;
    };
    const reopened = verificationAuthority(f.root);
    try {
      expect(reopened.head().seq).toBe(f.cut.seq + 1);
      expect(reopened.session(issued.token, "org").userId).toBe("owner");
      expect(() => reopened.session(f.boot.token, "org")).toThrow();
      reopened.verify();
    } finally {
      reopened.close();
    }
  });

  it.each([1, 2, 3])(
    "maps output proof-read failure %i to RECOVERY_UNKNOWN",
    async (failureIndex) => {
      const f = fixture();
      const output = join(f.secrets, "recovered.json");
      let outputReads = 0;
      const files = nativeFiles({
        readPrivateFile: (path, maxBytes) => {
          if (path === resolve(output)) {
            outputReads++;
            if (outputReads === failureIndex)
              throw new Error(`proof read ${failureIndex} failed`);
          }
          return safePrivateRead(path, maxBytes);
        },
      });
      const { ports } = nativePorts(files);
      useSyntheticWindowsPlatform();
      await expect(
        runRecoveryOperator(recoveryArgs(f, output), ports),
      ).rejects.toThrow("RECOVERY_UNKNOWN");
      expect(existsSync(output)).toBe(true);
      const issued = JSON.parse(readFileSync(output, "utf8")) as {
        token: string;
      };
      const reopened = verificationAuthority(f.root);
      try {
        if (failureIndex <= 2) {
          // Rolled back: old token valid, published token dead.
          expect(reopened.head()).toEqual(f.cut);
          expect(reopened.session(f.boot.token, "org").userId).toBe("owner");
          expect(() => reopened.session(issued.token, "org")).toThrow();
        } else {
          // Committed: new token valid, old token revoked.
          expect(reopened.head().seq).toBe(f.cut.seq + 1);
          expect(reopened.session(issued.token, "org").userId).toBe("owner");
          expect(() => reopened.session(f.boot.token, "org")).toThrow();
          reopened.verify();
        }
      } finally {
        reopened.close();
      }
    },
  );

  it("reports RESTORE_UNKNOWN and retains bytes when publication fails after writing", async () => {
    const f = fixture();
    const destination = join(f.base, "destination");
    const output = join(f.base, "restored-credentials.json");
    const files = nativeFiles({
      publishNewFile: (path, bytes) => {
        safePrivatePublish(path, bytes);
        throw new Error("publication failed");
      },
    });
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    await expect(
      runRestoreOperator(
        restoreArgs(f, { destination, credentialsOutput: output }),
        ports,
      ),
    ).rejects.toThrow("RESTORE_UNKNOWN");
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(output)).toBe(true);
    const issued = JSON.parse(readFileSync(output, "utf8")) as {
      token: string;
      recoveryKey: string;
    };
    expect(issued.token).toBeTruthy();
    expect(issued.recoveryKey).toBeTruthy();
    const source = verificationAuthority(f.root);
    try {
      expect(source.head()).toEqual(f.cut);
      expect(source.session(f.boot.token, "org").userId).toBe("owner");
    } finally {
      source.close();
    }
    // The rolled-back realm stays uninitialized: read the store directly
    // because SharedAuthority would initialize meta/role on open.
    const rolledBack = new RuntimeStore(destination, {
      platformAdapter: new TestStoreAdapter(),
    });
    try {
      expect(rolledBack.get("meta", "role")).toBeNull();
    } finally {
      rolledBack.close();
    }
  });

  it("maps a post-COMMIT proof failure to RESTORE_UNKNOWN and retains the realm", async () => {
    const f = fixture();
    const destination = join(f.base, "destination");
    const output = join(f.base, "restored-credentials.json");
    let outputReads = 0;
    const files = nativeFiles({
      readPrivateFile: (path, maxBytes) => {
        if (path === resolve(output)) {
          outputReads++;
          if (outputReads > 1) throw new Error("post-commit proof failed");
        }
        return safePrivateRead(path, maxBytes);
      },
    });
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    await expect(
      runRestoreOperator(
        restoreArgs(f, { destination, credentialsOutput: output }),
        ports,
      ),
    ).rejects.toThrow("RESTORE_UNKNOWN");
    expect(existsSync(destination)).toBe(true);
    expect(existsSync(output)).toBe(true);
  });

  it("rejects backup reads the port cannot honor without any fallback", async () => {
    const f = fixture();
    const destination = join(f.base, "destination");
    const files = nativeFiles({
      readPrivateFile: (path, maxBytes) => {
        if (maxBytes === 268435456)
          throw new CollaborationError("UNSUPPORTED_READ_LIMIT");
        return safePrivateRead(path, maxBytes);
      },
    });
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    await expect(
      runRestoreOperator(restoreArgs(f, { destination }), ports),
    ).rejects.toThrow("UNSUPPORTED_READ_LIMIT");
    expect(existsSync(destination)).toBe(false);
    expect(vi.mocked(files.createDirectory)).not.toHaveBeenCalled();
  });

  it("rejects empty, oversized and non-canonical file bytes from the port", async () => {
    const f = fixture();
    const destination = join(f.base, "destination");
    const empty = nativeFiles({
      readPrivateFile: (path, maxBytes) =>
        maxBytes === 268435456
          ? Buffer.alloc(0)
          : safePrivateRead(path, maxBytes),
    });
    useSyntheticWindowsPlatform();
    await expect(
      runRestoreOperator(
        restoreArgs(f, { destination }),
        nativePorts(empty).ports,
      ),
    ).rejects.toThrow("INVALID_BACKUP_FILE");

    const oversizedToken = nativeFiles({
      readPrivateFile: (path, maxBytes) =>
        path === f.keyFile
          ? Buffer.alloc(8193)
          : safePrivateRead(path, maxBytes),
    });
    await expect(
      runRestoreOperator(
        restoreArgs(f, { destination }),
        nativePorts(oversizedToken).ports,
      ),
    ).rejects.toThrow("INVALID_TOKEN_FILE");

    const pretty = join(f.secrets, "pretty-backup.json");
    writeFileSync(pretty, JSON.stringify(f.backup, null, 2), { mode: 0o600 });
    await expect(
      runRestoreOperator(
        restoreArgs(f, { backup: pretty, destination }),
        nativePorts(nativeFiles()).ports,
      ),
    ).rejects.toThrow("INVALID_BACKUP_FILE");
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects a rotated-away token before any destination or maintenance work", async () => {
    const f = fixture();
    {
      const authority = new SharedAuthority(f.root);
      try {
        authority.recover("org", f.boot.recoveryKey, "rotated-device");
      } finally {
        authority.close();
      }
    }
    const files = nativeFiles();
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const destination = join(f.base, "destination");
    await expect(
      runRestoreOperator(restoreArgs(f, { destination }), ports),
    ).rejects.toThrow("TOKEN_INVALID");
    expect(existsSync(destination)).toBe(false);
    expect(vi.mocked(files.createDirectory)).not.toHaveBeenCalled();
    await expect(
      runMaintenanceOperator(maintenanceArgs(f, "preview"), ports),
    ).rejects.toThrow("TOKEN_INVALID");
  });

  it("rejects a wrong recovery key before any publication", async () => {
    const f = fixture();
    const wrongKey = join(f.secrets, "wrong-key.json");
    writeFileSync(
      wrongKey,
      JSON.stringify({ token: f.boot.token, recoveryKey: "wrong-key" }),
      { mode: 0o600 },
    );
    const files = nativeFiles();
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    const output = join(f.secrets, "recovered.json");
    await expect(
      runRecoveryOperator(recoveryArgs(f, output, wrongKey), ports),
    ).rejects.toThrow("RECOVERY_INVALID");
    expect(vi.mocked(files.publishNewFile)).not.toHaveBeenCalled();
    expect(existsSync(output)).toBe(false);
  });

  it("rejects a reused factory adapter before any destination creation", async () => {
    const f = fixture();
    const files = nativeFiles();
    const { ports, calls } = nativePorts(files, {
      adapter: new TestStoreAdapter(),
    });
    useSyntheticWindowsPlatform();
    const destination = join(f.base, "destination");
    await expect(
      runRestoreOperator(restoreArgs(f, { destination }), ports),
    ).rejects.toThrow("WINDOWS_OPERATOR_ADAPTER_REUSED");
    expect(calls).toHaveLength(2);
    expect(existsSync(destination)).toBe(false);
    expect(vi.mocked(files.createDirectory)).not.toHaveBeenCalled();
  });

  it("never creates a missing source database through the guarded bind", async () => {
    const f = fixture();
    const empty = join(f.base, "empty-source");
    mkdirSync(empty, { mode: 0o700 });
    const files = nativeFiles();
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    await expect(
      runRestoreOperator(restoreArgs(f, { root: empty }), ports),
    ).rejects.toThrow("WINDOWS_DATABASE_MISSING");
    expect(existsSync(join(empty, SHARED_RUNTIME_FILE))).toBe(false);
  });

  it("rejects a null or foreign role before authority initialization", async () => {
    const f = fixture();
    const wrong = join(f.base, "wrong-role");
    {
      const store = new RuntimeStore(wrong);
      try {
        store.transaction(() => store.set("meta", "role", "client"));
      } finally {
        store.close();
      }
    }
    const empty = join(f.base, "null-role");
    {
      const store = new RuntimeStore(empty);
      store.close();
    }
    const foreign = join(f.base, "foreign");
    mkdirSync(foreign, { mode: 0o700 });
    {
      const db = new DatabaseSync(join(foreign, SHARED_RUNTIME_FILE));
      db.exec("CREATE TABLE private_notes(body TEXT)");
      db.close();
      chmodSync(join(foreign, SHARED_RUNTIME_FILE), 0o600);
    }
    const foreignBefore = readFileSync(join(foreign, SHARED_RUNTIME_FILE));
    const files = nativeFiles();
    const { ports } = nativePorts(files);
    useSyntheticWindowsPlatform();
    await expect(
      runRestoreOperator(restoreArgs(f, { root: wrong }), ports),
    ).rejects.toThrow("WRONG_STORE_ROLE");
    await expect(
      runRestoreOperator(restoreArgs(f, { root: empty }), ports),
    ).rejects.toThrow("WRONG_STORE_ROLE");
    await expect(
      runRestoreOperator(restoreArgs(f, { root: foreign }), ports),
    ).rejects.toThrow("NOT_SHARED_RUNTIME_FORMAT");
    expect(readFileSync(join(foreign, SHARED_RUNTIME_FILE))).toEqual(
      foreignBefore,
    );
    // The probe rejected the null role before SharedAuthority could set it.
    const probe = new RuntimeStore(empty, {
      platformAdapter: new TestStoreAdapter(),
    });
    try {
      expect(probe.get("meta", "role")).toBeNull();
    } finally {
      probe.close();
    }
  });

  it("applies explicit top-level bounds over factory defaults", async () => {
    const f = fixture();
    const files = nativeFiles();
    const { ports: factoryPorts } = nativePorts(files);
    const ports: SharedOperatorPorts = { ...factoryPorts, maxRows: 1 };
    useSyntheticWindowsPlatform();
    const destination = join(f.base, "destination");
    await expect(
      runRestoreOperator(restoreArgs(f, { destination }), ports),
    ).rejects.toThrow("SHARED_RUNTIME_LIMIT");
    expect(existsSync(destination)).toBe(false);
    expect(vi.mocked(files.createDirectory)).not.toHaveBeenCalled();
    const reopened = verificationAuthority(f.root);
    try {
      expect(reopened.head()).toEqual(f.cut);
      expect(reopened.session(f.boot.token, "org").userId).toBe("owner");
    } finally {
      reopened.close();
    }
  });

  it("closes the live authority when the destination factory fails", async () => {
    const f = fixture();
    const files = nativeFiles();
    const destination = join(f.base, "destination");
    const calls: FactoryCall[] = [];
    const ports: SharedOperatorPorts = {
      privateFiles: files,
      runtimeStoreOptions(directory: string): RuntimeStoreOptions {
        if (directory === resolve(destination))
          throw new Error("DESTINATION_FACTORY_FAILED");
        const adapter = new TestStoreAdapter();
        const options: RuntimeStoreOptions = { platformAdapter: adapter };
        calls.push({ directory, adapter, options });
        return options;
      },
    };
    useSyntheticWindowsPlatform();
    await expect(
      runRestoreOperator(restoreArgs(f, { destination }), ports),
    ).rejects.toThrow("DESTINATION_FACTORY_FAILED");
    // Source probe and live-authority adapters were both closed on the way out.
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.adapter.closed).toBe(true);
    expect(vi.mocked(files.createDirectory)).not.toHaveBeenCalled();
    expect(existsSync(destination)).toBe(false);
  });
});
