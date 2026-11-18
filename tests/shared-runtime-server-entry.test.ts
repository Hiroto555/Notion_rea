import { canonical } from "../src/collaboration/runtime/canonical";
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
import {
  main,
  runSharedServer,
  type SharedServerHandle,
} from "../src/collaboration/runtime/server-entry";
import {
  SHARED_RUNTIME_APPLICATION_ID,
  SHARED_RUNTIME_FILE,
  SHARED_RUNTIME_VERSION,
} from "../src/collaboration/runtime/store";

type Credentials = { token: string; recoveryKey: string };

const created: string[] = [];

function temporaryDirectory(): string {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "folio-shared-entry-")),
  );
  chmodSync(directory, 0o700);
  created.push(directory);
  return directory;
}

function bootstrapArgs(
  base: string,
  overrides: Partial<Record<"root" | "output" | "org", string>> = {},
): string[] {
  return [
    "bootstrap",
    "--root",
    overrides.root ?? join(base, "authority"),
    "--org",
    overrides.org ?? "org-one",
    "--user",
    "user-one",
    "--device",
    "device-one",
    "--workspace",
    "workspace-one",
    "--document",
    "document-one",
    "--credentials-output",
    overrides.output ?? join(base, "credentials.json"),
  ];
}

async function bootstrap(base: string): Promise<{
  root: string;
  credentialsPath: string;
  credentials: Credentials;
}> {
  const root = join(base, "authority");
  const credentialsPath = join(base, "credentials.json");
  const handle = await runSharedServer(bootstrapArgs(base));
  await handle.close();
  const credentials = JSON.parse(
    readFileSync(credentialsPath, "utf8"),
  ) as Credentials;
  return { root, credentialsPath, credentials };
}

async function request(
  url: string,
  operation: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${url}/v1/${operation}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: canonical(body),
  });
  return { status: response.status, body: await response.json() };
}

async function serveLoopback(
  root: string,
  extra: string[] = [],
): Promise<SharedServerHandle> {
  const handle = await runSharedServer([
    "serve",
    "--root",
    root,
    "--host",
    "127.0.0.1",
    "--port",
    "0",
    "--loopback-http",
    ...extra,
  ]);
  expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  return handle;
}

