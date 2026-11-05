import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GUI_TEST_OPT_IN_ENV,
  GUI_TEST_OPT_IN_VALUE,
  GUI_TEST_REFUSAL_MESSAGE,
  assertGuiTestAllowed,
  hasSafeListFlag,
  isGuiTestOptedIn,
} from "./gui-test-policy";
// @ts-ignore - the launcher is an untyped ESM entrypoint; it is imported for
// unit tests only and its child_process spawn is always injected below.
import * as runner from "../scripts/run-gui-tests.mjs";

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
  const spawn = vi.fn((command: string, args: string[], options: SpawnOptions) => {
    calls.push([command, args, options]);
    return child;
  });
  return { spawn, calls, child };
}

const bypassCases = [
  ["--grep", "--list"],
  ["--grep=--list"],
  ["-g", "--list"],
  ["--config", "--list"],
  ["--project", "--list"],
  ["--", "--list"],
  ["--list=1"],
  ["foo--list"],
  ["01--list"],
  ["--list", "--", "foo"],
  ...["--ui", "--ui-host=127.0.0.1", "--ui-port=9999", "--debug", "--debug=inspector", "--headed", "--reporter=html"].flatMap((flag) => [
    [flag, "--list"], ["--list", flag],
  ]),
];

describe("GUI test policy helper", () => {
  it("accepts only the exact opt-in value", () => {
    expect(isGuiTestOptedIn({ [GUI_TEST_OPT_IN_ENV]: GUI_TEST_OPT_IN_VALUE })).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes", "01", " 1", "1 ", "1\n"]) {
      expect(isGuiTestOptedIn({ [GUI_TEST_OPT_IN_ENV]: value })).toBe(false);
    }
    expect(isGuiTestOptedIn({})).toBe(false);
  });

  it("recognizes only a real standalone --list option", () => {
    expect(hasSafeListFlag(["test", "--list"])).toBe(true);
    expect(hasSafeListFlag(["test", "--list", "--workers=1"])).toBe(true);
    expect(hasSafeListFlag(["test", "--headed", "--list"])).toBe(false);
    expect(hasSafeListFlag(["test", "--grep", "foo", "--list"])).toBe(true);
    for (const args of bypassCases) expect(hasSafeListFlag(args)).toBe(false);
  });

  it("refuses direct use unless opted in or doing a safe list dry-run", () => {
    expect(() => assertGuiTestAllowed({}, ["test"])).toThrow(/GUIテストは既定で拒否/);
    expect(() => assertGuiTestAllowed({}, ["test", "--grep", "--list"])).toThrow(
      /GUIテストは既定で拒否/,
    );
    expect(() => assertGuiTestAllowed({ [GUI_TEST_OPT_IN_ENV]: "true" }, ["test"])).toThrow(
      /GUIテストは既定で拒否/,
    );
    expect(() => assertGuiTestAllowed({}, ["test", "--list"])).not.toThrow();
    expect(() =>
      assertGuiTestAllowed({ [GUI_TEST_OPT_IN_ENV]: GUI_TEST_OPT_IN_VALUE }, ["test"]),
    ).not.toThrow();
    expect(GUI_TEST_REFUSAL_MESSAGE).toContain("npm run test:e2e:batch");
    for (const env of [{ PWTEST_WATCH: "1" }, { PWDEBUG: "1" }]) {
      expect(() => assertGuiTestAllowed(env, ["test", "--list"])).toThrow(/GUIテストは既定で拒否/);
    }
  });
});

