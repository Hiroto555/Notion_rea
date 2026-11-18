import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  WINDOWS_OWNED_HELPER_MAX_OUTPUT_BYTES,
  WindowsOwnedExecutor,
  buildOwnedEnvironment,
  validateOwnedHelperPath,
  type OwnedHelperSpawn,
  type OwnedHelperSpawnOptions,
  type WindowsOwnedExecutorOptions,
} from "../src/platform/windows/owned-executor";

const HELPER = "C:\\Program Files\\Folio\\OwnedNodeJob.exe";
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const TEMP_ROOT = "C:\\Folio\\owned";
const SCRIPT = "C:\\Folio\\owned\\worker.js";
const NONCE = "nonce_0123456789";
const ARGV = Object.freeze([NODE_EXE, SCRIPT, TEMP_ROOT, NONCE, "5000"]);

type Call = Readonly<{
  command: string;
  args: readonly string[];
  options: OwnedHelperSpawnOptions;
}>;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(
  script: (child: FakeChild) => void,
): OwnedHelperSpawn & { calls: Call[]; children: FakeChild[] } {
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  const spawn = ((
    command: string,
    args: readonly string[],
    options: OwnedHelperSpawnOptions,
  ): ChildProcess => {
    const child = new FakeChild();
    calls.push({ command, args: [...args], options });
    children.push(child);
    queueMicrotask(() => script(child));
    return child as unknown as ChildProcess;
  }) as OwnedHelperSpawn & { calls: Call[]; children: FakeChild[] };
  spawn.calls = calls;
  spawn.children = children;
  return spawn;
}

function executorOptions(
  overrides: Partial<WindowsOwnedExecutorOptions> = {},
): WindowsOwnedExecutorOptions {
  return {
    platform: "win32",
    helperPath: HELPER,
    exists: () => true,
    graceMs: 5,
    ...overrides,
  };
}

function executor(spawn: OwnedHelperSpawn): WindowsOwnedExecutor {
  return new WindowsOwnedExecutor(executorOptions({ spawn }));
}

