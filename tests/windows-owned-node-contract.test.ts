import { describe, expect, it } from "vitest";
import {
  OWNED_NODE_MAX_RESULT_BYTES,
  OWNED_NODE_MAX_TIMEOUT_MS,
  createOwnedNodeJob,
  ownedNodeArgv,
  type OwnedNodeExecutorPort,
  type OwnedNodeOptions,
} from "../src/platform/windows/owned-node";

const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const TEMP_ROOT = "C:\\Folio\\owned";
const SCRIPT = "C:\\Folio\\owned\\worker.js";
const NONCE = "nonce_0123456789";

function options(overrides: Partial<OwnedNodeOptions> = {}): OwnedNodeOptions {
  return Object.freeze({
    platform: "win32",
    nodeExe: NODE_EXE,
    ownedScript: SCRIPT,
    tempRoot: TEMP_ROOT,
    nonce: NONCE,
    timeoutMs: 5_000,
    ...overrides,
  } as OwnedNodeOptions);
}

function outcome(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    owned: true,
    nonce: NONCE,
    ownRootNonce: NONCE,
    exited: true,
    processCount: 0,
    exitCode: 0,
    timedOut: false,
    stdoutBytes: 17,
    stderrBytes: 0,
    truncated: false,
    ...overrides,
  };
}

function executor(
  reply: unknown,
): OwnedNodeExecutorPort & { calls: readonly string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    execute(argv: readonly string[]): unknown {
      calls.push([...argv]);
      return reply;
    },
  };
}

