import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore - untyped ESM entrypoints; imported for unit tests only. Spawn
// and the owned-shutdown prepare seam are always injected below.
import * as runner from "../scripts/run-gui-tests.mjs";
// @ts-ignore - untyped ESM owned-shutdown core; imported for unit tests only.
import * as owned from "../scripts/gui-owned-shutdown.mjs";
// @ts-ignore - untyped ESM evidence writer; real intents/raw in temp roots.
import * as packageEvidence from "../scripts/write-evidence-manifest.mjs";
const { captureEvidenceIntent, readEvidenceIntent } = packageEvidence;

const SCOPE = "PIPE_CLOSED_AFTER_ACCEPTED_QUIT";

type SpawnOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: string;
  shell: boolean;
};
type SpawnCall = [string, string[], SpawnOptions];
type FakeChild = EventEmitter & { kill: (...args: unknown[]) => boolean };

function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const child = new EventEmitter() as FakeChild;
  child.kill = () => true;
  const spawn = vi.fn(
    (command: string, args: string[], options: SpawnOptions) => {
      calls.push([command, args, options]);
      return child;
    },
  );
  return { spawn, calls, child };
}

// Creates REAL session artifacts (intent.json, attempt.json, fixed
// monitor.mjs) inside prepared.runRoot via the production session starter,
// so finish() sees genuinely matching evidence — never a weakened fixture.
function genuineSession(prepared: {
  request: unknown;
  runRoot: string;
}): { sessionRoot: string } {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    unref(): void;
    kill(): boolean;
    killed: boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unref = () => {};
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  const session = owned.startOwnedShutdownSession(prepared.request, {
    untrustedTest: { spawn: () => child },
    receiptPollMs: 10,
  });
  return { sessionRoot: session.sessionRoot };
}

