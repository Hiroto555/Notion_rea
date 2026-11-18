/**
 * Headless server-ops CLI tests. The real entry point is bundled with esbuild
 * and spawned as a child Node process; no Electron, browser or GUI is used.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { inspectServerHistory } from "../src/sync/server-history-validation";

const roots: string[] = [];
const children = new Set<ChildProcess>();
let buildRoot = "";
let cliPath = "";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeAll(() => {
  buildRoot = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-server-ops-build-")),
  );
  cliPath = join(buildRoot, "server-ops.cjs");
  buildSync({
    entryPoints: [resolve("src/sync/server-ops-cli.ts")],
    outfile: cliPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["node:sqlite"],
    logLevel: "silent",
  });
}, 60_000);

afterAll(() => {
  if (buildRoot) rmSync(buildRoot, { recursive: true, force: true });
});

afterEach(async () => {
  for (const child of [...children]) await terminate(child);
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), prefix)),
  );
  roots.push(root);
  return root;
}

function privateParent(root: string, name: string): string {
  const parent = join(root, name);
  mkdirSync(parent, { mode: 0o700, recursive: true });
  chmodSync(parent, 0o700);
  return parent;
}

function childEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: root,
    LANG: "C",
    LC_ALL: "C",
  };
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: childEnv(cwd),
  });
}

function lastJson(text: string): Record<string, unknown> {
  const line = text
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error("expected a JSON line");
  return JSON.parse(line) as Record<string, unknown>;
}

function terminate(child: ChildProcess): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      resolvePromise();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    try {
      child.kill("SIGKILL");
    } catch {
      clearTimeout(timer);
      resolvePromise();
    }
  });
}

function startServe(root: string, directory: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [cliPath, "serve", "--directory", directory],
    {
      cwd: root,
      env: childEnv(root),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.add(child);
  return child;
}

function readReady(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error("serve ready timeout: " + stderr));
    }, 15_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onError);
      child.off("exit", onExit);
    }
    function onData(chunk: string): void {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      cleanup();
      try {
        resolvePromise(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        rejectPromise(error);
      }
    }
    function onError(chunk: string): void {
      stderr += chunk;
    }
    function onExit(code: number | null): void {
      cleanup();
      rejectPromise(new Error("serve exited early: " + String(code) + stderr));
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onError);
    child.once("exit", onExit);
  });
}

function waitExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(child.exitCode);
  return new Promise((resolvePromise) =>
    child.once("exit", (code) => resolvePromise(code)),
  );
}

it("initializes privately and hands off a credential without printing it", () => {
  const root = tempRoot("folio-server-ops-");
  const servers = privateParent(root, "servers");
  const handoff = privateParent(root, "handoff");
  const server = join(servers, "alpha");
  const credential = join(handoff, "client-a.json");
  const port = String(47_000 + (process.pid % 1_000));

  const init = runCli(
    [
      "init",
      "--directory",
      server,
      "--workspace",
      "workspace-a",
      "--owner",
      "owner-a",
      "--port",
      port,
    ],
    root,
  );
  expect(init.status).toBe(0);
  const initialized = lastJson(init.stdout);
  expect(initialized.ok).toBe(true);
  expect(initialized.serverEpoch).toMatch(UUID);
  expect(lstatSync(server).mode & 0o777).toBe(0o700);

  const issue = runCli(
    [
      "issue",
      "--directory",
      server,
      "--client",
      "client-a",
      "--credential-file",
      credential,
    ],
    root,
  );
  expect(issue.status).toBe(0);
  const issued = lastJson(issue.stdout);
  expect(issued).toEqual({
    ok: true,
    clientId: "client-a",
    baseUrl: `http://127.0.0.1:${port}`,
  });
  expect(issue.stdout).not.toMatch(/token/i);

  const text = readFileSync(credential, "utf8");
  const handoffValue = JSON.parse(text) as { token: string };
  expect(handoffValue.token).toMatch(/^[A-Za-z0-9_-]{32,512}$/);
  expect(lstatSync(credential).mode & 0o777).toBe(0o600);
  expect(issue.stdout).not.toContain(handoffValue.token);
  expect(issue.stdout).not.toContain(text);
});

it("rejects invalid, duplicate, unknown and missing flags before writing", () => {
  const root = tempRoot("folio-server-ops-invalid-");
  const servers = privateParent(root, "servers");
  const server = join(servers, "never");
  const credential = join(root, "credential.json");
  const cases: string[][] = [
    ["init", "--directory", server, "--workspace", "w", "--owner", "o"],
    [
      "init",
      "--directory",
      server,
      "--directory",
      server,
      "--workspace",
      "w",
      "--owner",
      "o",
      "--port",
      "1234",
    ],
    [
      "init",
      "--directory",
      server,
      "--workspace",
      "w",
      "--owner",
      "o",
      "--port",
      "1234",
      "--unknown",
      "x",
    ],
    [
      "init",
      "--directory",
      server,
      "--workspace",
      "w",
      "--owner",
      "o",
      "--port",
      "not-a-port",
    ],
    [
      "issue",
      "--directory",
      server,
      "--client",
      "c",
      "--credential-file",
      credential,
      "--token",
      "secret",
    ],
    ["bogus", "--directory", server],
  ];
  for (const args of cases) {
    const result = runCli(args, root);
    expect(result.status).toBe(2);
    expect(lastJson(result.stderr)).toEqual({ ok: false, error: "usage" });
    expect(result.stdout.trim()).toBe("");
    expect(existsSync(server)).toBe(false);
    expect(existsSync(credential)).toBe(false);
  }
});

it("serves until signalled, holds the lease, then revokes offline", async () => {
  const root = tempRoot("folio-server-ops-serve-");
  const servers = privateParent(root, "servers");
  const handoff = privateParent(root, "handoff");
  const backups = privateParent(root, "backups");
  const server = join(servers, "alpha");
  const port = String(48_000 + (process.pid % 1_000));

  const init = runCli(
    [
      "init",
      "--directory",
      server,
      "--workspace",
      "workspace-a",
      "--owner",
      "owner-a",
      "--port",
      port,
    ],
    root,
  );
  expect(init.status).toBe(0);
  const initialized = lastJson(init.stdout);
  const issue = runCli(
    [
      "issue",
      "--directory",
      server,
      "--client",
      "client-a",
      "--credential-file",
      join(handoff, "client.json"),
    ],
    root,
  );
  expect(issue.status).toBe(0);

  const child = startServe(root, server);
  const ready = await readReady(child);
  expect(ready).toEqual({
    ok: true,
    event: "ready",
    url: `http://127.0.0.1:${port}`,
    serverEpoch: initialized.serverEpoch,
  });

  const destination = join(backups, "snapshot");
  const busy = runCli(
    ["backup", "--directory", server, "--destination", destination],
    root,
  );
  expect(busy.status).toBe(1);
  expect(lastJson(busy.stderr)).toEqual({
    ok: false,
    error: "server-maintenance-busy",
  });
  expect(existsSync(destination)).toBe(false);

  child.kill("SIGTERM");
  expect(await waitExit(child)).toBe(0);

  const revoke = runCli(
    ["revoke", "--directory", server, "--client", "client-a"],
    root,
  );
  expect(revoke.status).toBe(0);
  expect(lastJson(revoke.stdout)).toEqual({ ok: true, clientId: "client-a" });
});

it("backs up, inspects safe counts and restores with a fresh epoch", () => {
  const root = tempRoot("folio-server-ops-restore-");
  const servers = privateParent(root, "servers");
  const handoff = privateParent(root, "handoff");
  const backups = privateParent(root, "backups");
  const restores = privateParent(root, "restores");
  const server = join(servers, "alpha");
  const backup = join(backups, "first");
  const restored = join(restores, "alpha");
  const port = String(49_000 + (process.pid % 1_000));

  const init = runCli(
    [
      "init",
      "--directory",
      server,
      "--workspace",
      "workspace-a",
      "--owner",
      "owner-a",
      "--port",
      port,
    ],
    root,
  );
  expect(init.status).toBe(0);
  const initialized = lastJson(init.stdout);
  const issue = runCli(
    [
      "issue",
      "--directory",
      server,
      "--client",
      "client-a",
      "--credential-file",
      join(handoff, "client.json"),
    ],
    root,
  );
  expect(issue.status).toBe(0);

  const backupResult = runCli(
    ["backup", "--directory", server, "--destination", backup],
    root,
  );
  expect(backupResult.status).toBe(0);
  const backupOutput = lastJson(backupResult.stdout);
  expect(backupOutput.ok).toBe(true);
  expect(backupOutput.serverEpoch).toBe(initialized.serverEpoch);
  expect(backupOutput.counts).toEqual({
    changes: 0,
    operations: 0,
    devices: 1,
    activeDevices: 1,
    revokedDevices: 0,
  });
  expect(backupResult.stdout).not.toContain(backup);

  const inspect = runCli(["inspect", "--backup", backup], root);
  expect(inspect.status).toBe(0);
  expect(inspect.stdout).not.toMatch(/token|workspace-a|owner-a/i);
  expect(lastJson(inspect.stdout)).toEqual({
    ok: true,
    counts: {
      changes: 0,
      operations: 0,
      devices: 1,
      activeDevices: 1,
      revokedDevices: 0,
    },
  });

  const restore = runCli(
    [
      "restore",
      "--backup",
      backup,
      "--destination",
      restored,
      "--port",
      String(Number(port) + 1),
    ],
    root,
  );
  expect(restore.status).toBe(0);
  const restoredOutput = lastJson(restore.stdout);
  expect(restoredOutput.previousEpoch).toBe(initialized.serverEpoch);
  expect(restoredOutput.serverEpoch).toMatch(UUID);
  expect(restoredOutput.serverEpoch).not.toBe(initialized.serverEpoch);
  expect(restore.stdout).not.toContain(restored);

  const database = new DatabaseSync(join(restored, "server.sqlite"), {
    readOnly: true,
  });
  try {
    const history = inspectServerHistory(database);
    expect(history.serverEpoch).toBe(restoredOutput.serverEpoch);
    expect(history.devices).toBe(1);
    expect(history.activeDevices).toBe(0);
    expect(history.revokedDevices).toBe(1);
  } finally {
    database.close();
  }

  const reissue = runCli(
    [
      "issue",
      "--directory",
      restored,
      "--client",
      "client-a",
      "--credential-file",
      join(privateParent(root, "handoff-2"), "client.json"),
    ],
    root,
  );
  expect(reissue.status).toBe(1);
  const failure = lastJson(reissue.stderr);
  expect(failure.ok).toBe(false);
  expect(failure.error).toMatch(/^[a-z][a-z0-9-]{1,80}$/);
  expect(JSON.stringify(failure)).not.toContain(restored);
});

it("uses the CLI bundle guard only for the standalone entry", () => {
  const source = readFileSync(
    resolve("src/sync/server-ops-cli.ts"),
    "utf8",
  );
  expect(source).toContain('"server-ops.cjs"');
  expect(source).toContain('"server-ops-cli.ts"');
});