describe("ownedNodeArgv", () => {
  it("builds a fixed five element argv without a shell", () => {
    const argv = ownedNodeArgv(options());
    expect(argv).toEqual([NODE_EXE, SCRIPT, TEMP_ROOT, NONCE, "5000"]);
    expect(argv).toHaveLength(5);
    expect(argv.join(" ")).not.toMatch(/cmd\.exe|powershell|&|\|/i);
    expect(Object.isFrozen(argv)).toBe(true);
  });

  it("canonicalizes separators without touching caller options", () => {
    const input = options({
      nodeExe: "C:/Program Files/nodejs/node.exe",
      ownedScript: "C:/Folio/owned/worker.js",
    });
    const before = JSON.stringify(input);
    expect(ownedNodeArgv(input)).toEqual([
      NODE_EXE,
      SCRIPT,
      TEMP_ROOT,
      NONCE,
      "5000",
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    ["relative node", { nodeExe: "node.exe" }, "INVALID_NODE_EXE"],
    ["relative script", { ownedScript: "worker.js" }, "INVALID_OWNED_SCRIPT"],
    ["relative root", { tempRoot: "Folio" }, "INVALID_TEMP_ROOT"],
    [
      "script traversal",
      { ownedScript: "C:\\Folio\\owned\\..\\worker.js" },
      "INVALID_OWNED_SCRIPT",
    ],
    [
      "script outside root",
      { ownedScript: "C:\\Other\\worker.js" },
      "SCRIPT_OUTSIDE_ROOT",
    ],
    [
      "drive mismatch",
      { ownedScript: "D:\\Folio\\owned\\worker.js" },
      "SCRIPT_OUTSIDE_ROOT",
    ],
    ["unc root", { tempRoot: "\\\\server\\share" }, "INVALID_TEMP_ROOT"],
    ["device root", { tempRoot: "\\\\?\\C:\\Folio" }, "INVALID_TEMP_ROOT"],
    [
      "reserved name",
      { ownedScript: "C:\\Folio\\owned\\CON.js" },
      "INVALID_OWNED_SCRIPT",
    ],
    [
      "short name",
      { ownedScript: "C:\\Folio\\owned\\WORKER~1.js" },
      "INVALID_OWNED_SCRIPT",
    ],
    [
      "trailing dot",
      { ownedScript: "C:\\Folio\\owned\\worker.js." },
      "INVALID_OWNED_SCRIPT",
    ],
    ["empty nonce", { nonce: "" }, "INVALID_NONCE"],
    ["spaced nonce", { nonce: "bad nonce" }, "INVALID_NONCE"],
    ["long nonce", { nonce: "a".repeat(129) }, "INVALID_NONCE"],
    ["zero timeout", { timeoutMs: 0 }, "INVALID_TIMEOUT"],
    [
      "huge timeout",
      { timeoutMs: OWNED_NODE_MAX_TIMEOUT_MS + 1 },
      "INVALID_TIMEOUT",
    ],
    ["fractional timeout", { timeoutMs: 1.5 }, "INVALID_TIMEOUT"],
  ] as Array<[string, Partial<OwnedNodeOptions>, string]>)(
    "rejects %s before any executor call",
    async (_label, overrides, code) => {
      const port = executor(outcome());
      const result = await createOwnedNodeJob(options(overrides), port);
      expect(result.status).toBe("NOT_RUN");
      if (result.status === "NOT_RUN") expect(result.code).toBe(code);
      expect(port.calls).toHaveLength(0);
    },
  );
});

describe("createOwnedNodeJob dispositions", () => {
  it("returns PASS only for a confirmed owned, exited, empty job with exit 0", async () => {
    const input = options();
    const reply = outcome();
    const before = JSON.stringify(input);
    const replyBefore = JSON.stringify(reply);
    const port = executor(reply);

    const result = await createOwnedNodeJob(input, port);

    expect(result).toEqual({
      status: "PASS",
      ownership: "OWNED",
      nonce: NONCE,
      exited: true,
      processCount: 0,
      exitCode: 0,
      timedOut: false,
      stdoutBytes: 17,
      stderrBytes: 0,
      truncated: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(reply)).toBe(replyBefore);
  });

  it("treats a nonzero child exit as a determined failure, not NOT_RUN or PASS", async () => {
    const port = executor(
      outcome({ exitCode: 7, stderrBytes: 40, truncated: true }),
    );
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("FAILED");
    expect(result).toMatchObject({
      code: "CHILD_EXIT",
      ownership: "OWNED",
      exitCode: 7,
      processCount: 0,
      timedOut: false,
    });
  });

  it("treats a reported timeout as a launched failure", async () => {
    const port = executor(
      outcome({
        exited: false,
        timedOut: true,
        exitCode: null,
        processCount: 1,
      }),
    );
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("FAILED");
    expect(result).toMatchObject({
      code: "TIMEOUT",
      timedOut: true,
      processCount: 1,
    });
  });

  it("treats an unowned job as a determined failure", async () => {
    const port = executor(outcome({ owned: false }));
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") expect(result.code).toBe("NOT_OWNED");
  });

  it("treats a job that did not exit as a launched failure", async () => {
    const port = executor(outcome({ exited: false, exitCode: null }));
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") expect(result.code).toBe("NOT_EXITED");
  });

  it("treats surviving job processes as a launched failure", async () => {
    const port = executor(outcome({ processCount: 2 }));
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("FAILED");
    expect(result).toMatchObject({ code: "ORPHAN_PROCESS", processCount: 2 });
  });

  it("does not pass on exit 0 while nonce is foreign", async () => {
    const port = executor(
      outcome({ nonce: "foreign", ownRootNonce: "foreign" }),
    );
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") expect(result.code).toBe("NONCE_MISMATCH");
  });

  it("does not pass when only the root nonce is foreign", async () => {
    const port = executor(outcome({ ownRootNonce: "foreign" }));
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("FAILED");
    if (result.status === "FAILED") expect(result.code).toBe("NONCE_MISMATCH");
  });

  it("requires exit 0 independently of a valid nonce", async () => {
    const port = executor(outcome({ exitCode: 1 }));
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("FAILED");
    expect(result).not.toMatchObject({ status: "PASS" });
  });
});

describe("createOwnedNodeJob indeterminate results", () => {
  it.each([
    ["null", null],
    ["array", []],
    ["string", "owned"],
    ["missing ownRootNonce", outcome({ ownRootNonce: undefined })],
    ["numeric nonce", outcome({ nonce: 1 })],
    ["negative exit code", outcome({ exitCode: -1 })],
    ["fractional exit code", outcome({ exitCode: 1.5 })],
    ["negative stdout", outcome({ stdoutBytes: -1 })],
    ["oversized stdout", outcome({ stdoutBytes: 64 * 1024 + 1 })],
    ["non boolean truncated", outcome({ truncated: "no" })],
    ["non boolean timedOut", outcome({ timedOut: "no" })],
    ["non boolean exited", outcome({ exited: "yes" })],
    ["negative process count", outcome({ processCount: -1 })],
    [
      "getter result",
      Object.defineProperty({}, "nonce", {
        enumerable: true,
        get: () => NONCE,
      }),
    ],
  ] as Array<[string, unknown]>)(
    "reports UNKNOWN for malformed result: %s",
    async (_label, reply) => {
      const port = executor(reply);
      const result = await createOwnedNodeJob(options(), port);
      expect(result.status).toBe("UNKNOWN");
      if (result.status === "UNKNOWN")
        expect(result.code).toMatch(/^INVALID_RESULT/);
    },
  );

  it("rejects a result larger than the bounded envelope as UNKNOWN", async () => {
    const port = executor(
      outcome({ padding: "x".repeat(OWNED_NODE_MAX_RESULT_BYTES) }),
    );
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("UNKNOWN");
    if (result.status === "UNKNOWN")
      expect(result.code).toMatch(/^INVALID_RESULT|JSON_LIMIT/);
  });

  it("reports executor rejection as UNKNOWN because work may have started", async () => {
    const input = options();
    const before = JSON.stringify(input);
    const port: OwnedNodeExecutorPort = {
      execute() {
        return Promise.reject(new Error("native helper unavailable"));
      },
    };
    const result = await createOwnedNodeJob(input, port);
    expect(result.status).toBe("UNKNOWN");
    if (result.status === "UNKNOWN")
      expect(result.code).toBe("EXECUTOR_FAILED");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("reports a synchronous executor throw as UNKNOWN", async () => {
    const port: OwnedNodeExecutorPort = {
      execute() {
        throw new Error("spawn refused");
      },
    };
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("UNKNOWN");
    if (result.status === "UNKNOWN")
      expect(result.code).toBe("EXECUTOR_FAILED");
  });

  it("preserves executor cancellation codes as UNKNOWN", async () => {
    const port: OwnedNodeExecutorPort = {
      execute() {
        return Promise.reject(
          Object.assign(new Error("timeout"), { code: "EXECUTOR_TIMEOUT" }),
        );
      },
    };
    const result = await createOwnedNodeJob(options(), port);
    expect(result.status).toBe("UNKNOWN");
    if (result.status === "UNKNOWN")
      expect(result.code).toBe("EXECUTOR_FAILED");
  });
});

describe("createOwnedNodeJob prelaunch rejection", () => {
  it("rejects non-win32 platforms without calling the executor", async () => {
    const port = executor(outcome());
    const result = await createOwnedNodeJob(
      options({ platform: "darwin" }),
      port,
    );
    expect(result.status).toBe("NOT_RUN");
    if (result.status === "NOT_RUN")
      expect(result.code).toBe("PLATFORM_UNSUPPORTED");
    expect(port.calls).toHaveLength(0);
  });

  it("rejects an executor without execute as NOT_RUN", async () => {
    const result = await createOwnedNodeJob(
      options(),
      {} as OwnedNodeExecutorPort,
    );
    expect(result.status).toBe("NOT_RUN");
    if (result.status === "NOT_RUN")
      expect(result.code).toBe("EXECUTOR_INVALID");
  });

  it("passes a frozen argv list and does not mutate caller options", async () => {
    let received: readonly string[] | null = null;
    const input = options();
    const before = JSON.stringify(input);
    const port: OwnedNodeExecutorPort = {
      execute(argv) {
        received = argv;
        expect(Object.isFrozen(argv)).toBe(true);
        expect(() => (argv as string[]).push("--extra")).toThrow();
        return outcome();
      },
    };
    const result = await createOwnedNodeJob(input, port);
    expect(result.status).toBe("PASS");
    expect(received).toEqual([NODE_EXE, SCRIPT, TEMP_ROOT, NONCE, "5000"]);
    expect(JSON.stringify(input)).toBe(before);
  });
});
