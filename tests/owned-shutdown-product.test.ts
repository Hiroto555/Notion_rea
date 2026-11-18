import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { finishWorkspaceQuit } from "../src/main/workspace-quit";
import {
  installProductOwnedShutdown,
  OWNED_SHUTDOWN_DATA_DIR_ENV,
  OWNED_SHUTDOWN_OPT_IN_ENV,
  OWNED_SHUTDOWN_REQUEST_ENV,
  type ProductShutdownLifecycle,
} from "../src/main/owned-shutdown";
// @ts-ignore - untyped ESM owned-shutdown core; imported for unit tests only.
import * as owned from "../scripts/gui-owned-shutdown.mjs";
// @ts-ignore - untyped ESM monitor source module; imported for unit tests only.
import { OWNED_SHUTDOWN_MONITOR_SOURCE } from "../scripts/owned-shutdown-monitor.mjs";

const SCOPE = "PIPE_CLOSED_AFTER_ACCEPTED_QUIT";
const MARKER = "--shutdown-monitor-stdin-v1";

// A small pinned fixture binary stands in for the Node executable: hashing a
// real interpreter is unnecessary for the source contract and the fixture is
// guaranteed single-linked.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "folio-owned-fixture-"));
const NODE_EXE = join(FIXTURE_DIR, "node");
writeFileSync(NODE_EXE, "fixture-node-bytes");
const NODE_SHA256 = createHash("sha256")
  .update("fixture-node-bytes")
  .digest("hex");

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function freshRunRoot(): string {
  return mkdtempSync(join(tmpdir(), "folio-owned-run-"));
}

function freshDataDir(): string {
  return mkdtempSync(join(tmpdir(), "folio-owned-data-"));
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    runId: "run-owned-1",
    runRoot: freshRunRoot(),
    nodeExe: NODE_EXE,
    nodeSha256: NODE_SHA256,
    timeoutMs: 5_000,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  unref(): void {}
}

type SpawnCall = readonly [string, string[], Record<string, unknown>];

function fakeSpawn(): {
  spawn: (...args: unknown[]) => ChildProcess;
  calls: SpawnCall[];
  child: FakeChild;
  written: string[];
} {
  const calls: SpawnCall[] = [];
  const child = new FakeChild();
  const written: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => written.push(chunk.toString()));
  const spawn = vi.fn(
    (command: string, args: string[], options: Record<string, unknown>) => {
      calls.push([command, args, options]);
      return child as unknown as ChildProcess;
    },
  ) as unknown as (...args: unknown[]) => ChildProcess;
  return { spawn, calls, child, written };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Writes genuinely matching worker evidence (raw stdin bytes + bound receipt)
// into a session root created by startOwnedShutdownSession. The on-disk
// intent.json written before spawn is the binding source of truth.
function writeWorkerEvidence(
  sessionRoot: string,
  overrides: {
    status?: string;
    code?: string;
    acceptedQuitSeen?: boolean;
    malformed?: boolean;
    rawSaved?: boolean;
    rawTruncated?: boolean;
    rawSha256?: string | null;
    rawBytes?: number;
    acceptedNonce?: string;
    lines?: string[];
  } = {},
) {
  const intent = JSON.parse(
    readFileSync(join(sessionRoot, "intent.json"), "utf8"),
  ) as Record<string, unknown>;
  const acceptedLine = JSON.stringify({
    v: 1,
    type: "accepted-quit",
    runId: intent.runId,
    sessionId: intent.sessionId,
    nonce: overrides.acceptedNonce ?? intent.nonce,
  });
  const lines = overrides.lines ?? [
    JSON.stringify(intent),
    acceptedLine,
  ];
  const raw = Buffer.from(lines.map((l) => `${l}\n`).join(""), "utf8");
  const rawSaved = overrides.rawSaved ?? true;
  if (rawSaved) writeFileSync(join(sessionRoot, "stdin-raw.bin"), raw);
  const receipt = {
    v: 1,
    status: overrides.status ?? "COMPLETED",
    code: overrides.code ?? "PIPE_CLOSED_AFTER_ACCEPTED_QUIT",
    scope: SCOPE,
    runId: intent.runId,
    sessionId: intent.sessionId,
    nonce: intent.nonce,
    timeoutMs: intent.timeoutMs,
    acceptedQuitSeen: overrides.acceptedQuitSeen ?? true,
    malformed: overrides.malformed ?? false,
    rawSaved,
    rawTruncated: overrides.rawTruncated ?? false,
    rawSha256:
      overrides.rawSha256 !== undefined
        ? overrides.rawSha256
        : sha256(raw),
    rawBytes: overrides.rawBytes ?? raw.length,
    productResult: "NOT_RUN",
    physical: "NOT_RUN",
  };
  writeFileSync(
    join(sessionRoot, "receipt.json"),
    JSON.stringify(receipt),
  );
  return receipt;
}

