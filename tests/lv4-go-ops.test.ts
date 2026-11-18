import {
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  LV4_GO_OPS_MAX_LINE_BYTES,
  LV4_GO_OPS_WORKSPACE_ID,
  Lv4GoOpsSession,
  type Lv4GoOpsResponse,
  type Lv4GoOpsStatus,
} from "../src/sync/lv4-go-ops";

const roots: string[] = [];
const children = new Set<ChildProcess>();
let buildRoot = "";
let cliPath = "";

type CliExit = { code: number | null; signal: NodeJS.Signals | null };
type CliHandle = {
  send(value: unknown): void;
  end(): void;
  next(): Promise<Lv4GoOpsResponse>;
  stdout(): string;
  stderr(): string;
  exit: Promise<CliExit>;
};

beforeAll(() => {
  buildRoot = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-go-ops-build-")),
  );
  cliPath = join(buildRoot, "lv4-go-ops-cli.cjs");
  buildSync({
    entryPoints: [resolve("src/sync/lv4-go-ops-cli.ts")],
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

function childEnv(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: root,
    LANG: "C",
    LC_ALL: "C",
  };
}

function terminate(child: ChildProcess): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolvePromise) => {
    const done = () => resolvePromise();
    child.once("exit", done);
    try {
      child.kill("SIGKILL");
    } catch {
      done();
    }
    const timer = setTimeout(done, 5_000);
    timer.unref();
  });
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(label)), 10_000);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function startCli(root: string): CliHandle {
  const child = spawn(process.execPath, [cliPath], {
    cwd: root,
    env: childEnv(root),
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  let ended = false;
  let exitError: Error | undefined;

  const flush = (): void => {
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else queued.push(line);
    }
  };
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
    buffer += chunk;
    flush();
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit = new Promise<CliExit>((resolvePromise, rejectPromise) => {
    child.once("error", (error) => {
      children.delete(child);
      ended = true;
      exitError = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      ended = true;
      flush();
      for (const waiter of waiters.splice(0))
        waiter.reject(new Error("lv4-go-ops-cli-exited"));
      resolvePromise({ code, signal });
    });
  });
  exit.catch(() => {});

  return {
    send(value) {
      const line = typeof value === "string" ? value : JSON.stringify(value);
      child.stdin?.write(`${line}\n`);
    },
    end() {
      child.stdin?.end();
    },
    next() {
      const queuedLine = queued.shift();
      if (queuedLine !== undefined)
        return Promise.resolve(JSON.parse(queuedLine) as Lv4GoOpsResponse);
      if (ended)
        return Promise.reject(exitError ?? new Error("lv4-go-ops-cli-exited"));
      return withTimeout(
        new Promise<string>((resolvePromise, rejectPromise) => {
          waiters.push({ resolve: resolvePromise, reject: rejectPromise });
        }),
        "lv4-go-ops-cli-response-timeout",
      ).then((line) => JSON.parse(line) as Lv4GoOpsResponse);
    },
    stdout: () => stdout,
    stderr: () => stderr,
    exit,
  };
}

function statusResult(response: Lv4GoOpsResponse): Lv4GoOpsStatus {
  if (!response.ok) throw new Error(`unexpected ${response.error}`);
  return response.result as Lv4GoOpsStatus;
}

it("enforces a strict typed line protocol without exposing device secrets", async () => {
  const session = await Lv4GoOpsSession.open();
  try {
    const endpoint = new URL(session.url);
    expect(endpoint.hostname).toBe("127.0.0.1");
    expect(endpoint.username).toBe("");
    expect(endpoint.password).toBe("");
    expect(endpoint.search).toBe("");
    expect(endpoint.hash).toBe("");
    expect(session.url).not.toMatch(/token|secret|credential|authorization/i);

    const initial = statusResult(
      await session.handleLine('{"id":"s1","command":"status"}'),
    );
    expect(initial).toEqual({
      workspaceId: LV4_GO_OPS_WORKSPACE_ID,
      serverEpoch: expect.any(String),
      devices: [],
    });
    expect(Object.keys(initial).sort()).toEqual([
      "devices",
      "serverEpoch",
      "workspaceId",
    ]);
    expect(initial.serverEpoch.length).toBeGreaterThan(0);

    expect(
      await session.handleLine(
        '{"id":"s2","command":"register","clientId":"client-a"}',
      ),
    ).toEqual({ id: "s2", ok: true, result: { clientId: "client-a" } });
    const active = statusResult(
      await session.handleLine('{"id":"s3","command":"status"}'),
    );
    expect(active.devices).toEqual([
      { clientId: "client-a", state: "active" },
    ]);

    const serialized = JSON.stringify([initial, active]);
    expect(serialized).not.toMatch(/token|secret|credential|authorization/i);
    expect(serialized).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(serialized).not.toMatch(/https?:\/\//);

    expect(
      await session.handleLine(
        '{"id":"s4","command":"register","clientId":"client-a"}',
      ),
    ).toEqual({ id: "s4", ok: false, error: "fixture-device-exists" });
    expect(
      await session.handleLine(
        '{"id":"s5","command":"revoke","clientId":"client-a"}',
      ),
    ).toEqual({ id: "s5", ok: true, result: { clientId: "client-a" } });
    const revoked = statusResult(
      await session.handleLine('{"id":"s6","command":"status"}'),
    );
    expect(revoked.devices).toEqual([
      { clientId: "client-a", state: "revoked" },
    ]);
    expect(
      await session.handleLine(
        '{"id":"s7","command":"register","clientId":"client-a"}',
      ),
    ).toEqual({ id: "s7", ok: false, error: "fixture-device-exists" });

    expect(await session.handleLine("not json")).toEqual({
      id: null,
      ok: false,
      error: "invalid-json",
    });
    expect(await session.handleLine("")).toEqual({
      id: null,
      ok: false,
      error: "invalid-json",
    });
    expect(await session.handleLine("[]")).toEqual({
      id: null,
      ok: false,
      error: "expected-object",
    });
    expect(
      await session.handleLine('{"id":"s8","command":"status","extra":true}'),
    ).toEqual({ id: "s8", ok: false, error: "unexpected-fields" });
    expect(
      await session.handleLine('{"id":"s9","command":"register"}'),
    ).toEqual({ id: "s9", ok: false, error: "unexpected-fields" });
    expect(
      await session.handleLine(
        '{"id":"s10","command":"register","clientId":"bad id"}',
      ),
    ).toEqual({ id: "s10", ok: false, error: "invalid-identifier" });
    expect(
      await session.handleLine(
        '{"id":"s11","command":"delete","clientId":"client-a"}',
      ),
    ).toEqual({ id: "s11", ok: false, error: "invalid-command" });
    expect(
      await session.handleLine('{"id":"bad id","command":"status"}'),
    ).toEqual({ id: null, ok: false, error: "invalid-identifier" });
    expect(
      await session.handleLine(
        JSON.stringify({
          id: "s12",
          command: "status",
          padding: "x".repeat(LV4_GO_OPS_MAX_LINE_BYTES),
        }),
      ),
    ).toEqual({ id: null, ok: false, error: "line-too-large" });

    const final = statusResult(
      await session.handleLine('{"id":"s13","command":"status"}'),
    );
    expect(final.devices).toEqual([
      { clientId: "client-a", state: "revoked" },
    ]);
  } finally {
    await session.close();
  }
});

it("uses a separate loopback fixture and temporary state per session", async () => {
  const first = await Lv4GoOpsSession.open();
  let second: Lv4GoOpsSession | undefined;
  try {
    second = await Lv4GoOpsSession.open();
    expect(new URL(first.url).hostname).toBe("127.0.0.1");
    expect(new URL(second.url).hostname).toBe("127.0.0.1");
    expect(first.url).not.toBe(second.url);

    const firstStatus = statusResult(
      await first.handleLine('{"id":"a","command":"status"}'),
    );
    const secondStatus = statusResult(
      await second.handleLine('{"id":"b","command":"status"}'),
    );
    expect(firstStatus.serverEpoch).not.toBe(secondStatus.serverEpoch);
    expect(secondStatus.devices).toEqual([]);

    await first.handleLine(
      '{"id":"c","command":"register","clientId":"only-first"}',
    );
    const isolated = statusResult(
      await second.handleLine('{"id":"d","command":"status"}'),
    );
    expect(isolated.devices).toEqual([]);
  } finally {
    try {
      if (second) await second.close();
    } finally {
      await first.close();
    }
  }
});

it("rejects requests after close and closes idempotently", async () => {
  const session = await Lv4GoOpsSession.open();
  await session.close();
  expect(
    await session.handleLine('{"id":"c1","command":"status"}'),
  ).toEqual({ id: "c1", ok: false, error: "fixture-ops-closed" });
  await expect(session.close()).resolves.toBeUndefined();
});

it("processes strict NDJSON over stdin and cleans its temporary root", async () => {
  const root = tempRoot("folio-lv4-go-ops-cli-");
  const cli = startCli(root);

  cli.send({ id: "p1", command: "status" });
  expect(await cli.next()).toMatchObject({
    id: "p1",
    ok: true,
    result: { workspaceId: LV4_GO_OPS_WORKSPACE_ID, devices: [] },
  });
  cli.send({ id: "p2", command: "register", clientId: "client-a" });
  expect(await cli.next()).toEqual({
    id: "p2",
    ok: true,
    result: { clientId: "client-a" },
  });
  cli.send({ id: "p3", command: "status" });
  expect(await cli.next()).toMatchObject({
    id: "p3",
    ok: true,
    result: { devices: [{ clientId: "client-a", state: "active" }] },
  });
  cli.send({ id: "p4", command: "revoke", clientId: "client-a" });
  expect(await cli.next()).toEqual({
    id: "p4",
    ok: true,
    result: { clientId: "client-a" },
  });
  cli.send({ id: "p5", command: "status" });
  expect(await cli.next()).toMatchObject({
    id: "p5",
    ok: true,
    result: { devices: [{ clientId: "client-a", state: "revoked" }] },
  });
  cli.send({ id: "p6", command: "nope" });
  expect(await cli.next()).toEqual({
    id: "p6",
    ok: false,
    error: "invalid-command",
  });
  cli.send("not-json");
  expect(await cli.next()).toEqual({
    id: null,
    ok: false,
    error: "invalid-json",
  });
  cli.send(
    JSON.stringify({
      id: "p7",
      command: "status",
      padding: "x".repeat(LV4_GO_OPS_MAX_LINE_BYTES),
    }),
  );
  expect(await cli.next()).toEqual({
    id: null,
    ok: false,
    error: "line-too-large",
  });
  // The input reader must discard an oversized line before parsing it and
  // recover at the next newline rather than buffering the entire line.
  cli.send("x".repeat(1_000_000));
  expect(await cli.next()).toEqual({id: null, ok: false, error: "line-too-large"});
  cli.send({ id: "p8", command: "status" });
  expect(await cli.next()).toMatchObject({ id: "p8", ok: true });

  expect(cli.stdout()).not.toMatch(
    /token|secret|credential|authorization/i,
  );
  expect(cli.stdout()).not.toMatch(/[A-Za-z0-9_-]{43}/);
  expect(cli.stdout()).not.toMatch(/https?:\/\//);
  expect(cli.stderr()).toBe("");

  cli.end();
  expect(await withTimeout(cli.exit, "lv4-go-ops-cli-exit-timeout")).toEqual({
    code: 0,
    signal: null,
  });
  expect(
    readdirSync(root).filter((name) => name.startsWith("folio-lv4-ops-")),
  ).toEqual([]);
}, 20_000);

it("refuses argv so credentials cannot be supplied by argument", () => {
  const root = tempRoot("folio-lv4-go-ops-args-");
  const marker = "not-a-real-credential";
  const result = spawnSync(process.execPath, [cliPath, `--token=${marker}`], {
    cwd: root,
    env: childEnv(root),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status).toBe(2);
  expect(String(result.stdout ?? "")).toBe("");
  expect(String(result.stderr ?? "")).toContain("arguments are not accepted");
  expect(String(result.stderr ?? "")).not.toContain(marker);
  expect(
    readdirSync(root).filter((name) => name.startsWith("folio-lv4-ops-")),
  ).toEqual([]);
}, 20_000);
