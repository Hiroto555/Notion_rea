import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// Every child in this test is a fixed synthetic Node fixture, never a GUI.
import { superviseOwnedProcess } from "../../scripts/mac-acceptance/watchdog/owned-process.mjs";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

function writeScript(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source + "\n", { mode: 0o600 });
  return path;
}

type Fixture = ReturnType<typeof makeFixture>;

function makeFixture() {
  const work = mkdtempSync(join(tmpdir(), "folio-owned-process-fixture-"));
  const outputParent = join(work, "output");
  const scriptDir = join(work, "scripts");
  mkdirSync(outputParent, { mode: 0o700 });
  mkdirSync(scriptDir, { mode: 0o700 });
  const scripts = {
    normal: writeScript(
      scriptDir,
      "normal.mjs",
      'process.stdout.write("synthetic ok\\n");\nprocess.stderr.write("synthetic err\\n");',
    ),
    nonzero: writeScript(
      scriptDir,
      "nonzero.mjs",
      'process.stdout.write("nonzero out\\n");\nprocess.stderr.write("nonzero err\\n");\nprocess.exitCode = 7;',
    ),
    block: writeScript(
      scriptDir,
      "block.mjs",
      'if (process.connected) process.send({ phase: "blocking" });\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
    ),
    ignoreTerm: writeScript(
      scriptDir,
      "ignore-term.mjs",
      'if (process.connected) process.send({ phase: "ready" });\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);',
    ),
    outputLimit: writeScript(
      scriptDir,
      "output-limit.mjs",
      "process.stdout.write(Buffer.alloc(64 * 1024, 120));\nsetInterval(() => {}, 1000);",
    ),
    orphanChild: writeScript(
      scriptDir,
      "orphan-child.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => {});',
        'writeFileSync("orphan-child.pid", String(process.pid));',
        'if (process.connected) process.send({ phase: "ready" });',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    ),
    orphanParent: writeScript(
      scriptDir,
      "orphan-parent.mjs",
      [
        'import { spawn } from "node:child_process";',
        "const child = spawn(process.execPath, [process.argv[2]], {",
        "  env: {},",
        "  shell: false,",
        '  stdio: ["ignore", "ignore", "ignore", "ipc"],',
        "});",
        'child.on("error", () => process.exit(1));',
        'child.once("message", () => {',
        "  if (process.connected)",
        '    process.send({ phase: "descendant-ready", descendantPid: child.pid });',
        "  setTimeout(() => process.exit(0), 100);",
        "});",
        'process.on("SIGTERM", () => process.exit(0));',
      ].join("\n"),
    ),
    privacy: writeScript(
      scriptDir,
      "privacy.mjs",
      [
        "const secret = process.argv[2] ?? process.env.FOLIO_TEST_SECRET ?? '';",
        "process.stdout.write(`stdout:${secret}\\n`);",
        "process.stderr.write(`stderr:${secret}\\n`);",
      ].join("\n"),
    ),
  };
  return {
    work,
    outputParent,
    scripts,
    cleanup() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}

function options(f: Fixture, extra: Record<string, unknown> = {}) {
  return {
    executable: process.execPath,
    args: [f.scripts.normal],
    cwd: f.work,
    env: {},
    outputParent: f.outputParent,
    timeoutMs: 1500,
    graceMs: 100,
    ...extra,
  };
}

function expectOwnedProcessGone(pid: number | null) {
  expect(typeof pid).toBe("number");
  expect(pid).toBeGreaterThan(1);
  if (pid === null || pid <= 1)
    throw new Error("Expected a real owned child PID");
  expect(() => process.kill(pid, 0)).toThrow();
}

function readMetadata(root: string, name: string) {
  return JSON.parse(readFileSync(join(root, name), "utf8"));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("superviseOwnedProcess outside the child's event loop", () => {
  it("reports a spawn error without claiming a supervised process", async () => {
    const f = makeFixture();
    try {
      const { root, result } = await superviseOwnedProcess(
        options(f, { cwd: join(f.work, "missing-directory") }),
      );
      expect(result).toMatchObject({
        schemaVersion: 1,
        observationKind: "NODE_SYNTHETIC",
        productResult: "NOT_RUN",
        outcome: "SPAWN_FAILED",
        expired: false,
        cleanupConfirmed: true,
        pid: null,
        descendantPid: null,
        lastPhase: null,
        exitCode: null,
        exitSignal: null,
        signals: [],
        disposition: "UNRESOLVED",
        stack: "NOT_COLLECTED",
      });
      expect(readMetadata(root, "watchdog.json")).toEqual(result);
    } finally {
      f.cleanup();
    }
  }, 15000);

  it.each([
    ["normal", "COMPLETED", 0, "NOT_RUN", "synthetic ok\n", "synthetic err\n"],
    [
      "nonzero",
      "PROCESS_FAILED",
      7,
      "UNRESOLVED",
      "nonzero out\n",
      "nonzero err\n",
    ],
  ] as const)(
    "records the %s exit without storing streams",
    async (script, outcome, exitCode, disposition, stdout, stderr) => {
      const f = makeFixture();
      try {
        const { root, result } = await superviseOwnedProcess(
          options(f, { args: [f.scripts[script]], timeoutMs: 3000 }),
        );
        const out = Buffer.from(stdout);
        const err = Buffer.from(stderr);
        expect(result).toMatchObject({
          observationKind: "NODE_SYNTHETIC",
          productResult: "NOT_RUN",
          outcome,
          expired: false,
          cleanupConfirmed: true,
          exitCode,
          exitSignal: null,
          signals: [],
          disposition,
          stdout: { bytes: out.length, sha256: sha256(out) },
          stderr: { bytes: err.length, sha256: sha256(err) },
        });
        expect(JSON.stringify(result)).not.toContain(stdout.trim());
        expect(JSON.stringify(result)).not.toContain(stderr.trim());
        expect(readMetadata(root, "watchdog.json")).toEqual(result);
        expectOwnedProcessGone(result.pid);
      } finally {
        f.cleanup();
      }
    },
    15000,
  );

  it("keeps the caller's synthetic binding without promoting the observation", async () => {
    const f = makeFixture();
    const binding = {
      runId: "00000000-0000-4000-8000-000000000002",
      caseId: "MAC-H1",
      hostHash: "a".repeat(64),
      artifactSha256: "b".repeat(64),
    };
    try {
      const { result } = await superviseOwnedProcess(
        options(f, {
          args: [f.scripts.normal],
          timeoutMs: 3000,
          observationKind: "NODE_SYNTHETIC",
          binding,
        }),
      );
      expect(result).toMatchObject({
        observationKind: "NODE_SYNTHETIC",
        productResult: "NOT_RUN",
        outcome: "COMPLETED",
        disposition: "NOT_RUN",
        binding,
      });
    } finally {
      f.cleanup();
    }
  }, 15000);

  it.each(["block", "ignoreTerm"] as const)(
    "times out %s",
    async (script) => {
      const f = makeFixture();
      try {
        const { root, result } = await superviseOwnedProcess(
          options(f, { args: [f.scripts[script]], timeoutMs: 800 }),
        );
        expect(result).toMatchObject({
          outcome: "TIMED_OUT",
          expired: true,
          cleanupConfirmed: true,
          disposition: "UNRESOLVED",
        });
        if (script === "ignoreTerm")
          expect(result.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(readMetadata(root, "watchdog.json")).toEqual(result);
        expectOwnedProcessGone(result.pid);
      } finally {
        f.cleanup();
      }
    },
    15000,
  );

  it("cleans an orphaned descendant in the owned group", async () => {
    const f = makeFixture();
    try {
      const { root, result } = await superviseOwnedProcess(
        options(f, {
          args: [f.scripts.orphanParent, f.scripts.orphanChild],
          timeoutMs: 3000,
        }),
      );
      const descendantPid = Number(
        readFileSync(join(f.work, "orphan-child.pid"), "utf8"),
      );
      expect(descendantPid).toBeGreaterThan(1);
      expect(result).toMatchObject({
        outcome: "DESCENDANTS_LEFT",
        expired: false,
        cleanupConfirmed: true,
        exitCode: 0,
        exitSignal: null,
        disposition: "UNRESOLVED",
        descendantPid,
        lastPhase: "descendant-ready",
        signals: ["SIGTERM", "SIGKILL"],
      });
      expect(readMetadata(root, "watchdog.json")).toEqual(result);
      expectOwnedProcessGone(result.pid);
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      f.cleanup();
    }
  }, 15000);

  it("refuses a pre-aborted request before creating any evidence", async () => {
    const f = makeFixture();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        superviseOwnedProcess(
          options(f, { signal: controller.signal, timeoutMs: 3000 }),
        ),
      ).rejects.toThrow();
      expect(readdirSync(f.outputParent)).toEqual([]);
    } finally {
      f.cleanup();
    }
  }, 15000);

  it("aborts in-flight work and cleans only its own group", async () => {
    const f = makeFixture();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const { root, result } = await superviseOwnedProcess(
        options(f, {
          args: [f.scripts.ignoreTerm],
          timeoutMs: 3000,
          signal: controller.signal,
        }),
      );
      expect(result).toMatchObject({
        outcome: "ABORTED",
        expired: false,
        cleanupConfirmed: true,
        disposition: "UNRESOLVED",
        signals: ["SIGTERM", "SIGKILL"],
      });
      expect(readMetadata(root, "watchdog.json")).toEqual(result);
      expectOwnedProcessGone(result.pid);
    } finally {
      clearTimeout(timer);
      f.cleanup();
    }
  }, 15000);

  it("preserves an unrelated Node sentinel while aborting", async () => {
    const f = makeFixture();
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { env: {}, stdio: "ignore", shell: false },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const { result } = await superviseOwnedProcess(
        options(f, {
          args: [f.scripts.ignoreTerm],
          timeoutMs: 3000,
          signal: controller.signal,
        }),
      );
      expect(result.outcome).toBe("ABORTED");
      expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
      expectOwnedProcessGone(result.pid);
    } finally {
      clearTimeout(timer);
      const done =
        sentinel.exitCode === null && sentinel.signalCode === null
          ? new Promise<void>((resolve) =>
              sentinel.once("exit", () => resolve()),
            )
          : Promise.resolve();
      sentinel.kill("SIGKILL");
      await done;
      f.cleanup();
    }
  }, 15000);

  it("stops a process that exceeds the bounded output limit", async () => {
    const f = makeFixture();
    try {
      const { root, result } = await superviseOwnedProcess(
        options(f, {
          args: [f.scripts.outputLimit],
          timeoutMs: 3000,
          maxOutputBytes: 1024,
        }),
      );
      expect(result).toMatchObject({
        outcome: "OUTPUT_LIMIT",
        expired: false,
        cleanupConfirmed: true,
        disposition: "UNRESOLVED",
      });
      expect(result.stdout.bytes + result.stderr.bytes).toBeGreaterThan(1024);
      expect(readMetadata(root, "watchdog.json")).toEqual(result);
      expectOwnedProcessGone(result.pid);
    } finally {
      f.cleanup();
    }
  }, 15000);

  it("stores only hashes and the synthetic binding for argv, env and streams", async () => {
    const f = makeFixture();
    const secret = "synthetic-secret-marker-8b1c";
    const binding = {
      runId: "00000000-0000-4000-8000-000000000003",
      caseId: "MAC-H2",
      hostHash: "c".repeat(64),
      artifactSha256: "d".repeat(64),
    };
    try {
      const { root, result } = await superviseOwnedProcess(
        options(f, {
          args: [f.scripts.privacy, secret],
          env: { FOLIO_TEST_SECRET: secret },
          timeoutMs: 3000,
          observationKind: "NODE_SYNTHETIC",
          binding,
        }),
      );
      const out = Buffer.from(`stdout:${secret}\n`);
      const err = Buffer.from(`stderr:${secret}\n`);
      expect(result).toMatchObject({
        observationKind: "NODE_SYNTHETIC",
        productResult: "NOT_RUN",
        outcome: "COMPLETED",
        disposition: "NOT_RUN",
        binding,
        stdout: { bytes: out.length, sha256: sha256(out) },
        stderr: { bytes: err.length, sha256: sha256(err) },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      for (const path of filesUnder(root))
        expect(readFileSync(path, "utf8")).not.toContain(secret);
      expect(readMetadata(root, "watchdog.json")).toEqual(result);
    } finally {
      f.cleanup();
    }
  }, 15000);

  it("rejects invalid limits and signals before creating evidence", async () => {
    const f = makeFixture();
    try {
      for (const extra of [
        { timeoutMs: 0 },
        { timeoutMs: 99 },
        { timeoutMs: 900001 },
        { timeoutMs: 1.5 },
        { timeoutMs: Infinity },
        { timeoutMs: NaN },
        { graceMs: 9 },
        { graceMs: 10001 },
        { graceMs: 1.5 },
        { graceMs: Infinity },
        { maxOutputBytes: 1023 },
        { maxOutputBytes: 1024 * 1024 + 1 },
        { maxOutputBytes: 1.5 },
        { maxOutputBytes: Infinity },
        { signal: {} },
      ])
        await expect(
          superviseOwnedProcess(options(f, extra)),
        ).rejects.toThrow();
      expect(readdirSync(f.outputParent)).toEqual([]);
    } finally {
      f.cleanup();
    }
  }, 15000);
});
