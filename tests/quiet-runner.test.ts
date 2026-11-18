import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore - the runner is an untyped ESM entrypoint; spawn is always
// injected below so no real process is started by these tests.
import * as quiet from "../scripts/verify-quiet.mjs";

type SpawnOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: string;
  shell: boolean;
};
type SpawnCall = [string, string[], SpawnOptions];
type FakeChild = EventEmitter & { kill: (...args: unknown[]) => boolean };
type StagePlan = {
  code?: number | null;
  signal?: string | null;
  error?: Error;
  throwOnSpawn?: Error;
};

function fakeSpawn(plans: StagePlan[]) {
  const calls: SpawnCall[] = [];
  let index = 0;
  const spawn = vi.fn(
    (command: string, args: string[], options: SpawnOptions) => {
      calls.push([command, args, options]);
      const plan = plans[index++] ?? { code: 0 };
      if (plan.throwOnSpawn) throw plan.throwOnSpawn;
      const child = new EventEmitter() as FakeChild;
      child.kill = () => true;
      // Deliver the result after runStage has attached its listeners, without
      // starting any child process.
      queueMicrotask(() => {
        if (plan.error) child.emit("error", plan.error);
        else child.emit("exit", plan.code ?? null, plan.signal ?? null);
      });
      return child;
    },
  );
  return { spawn, calls };
}

async function runWith(
  plans: StagePlan[],
  overrides: Record<string, unknown> = {},
) {
  const { spawn, calls } = fakeSpawn(plans);
  const logs: string[] = [];
  const errors: string[] = [];
  const result = await quiet.runQuietChecks({
    spawn,
    env: { PATH: "/bin" },
    cwd: "/repo",
    log: (line: string) => logs.push(line),
    errorLog: (line: string) => errors.push(line),
    forwardSignals: false,
    ...overrides,
  });
  return { result, calls, logs, errors };
}

describe("quiet runner stages", () => {
  it("runs typecheck, Vitest, then build in order without a shell", async () => {
    const { result, calls, logs } = await runWith([
      { code: 0 },
      { code: 0 },
      { code: 0 },
    ]);

    expect(result).toMatchObject({
      ok: true,
      failedStage: null,
      exitCode: 0,
      signal: null,
    });
    expect(result.results.map((entry: { id: string }) => entry.id)).toEqual([
      "typecheck",
      "test",
      "build",
    ]);
    expect(
      result.results.every(
        (entry: { status: string }) => entry.status === "pass",
      ),
    ).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.map(([, args]) => args)).toEqual([
      ["run", "check"],
      ["run", "test", "--", "--maxWorkers=2"],
      ["run", "build"],
    ]);

    for (const [command, args, options] of calls) {
      expect(command).toBe("npm");
      expect(options.shell).toBe(false);
      expect(options.stdio).toBe("inherit");
      expect(options.cwd).toBe("/repo");
      const joined = args.join(" ");
      expect(joined).not.toMatch(
        /test:e2e|electron|playwright|screenshot|osascript|pbcopy|pbpaste/i,
      );
    }
    expect(logs.at(-1)).toContain("PASS all 3 stages");
    expect(logs.join("\n")).toContain("[quiet] ==> test:");
  });

  it("uses a conservative Vitest worker count and no oversized timeout", () => {
    expect(quiet.QUIET_TEST_WORKERS).toBe(2);
    const testStage = quiet.QUIET_STAGES.find(
      (stage: { id: string }) => stage.id === "test",
    );
    expect(testStage).toBeDefined();
    expect(testStage.args).toEqual(["--maxWorkers=2"]);
    expect(testStage.args.join(" ")).not.toMatch(
      /--maxWorkers=([3-9]|\d{2,})|--testTimeout=\d{6,}/,
    );
  });

  it("accepts every built-in stage through the policy validator", () => {
    expect(quiet.QUIET_STAGES).toHaveLength(3);
    expect(
      new Set(quiet.QUIET_STAGES.map((stage: { id: string }) => stage.id)).size,
    ).toBe(3);
    for (const stage of quiet.QUIET_STAGES) {
      expect(() => quiet.assertQuietStage(stage)).not.toThrow();
      expect(quiet.validateQuietStage(stage)).toBeNull();
    }
  });

  it("builds shell-free npm invocations for script arguments", () => {
    expect(
      quiet.buildStageInvocation({ id: "check", script: "check", args: [] }),
    ).toEqual({
      command: "npm",
      args: ["run", "check"],
    });
    expect(
      quiet.buildStageInvocation({
        id: "test",
        script: "test",
        args: ["--maxWorkers=2"],
      }),
    ).toEqual({
      command: "npm",
      args: ["run", "test", "--", "--maxWorkers=2"],
    });
  });
});