// Writes genuinely binding worker evidence (raw bytes + receipt) into a real
// session root; the on-disk intent.json supplies every binding field.
function writeWorkerEvidence(
  sessionRoot: string,
  overrides: Record<string, unknown> = {},
) {
  const intent = JSON.parse(
    readFileSync(join(sessionRoot, "intent.json"), "utf8"),
  ) as Record<string, unknown>;
  const accepted = JSON.stringify({
    v: 1,
    type: "accepted-quit",
    runId: intent.runId,
    sessionId: intent.sessionId,
    nonce: intent.nonce,
  });
  const raw = Buffer.from(
    `${JSON.stringify(intent)}\n${accepted}\n`,
    "utf8",
  );
  writeFileSync(join(sessionRoot, "stdin-raw.bin"), raw);
  const receipt = {
    v: 1,
    status: "COMPLETED",
    code: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT",
    scope: SCOPE,
    runId: intent.runId,
    sessionId: intent.sessionId,
    nonce: intent.nonce,
    timeoutMs: intent.timeoutMs,
    acceptedQuitSeen: true,
    malformed: false,
    rawSaved: true,
    rawTruncated: false,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    rawBytes: raw.length,
    productResult: "NOT_RUN",
    physical: "NOT_RUN",
    ...overrides,
  };
  writeFileSync(join(sessionRoot, "receipt.json"), JSON.stringify(receipt));
  return receipt;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("--owned-shutdown gating", () => {
  it("is refused without the explicit batch mode and never spawns", async () => {
    const { spawn, calls } = fakeSpawn();
    const result = await runner.runGuiTests({
      batch: false,
      args: ["--owned-shutdown"],
      env: {},
      spawn,
      cliPath: "/fake/playwright/cli.js",
      forwardSignals: false,
    });
    expect(result.refused).toBe(true);
    expect(result.code).toBe(1);
    expect(result.message).toContain("--owned-shutdown");
    expect(calls).toHaveLength(0);
  });

  it("cannot be activated by --list under refuse/list mode", async () => {
    for (const args of [
      ["--owned-shutdown", "--list"],
      ["--list", "--owned-shutdown"],
    ]) {
      const { spawn, calls } = fakeSpawn();
      const result = await runner.runGuiTests({
        batch: false,
        args,
        env: {},
        spawn,
        cliPath: "/fake/cli.js",
        forwardSignals: false,
      });
      expect(result.refused, args.join(" ")).toBe(true);
      expect(calls, args.join(" ")).toHaveLength(0);
    }
  });

  it("cannot be combined with the remote Mac acceptance plan", async () => {
    const { spawn, calls } = fakeSpawn();
    const result = await runner.runGuiTests({
      batch: true,
      args: ["--owned-shutdown", "--mac-acceptance-plan", "/tmp/plan.json"],
      env: {},
      spawn,
      cliPath: "/fake/cli.js",
      forwardSignals: false,
    });
    expect(result.refused).toBe(true);
    expect(result.message).toContain("remote Mac");
    expect(calls).toHaveLength(0);
  });

  it("refuses a duplicated --owned-shutdown token before any spawn", async () => {
    const { spawn, calls } = fakeSpawn();
    const prepare = vi.fn();
    const result = await runner.runGuiTests({
      batch: true,
      args: ["--owned-shutdown", "--workers=1", "--owned-shutdown"],
      env: {},
      spawn,
      cliPath: "/fake/cli.js",
      prepare,
      forwardSignals: false,
    });
    expect(result.refused).toBe(true);
    expect(result.message).toContain("at most once");
    expect(prepare).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("refuses before any GUI launch when preparation fails", async () => {
    const { spawn, calls } = fakeSpawn();
    const prepare = vi.fn(async () => {
      const error = new Error("WINDOWS_HELPER_CONFIG: missing pinned helper");
      throw error;
    });
    const result = await runner.runGuiTests({
      batch: true,
      args: ["--owned-shutdown"],
      env: {},
      spawn,
      cliPath: "/fake/cli.js",
      prepare,
      forwardSignals: false,
    });
    expect(result.refused).toBe(true);
    expect(result.message).toContain("WINDOWS_HELPER_CONFIG");
    expect(calls).toHaveLength(0);
  });
});

describe("--owned-shutdown batch wiring", () => {
  it("strips exactly one flag before Playwright and wires the prepared env", async () => {
    const { spawn, calls, child } = fakeSpawn();
    const preparedEnv = {
      PATH: "/bin",
      FOLIO_GUI_TEST_OPT_IN: "1",
      FOLIO_DATA_DIR: "/tmp/owned-workspace",
      FOLIO_OWNED_SHUTDOWN_REQUEST: '{"v":1}',
    };
    const finish = vi.fn(async () => ({
      status: "COMPLETED",
      code: SCOPE,
    }));
    const prepare = vi.fn(async () => ({
      env: preparedEnv,
      runRoot: "/tmp/owned-run",
      finish,
    }));
    const pending = runner.runGuiTests({
      batch: true,
      args: ["--workers=1", "--owned-shutdown", "tests/e2e/app.spec.ts"],
      env: { PATH: "/bin" },
      spawn,
      cliPath: "/fake/playwright/cli.js",
      cwd: "/repo",
      prepare,
      forwardSignals: false,
    });
    await tick();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0];
    expect(command).toBe(process.execPath);
    // Exactly one occurrence stripped; the flag never reaches Playwright.
    expect(args).toEqual([
      "/fake/playwright/cli.js",
      "test",
      "--workers=1",
      "tests/e2e/app.spec.ts",
    ]);
    expect(args).not.toContain("--owned-shutdown");
    expect(options.env).toEqual(preparedEnv);
    expect(options.env.FOLIO_OWNED_SHUTDOWN_REQUEST).toBeDefined();
    expect(options.env.FOLIO_DATA_DIR).toBe("/tmp/owned-workspace");

    // Receipts are awaited after the real child's close, not at exit.
    child.emit("exit", 0, null);
    await tick();
    expect(finish).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    const result = await pending;
    expect(finish).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(0);
    expect(result.refused).toBe(false);
    expect(result.observation).toMatchObject({ status: "COMPLETED" });
  });

  it("preserves the child's nonzero exit and signal regardless of observation", async () => {
    const { spawn, child } = fakeSpawn();
    const finish = vi.fn(async () => ({ status: "COMPLETED" }));
    const prepare = vi.fn(async () => ({ env: {}, finish }));
    const pending = runner.runGuiTests({
      batch: true,
      args: ["--owned-shutdown"],
      env: {},
      spawn,
      cliPath: "/fake/cli.js",
      prepare,
      forwardSignals: false,
    });
    await tick();
    child.emit("close", 7, null);
    const result = await pending;
    expect(result.code).toBe(7);
    expect(result.observation).toMatchObject({ status: "COMPLETED" });
  });

  it("keeps a signal outcome even when observation is unresolved", async () => {
    const { spawn, child } = fakeSpawn();
    const finish = vi.fn(async () => ({ status: "UNKNOWN" }));
    const prepare = vi.fn(async () => ({ env: {}, finish }));
    const pending = runner.runGuiTests({
      batch: true,
      args: ["--owned-shutdown"],
      env: {},
      spawn,
      cliPath: "/fake/cli.js",
      prepare,
      forwardSignals: false,
    });
    await tick();
    child.emit("close", null, "SIGTERM");
    const result = await pending;
    expect(result.signal).toBe("SIGTERM");
    expect(result.code).toBeNull();
  });

  it("maps a zero exit plus UNKNOWN or TIMED_OUT observation to code 1", async () => {
    for (const status of ["UNKNOWN", "TIMED_OUT"]) {
      const { spawn, child } = fakeSpawn();
      const finish = vi.fn(async () => ({ status, code: "RECEIPTS_MISSING" }));
      const prepare = vi.fn(async () => ({ env: {}, finish }));
      const pending = runner.runGuiTests({
        batch: true,
        args: ["--owned-shutdown"],
        env: {},
        spawn,
        cliPath: "/fake/cli.js",
        prepare,
        forwardSignals: false,
      });
      await tick();
      child.emit("close", 0, null);
      const result = await pending;
      expect(result.code, status).toBe(1);
      expect(result.observation, status).toMatchObject({ status });
    }
  });

  it("leaves the ordinary batch route untouched with no request env", async () => {
    const { spawn, calls, child } = fakeSpawn();
    const prepare = vi.fn();
    const pending = runner.runGuiTests({
      batch: true,
      args: ["--workers=1"],
      env: { PATH: "/bin" },
      spawn,
      cliPath: "/fake/playwright/cli.js",
      cwd: "/repo",
      prepare,
      forwardSignals: false,
    });
    await tick();
    expect(prepare).not.toHaveBeenCalled();
    const [, args, options] = calls[0];
    expect(args).toEqual(["/fake/playwright/cli.js", "test", "--workers=1"]);
    expect(options.env.FOLIO_OWNED_SHUTDOWN_REQUEST).toBeUndefined();
    expect(options.env.FOLIO_GUI_TEST_OPT_IN).toBe("1");
    // The ordinary route still resolves at exit, not close.
    child.emit("exit", 0, null);
    const result = await pending;
    expect(result).toMatchObject({ code: 0, refused: false });
    expect(result.observation).toBeUndefined();
  });
});

describe("prepareGuiOwnedShutdown", () => {
  it("creates a private runRoot, disposable FOLIO_DATA_DIR and a frozen request", () => {
    const prepared = owned.prepareGuiOwnedShutdown({
      env: { PATH: "/bin" },
      waitMs: 500,
    });
    const base = realpathSync(tmpdir());
    expect(realpathSync(prepared.runRoot).startsWith(base)).toBe(true);
    expect(prepared.workspace).toBe(join(prepared.runRoot, "workspace"));
    expect(existsSync(prepared.workspace)).toBe(true);

    const env = prepared.env;
    expect(env.FOLIO_GUI_TEST_OPT_IN).toBe("1");
    expect(env.FOLIO_DATA_DIR).toBe(prepared.workspace);
    if (process.platform === "darwin") {
      // Darwin routes through the existing authorized local-batch fixture
      // contract; the fixture's FOLIO_DATA_DIR lands inside runRoot.
      expect(env.FOLIO_LOCAL_GUI_BATCH).toBe("1");
      expect(env.FOLIO_LOCAL_GUI_DATA_ROOT).toBe(prepared.runRoot);
    }
    const request = JSON.parse(env.FOLIO_OWNED_SHUTDOWN_REQUEST);
    expect(request.v).toBe(1);
    expect(request.runRoot).toBe(prepared.runRoot);
    expect(request.nodeExe).toBe(process.execPath);
    expect(request.nodeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(request.timeoutMs).toBeGreaterThanOrEqual(1);
    expect(request.timeoutMs).toBeLessThanOrEqual(300_000);
    expect(Date.parse(request.expiresAt)).toBeGreaterThan(Date.now());
    expect(Object.isFrozen(request) || Object.isFrozen(prepared.request)).toBe(true);
  });

  it("fails before GUI on win32 without the pinned helper configuration", () => {
    for (const env of [
      {},
      { FOLIO_WINDOWS_OWNED_HELPER: "C:\\Folio\\bin\\OwnedNodeJob.exe" },
      {
        FOLIO_WINDOWS_OWNED_HELPER: "C:\\Folio\\bin\\OwnedNodeJob.exe",
        FOLIO_WINDOWS_OWNED_HELPER_SHA256: "not-a-hash",
      },
    ]) {
      expect(() =>
        owned.prepareGuiOwnedShutdown({
          env,
          untrustedTest: { platform: "win32" },
        }),
      ).toThrow(/WINDOWS_HELPER_CONFIG/);
    }
  });

  it("refuses incompatible CI/debug/watch state on the Darwin local batch", () => {
    for (const env of [
      { GITHUB_ACTIONS: "true" },
      { PWDEBUG: "1" },
      { FOLIO_DEV_URL: "http://localhost:3000" },
      { FOLIO_LOCAL_GUI_BATCH: "0" },
    ]) {
      expect(() =>
        owned.prepareGuiOwnedShutdown({
          env,
          untrustedTest: { platform: "darwin" },
        }),
      ).toThrow(/LOCAL_BATCH_POLICY/);
    }
  });

  it("finish() stays UNKNOWN when no session produced a receipt", async () => {
    const prepared = owned.prepareGuiOwnedShutdown({
      env: {},
      waitMs: 50,
    });
    const observation = await prepared.finish();
    expect(observation.status).toBe("UNKNOWN");
    expect(observation.code).toBe("RECEIPTS_MISSING");
    expect(observation.sessions).toHaveLength(0);
    expect(observation.productResult).toBe("NOT_RUN");
  });

  it("finish() resolves COMPLETED only for genuinely matching evidence", async () => {
    const prepared = owned.prepareGuiOwnedShutdown({
      env: {},
      waitMs: 500,
    });
    const { sessionRoot } = genuineSession(prepared);
    writeWorkerEvidence(sessionRoot);
    const observation = await prepared.finish();
    expect(observation.status).toBe("COMPLETED");
    expect(observation.code).toBe(SCOPE);
    expect(observation.sessions).toHaveLength(1);
    expect(observation.sessions[0].sessionRoot).toBe(sessionRoot);
  });

  it("finish() retains UNKNOWN on tampered or foreign evidence", async () => {
    for (const [label, tamper, code] of [
      [
        "malformed receipt",
        (root: string) => {
          writeFileSync(join(root, "receipt.json"), "{nope");
        },
        /RECEIPT_MISMATCH/,
      ],
      [
        "foreign runId in intent",
        (root: string) => {
          const intent = JSON.parse(
            readFileSync(join(root, "intent.json"), "utf8"),
          );
          writeFileSync(
            join(root, "intent.json"),
            JSON.stringify({ ...intent, runId: "foreign" }),
          );
        },
        /INTENT_MISMATCH/,
      ],
      [
        "attempt nonce mismatch",
        (root: string) => {
          const attempt = JSON.parse(
            readFileSync(join(root, "attempt.json"), "utf8"),
          );
          writeFileSync(
            join(root, "attempt.json"),
            JSON.stringify({ ...attempt, nonce: "foreign" }),
          );
        },
        /ATTEMPT_MISMATCH/,
      ],
      [
        "receipt nonce foreign",
        (root: string) => writeWorkerEvidence(root, { nonce: "foreign" }),
        /RECEIPT_MISMATCH|RAW_MISMATCH/,
      ],
      [
        "missing raw evidence",
        (root: string) => {
          const intent = JSON.parse(
            readFileSync(join(root, "intent.json"), "utf8"),
          );
          writeFileSync(
            join(root, "receipt.json"),
            JSON.stringify({
              v: 1,
              status: "COMPLETED",
              code: SCOPE,
              scope: SCOPE,
              runId: intent.runId,
              sessionId: intent.sessionId,
              nonce: intent.nonce,
              timeoutMs: intent.timeoutMs,
              acceptedQuitSeen: true,
              malformed: false,
              rawSaved: true,
              rawTruncated: false,
              rawSha256: "0".repeat(64),
              rawBytes: 10,
              productResult: "NOT_RUN",
              physical: "NOT_RUN",
            }),
          );
          // stdin-raw.bin is simply never written.
        },
        /RAW_MISSING/,
      ],
    ] as const) {
      const prepared = owned.prepareGuiOwnedShutdown({ env: {}, waitMs: 200 });
      const { sessionRoot } = genuineSession(prepared);
      if (label !== "missing raw evidence") writeWorkerEvidence(sessionRoot);
      tamper(sessionRoot);
      const observation = await prepared.finish();
      expect(observation.status, label).toBe("UNKNOWN");
      expect(observation.sessions[0].code, label).toMatch(code);
    }
  });

  it("finish() hits a bounded TIMED_OUT while a receipt is still pending", async () => {
    const prepared = owned.prepareGuiOwnedShutdown({
      env: {},
      waitMs: 50,
    });
    const { sessionRoot } = genuineSession(prepared);
    const observation = await prepared.finish();
    expect(observation.status).toBe("TIMED_OUT");
    expect(observation.code).toBe("RECEIPT_DEADLINE");
    expect(observation.waitedMs).toBeLessThanOrEqual(50);
    // The pending session evidence is retained, not deleted.
    expect(readdirSync(prepared.runRoot)).toContain(
      sessionRoot.split("/").pop(),
    );
  });
});

// --package-smoke: the packaged-artifact GUI smoke is a separate explicit
// batch route bound to a folio.package-evidence-intent.v1 run. All process,
// GUI, native and SDK seams are injected; the intents, attempts and evidence
// records are REAL temp files. Simulation only — no OS acceptance claimed.
describe("runGuiTests --package-smoke", () => {
  const T0 = 1_800_000_000_000;
  const roots: string[] = [];
  const tmpRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "folio-package-smoke-"));
    roots.push(dir);
    return dir;
  };
  const sha256 = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");

  function putFile(path: string, content: string | Buffer) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  function makePackageFixture(platform: string, arch: string) {
    const root = tmpRoot();
    putFile(join(root, "package.json"), JSON.stringify({ name: "folio", version: "0.1.0" }));
    for (const config of ["package-lock.json", "tsconfig.json", "vite.config.ts", "vitest.config.ts"])
      putFile(join(root, config), "// fixture\n");
    putFile(join(root, "src", "main.ts"), "export {};\n");
    putFile(join(root, "tests", "a.test.ts"), "// t\n");
    putFile(join(root, "scripts", "build.mjs"), "// b\n");
    putFile(join(root, "dist", "index.js"), "console.log(1);\n");
    const release = join(root, "release");
    const outputDir = join(release, `Folio-${platform}-${arch}`);
    const artifactPath = join(release, `Folio-0.1.0-${platform}-${arch}.zip`);
    const manifestPath = join(release, `Folio-0.1.0-${platform}-${arch}.manifest.json`);
    const nativeHelpers: Array<Record<string, unknown>> = [];
    if (platform === "win32") {
      const probeFile = join(outputDir, "resources", "PrivateRootProbe.exe");
      const ownedFile = join(outputDir, "resources", "OwnedNodeJob.exe");
      putFile(probeFile, Buffer.from([0x4d, 0x5a, 1, 2]));
      putFile(ownedFile, Buffer.from([0x4d, 0x5a, 3, 4]));
      nativeHelpers.push(
        {
          role: "probe",
          path: join(root, "native", "probe", "PrivateRootProbe.exe"),
          resource: "resources/PrivateRootProbe.exe",
          sha256: sha256(readFileSync(probeFile)),
          arch,
        },
        {
          role: "owned",
          path: join(root, "native", "owned", "OwnedNodeJob.exe"),
          resource: "resources/OwnedNodeJob.exe",
          sha256: sha256(readFileSync(ownedFile)),
          arch,
        },
      );
    }
    const manifest = {
      schema: "folio.package-artifact.v1",
      plan: { platform, arch, appVersion: "0.1.0", outputDir, artifactPath, manifestPath },
      invocation: { deterministicBase: sha256(`base-${platform}-${arch}`) },
      source: [
        {
          path: join(root, "dist", "index.js"),
          sha256: sha256(readFileSync(join(root, "dist", "index.js"))),
        },
      ],
      files: [],
      nativeHelpers,
      artifact: { path: artifactPath, sha256: "" },
      prerequisites:
        platform === "win32"
          ? [{ name: "Microsoft.NETCore.App", major: 10, arch, bundled: false }]
          : [],
      evidence: {},
    };
    putFile(artifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 9]));
    (manifest.artifact as { sha256: string }).sha256 = sha256(readFileSync(artifactPath));
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const selection = { root, platform, arch };
    return { root, manifest: Object.freeze(manifest), selection };
  }
  function boundRun(fx: ReturnType<typeof makePackageFixture>, runId = "smoke-run") {
    const { intentPath, runRoot } = captureEvidenceIntent(
      { selection: fx.selection, runId, now: T0, ttlMs: 60_000 },
      { verify: () => fx.manifest },
    );
    const requestPath = join(tmpRoot(), "request.json");
    writeFileSync(
      requestPath,
      JSON.stringify({
        schema: "folio.package-smoke-request.v1",
        selection: fx.selection,
        intentPath,
        runId,
      }),
    );
    return { intentPath, runRoot, requestPath };
  }
  function fakePrepare(order: string[], monitorRunId = "monitor-1") {
    const preparedRoot = join(tmpRoot(), "prepared");
    const workspace = join(preparedRoot, "workspace");
    mkdirSync(preparedRoot, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    return {
      preparedRoot,
      workspace,
      prepare: () => {
        order.push("prepare");
        return {
          runRoot: preparedRoot,
          workspace,
          env: { FOLIO_DATA_DIR: workspace },
          request: { runId: monitorRunId },
          finish: async () => {
            order.push("finish");
            return {
              status: "COMPLETED",
              runId: monitorRunId,
              scope: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT",
              code: "PIPE_CLOSED_AFTER_ACCEPTED_QUIT",
              sessions: [{ status: "COMPLETED", id: "session-1" }],
            };
          },
        };
      },
    };
  }
  function buildResult(name: string, runRoot: string, exitCode = 0) {
    const stdoutPath = join(runRoot, `build-${name}.stdout`);
    const stderrPath = join(runRoot, `build-${name}.stderr`);
    writeFileSync(stdoutPath, "mock build log\n", { flag: "wx" });
    writeFileSync(stderrPath, "", { flag: "wx" });
    return { exitCode, signal: null, error: null, stdoutPath, stderrPath };
  }
  function portsOf(fx: ReturnType<typeof makePackageFixture>, over: Record<string, unknown> = {}) {
    const order: string[] = [];
    const launchCalls: Array<Record<string, unknown>> = [];
    const ports = {
      verify: () => fx.manifest,
      untrustedTest: {
        host: { platform: fx.manifest.plan.platform, arch: fx.manifest.plan.arch },
        allowPosixProbePaths: true,
      },
      now: () => T0 + 10,
      tmpBase: tmpdir(),
      build: async ({ name, runRoot }: { name: string; runRoot: string }) => {
        order.push(`build:${name}`);
        return buildResult(name, runRoot);
      },
      probe: async ({ args }: { args: string[] }) => ({
        status: 0,
        signal: null,
        error: null,
        stdout: JSON.stringify({
          canonicalPath: args[0],
          canonicalRoot: args[1],
          daclPrivate: true,
          fileId: sha256(args[0]).slice(0, 32),
          linkCount: 1,
          localFilesystem: true,
          ownerSid: "S-1-5-test",
          platform: "win32",
          reparsePoint: false,
          rootFileId: sha256(args[1]).slice(0, 32),
          rootVolumeId: "c".repeat(16),
          sid: "S-1-5-test",
          volumeId: "c".repeat(16),
        }),
        stderr: "",
      }),
      smoke: async (
        _opts: unknown,
        deps: { launch: (o: unknown) => Promise<unknown> },
      ) => {
        order.push("smoke");
        await deps.launch({ env: { INHERITED: "x" } });
        order.push("smoke:done");
        return {
          ok: true,
          persistence: true,
          artifactHash: fx.manifest.artifact.sha256,
          platform: fx.manifest.plan.platform,
          arch: fx.manifest.plan.arch,
          executablePath: join(
            fx.manifest.plan.outputDir,
            fx.manifest.plan.platform === "darwin"
              ? "Folio.app/Contents/MacOS/Folio"
              : "Folio.exe",
          ),
        };
      },
      launch: async (options: Record<string, unknown>) => {
        order.push("launch");
        launchCalls.push(options);
        return {};
      },
      ...over,
    };
    return { order, launchCalls, ports };
  }
  const env = { PATH: "/usr/bin", FOLIO_DATA_DIR: "/must/be/stripped", NODE_OPTIONS: "--inspect" };

  it("refuses outside the exact [--package-smoke REQUEST.json] batch form", async () => {
    const fx = makePackageFixture("darwin", "arm64");
    const { requestPath } = boundRun(fx);
    for (const args of [
      ["--package-smoke", requestPath],
      ["--package-smoke"],
      ["--package-smoke", requestPath, "--list"],
      ["--package-smoke", requestPath, "--owned-shutdown"],
      [`--package-smoke=${requestPath}`],
      ["--package-smoke", requestPath, "--package-smoke", requestPath],
      ["x--package-smoke-suffix"],
    ]) {
      const result = await runner.runGuiTests({
        batch: false,
        args,
        env,
        spawn: vi.fn(),
        cliPath: "/x",
        packagePorts: portsOf(fx).ports,
      });
      expect(result.refused).toBe(true);
      expect(result.code).toBe(1);
    }
    const extra = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", "a", "--owned-shutdown"],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
    });
    expect(extra.refused).toBe(true);
  });

  it("positive darwin path: build precedes prepare/launch; evidence recorded", async () => {
    const fx = makePackageFixture("darwin", "arm64");
    const { intentPath, runRoot, requestPath } = boundRun(fx);
    const { order, launchCalls, ports } = portsOf(fx);
    const { preparedRoot, workspace, prepare } = fakePrepare(order);
    const result = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", requestPath],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
      cwd: fx.root,
      prepare,
      packagePorts: ports,
    });
    expect(result.refused).toBeFalsy();
    expect(result.code).toBe(0);
    expect(result.packageEvidenceRecord).toMatch(/package-gui-result\.json$/);
    // Order: all three build stages, then prepare, then launch, then finish.
    expect(order).toEqual([
      "build:tsc", "build:vite", "build:main",
      "prepare", "smoke", "launch", "smoke:done", "finish",
    ]);
    const launchEnv = (launchCalls[0] as { env: Record<string, string> }).env;
    expect(launchEnv.FOLIO_DATA_DIR).toBe(workspace);
    expect(launchEnv.FOLIO_CREDENTIAL_DIR).toBe(join(preparedRoot, "vault"));
    // Bound immutable evidence was retained, not retried or deleted.
    expect(JSON.parse(readFileSync(join(runRoot, "package-gui-raw.json"), "utf8")).status).toBe("COMPLETED");
    const revalidated = readEvidenceIntent(intentPath, {
      verify: () => fx.manifest,
      now: T0 + 20,
    });
    expect(revalidated.intent.runId).toBe("smoke-run");
    rmSync(fx.root, { recursive: true, force: true });
  });

  it.each(["x64", "arm64"])(
    "positive simulated win32/%s: privacy probes mandatory before launch",
    async (arch) => {
      const fx = makePackageFixture("win32", arch);
      const { runRoot, requestPath } = boundRun(fx, `win-${arch}`);
      const { order, ports } = portsOf(fx);
      const probeCalls: string[][] = [];
      const baseProbe = ports.probe;
      ports.probe = async (opts: { args: string[] }) => {
        probeCalls.push(opts.args);
        return baseProbe(opts);
      };
      const { prepare } = fakePrepare(order);
      const result = await runner.runGuiTests({
        batch: true,
        args: ["--package-smoke", requestPath],
        env,
        spawn: vi.fn(),
        cliPath: "/x",
        cwd: fx.root,
        prepare,
        packagePorts: ports,
      });
      expect(result.code).toBe(0);
      // Probes cover runRoot/workspace/vault/stateRoot/ledger before launch.
      expect(probeCalls.length).toBeGreaterThanOrEqual(5);
      expect(order.indexOf("launch")).toBeGreaterThan(order.indexOf("prepare"));
      expect(JSON.parse(readFileSync(join(runRoot, "package-gui-raw.json"), "utf8")).privateRoots.runRoot).toBeTruthy();
    },
  );

  it("no automatic retry: an existing attempt refuses", async () => {
    const fx = makePackageFixture("darwin", "arm64");
    const { runRoot, requestPath } = boundRun(fx);
    writeFileSync(join(runRoot, "package-gui-attempt.json"), "{}");
    const result = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", requestPath],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
      packagePorts: portsOf(fx).ports,
    });
    expect(result.refused).toBe(true);
    expect(result.message).toMatch(/attempt already exists/);
  });

  it("build failure produces retained UNKNOWN evidence and never launches", async () => {
    const fx = makePackageFixture("darwin", "arm64");
    const { runRoot, requestPath } = boundRun(fx);
    const { order, ports } = portsOf(fx, {
      build: async ({ name, runRoot }: { name: string; runRoot: string }) => {
        order.push(`build:${name}`);
        return buildResult(name, runRoot, name === "vite" ? 1 : 0);
      },
    });
    const { prepare } = fakePrepare(order);
    const result = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", requestPath],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
      cwd: fx.root,
      prepare,
      packagePorts: ports,
    });
    expect(result.code).toBe(1);
    expect(order).not.toContain("prepare");
    expect(order).not.toContain("launch");
    expect(JSON.parse(readFileSync(join(runRoot, "package-gui-raw.json"), "utf8")).status).toBe("UNKNOWN");
    expect(existsSync(join(runRoot, "package-gui-attempt.json"))).toBe(true);
  });

  it("stale binding after build terminates UNKNOWN without retry", async () => {
    const fx = makePackageFixture("darwin", "arm64");
    const { runRoot, requestPath } = boundRun(fx);
    let built = false;
    const { order, ports } = portsOf(fx, {
      build: async ({ name, runRoot }: { name: string; runRoot: string }) => {
        order.push(`build:${name}`);
        built = true;
        return buildResult(name, runRoot);
      },
      verify: () => {
        if (built) throw new Error("PACKAGE_STALE_SOURCE");
        return fx.manifest;
      },
    });
    const result = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", requestPath],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
      cwd: fx.root,
      prepare: fakePrepare(order).prepare,
      packagePorts: ports,
    });
    expect(result.code).toBe(1);
    expect(order).not.toContain("launch");
    expect(JSON.parse(readFileSync(join(runRoot, "package-gui-raw.json"), "utf8")).status).toBe("UNKNOWN");
  });

  it("missing probe evidence and host mismatch refuse/fail closed", async () => {
    const winFx = makePackageFixture("win32", "x64");
    const { requestPath } = boundRun(winFx);
    const missing = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", requestPath],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
      cwd: winFx.root,
      prepare: fakePrepare([]).prepare,
      packagePorts: portsOf(winFx, {
        probe: async () => ({ status: null, signal: null, error: "ENOENT", stdout: "", stderr: "" }),
      }).ports,
    });
    expect(missing.code).toBe(1);
    expect(missing.observation?.status).toBe("UNKNOWN");
    const darwinFx = makePackageFixture("darwin", "arm64");
    const { requestPath: req2 } = boundRun(darwinFx, "host-mismatch");
    const wrong = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", req2],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
      packagePorts: portsOf(darwinFx, {
        untrustedTest: { host: { platform: "win32", arch: "x64" } },
      }).ports,
    });
    expect(wrong.refused).toBe(true);
  });

  it("incompatible debug/CI environment refuses before any build", async () => {
    const fx = makePackageFixture("darwin", "arm64");
    const { requestPath } = boundRun(fx);
    const { order, ports } = portsOf(fx);
    const result = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", requestPath],
      env: { ...env, CI: "true" },
      spawn: vi.fn(),
      cliPath: "/x",
      packagePorts: ports,
    });
    expect(result.refused).toBe(true);
    expect(order).toEqual([]);
  });

  it("missing intent/request binding refuses without writing evidence", async () => {
    const fx = makePackageFixture("darwin", "arm64");
    const badRequest = join(tmpRoot(), "bad.json");
    writeFileSync(badRequest, JSON.stringify({ schema: "folio.package-smoke-request.v1" }));
    const missing = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", badRequest],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
      packagePorts: portsOf(fx).ports,
    });
    expect(missing.refused).toBe(true);
    const absent = join(tmpRoot(), "absent.json");
    const unreadable = await runner.runGuiTests({
      batch: true,
      args: ["--package-smoke", absent],
      env,
      spawn: vi.fn(),
      cliPath: "/x",
      packagePorts: portsOf(fx).ports,
    });
    expect(unreadable.refused).toBe(true);
  });
  it("the exported package API also refuses without explicit batch", async () => {
    const result = await runner.runPackageSmokeBatch();
    expect(result.refused).toBe(true);
    expect(result.code).toBe(1);
  });
  it.each(["UNKNOWN", "TIMED_OUT"])("retains %s shutdown evidence without success", async (status) => {
    const fx = makePackageFixture("darwin", "arm64");
    const { requestPath, runRoot } = boundRun(fx);
    const { order, ports } = portsOf(fx);
    const base = fakePrepare(order);
    const result = await runner.runGuiTests({
      batch: true, args: ["--package-smoke", requestPath], env,
      prepare: () => ({ ...base.prepare(), finish: async () => ({
        status, runId: "monitor-1", sessions: [],
      }) }),
      packagePorts: ports,
    });
    expect(result.code).toBe(1);
    expect(result.observation.status).toBe("UNKNOWN");
    expect(JSON.parse(readFileSync(join(runRoot, "package-gui-raw.json"), "utf8")).shutdown.status)
      .toBe(status);
  });
  it("never returns success when the immutable result record collides", async () => {
    const fx = makePackageFixture("darwin", "arm64");
    const { requestPath, runRoot } = boundRun(fx);
    const { order, ports } = portsOf(fx);
    const baseSmoke = ports.smoke;
    ports.smoke = async (options, dependencies) => {
      const observation = await baseSmoke(options, dependencies);
      writeFileSync(join(runRoot, "package-gui-result.json"), "existing original", { flag: "wx" });
      return observation;
    };
    const result = await runner.runGuiTests({
      batch: true, args: ["--package-smoke", requestPath], env,
      prepare: fakePrepare(order).prepare, packagePorts: ports,
    });
    expect(result.code).toBe(1);
    expect(result.packageEvidenceRecord).toBeNull();
    expect(result.observation.status).toBe("UNKNOWN");
    expect(readFileSync(join(runRoot, "package-gui-result.json"), "utf8")).toBe("existing original");
  });
  it("requires the selected owned helper and pins full root IDs before native launch", async () => {
    for (const missingOwned of [true, false]) {
      const fx = makePackageFixture("win32", "x64");
      const { requestPath } = boundRun(fx);
      const { order, launchCalls, ports } = portsOf(fx);
      if (missingOwned) fx.manifest.nativeHelpers.splice(1, 1);
      const baseProbe = ports.probe;
      let calls = 0;
      ports.probe = async (options) => {
        const result = await baseProbe(options);
        if (++calls > 5) {
          const parsed = JSON.parse(result.stdout);
          parsed.rootFileId = "d".repeat(32);
          result.stdout = JSON.stringify(parsed);
        }
        return result;
      };
      const result = await runner.runGuiTests({
        batch: true, args: ["--package-smoke", requestPath], env,
        prepare: fakePrepare(order).prepare, packagePorts: ports,
      });
      expect(result.code).toBe(1);
      expect(launchCalls).toHaveLength(0);
    }
  });
});