describe("GUI test launcher", () => {
  it("refuses npm run test:e2e by default without spawning, even with ambient opt-in", async () => {
    const { spawn, calls } = fakeSpawn();
    const result = await runner.runGuiTests({
      batch: false,
      args: [],
      env: { [GUI_TEST_OPT_IN_ENV]: GUI_TEST_OPT_IN_VALUE },
      spawn,
      cliPath: "/fake/playwright/cli.js",
      forwardSignals: false,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(result.refused).toBe(true);
    expect(result.code).toBe(1);
    expect(result.message).toContain("GUIテストは既定で拒否");
    expect(result.message).toContain("npm run test:e2e:batch");
  });

  it("adds opt-in to the child env only in explicit batch mode and forwards argv as an array", async () => {
    const { spawn, calls, child } = fakeSpawn();
    const args = ["--workers=1", "tests/e2e/foo.spec.ts", "--grep", "a b; echo nope"];
    const pending = runner.runGuiTests({
      batch: true,
      args,
      env: { PATH: "/bin", [GUI_TEST_OPT_IN_ENV]: "0" },
      spawn,
      cliPath: "/fake/playwright/cli.js",
      cwd: "/repo",
      forwardSignals: false,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, commandArgs, options] = calls[0];
    expect(command).toBe(process.execPath);
    expect(commandArgs).toEqual(["/fake/playwright/cli.js", "test", ...args]);
    expect(commandArgs).toContain("a b; echo nope");
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe("/repo");
    expect(options.env[GUI_TEST_OPT_IN_ENV]).toBe(GUI_TEST_OPT_IN_VALUE);
    expect(options.env.PATH).toBe("/bin");

    child.emit("exit", 0, null);
    await expect(pending).resolves.toMatchObject({ code: 0, signal: null, refused: false });
  });

  it("allows a list dry-run without adding opt-in", async () => {
    const { spawn, calls, child } = fakeSpawn();
    const pending = runner.runGuiTests({
      batch: false,
      args: ["--list", "tests/e2e/foo.spec.ts"],
      env: { PATH: "/bin", [GUI_TEST_OPT_IN_ENV]: GUI_TEST_OPT_IN_VALUE },
      spawn,
      cliPath: "/fake/playwright/cli.js",
      forwardSignals: false,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, commandArgs, options] = calls[0];
    expect(commandArgs).toEqual(["/fake/playwright/cli.js", "test", "--list", "tests/e2e/foo.spec.ts"]);
    expect(options.env[GUI_TEST_OPT_IN_ENV]).toBeUndefined();

    child.emit("exit", 0, null);
    await expect(pending).resolves.toMatchObject({ code: 0, refused: false });
  });

  it("does not let --list inside option values bypass the default refusal", async () => {
    for (const args of bypassCases) {
      const { spawn, calls } = fakeSpawn();
      const result = await runner.runGuiTests({
        batch: false,
        args,
        env: {},
        spawn,
        cliPath: "/fake/playwright/cli.js",
        forwardSignals: false,
      });
      expect(calls, args.join(" ")).toHaveLength(0);
      expect(result.refused, args.join(" ")).toBe(true);
    }
  });

  it("refuses list mode with ambient watch or debug mode without spawning", async () => {
    for (const env of [{ PWTEST_WATCH: "1" }, { PWDEBUG: "1" }]) {
      const { spawn } = fakeSpawn();
      const result = await runner.runGuiTests({ batch: false, args: ["--list"], env, spawn, cliPath: "/fake/cli.js", forwardSignals: false });
      expect(result.refused).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    }
  });

  it("propagates the child exit code and signal", async () => {
    const first = fakeSpawn();
    const pendingCode = runner.runGuiTests({
      batch: true,
      args: [],
      env: {},
      spawn: first.spawn,
      cliPath: "/fake/playwright/cli.js",
      forwardSignals: false,
    });
    first.child.emit("exit", 7, null);
    await expect(pendingCode).resolves.toMatchObject({ code: 7, signal: null, refused: false });

    const second = fakeSpawn();
    const pendingSignal = runner.runGuiTests({
      batch: true,
      args: [],
      env: {},
      spawn: second.spawn,
      cliPath: "/fake/playwright/cli.js",
      forwardSignals: false,
    });
    second.child.emit("exit", null, "SIGTERM");
    await expect(pendingSignal).resolves.toMatchObject({
      code: null,
      signal: "SIGTERM",
      refused: false,
    });
  });

  it("cannot be switched to batch by appending --mode=batch to test:e2e", () => {
    const parsed = runner.parseRunnerInvocation(["--mode=refuse", "--mode=batch"]);
    expect(parsed).toEqual({ batch: false, args: ["--mode=batch"] });
    expect(runner.decideGuiRun(parsed).action).toBe("refuse");
    expect(runner.parseRunnerInvocation(["--mode=batch", "--workers=1"])).toEqual({
      batch: true,
      args: ["--workers=1"],
    });
  });

  it("keeps the launcher and helper policy in sync", () => {
    expect(runner.GUI_TEST_OPT_IN_ENV).toBe(GUI_TEST_OPT_IN_ENV);
    expect(runner.GUI_TEST_OPT_IN_VALUE).toBe(GUI_TEST_OPT_IN_VALUE);
    const matrix = [
      ["test", "--list"],
      ...bypassCases,
      ["test", "--grep", "foo", "--list"],
      ["test", "--headed", "--list"],
    ];
    for (const args of matrix) {
      expect(runner.hasSafeListFlag(args), args.join(" ")).toBe(hasSafeListFlag(args));
    }
    for (const value of [undefined, "", "0", "true", "01", " 1", "1 "]) {
      expect(runner.isGuiTestOptedIn({ [GUI_TEST_OPT_IN_ENV]: value })).toBe(
        isGuiTestOptedIn({ [GUI_TEST_OPT_IN_ENV]: value }),
      );
    }
  });
});

describe("Playwright config evaluation", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
    delete process.env[GUI_TEST_OPT_IN_ENV];
    vi.resetModules();
  });

  it("rejects both configs when directly evaluated without opt-in", async () => {
    delete process.env[GUI_TEST_OPT_IN_ENV];
    process.argv = ["node", "playwright", "test"];
    vi.resetModules();
    await expect(import("../playwright.config")).rejects.toThrow(/GUIテストは既定で拒否/);
    vi.resetModules();
    await expect(import("../playwright.dev-round3.config")).rejects.toThrow(
      /GUIテストは既定で拒否/,
    );
  });

  it("allows config evaluation for a standalone --list dry-run", async () => {
    delete process.env[GUI_TEST_OPT_IN_ENV];
    process.argv = ["node", "playwright", "test", "--list"];
    vi.resetModules();
    await expect(import("../playwright.config")).resolves.toBeDefined();
    vi.resetModules();
    await expect(import("../playwright.dev-round3.config")).resolves.toBeDefined();
  });

  it("rejects config evaluation when --list is only a --grep value", async () => {
    delete process.env[GUI_TEST_OPT_IN_ENV];
    process.argv = ["node", "playwright", "test", "--grep", "--list"];
    vi.resetModules();
    await expect(import("../playwright.config")).rejects.toThrow(/GUIテストは既定で拒否/);
  });

  it("rejects UI-mode flags even when list mode is also requested", async () => {
    delete process.env[GUI_TEST_OPT_IN_ENV];
    for (const args of [["--ui", "--list"], ["--list", "--ui"], ["--list", "--ui-port=9999"]]) {
      process.argv = ["node", "playwright", "test", ...args];
      vi.resetModules();
      await expect(import("../playwright.config")).rejects.toThrow(/GUIテストは既定で拒否/);
      vi.resetModules();
      await expect(import("../playwright.dev-round3.config")).rejects.toThrow(/GUIテストは既定で拒否/);
    }
  });

  it("allows config evaluation with the explicit opt-in child env", async () => {
    process.env[GUI_TEST_OPT_IN_ENV] = GUI_TEST_OPT_IN_VALUE;
    process.argv = ["node", "playwright", "test"];
    vi.resetModules();
    await expect(import("../playwright.config")).resolves.toBeDefined();
    vi.resetModules();
    await expect(import("../playwright.dev-round3.config")).resolves.toBeDefined();
  });
});

describe("package scripts", () => {
  it("keeps non-GUI commands unchanged and routes both e2e scripts through the gate", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts.check).toBe("tsc --noEmit");
    expect(pkg.scripts.build).toBe("tsc --noEmit && vite build && node scripts/build.mjs");
    expect(pkg.scripts["test:e2e"]).toBe("node scripts/run-gui-tests.mjs --mode=refuse");
    expect(pkg.scripts["test:e2e:batch"]).toBe("node scripts/run-gui-tests.mjs --mode=batch");
  });
});