function fakeLifecycle(): {
  lifecycle: ProductShutdownLifecycle;
  listeners: Map<string, () => void>;
} {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    lifecycle: {
      once(event: "quit", listener: () => void) {
        listeners.set(event, listener);
      },
    },
  };
}

function armedEnv(dataDir: string): NodeJS.ProcessEnv {
  return {
    [OWNED_SHUTDOWN_OPT_IN_ENV]: "1",
    [OWNED_SHUTDOWN_REQUEST_ENV]: JSON.stringify(request()),
    [OWNED_SHUTDOWN_DATA_DIR_ENV]: dataDir,
  };
}

describe("installProductOwnedShutdown gating", () => {
  it("requires native proof of the actual Windows data directory and rechecks its full identity at quit", () => {
    const dataDir = freshDataDir(), env = armedEnv(dataDir), startSession = vi.fn(() => ({acceptedQuit: vi.fn(), observation: async () => ({})}));
    const absent = installProductOwnedShutdown(fakeLifecycle().lifecycle, {env, untrustedTest: {platform: "win32", startSession}});
    expect(absent.status).toBe("REJECTED"); expect(startSession).not.toHaveBeenCalled();
    const denied = installProductOwnedShutdown(fakeLifecycle().lifecycle, {env, untrustedTest: {platform: "win32", startSession,
      nativeDirectoryProof() {throw new Error("DACL_EVERYONE_WRITABLE");}}});
    expect(denied.status).toBe("REJECTED"); expect(startSession).not.toHaveBeenCalled();
    let fileId = "a".repeat(32);
    const {lifecycle, listeners} = fakeLifecycle();
    const valid = installProductOwnedShutdown(lifecycle, {env, untrustedTest: {platform: "win32", startSession,
      nativeDirectoryProof(path) {return {canonicalPath: realpathSync(path), fileId, volumeId: "b".repeat(16)};}}});
    expect(valid.status).toBe("ARMED"); expect(startSession).toHaveBeenCalledTimes(1);
    fileId = "c".repeat(32); listeners.get("quit")!();
    expect(startSession.mock.results[0].value.acceptedQuit).not.toHaveBeenCalled();
    const positive = fakeLifecycle();
    const unchanged = installProductOwnedShutdown(positive.lifecycle, {env, untrustedTest: {platform: "win32", startSession,
      nativeDirectoryProof(path) {return {canonicalPath: realpathSync(path), fileId, volumeId: "b".repeat(16)};}}});
    expect(unchanged.status).toBe("ARMED"); positive.listeners.get("quit")!();
    expect(startSession.mock.results[1].value.acceptedQuit).toHaveBeenCalledTimes(1);
  });
  it("stays disabled without the exact opt-in and never spawns", () => {
    const { lifecycle, listeners } = fakeLifecycle();
    const startSession = vi.fn();
    const handle = installProductOwnedShutdown(lifecycle, {
      env: {
        [OWNED_SHUTDOWN_REQUEST_ENV]: JSON.stringify(request()),
        [OWNED_SHUTDOWN_DATA_DIR_ENV]: freshDataDir(),
      },
      untrustedTest: { startSession },
    });
    expect(handle.status).toBe("NOT_RUN");
    expect(handle.code).toBe("OPT_IN_MISSING");
    expect(handle.observation()).toBeNull();
    expect(startSession).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("stays disabled without a request and does not register a quit listener", () => {
    const { lifecycle, listeners } = fakeLifecycle();
    const handle = installProductOwnedShutdown(lifecycle, {
      env: {
        [OWNED_SHUTDOWN_OPT_IN_ENV]: "1",
        [OWNED_SHUTDOWN_DATA_DIR_ENV]: freshDataDir(),
      },
    });
    expect(handle.status).toBe("NOT_RUN");
    expect(handle.code).toBe("REQUEST_ABSENT");
    expect(listeners.size).toBe(0);
  });

  it.each([
    ["malformed JSON", { request: "{not-json", code: "REQUEST_JSON" }],
    ["unparseable expiry", { request: { v: 1, expiresAt: "never" }, code: "REQUEST_EXPIRY" }],
  ])("rejects a %s request before any spawn", (_label, c) => {
    const { lifecycle } = fakeLifecycle();
    const startSession = vi.fn();
    const handle = installProductOwnedShutdown(lifecycle, {
      env: {
        [OWNED_SHUTDOWN_OPT_IN_ENV]: "1",
        [OWNED_SHUTDOWN_REQUEST_ENV]:
          typeof c.request === "string" ? c.request : JSON.stringify(c.request),
        [OWNED_SHUTDOWN_DATA_DIR_ENV]: freshDataDir(),
      },
      untrustedTest: { startSession },
    });
    expect(handle.status).toBe("REJECTED");
    expect(handle.code).toBe(c.code);
    expect(startSession).not.toHaveBeenCalled();
  });

  it("rejects an expired request using the current clock", () => {
    const { lifecycle } = fakeLifecycle();
    const startSession = vi.fn();
    const handle = installProductOwnedShutdown(lifecycle, {
      env: {
        [OWNED_SHUTDOWN_OPT_IN_ENV]: "1",
        [OWNED_SHUTDOWN_REQUEST_ENV]: JSON.stringify(
          request({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
        ),
        [OWNED_SHUTDOWN_DATA_DIR_ENV]: freshDataDir(),
      },
      untrustedTest: { startSession },
    });
    expect(handle.status).toBe("REJECTED");
    expect(handle.code).toBe("REQUEST_EXPIRED");
    expect(startSession).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["relative", "workspace"],
    ["outside temp", "/"],
  ])("rejects a %s FOLIO_DATA_DIR before session start", (_label, dataDir) => {
    const { lifecycle } = fakeLifecycle();
    const startSession = vi.fn();
    const env: NodeJS.ProcessEnv = {
      [OWNED_SHUTDOWN_OPT_IN_ENV]: "1",
      [OWNED_SHUTDOWN_REQUEST_ENV]: JSON.stringify(request()),
    };
    if (dataDir !== undefined) env[OWNED_SHUTDOWN_DATA_DIR_ENV] = dataDir;
    const handle = installProductOwnedShutdown(lifecycle, {
      env,
      untrustedTest: { startSession },
    });
    expect(handle.status).toBe("REJECTED");
    expect(handle.code).toMatch(/^DATA_DIR/);
    expect(startSession).not.toHaveBeenCalled();
  });
});

describe("installProductOwnedShutdown lifecycle", () => {
  it("arms exactly once on a live request and acceptedQuit does not end stdin", async () => {
    const { lifecycle, listeners } = fakeLifecycle();
    const { spawn, calls, child, written } = fakeSpawn();
    const startSession = vi.fn((req: unknown) =>
      owned.startOwnedShutdownSession(req, {
        untrustedTest: { spawn },
        receiptPollMs: 10,
        observationGraceMs: 10,
      }),
    );
    const handle = installProductOwnedShutdown(lifecycle, {
      env: armedEnv(freshDataDir()),
      untrustedTest: { startSession },
    });
    expect(handle.status).toBe("ARMED");
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    expect(listeners.has("quit")).toBe(true);
    await tick();
    expect(child.stdin.writableEnded).toBe(false);

    const quit = listeners.get("quit")!;
    quit();
    quit(); // Electron fires the non-vetoable event at most once; stay safe anyway.
    await tick();
    const messages = written
      .join("")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const accepted = messages.filter(
      (message) => message.type === "accepted-quit",
    );
    expect(accepted).toHaveLength(1);
    const session = startSession.mock.results[0]?.value;
    expect(accepted[0]).toMatchObject({
      v: 1,
      runId: session.runId,
      sessionId: session.sessionId,
      nonce: session.nonce,
    });
    expect(calls).toHaveLength(1);
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.stdin.destroyed).toBe(false);
    // The public handle exposes no acceptedQuit(): only the lifecycle event
    // may notify. A second quit fire stays idempotent inside the session.
    quit();
    await tick();
    expect(
      written
        .join("")
        .split("\n")
        .filter((line) => line.includes('"accepted-quit"')),
    ).toHaveLength(1);
  });

  it.each([
    [
      "mutated request env",
      (env: NodeJS.ProcessEnv) => {
        env[OWNED_SHUTDOWN_REQUEST_ENV] = JSON.stringify(
          request({ runId: "run-owned-2" }),
        );
      },
    ],
    [
      "expired authorization",
      (_env: NodeJS.ProcessEnv) => {
        const t = Date.now();
        vi.spyOn(Date, "now").mockImplementation(() => t + 120_000);
      },
    ],
  ])(
    "does not notify on quit when the current %s no longer matches",
    (_label, sabotage) => {
      const { lifecycle, listeners } = fakeLifecycle();
      const acceptedQuit = vi.fn();
      const startSession = vi.fn(() => ({
        acceptedQuit,
        observation: () => Promise.resolve(null),
      }));
      const env = armedEnv(freshDataDir());
      installProductOwnedShutdown(lifecycle, {
        env,
        untrustedTest: { startSession },
      });
      sabotage(env);
      listeners.get("quit")!();
      expect(acceptedQuit).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    },
  );

  it("keeps the monitor untouched on a held restart quit and closes neither store nor monitor", () => {
    const { lifecycle, listeners } = fakeLifecycle();
    const acceptedQuit = vi.fn();
    const startSession = vi.fn(() => ({
      acceptedQuit,
      observation: () => Promise.resolve(null),
    }));
    const handle = installProductOwnedShutdown(lifecycle, {
      env: armedEnv(freshDataDir()),
      untrustedTest: { startSession },
    });
    expect(handle.status).toBe("ARMED");

    const preventQuit = vi.fn();
    const reopenWindow = vi.fn();
    const closeStore = vi.fn();
    const outcome = finishWorkspaceQuit({
      commitRestart: () => "blocked",
      preventQuit,
      reopenWindow,
      closeStore,
    });
    expect(outcome).toBe("held");
    expect(preventQuit).toHaveBeenCalledOnce();
    expect(reopenWindow).toHaveBeenCalledOnce();
    // A held quit never reaches the non-vetoable "quit" event: neither the
    // store nor the monitor is closed or notified.
    expect(closeStore).not.toHaveBeenCalled();
    expect(acceptedQuit).not.toHaveBeenCalled();
  });

  it("notifies the monitor only on the accepted quit after committed/not-prepared close", () => {
    for (const outcome of ["committed", "not-prepared"] as const) {
      const { lifecycle, listeners } = fakeLifecycle();
      const acceptedQuit = vi.fn();
      const startSession = vi.fn(() => ({
        acceptedQuit,
        observation: () => Promise.resolve(null),
      }));
      installProductOwnedShutdown(lifecycle, {
        env: armedEnv(freshDataDir()),
        untrustedTest: { startSession },
      });
      const closeStore = vi.fn();
      expect(
        finishWorkspaceQuit({
          commitRestart: () => outcome,
          preventQuit: vi.fn(),
          reopenWindow: vi.fn(),
          closeStore,
        }),
      ).toBe("quit");
      expect(closeStore).toHaveBeenCalledOnce();
      listeners.get("quit")!();
      expect(acceptedQuit).toHaveBeenCalledTimes(1);
    }
  });
});

describe("startOwnedShutdownSession POSIX fixed route", () => {
  it("spawns Node with exactly the fixed script, no child argv and a minimal env", async () => {
    const { spawn, calls, written } = fakeSpawn();
    const req = request();
    const session = owned.startOwnedShutdownSession(req, {
      untrustedTest: { spawn },
      receiptPollMs: 10,
    });
    expect(session.status).toBe("STARTED");
    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0];
    expect(command).toBe(NODE_EXE);
    expect(args).toHaveLength(1);
    expect(args[0]).toBe(session.scriptPath);
    expect(session.scriptPath.startsWith(session.sessionRoot)).toBe(true);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.cwd).toBe(session.sessionRoot);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    const env = options.env as Record<string, string>;
    for (const key of Object.keys(env))
      expect(key).not.toMatch(/FOLIO|NODE_OPTIONS|ELECTRON|TOKEN|SECRET|PASSWORD|API/i);
    expect(env.TEMP).toBe(session.sessionRoot);
    expect(env.TMP).toBe(session.sessionRoot);
    expect(env.TMPDIR).toBe(session.sessionRoot);

    // Immutable evidence is written before spawn: fixed source, intent, attempt.
    expect(existsSync(session.sessionRoot)).toBe(true);
    expect(readFileSync(session.scriptPath, "utf8")).toBe(
      OWNED_SHUTDOWN_MONITOR_SOURCE,
    );
    expect(existsSync(join(session.sessionRoot, "intent.json"))).toBe(true);
    expect(existsSync(join(session.sessionRoot, "attempt.json"))).toBe(true);

    await tick();
    const init = JSON.parse(written.join("").split("\n")[0]) as Record<
      string,
      unknown
    >;
    expect(init).toMatchObject({
      v: 1,
      type: "init",
      runId: req.runId,
      sessionId: session.sessionId,
      nonce: session.nonce,
      timeoutMs: req.timeoutMs,
      tempRoot: session.sessionRoot,
    });
    expect(init.scriptHash).toBe(
      sha256(readFileSync(session.scriptPath)),
    );
  });

  it("rejects request mismatches before spawn: temp root, expiry, hash, nonce fields", () => {
    const base = request();
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["runRoot outside tmp", { runRoot: "/" }, /RUN_ROOT/],
      ["missing runRoot", { runRoot: join(tmpdir(), "no-such-dir-x9") }, /RUN_ROOT/],
      ["expired", { expiresAt: new Date(Date.now() - 1).toISOString() }, /REQUEST_EXPIRED/],
      ["bad node hash", { nodeSha256: "0".repeat(64) }, /NODE_HASH_MISMATCH/],
      ["bad runId label", { runId: "bad id!" }, /REQUEST_RUN_ID/],
      ["timeout over bound", { timeoutMs: 300_001 }, /REQUEST_TIMEOUT/],
      ["relative nodeExe", { nodeExe: "bin/node" }, /NODE_PATH/],
      ["extra key", { extra: true }, /REQUEST_SCHEMA/],
    ];
    for (const [_label, overrides, code] of cases) {
      const { spawn, calls } = fakeSpawn();
      expect(() =>
        owned.startOwnedShutdownSession(
          { ...base, ...overrides },
          { untrustedTest: { spawn } },
        ),
        _label,
      ).toThrow(code);
      expect(calls, _label).toHaveLength(0);
    }
  });
  it("rechecks expiry immediately before dispatch and retains the undispatched attempt", () => {
    const time = Date.now(), {spawn, calls} = fakeSpawn();
    const value = request({expiresAt: new Date(time + 1000).toISOString()});
    let clockReads = 0;
    expect(() => owned.startOwnedShutdownSession(value, {untrustedTest: {spawn, now: () => clockReads++ === 0 ? time : time + 2000}})).toThrow(/REQUEST_EXPIRED/);
    expect(calls).toHaveLength(0);
    const sessions = readdirSync(value.runRoot).filter(name => name.startsWith("session-"));
    expect(sessions).toHaveLength(1);
    expect(existsSync(join(value.runRoot, sessions[0], "attempt.json"))).toBe(true);
  });
});

