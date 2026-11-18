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
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CheckpointServerHandle } from "../src/sync/checkpoint-server";
import {
  initializeOperationalServer,
  startOperationalServer,
} from "../src/sync/operational-server";
import { readIssuedSyncCredential } from "../src/sync/server-ops-config";
import { runServerOpsCli } from "../src/sync/server-ops-cli";

const workspaceId = "workspace-a";
const ownerId = "owner-a";
const clientId = "client-a";

const roots: string[] = [];
const running = new Set<CheckpointServerHandle>();

type OpsResult = { status: number; stdout: string; stderr: string };

afterEach(async () => {
  for (const server of [...running]) {
    running.delete(server);
    try {
      await server.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  roots.push(root);
  return root;
}

function privateParent(root: string, name: string): string {
  const parent = join(root, name);
  mkdirSync(parent, { mode: 0o700, recursive: true });
  chmodSync(parent, 0o700);
  return parent;
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("loopback port unavailable");
  }
  const port = address.port;
  await new Promise<void>((resolvePromise, rejectPromise) =>
    server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
  );
  return port;
}

async function runOps(args: string[]): Promise<OpsResult> {
  let stdout = "";
  let stderr = "";
  const status = await runServerOpsCli(args, {
    write: (line) => {
      stdout += line + "\n";
    },
    error: (line) => {
      stderr += line + "\n";
    },
  });
  return { status, stdout, stderr };
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

async function setup() {
  const root = tempRoot("folio-credential-reuse-");
  const host = privateParent(root, "host");
  const handoff = privateParent(root, "handoff");
  const serverDirectory = join(host, "server");
  const port = await freeLoopbackPort();
  await initializeOperationalServer(serverDirectory, {
    format: "folio-server-config/v1",
    workspaceId,
    ownerId,
    port,
  });
  expect(lstatSync(serverDirectory).mode & 0o777).toBe(0o700);
  return { root, host, handoff, serverDirectory, port };
}

function issueArgs(
  serverDirectory: string,
  credentialFile: string,
  reuse = false,
): string[] {
  const args = [
    "issue",
    "--directory",
    serverDirectory,
    "--client",
    clientId,
    "--credential-file",
    credentialFile,
  ];
  if (reuse) args.push("--reuse-credential");
  return args;
}

async function start(serverDirectory: string): Promise<CheckpointServerHandle> {
  const server = await startOperationalServer(serverDirectory);
  running.add(server);
  return server;
}

async function stop(server: CheckpointServerHandle): Promise<void> {
  running.delete(server);
  await server.close();
}

async function headStatus(
  credential: ReturnType<typeof readIssuedSyncCredential>,
): Promise<number> {
  const response = await fetch(
    credential.baseUrl + `/v1/workspaces/${credential.workspaceId}/head`,
    { headers: { Authorization: "Bearer " + credential.token } },
  );
  await response.arrayBuffer();
  return response.status;
}

it(
  "rotates the token when a new handoff is issued for the same client",
  async () => {
    const { handoff, serverDirectory } = await setup();
    const firstFile = join(handoff, "first.json");
    const secondFile = join(handoff, "second.json");

    const firstIssue = await runOps(issueArgs(serverDirectory, firstFile));
    expect(firstIssue.status).toBe(0);
    const first = readIssuedSyncCredential(firstFile);
    expect(lastJson(firstIssue.stdout)).toEqual({
      ok: true,
      clientId,
      baseUrl: first.baseUrl,
    });
    const firstText = readFileSync(firstFile, "utf8");
    expect(firstIssue.stdout.includes(first.token)).toBe(false);
    expect(lstatSync(firstFile).mode & 0o777).toBe(0o600);

    const secondIssue = await runOps(issueArgs(serverDirectory, secondFile));
    expect(secondIssue.status).toBe(0);
    const second = readIssuedSyncCredential(secondFile);
    expect(secondIssue.stdout.includes(second.token)).toBe(false);
    expect(lstatSync(secondFile).mode & 0o777).toBe(0o600);
    expect(second.clientId).toBe(clientId);
    expect(first.token !== second.token).toBe(true);
    expect(readFileSync(firstFile, "utf8") === firstText).toBe(true);

    const server = await start(serverDirectory);
    expect(await headStatus(second)).toBe(200);
    expect(await headStatus(first)).toBe(401);
    await stop(server);
  },
  30_000,
);

it(
  "rejects a stale reuse without rotating the current token and reuses the current file idempotently",
  async () => {
    const { handoff, serverDirectory } = await setup();
    const firstFile = join(handoff, "first.json");
    const secondFile = join(handoff, "second.json");

    expect((await runOps(issueArgs(serverDirectory, firstFile))).status).toBe(0);
    expect((await runOps(issueArgs(serverDirectory, secondFile))).status).toBe(
      0,
    );
    const first = readIssuedSyncCredential(firstFile);
    const second = readIssuedSyncCredential(secondFile);
    const secondText = readFileSync(secondFile, "utf8");

    const stale = await runOps(
      issueArgs(serverDirectory, firstFile, true),
    );
    expect(stale.status).toBe(1);
    expect(stale.stdout.trim()).toBe("");
    expect(lastJson(stale.stderr)).toEqual({
      ok: false,
      error: "server-credential-stale",
    });
    expect(readFileSync(secondFile, "utf8") === secondText).toBe(true);

    const current = await runOps(
      issueArgs(serverDirectory, secondFile, true),
    );
    expect(current.status).toBe(0);
    expect(lastJson(current.stdout)).toEqual({
      ok: true,
      clientId,
      baseUrl: second.baseUrl,
    });
    expect(current.stdout.includes(second.token)).toBe(false);
    expect(readFileSync(secondFile, "utf8") === secondText).toBe(true);
    expect(readIssuedSyncCredential(secondFile).token === second.token).toBe(
      true,
    );

    const server = await start(serverDirectory);
    expect(await headStatus(second)).toBe(200);
    expect(await headStatus(first)).toBe(401);
    await stop(server);
  },
  30_000,
);

it(
  "refuses fresh and reused handoffs after offline revocation without creating files",
  async () => {
    const { handoff, serverDirectory } = await setup();
    const firstFile = join(handoff, "first.json");
    const secondFile = join(handoff, "second.json");
    const freshFile = join(handoff, "fresh.json");

    expect((await runOps(issueArgs(serverDirectory, firstFile))).status).toBe(0);
    expect((await runOps(issueArgs(serverDirectory, secondFile))).status).toBe(
      0,
    );
    const firstText = readFileSync(firstFile, "utf8");
    const secondText = readFileSync(secondFile, "utf8");

    const revoke = await runOps([
      "revoke",
      "--directory",
      serverDirectory,
      "--client",
      clientId,
    ]);
    expect(revoke.status).toBe(0);
    expect(lastJson(revoke.stdout)).toEqual({ ok: true, clientId });

    const fresh = await runOps(issueArgs(serverDirectory, freshFile));
    expect(fresh.status).toBe(1);
    expect(lastJson(fresh.stderr)).toEqual({
      ok: false,
      error: "device-revoked",
    });
    expect(existsSync(freshFile)).toBe(false);

    const reusedSecond = await runOps(
      issueArgs(serverDirectory, secondFile, true),
    );
    expect(reusedSecond.status).toBe(1);
    expect(lastJson(reusedSecond.stderr)).toEqual({
      ok: false,
      error: "device-revoked",
    });

    const reusedFirst = await runOps(
      issueArgs(serverDirectory, firstFile, true),
    );
    expect(reusedFirst.status).toBe(1);
    expect(lastJson(reusedFirst.stderr)).toEqual({
      ok: false,
      error: "device-revoked",
    });

    expect(existsSync(firstFile)).toBe(true);
    expect(existsSync(secondFile)).toBe(true);
    expect(readFileSync(firstFile, "utf8") === firstText).toBe(true);
    expect(readFileSync(secondFile, "utf8") === secondText).toBe(true);
    expect(lstatSync(firstFile).mode & 0o777).toBe(0o600);
    expect(lstatSync(secondFile).mode & 0o777).toBe(0o600);
  },
  30_000,
);

it(
  "reports bounded offline status and holds the lease while serving",
  async () => {
    const { handoff, serverDirectory } = await setup();
    const credentialFile = join(handoff, "client.json");
    expect(
      (await runOps(issueArgs(serverDirectory, credentialFile))).status,
    ).toBe(0);
    const credential = readIssuedSyncCredential(credentialFile);

    const before = await runOps(["status", "--directory", serverDirectory]);
    expect(before.status).toBe(0);
    const beforeStatus = lastJson(before.stdout);
    expect(beforeStatus.ok).toBe(true);
    expect(beforeStatus.devices).toBe(1);
    expect(beforeStatus.maxDevices).toBe(512);
    const beforeHistory = beforeStatus.history as Record<string, unknown>;
    expect(beforeHistory.rows).toBe(0);
    expect(beforeHistory.bytes).toBe(0);
    expect(beforeHistory.maxRows).toBe(1024);
    expect(beforeHistory.maxBytes).toBe(64 * 1024 * 1024);
    expect(beforeHistory.held).toBe(false);
    const beforeBlobs = beforeStatus.blobs as Record<string, unknown>;
    expect(beforeBlobs.bytes).toBe(0);
    expect(beforeBlobs.entries).toBe(0);
    expect(beforeBlobs.held).toBe(false);
    expect(beforeStatus.held).toBe(null);
    const beforeText = JSON.stringify(beforeStatus);
    expect(beforeText.includes(credential.token)).toBe(false);
    expect(/token_hash|"payload"|"token"/i.test(beforeText)).toBe(false);

    const server = await start(serverDirectory);
    const busy = await runOps(["status", "--directory", serverDirectory]);
    expect(busy.status).toBe(1);
    expect(lastJson(busy.stderr)).toEqual({
      ok: false,
      error: "server-maintenance-busy",
    });
    await stop(server);

    const after = await runOps(["status", "--directory", serverDirectory]);
    expect(after.status).toBe(0);
    const afterStatus = lastJson(after.stdout);
    expect(afterStatus.ok).toBe(true);
    expect(afterStatus.devices).toBe(1);
    expect(afterStatus.maxDevices).toBe(512);
    const afterText = JSON.stringify(afterStatus);
    expect(afterText.includes(credential.token)).toBe(false);
    expect(/token_hash|"payload"|"token"/i.test(afterText)).toBe(false);
  },
  30_000,
);