describe("shared server entry", () => {
  afterEach(() => {
    for (const directory of created.splice(0)) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Test cleanup must not mask the assertion that failed.
      }
    }
    vi.restoreAllMocks();
  });

  it("bootstraps a private authority and serves the issued token across restarts", async () => {
    const base = temporaryDirectory();
    const { root, credentialsPath, credentials } = await bootstrap(base);

    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(credentialsPath).mode & 0o777).toBe(0o600);
    expect(Object.keys(credentials).sort()).toEqual(["recoveryKey", "token"]);
    expect(credentials.token.length).toBeGreaterThan(0);
    expect(credentials.recoveryKey.length).toBeGreaterThan(0);
    expect(existsSync(join(root, SHARED_RUNTIME_FILE))).toBe(true);

    const first = await serveLoopback(root);
    try {
      const session = await request(first.url!, "session", credentials.token, {
        orgId: "org-one",
      });
      expect(session.status).toBe(200);
      expect(session.body).toMatchObject({
        v: 1,
        ok: true,
        result: { userId: "user-one", deviceId: "device-one" },
      });
      const workspaces = await request(
        first.url!,
        "workspaces",
        credentials.token,
        { orgId: "org-one" },
      );
      expect(workspaces.status).toBe(200);
      expect(workspaces.body.ok).toBe(true);
      const workspace = workspaces.body.result[0];
      expect(workspace.workspaceId).toBe("workspace-one");
      const document = workspace.documents[0];
      expect(document.documentId).toBe("document-one");
      const snapshot = await request(
        first.url!,
        "snapshot",
        credentials.token,
        {
          scope: {
            orgId: "org-one",
            workspaceId: workspace.workspaceId,
            documentId: document.documentId,
            incarnationId: document.incarnationId,
          },
        },
      );
      expect(snapshot.status).toBe(200);
      const paragraph = snapshot.body.result.state.document.content[0];
      expect(paragraph.type).toBe("paragraph");
      expect(paragraph.attrs.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    } finally {
      await first.close();
    }

    const restarted = await serveLoopback(root);
    try {
      const session = await request(
        restarted.url!,
        "session",
        credentials.token,
        { orgId: "org-one" },
      );
      expect(session.status).toBe(200);
      expect(session.body.result.userId).toBe("user-one");
    } finally {
      await restarted.close();
    }
  });

  it("does not overwrite an existing credentials file and creates no authority", async () => {
    const base = temporaryDirectory();
    const root = join(base, "authority");
    const output = join(base, "credentials.json");
    writeFileSync(output, "already-here", { mode: 0o600 });

    await expect(runSharedServer(bootstrapArgs(base))).rejects.toThrow(
      "CREDENTIALS_EXIST",
    );
    expect(readFileSync(output, "utf8")).toBe("already-here");
    expect(existsSync(root)).toBe(false);
  });

  it("rejects a second bootstrap without publishing new credentials", async () => {
    const base = temporaryDirectory();
    await bootstrap(base);
    const secondOutput = join(base, "second-credentials.json");

    await expect(
      runSharedServer(bootstrapArgs(base, { output: secondOutput })),
    ).rejects.toThrow("ALREADY_BOOTSTRAPPED");
    expect(existsSync(secondOutput)).toBe(false);
  });

  it("rejects malformed arguments before opening any authority", async () => {
    const base = temporaryDirectory();
    const root = join(base, "authority");

    await expect(runSharedServer([])).rejects.toThrow("INVALID_ARGUMENT");
    await expect(runSharedServer(["unknown"])).rejects.toThrow(
      "INVALID_ARGUMENT",
    );
    await expect(
      runSharedServer(["bootstrap", "--root", root]),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      runSharedServer([
        ...bootstrapArgs(base),
        "--credentials-output",
        join(base, "other.json"),
      ]),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      runSharedServer([
        "serve",
        "--root",
        root,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--loopback-http",
        "--loopback-http",
      ]),
    ).rejects.toThrow("INVALID_ARGUMENT");

    expect(existsSync(root)).toBe(false);
  });

  it("rejects non-absolute and inside-root credential destinations before bootstrap", async () => {
    const base = temporaryDirectory();
    const root = join(base, "authority");

    await expect(
      runSharedServer(bootstrapArgs(base, { output: "relative.json" })),
    ).rejects.toThrow("INVALID_ARGUMENT");
    await expect(
      runSharedServer(
        bootstrapArgs(base, { output: join(root, "credentials.json") }),
      ),
    ).rejects.toThrow("CREDENTIALS_INSIDE_ROOT");
    expect(existsSync(root)).toBe(false);
  });

  it("rejects an output parent that is not private", async () => {
    const base = temporaryDirectory();
    const publicDirectory = join(base, "public");
    mkdirSync(publicDirectory, { mode: 0o755 });
    chmodSync(publicDirectory, 0o755);
    const root = join(base, "authority");

    await expect(
      runSharedServer(
        bootstrapArgs(base, {
          output: join(publicDirectory, "credentials.json"),
        }),
      ),
    ).rejects.toThrow("UNSAFE_CREDENTIALS_PATH");
    expect(existsSync(root)).toBe(false);
  });

  it("rejects serve on a missing root without creating an empty authority", async () => {
    const base = temporaryDirectory();
    const root = join(base, "authority");

    await expect(serveLoopback(root)).rejects.toThrow("ROOT_MISSING");
    expect(existsSync(root)).toBe(false);
  });

  it("rejects serve on an existing but un-bootstrapped root", async () => {
    const base = temporaryDirectory();
    const root = join(base, "authority");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);

    await expect(serveLoopback(root)).rejects.toThrow("NOT_BOOTSTRAPPED");
    expect(existsSync(join(root, SHARED_RUNTIME_FILE))).toBe(false);
  });

  it("rejects foreign private SQLite roots for bootstrap and serve", async () => {
    const base = temporaryDirectory();
    const root = join(base, "authority");
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    writeFileSync(join(root, SHARED_RUNTIME_FILE), "not a shared runtime", {
      mode: 0o600,
    });

    await expect(runSharedServer(bootstrapArgs(base))).rejects.toThrow(
      "NOT_SHARED_RUNTIME_FORMAT",
    );
    await expect(serveLoopback(root)).rejects.toThrow(
      "NOT_SHARED_RUNTIME_FORMAT",
    );
  });

  it("rejects a non-loopback host and mixed loopback/TLS arguments", async () => {
    const base = temporaryDirectory();
    const { root } = await bootstrap(base);

    await expect(
      runSharedServer([
        "serve",
        "--root",
        root,
        "--host",
        "0.0.0.0",
        "--port",
        "0",
        "--loopback-http",
      ]),
    ).rejects.toThrow("INVALID_HOST");

    const key = join(base, "key.pem");
    const cert = join(base, "cert.pem");
    writeFileSync(key, "key", { mode: 0o600 });
    writeFileSync(cert, "cert", { mode: 0o600 });
    await expect(
      runSharedServer([
        "serve",
        "--root",
        root,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--loopback-http",
        "--key",
        key,
        "--cert",
        cert,
      ]),
    ).rejects.toThrow("INVALID_ARGUMENT");
  });

  it("rejects symlinked TLS key material without logging it", async () => {
    const base = temporaryDirectory();
    const { root } = await bootstrap(base);
    const realKey = join(base, "real-key.pem");
    const linkedKey = join(base, "linked-key.pem");
    const cert = join(base, "cert.pem");
    writeFileSync(realKey, "secret-key-material", { mode: 0o600 });
    writeFileSync(cert, "cert", { mode: 0o600 });
    symlinkSync(realKey, linkedKey);

    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    try {
      await expect(
        runSharedServer([
          "serve",
          "--root",
          root,
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--key",
          linkedKey,
          "--cert",
          cert,
        ]),
      ).rejects.toThrow("INVALID_TLS_FILE");
      expect(writes.join("")).not.toContain("secret-key-material");
      expect(writes).toHaveLength(0);
    } finally {
      stdout.mockRestore();
    }
  });

  it("never writes a token or recovery key to stdout or console output", async () => {
    const base = temporaryDirectory();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(((
      ...parts: unknown[]
    ) => {
      logs.push(parts.map(String).join(" "));
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(((
      ...parts: unknown[]
    ) => {
      errors.push(parts.map(String).join(" "));
    }) as never);
    try {
      const handle = await runSharedServer(bootstrapArgs(base));
      await handle.close();
      const credentials = JSON.parse(
        readFileSync(join(base, "credentials.json"), "utf8"),
      ) as Credentials;
      const emitted = [...stdout, ...stderr, ...logs, ...errors].join("\n");
      expect(emitted).not.toContain(credentials.token);
      expect(emitted).not.toContain(credentials.recoveryKey);
      expect(stdout).toHaveLength(0);
      expect(stderr).toHaveLength(0);
      expect(logs).toHaveLength(0);
      expect(errors).toHaveLength(0);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("exposes main and keeps the shared runtime format constants stable", async () => {
    expect(typeof main).toBe("function");
    expect(SHARED_RUNTIME_APPLICATION_ID).toBe(0x464c5352);
    expect(SHARED_RUNTIME_VERSION).toBe(1003);
  });
});