describe("startOwnedShutdownSession observation", () => {
  it("resolves COMPLETED when the pipe closes after an accepted quit receipt", async () => {
    const { spawn, child } = fakeSpawn();
    const req = request();
    const session = owned.startOwnedShutdownSession(req, {
      untrustedTest: { spawn },
      receiptPollMs: 10,
      observationGraceMs: 10,
    });
    session.acceptedQuit();
    writeWorkerEvidence(session.sessionRoot);
    child.emit("close", 0, null);
    const observation = await session.observation();
    expect(observation.status).toBe("COMPLETED");
    expect(observation.code).toBe("PIPE_CLOSED_AFTER_ACCEPTED_QUIT");
    expect(observation.scope).toBe(SCOPE);
    expect(observation.receipt).toMatchObject({
      status: "COMPLETED",
      runId: req.runId,
      sessionId: session.sessionId,
      nonce: session.nonce,
      timeoutMs: req.timeoutMs,
    });
    expect(observation.cleanupConfirmed).toBe(true);
    expect(observation.productResult).toBe("NOT_RUN");
    expect(observation.physical).toBe("NOT_RUN");
    expect(child.killed).toBe(false);
  });

  it("retains UNKNOWN when the pipe closes without an accepted-quit receipt", async () => {
    const { spawn, child } = fakeSpawn();
    const session = owned.startOwnedShutdownSession(request(), {
      untrustedTest: { spawn },
      receiptPollMs: 10,
      observationGraceMs: 10,
    });
    child.emit("close", 0, null);
    const observation = await session.observation();
    expect(observation.status).toBe("UNKNOWN");
    expect(observation.code).toBe("RECEIPT_MISSING");
    expect(observation.receipt).toBeNull();
    expect(child.killed).toBe(false);
  });

  it("retains UNKNOWN on tampered evidence: malformed, wrong nonce, missing raw, false flags", async () => {
    const cases: Array<[string, (root: string) => void, RegExp]> = [
      [
        "malformed receipt",
        (root) => writeFileSync(join(root, "receipt.json"), "{malformed"),
        /RECEIPT_MISMATCH/,
      ],
      [
        "wrong nonce in raw accepted line",
        (root) => writeWorkerEvidence(root, { acceptedNonce: "foreign" }),
        /RAW_MISMATCH/,
      ],
      [
        "missing raw evidence",
        (root) => writeWorkerEvidence(root, { rawSaved: false }),
        /RECEIPT_INCOMPLETE|RAW_MISSING/,
      ],
      [
        "raw hash mismatch",
        (root) => writeWorkerEvidence(root, { rawSha256: "0".repeat(64) }),
        /RAW_MISMATCH/,
      ],
      [
        "raw length mismatch",
        (root) => writeWorkerEvidence(root, { rawBytes: 5 }),
        /RAW_MISMATCH/,
      ],
      [
        "acceptedQuitSeen false",
        (root) => writeWorkerEvidence(root, { acceptedQuitSeen: false }),
        /RECEIPT_INCOMPLETE/,
      ],
      [
        "truncated raw flag",
        (root) => writeWorkerEvidence(root, { rawTruncated: true }),
        /RECEIPT_INCOMPLETE/,
      ],
      [
        "tampered attempt argv",
        (root) => {
          writeWorkerEvidence(root);
          const attemptPath = join(root, "attempt.json");
          const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
          writeFileSync(
            attemptPath,
            JSON.stringify({ ...attempt, argv: ["evil.mjs"] }),
          );
        },
        /ATTEMPT_MISMATCH/,
      ],
    ];
    for (const [label, plant, code] of cases) {
      const { spawn, child } = fakeSpawn();
      const session = owned.startOwnedShutdownSession(request(), {
        untrustedTest: { spawn },
        receiptPollMs: 10,
        observationGraceMs: 10,
      });
      plant(session.sessionRoot);
      child.emit("close", 0, null);
      const observation = await session.observation();
      expect(observation.status, label).toBe("UNKNOWN");
      expect(observation.code, label).toMatch(code);
      expect(child.killed, label).toBe(false);
    }
  });

  it("never promotes a valid receipt to COMPLETED on a nonzero or signalled child", async () => {
    for (const [code, signal] of [
      [1, null],
      [null, "SIGKILL"],
    ] as const) {
      const { spawn, child } = fakeSpawn();
      const session = owned.startOwnedShutdownSession(request(), {
        untrustedTest: { spawn },
        receiptPollMs: 10,
        observationGraceMs: 10,
      });
      session.acceptedQuit();
      writeWorkerEvidence(session.sessionRoot);
      child.emit("close", code, signal);
      const observation = await session.observation();
      expect(observation.status).toBe("UNKNOWN");
      expect(observation.code).toBe("DISPATCH_INCOMPLETE");
      expect(observation.cleanupConfirmed).toBe(false);
    }
  });

  it("times out only its own spawned handle past the bounded deadline", async () => {
    const { spawn, child, calls } = fakeSpawn();
    const session = owned.startOwnedShutdownSession(
      request({ timeoutMs: 20 }),
      {
        untrustedTest: { spawn },
        receiptPollMs: 10,
        observationGraceMs: 10,
      },
    );
    const observation = await session.observation();
    expect(observation.status).toBe("TIMED_OUT");
    expect(observation.code).toBe("OBSERVATION_DEADLINE");
    expect(child.killed).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("retains UNKNOWN with the attempt preserved on a postdispatch error and never resends", async () => {
    const { spawn, child, calls } = fakeSpawn();
    const session = owned.startOwnedShutdownSession(request(), {
      untrustedTest: { spawn },
      receiptPollMs: 10,
      observationGraceMs: 10,
    });
    session.acceptedQuit();
    child.emit("error", new Error("pipe gone"));
    const observation = await session.observation();
    expect(observation.status).toBe("UNKNOWN");
    expect(observation.dispatchError).toContain("pipe gone");
    expect(calls).toHaveLength(1);
    // One attempt only: the immutable attempt and intent stay on disk.
    const attempt = JSON.parse(
      readFileSync(join(session.sessionRoot, "attempt.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(attempt).toMatchObject({
      runId: session.runId,
      sessionId: session.sessionId,
      nonce: session.nonce,
    });
    expect(existsSync(join(session.sessionRoot, "intent.json"))).toBe(true);
  });

  it("retains UNKNOWN when spawn itself fails before dispatch", async () => {
    const spawn = vi.fn(() => {
      throw new Error("ENOENT");
    });
    const req = request();
    const session = owned.startOwnedShutdownSession(req, {
      untrustedTest: { spawn: spawn as never },
      receiptPollMs: 10,
    });
    expect(session.status).toBe("UNKNOWN");
    const observation = await session.observation();
    expect(observation.status).toBe("UNKNOWN");
    expect(observation.code).toBe("SPAWN_FAILED");
    expect(existsSync(join(session.sessionRoot, "attempt.json"))).toBe(true);
  });
});

describe("startOwnedShutdownSession Windows helper route (simulated)", () => {
  function windowsFixture() {
    const dir = freshRunRoot();
    const nodePath = join(dir, "node.exe");
    const helperPath = join(dir, "OwnedNodeJob.exe");
    writeFileSync(nodePath, "fake-node-bytes");
    writeFileSync(helperPath, "fake-helper-bytes");
    return {
      dir,
      nodePath,
      helperPath,
      nodeSha256: sha256("fake-node-bytes"),
      helperSha256: sha256("fake-helper-bytes"),
    };
  }

  it("launches the pinned helper with five fields plus the exact marker", () => {
    const fixture = windowsFixture();
    const { spawn, calls } = fakeSpawn();
    const req = request({
      runRoot: fixture.dir,
      nodeExe: fixture.nodePath,
      nodeSha256: fixture.nodeSha256,
      windows: {
        helperPath: fixture.helperPath,
        helperSha256: fixture.helperSha256,
      },
    });
    const session = owned.startOwnedShutdownSession(req, {
      untrustedTest: { spawn, platform: "win32" },
      receiptPollMs: 10,
    });
    expect(session.route).toBe("windows-helper");
    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0];
    expect(command).toBe(fixture.helperPath);
    expect(args).toHaveLength(6);
    expect(args[0]).toBe(fixture.nodePath);
    expect(args[1]).toBe(session.scriptPath);
    expect(args[2]).toBe(session.sessionRoot);
    expect(args[3]).toBe(session.nonce);
    expect(args[4]).toBe(String(req.timeoutMs));
    expect(args[5]).toBe(MARKER);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(session.sessionRoot);
  });

  it("requires the pinned helper config and hashes on the win32 route", () => {
    const fixture = windowsFixture();
    const { spawn, calls } = fakeSpawn();
    expect(() =>
      owned.startOwnedShutdownSession(
        request({
          runRoot: fixture.dir,
          nodeExe: fixture.nodePath,
          nodeSha256: fixture.nodeSha256,
        }),
        { untrustedTest: { spawn, platform: "win32" } },
      ),
    ).toThrow(/WINDOWS_HELPER_CONFIG/);
    expect(() =>
      owned.startOwnedShutdownSession(
        request({
          runRoot: fixture.dir,
          nodeExe: fixture.nodePath,
          nodeSha256: fixture.nodeSha256,
          windows: {
            helperPath: fixture.helperPath,
            helperSha256: "0".repeat(64),
          },
        }),
        { untrustedTest: { spawn, platform: "win32" } },
      ),
    ).toThrow(/HELPER_HASH_MISMATCH/);
    expect(calls).toHaveLength(0);
  });
});

describe("monitor worker source contract", () => {
  it("is self-contained, fixed and argument-free", () => {
    expect(typeof OWNED_SHUTDOWN_MONITOR_SOURCE).toBe("string");
    expect(OWNED_SHUTDOWN_MONITOR_SOURCE).toContain("process.argv.length !== 2");
    expect(OWNED_SHUTDOWN_MONITOR_SOURCE).toContain('"accepted-quit"');
    expect(OWNED_SHUTDOWN_MONITOR_SOURCE).toContain(SCOPE);
    // The worker never launches, attaches, or kills: no child_process and no
    // process.kill in the embedded source.
    expect(OWNED_SHUTDOWN_MONITOR_SOURCE).not.toMatch(
      /child_process|process\.kill|execSync|spawn\(/,
    );
  });
});

// The following cases execute the embedded worker in a disposable real Node
// interpreter (process.execPath) with its fixed source written into a private
// tmp session root — source-level contract checks run by the parent vitest
// pass, NOT Windows/Electron proof. EOF is simulated by closing the child
// stdin in this test only; production never ends monitor stdin.
describe("owned-shutdown monitor worker (real disposable Node)", () => {
  const scriptHash = sha256(OWNED_SHUTDOWN_MONITOR_SOURCE);

  function workerRoot() {
    const runRoot = mkdtempSync(join(tmpdir(), "folio-owned-run-"));
    const sessionRoot = mkdtempSync(join(runRoot, "session-"));
    const scriptPath = join(sessionRoot, "monitor.mjs");
    writeFileSync(scriptPath, OWNED_SHUTDOWN_MONITOR_SOURCE, {
      mode: 0o500,
    });
    const intent = {
      v: 1,
      type: "init",
      runId: "run-worker",
      sessionId: "s-worker",
      nonce: "n-worker",
      runRoot: realpathSync(runRoot),
      approvedTempParent: realpathSync(tmpdir()),
      tempRoot: realpathSync(sessionRoot),
      scriptHash,
      timeoutMs: 2_000,
    };
    writeFileSync(
      join(sessionRoot, "intent.json"),
      JSON.stringify(intent) + "\n",
    );
    return { runRoot, sessionRoot, scriptPath, intent };
  }

  function runWorker(
    root: ReturnType<typeof workerRoot>,
    options: { args?: string[] } = {},
  ) {
    const child = nodeSpawn(
      process.execPath,
      [root.scriptPath, ...(options.args ?? [])],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.on("error", () => {}); // EPIPE on early worker exit is expected.
    const closed = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) =>
        child.on("close", (code, signal) => resolve({ code, signal })),
    );
    return { child, closed };
  }

  const acceptedLine = (intent: Record<string, unknown>, nonce?: string) =>
    JSON.stringify({
      v: 1,
      type: "accepted-quit",
      runId: intent.runId,
      sessionId: intent.sessionId,
      nonce: nonce ?? intent.nonce,
    }) + "\n";

  function readReceipt(sessionRoot: string) {
    return JSON.parse(
      readFileSync(join(sessionRoot, "receipt.json"), "utf8"),
    ) as Record<string, unknown>;
  }

  it("accepts a bound init + accepted-quit then owner EOF: COMPLETED receipt", async () => {
    const root = workerRoot();
    const { child, closed } = runWorker(root);
    child.stdin.write(JSON.stringify(root.intent) + "\n");
    child.stdin.write(acceptedLine(root.intent));
    child.stdin.end();
    const { code } = await closed;
    expect(code).toBe(0);
    const receipt = readReceipt(root.sessionRoot);
    expect(receipt).toMatchObject({
      status: "COMPLETED",
      code: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT",
      scope: SCOPE,
      nonce: "n-worker",
      acceptedQuitSeen: true,
      malformed: false,
      rawSaved: true,
      rawTruncated: false,
      productResult: "NOT_RUN",
      physical: "NOT_RUN",
    });
    const raw = readFileSync(join(root.sessionRoot, "stdin-raw.bin"));
    expect(sha256(raw)).toBe(receipt.rawSha256);
    expect(raw.length).toBe(receipt.rawBytes);
    expect(raw.toString("utf8")).toContain('"accepted-quit"');
  });

  it("EOF without an accepted message is UNKNOWN, never success", async () => {
    const root = workerRoot();
    const { child, closed } = runWorker(root);
    child.stdin.write(JSON.stringify(root.intent) + "\n");
    child.stdin.end();
    await closed;
    const receipt = readReceipt(root.sessionRoot);
    expect(receipt.status).toBe("UNKNOWN");
    expect(receipt.code).toBe("NO_ACCEPTED_QUIT");
    expect(receipt.acceptedQuitSeen).toBe(false);
  });

  it.each([
    [
      "a trailing partial fragment",
      (i: Record<string, unknown>) =>
        JSON.stringify(i) + "\n" + acceptedLine(i) + "{partial",
    ],
    [
      "a wrong-nonce accepted line",
      (i: Record<string, unknown>) =>
        JSON.stringify(i) + "\n" + acceptedLine(i, "foreign"),
    ],
    [
      "a malformed line",
      (i: Record<string, unknown>) =>
        JSON.stringify(i) + "\nnot-json\n" + acceptedLine(i),
    ],
    [
      "a helper relay-error marker",
      (i: Record<string, unknown>) =>
        JSON.stringify(i) + "\n" + acceptedLine(i) + "OWNED_HELPER_STDIN_ERROR\n",
    ],
  ])("EOF after %s stays UNKNOWN", async (_label, stream) => {
    const root = workerRoot();
    const { child, closed } = runWorker(root);
    child.stdin.write(stream(root.intent));
    child.stdin.end();
    await closed;
    const receipt = readReceipt(root.sessionRoot);
    expect(receipt.status).toBe("UNKNOWN");
    expect(receipt.code).toBe("MALFORMED");
  });

  it("a missing on-disk intent.json rejects init (INIT_INTENT)", async () => {
    const runRoot = mkdtempSync(join(tmpdir(), "folio-owned-run-"));
    const sessionRoot = mkdtempSync(join(runRoot, "session-"));
    const scriptPath = join(sessionRoot, "monitor.mjs");
    writeFileSync(scriptPath, OWNED_SHUTDOWN_MONITOR_SOURCE, { mode: 0o500 });
    const intent = {
      v: 1,
      type: "init",
      runId: "run-worker",
      sessionId: "s-worker",
      nonce: "n-worker",
      runRoot: realpathSync(runRoot),
      approvedTempParent: realpathSync(tmpdir()),
      tempRoot: realpathSync(sessionRoot),
      scriptHash,
      timeoutMs: 2_000,
    };
    const child = nodeSpawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<{ code: number | null }>((resolve) =>
      child.on("close", (code) => resolve({ code })),
    );
    child.stdin.write(JSON.stringify(intent) + "\n");
    child.stdin.end();
    const { code } = await closed;
    expect(code).not.toBe(0);
    expect(existsSync(join(sessionRoot, "receipt.json"))).toBe(false);
    expect(existsSync(join(sessionRoot, "stdin-raw.bin"))).toBe(true);
  });

  it("extra argv exits nonzero with no receipt", async () => {
    const root = workerRoot();
    const { child, closed } = runWorker(root, { args: ["extra"] });
    child.stdin.end();
    const { code } = await closed;
    expect(code).toBe(2);
    expect(existsSync(join(root.sessionRoot, "receipt.json"))).toBe(false);
  });

  it("no EOF inside the bounded deadline produces a TIMED_OUT receipt", async () => {
    const root = workerRoot();
    root.intent.timeoutMs = 250;
    writeFileSync(
      join(root.sessionRoot, "intent.json"),
      JSON.stringify(root.intent) + "\n",
    );
    const { child, closed } = runWorker(root);
    child.stdin.write(JSON.stringify(root.intent) + "\n");
    const { code } = await closed;
    expect(code).toBe(3);
    child.stdin.end();
    const receipt = readReceipt(root.sessionRoot);
    expect(receipt.status).toBe("TIMED_OUT");
    expect(receipt.code).toBe("DEADLINE");
  });
});