describe("quiet runner failure handling", () => {
  it("stops at the first failing stage and preserves its exit code", async () => {
    const { result, calls, errors } = await runWith([
      { code: 7 },
      { code: 0 },
      { code: 0 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("typecheck");
    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      id: "typecheck",
      status: "fail",
      exitCode: 7,
    });
    expect(calls).toHaveLength(1);
    expect(errors.join("\n")).toContain("FAIL stage=typecheck exit=7");
    expect(errors.join("\n")).toContain("2 later stage(s) were not run");
  });

  it("reports the failing test stage and skips build", async () => {
    const { result, calls, errors } = await runWith([
      { code: 0 },
      { code: 3 },
      { code: 0 },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("test");
    expect(result.exitCode).toBe(3);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toEqual(["run", "test", "--", "--maxWorkers=2"]);
    expect(errors.join("\n")).toContain("FAIL stage=test exit=3");
    expect(errors.join("\n")).toContain("1 later stage(s) were not run");
  });

  it("turns an async spawn error into a failed stage without continuing", async () => {
    const { result, calls, errors } = await runWith([
      { error: new Error("spawn boom") },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("typecheck");
    expect(result.exitCode).toBe(1);
    expect(result.results[0].error).toContain("spawn boom");
    expect(calls).toHaveLength(1);
    expect(errors.join("\n")).toContain(
      "FAIL stage=typecheck error=spawn boom",
    );
  });

  it("fails closed when spawn throws synchronously", async () => {
    const { result, calls } = await runWith([
      { throwOnSpawn: new Error("ENOENT") },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("typecheck");
    expect(result.exitCode).toBe(1);
    expect(result.results[0].error).toContain("ENOENT");
    expect(calls).toHaveLength(1);
  });

  it("treats signal termination as failure with a stable exit code", async () => {
    const { result, calls, errors } = await runWith([
      { code: null, signal: "SIGTERM" },
    ]);

    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("typecheck");
    expect(result.exitCode).toBe(1);
    expect(result.signal).toBe("SIGTERM");
    expect(calls).toHaveLength(1);
    expect(errors.join("\n")).toContain("signal=SIGTERM");
  });
});

describe("quiet runner process entry", () => {
  it("sets the failing stage's exit code on the process", async () => {
    const previousExitCode = process.exitCode;
    const { spawn, calls } = fakeSpawn([{ code: 9 }]);
    try {
      const result = await quiet.main({
        argv: [],
        spawn,
        env: {},
        cwd: "/repo",
        forwardSignals: false,
        log: () => {},
        errorLog: () => {},
      });

      expect(result.failedStage).toBe("typecheck");
      expect(result.exitCode).toBe(9);
      expect(process.exitCode).toBe(9);
      expect(calls).toHaveLength(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("refuses unknown arguments without spawning", async () => {
    const previousExitCode = process.exitCode;
    const { spawn, calls } = fakeSpawn([{ code: 0 }]);
    const errors: string[] = [];
    try {
      const result = await quiet.main({
        argv: ["--maxWorkers=8"],
        spawn,
        env: {},
        cwd: "/repo",
        forwardSignals: false,
        log: () => {},
        errorLog: (line: string) => errors.push(line),
      });

      expect(result.exitCode).toBe(2);
      expect(process.exitCode).toBe(2);
      expect(calls).toHaveLength(0);
      expect(errors.join("\n")).toContain("accepts no arguments");
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

describe("quiet runner GUI refusal", () => {
  const forbiddenStages = [
    { id: "e2e", script: "test:e2e", args: [] },
    { id: "e2e-batch", script: "test:e2e:batch", args: [] },
    { id: "e2e-linux-ci", script: "test:e2e:linux-ci", args: [] },
    { id: "dev", script: "dev", args: [] },
    { id: "start", script: "start", args: [] },
    { id: "package", script: "package", args: [] },
    { id: "mixed-case", script: "Dev", args: [] },
    { id: "playwright", script: "check", args: ["--reporter", "playwright"] },
    { id: "electron", script: "build", args: ["run", "electron"] },
    { id: "screenshot", script: "build", args: ["--screenshot"] },
    { id: "clipboard", script: "check", args: ["pbcopy"] },
    { id: "osascript", script: "check", args: ["osascript"] },
  ];

  it("rejects GUI-capable scripts and arguments before spawning anything", async () => {
    for (const stage of forbiddenStages) {
      expect(() => quiet.assertQuietStage(stage), stage.id).toThrow(
        /policy violation/i,
      );
      expect(quiet.validateQuietStage(stage), stage.id).toEqual(
        expect.any(String),
      );
    }

    const { result, calls, errors } = await runWith([{ code: 0 }], {
      stages: [
        quiet.QUIET_STAGES[0],
        forbiddenStages.find((stage) => stage.id === "playwright"),
      ],
    });

    expect(result.refused).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe("playwright");
    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("FAIL stage=playwright exit=1");
  });

  it("rejects a GUI-capable executable even if the stage list is valid", async () => {
    expect(quiet.validateQuietCommand("/usr/local/bin/npm")).toBeNull();
    expect(quiet.validateQuietCommand("/usr/local/bin/electron")).toMatch(
      /GUI-capable/,
    );
    expect(() =>
      quiet.buildStageInvocation(quiet.QUIET_STAGES[0], {
        npmCommand: "playwright",
      }),
    ).toThrow(/policy violation/i);

    const { result, calls, errors } = await runWith([{ code: 0 }], {
      npmCommand: "/opt/homebrew/bin/electron",
    });

    expect(result.refused).toBe(true);
    expect(result.failedStage).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(0);
    expect(errors.join("\n")).toContain("command is GUI-capable");
  });

  it("strips ambient GUI opt-in and debug variables from every child", async () => {
    const { spawn, calls } = fakeSpawn([{ code: 0 }, { code: 0 }, { code: 0 }]);
    const env = {
      PATH: "/bin",
      HOME: "/tmp/home",
      FOLIO_GUI_TEST_OPT_IN: "1",
      PWTEST_WATCH: "1",
      PWDEBUG: "1",
      KEEP_ME: "yes",
    };

    await quiet.runQuietChecks({
      spawn,
      env,
      cwd: "/repo",
      log: () => {},
      errorLog: () => {},
      forwardSignals: false,
    });

    expect(calls).toHaveLength(3);
    for (const [, , options] of calls) {
      expect(options.env.FOLIO_GUI_TEST_OPT_IN).toBeUndefined();
      expect(options.env.PWTEST_WATCH).toBeUndefined();
      expect(options.env.PWDEBUG).toBeUndefined();
      expect(options.env.PATH).toBe("/bin");
      expect(options.env.HOME).toBe("/tmp/home");
      expect(options.env.KEEP_ME).toBe("yes");
    }
    // The caller's environment object is not mutated.
    expect(env.FOLIO_GUI_TEST_OPT_IN).toBe("1");
    expect(env.PWDEBUG).toBe("1");
  });
});

describe("quiet runner wiring", () => {
  it("adds verify:quiet without changing existing script semantics", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts["verify:quiet"]).toBe("node scripts/verify-quiet.mjs");
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.check).toBe("tsc --noEmit");
    expect(pkg.scripts.build).toBe(
      "tsc --noEmit && vite build && node scripts/build.mjs",
    );
    expect(pkg.scripts["test:e2e"]).toBe(
      "node scripts/run-gui-tests.mjs --mode=refuse",
    );
    expect(pkg.scripts["test:e2e:batch"]).toBe(
      "node scripts/run-gui-tests.mjs --mode=batch",
    );
    // The quiet runner must not add a GUI opt-in wrapper to the normal test
    // command or replace the explicit GUI batch entry point.
    expect(pkg.scripts.test).not.toContain("FOLIO_GUI_TEST_OPT_IN");
    expect(pkg.scripts["verify:quiet"]).not.toContain("test:e2e");
  });

  it("keeps CI limited to quiet checks on GitHub-hosted Node 24 with pinned official actions", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/quiet-checks.yml", import.meta.url),
      "utf8",
    );
    // Ignore comments when checking for GUI/deploy commands: the workflow
    // comments deliberately explain what is not run.
    const executable = workflow
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .map((line) => line.replace(/\s+#.*$/, ""))
      .join("\n");

    expect(workflow).toMatch(/^name: quiet-checks$/m);
    expect(executable).toMatch(/^on:\n(?:.*\n)*?  pull_request:$/m);
    expect(executable).toMatch(/^  push:\n    branches: \[master\]$/m);
    expect(executable).toContain("permissions:\n  contents: read");
    expect(executable).toContain("runs-on: ubuntu-latest");
    expect(executable).toContain('node-version: "24"');
    expect(executable).toContain("npm ci");
    expect(executable).toContain("npm run verify:quiet");
    expect(executable).toContain("node:sqlite");
    expect(executable).toContain("timeout-minutes: 15");

    expect(executable).not.toMatch(
      /pull_request_target|workflow_dispatch|schedule:|secrets\.|self-hosted|deploy|publish|electron|playwright|test:e2e|screenshot|clipboard|osascript|pbcopy|pbpaste/i,
    );
    expect(executable).not.toMatch(/npm run (?:dev|start|package)\b/);

    const uses = [...executable.matchAll(/^\s*uses:\s*(\S+)/gm)].map(
      (match) => match[1],
    );
    expect(uses).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    ]);
    expect(workflow).toContain("# Official actions/checkout v7.0.1");
    expect(workflow).toContain("# Official actions/setup-node v7.1.0");
  });
});