function reply(
  text: string,
  code: number | null = 0,
): (child: FakeChild) => void {
  return (child) => {
    child.stdout.write(text);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

const OUTCOME = JSON.stringify({
  v: 1,
  owned: true,
  nonce: NONCE,
  ownRootNonce: NONCE,
  exited: true,
  processCount: 0,
  exitCode: 0,
  timedOut: false,
  stdoutBytes: 12,
  stderrBytes: 0,
  truncated: false,
});

describe("WindowsOwnedExecutor construction", () => {
  it("rejects non-win32 hosts before touching the helper", () => {
    expectCode(
      () => new WindowsOwnedExecutor(executorOptions({ platform: "darwin" })),
      "PLATFORM_UNSUPPORTED",
    );
  });

  it("rejects a relative helper path", () => {
    expectCode(
      () =>
        new WindowsOwnedExecutor(
          executorOptions({ helperPath: "OwnedNodeJob.exe" }),
        ),
      "INVALID_HELPER",
    );
  });

  it("rejects a UNC helper path", () => {
    expectCode(
      () =>
        new WindowsOwnedExecutor(
          executorOptions({
            helperPath: "\\\\server\\share\\OwnedNodeJob.exe",
          }),
        ),
      "INVALID_HELPER",
    );
  });

  it("rejects a helper without the compiled executable suffix", () => {
    expectCode(
      () =>
        new WindowsOwnedExecutor(
          executorOptions({ helperPath: "C:\\Folio\\OwnedNodeJob.dll" }),
        ),
      "HELPER_NOT_EXE",
    );
  });

  it("fails closed when the compiled helper is absent", () => {
    expectCode(
      () => new WindowsOwnedExecutor(executorOptions({ exists: () => false })),
      "HELPER_MISSING",
    );
  });

  it("accepts an absolute compiled helper without compiling anything", () => {
    const constructed = new WindowsOwnedExecutor(executorOptions());
    expect(constructed).toBeInstanceOf(WindowsOwnedExecutor);
  });
});

describe("validateOwnedHelperPath", () => {
  it("canonicalizes separators", () => {
    expect(
      validateOwnedHelperPath("C:/Program Files/Folio/OwnedNodeJob.exe"),
    ).toBe("C:\\Program Files\\Folio\\OwnedNodeJob.exe");
  });

  it("rejects device prefixes", () => {
    expectCode(
      () => validateOwnedHelperPath("\\\\?\\C:\\Folio\\OwnedNodeJob.exe"),
      "INVALID_HELPER",
    );
  });
});

describe("buildOwnedEnvironment", () => {
  it("allows only safe system values and forces TEMP/TMP onto the owned root", () => {
    const source = {
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      TEMP: "C:\\Users\\public\\temp",
      TMP: "C:\\Users\\public\\temp",
      FOLIO_TOKEN: "leak",
      GITHUB_TOKEN: "leak",
      AWS_SECRET_ACCESS_KEY: "leak",
      OPENAI_API_KEY: "leak",
      USERPROFILE: "C:\\Users\\someone",
    };
    const before = JSON.stringify(source);
    const environment = buildOwnedEnvironment(source, TEMP_ROOT);
    expect(environment).toEqual({
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      TEMP: TEMP_ROOT,
      TMP: TEMP_ROOT,
    });
    expect(environment).not.toHaveProperty("FOLIO_TOKEN");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("USERPROFILE");
    expect(Object.isFrozen(environment)).toBe(true);
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe("WindowsOwnedExecutor.execute validation", () => {
  it.each([
    [
      "wrong arity",
      Object.freeze([NODE_EXE, SCRIPT, TEMP_ROOT, NONCE]) as readonly string[],
      "INVALID_ARGV",
    ],
    [
      "relative node",
      Object.freeze([
        "node.exe",
        SCRIPT,
        TEMP_ROOT,
        NONCE,
        "5000",
      ]) as readonly string[],
      "INVALID_NODE_EXE",
    ],
    [
      "relative script",
      Object.freeze([
        NODE_EXE,
        "worker.js",
        TEMP_ROOT,
        NONCE,
        "5000",
      ]) as readonly string[],
      "INVALID_OWNED_SCRIPT",
    ],
    [
      "script outside root",
      Object.freeze([
        NODE_EXE,
        "C:\\Other\\worker.js",
        TEMP_ROOT,
        NONCE,
        "5000",
      ]) as readonly string[],
      "SCRIPT_OUTSIDE_ROOT",
    ],
    [
      "zero timeout",
      Object.freeze([
        NODE_EXE,
        SCRIPT,
        TEMP_ROOT,
        NONCE,
        "0",
      ]) as readonly string[],
      "INVALID_ARGV_TIMEOUT",
    ],
    [
      "huge timeout",
      Object.freeze([
        NODE_EXE,
        SCRIPT,
        TEMP_ROOT,
        NONCE,
        "300001",
      ]) as readonly string[],
      "INVALID_ARGV_TIMEOUT",
    ],
    [
      "non numeric timeout",
      Object.freeze([
        NODE_EXE,
        SCRIPT,
        TEMP_ROOT,
        NONCE,
        "5s",
      ]) as readonly string[],
      "INVALID_ARGV_TIMEOUT",
    ],
    [
      "bad nonce",
      Object.freeze([
        NODE_EXE,
        SCRIPT,
        TEMP_ROOT,
        "",
        "5000",
      ]) as readonly string[],
      "INVALID_ARGV_NONCE",
    ],
  ] as Array<[string, readonly string[], string]>)(
    "rejects %s before spawning",
    async (_label, argv, code) => {
      const spawn = fakeSpawn(reply(OUTCOME));
      await expect(executor(spawn).execute(argv)).rejects.toMatchObject({
        code,
      });
      expect(spawn.calls).toHaveLength(0);
    },
  );
});

describe("WindowsOwnedExecutor.execute launch", () => {
  it("spawns the absolute helper directly with no shell and returns its JSON outcome", async () => {
    const spawn = fakeSpawn(reply(OUTCOME));
    const result = await executor(spawn).execute(ARGV);
    expect(result).toMatchObject({ owned: true, nonce: NONCE, exitCode: 0 });
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    expect(call.command).toBe(HELPER);
    expect(call.args).toEqual(ARGV);
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.cwd).toBe(TEMP_ROOT);
    expect(call.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(call.options.env).not.toHaveProperty("FOLIO_TOKEN");
    expect(call.options.env.TEMP).toBe(TEMP_ROOT);
  });

  it("rejects a nonzero helper exit as an execution failure", async () => {
    const spawn = fakeSpawn(reply("", 3));
    await expect(executor(spawn).execute(ARGV)).rejects.toMatchObject({
      code: "HELPER_EXIT",
    });
  });

  it("rejects malformed helper JSON", async () => {
    const spawn = fakeSpawn(reply("not-json"));
    await expect(executor(spawn).execute(ARGV)).rejects.toMatchObject({
      code: "HELPER_INVALID_RESULT",
    });
  });

  it("kills and rejects a helper that exceeds the bounded stdout", async () => {
    const spawn = fakeSpawn((child) => {
      child.stdout.write(
        Buffer.alloc(WINDOWS_OWNED_HELPER_MAX_OUTPUT_BYTES + 1),
      );
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    await expect(executor(spawn).execute(ARGV)).rejects.toMatchObject({
      code: "EXECUTOR_OUTPUT_LIMIT",
    });
  });

  it("times out and terminates the helper after the bounded deadline", async () => {
    const spawn = fakeSpawn(() => undefined);
    const shortArgv = Object.freeze([NODE_EXE, SCRIPT, TEMP_ROOT, NONCE, "1"]);
    await expect(executor(spawn).execute(shortArgv)).rejects.toMatchObject({
      code: "EXECUTOR_TIMEOUT",
    });
    expect(spawn.children[0].killed).toBe(true);
  });

  it("rejects a spawn that provides no pipes", async () => {
    const spawn = (() =>
      ({
        stdout: null,
        stderr: null,
      }) as unknown as ChildProcess) as OwnedHelperSpawn;
    await expect(executor(spawn).execute(ARGV)).rejects.toMatchObject({
      code: "EXECUTOR_PIPE",
    });
  });
});
