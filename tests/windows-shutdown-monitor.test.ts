import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationError } from "../src/collaboration/runtime/contract";
import {
  WindowsOwnedExecutor,
  WINDOWS_SHUTDOWN_MONITOR_MARKER,
  buildOwnedEnvironment,
  type OwnedHelperSpawn,
  type OwnedHelperSpawnOptions,
} from "../src/platform/windows/owned-executor";
import type { OwnedNodeExecutorPort } from "../src/platform/windows/owned-node";
import * as ownedNode from "../src/platform/windows/owned-node";
import type { WindowsNativeProbe } from "../src/platform/windows/native-probe";
import {
  WindowsShutdownMonitor,
  type WindowsShutdownDependencies,
  type WindowsShutdownIntent,
} from "../src/platform/windows/shutdown-monitor";

const HELPER = "C:\\Folio\\bin\\OwnedNodeJob.exe";
const NODE_EXE = "C:\\Program Files\\nodejs\\node.exe";
const TEMP_PARENT = "C:\\Folio\\Temp";
const TEMP_ROOT = "C:\\Folio\\Temp\\owned-1";
const SCRIPT = "C:\\Folio\\Temp\\owned-1\\worker.js";
const NONCE = "nonce_shutdown_01";
const MACHINE = "TEST-MACHINE";
const CHILD = "shutdown-child-1";
const VOLUME = "0123456789abcdef";
const OTHER_VOLUME = "fedcba9876543210";
const ROOT_FILE_ID = "a".repeat(32);
const PARENT_FILE_ID = "c".repeat(32);
const SCRIPT_FILE_ID = "b".repeat(32);
const SID = "S-1-5-21-100";
const ARGV: readonly string[] = [NODE_EXE, SCRIPT, TEMP_ROOT, NONCE, "5000"];

const HELPER_BYTES = new TextEncoder().encode("owned-helper-bytes");
const NODE_BYTES = new TextEncoder().encode("owned-node-bytes");
const SCRIPT_BYTES = new TextEncoder().encode("owned-script-bytes");

function pin(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const HASHES = Object.freeze({
  helper: pin(HELPER_BYTES),
  node: pin(NODE_BYTES),
  script: pin(SCRIPT_BYTES),
});

function intent(
  overrides: Record<string, unknown> = {},
): WindowsShutdownIntent {
  return {
    platform: "win32",
    nodeExe: NODE_EXE,
    ownedScript: SCRIPT,
    tempRoot: TEMP_ROOT,
    nonce: NONCE,
    timeoutMs: 5_000,
    ownership: "OWNED",
    machineId: MACHINE,
    childId: CHILD,
    helperPath: HELPER,
    approvedTempParent: TEMP_PARENT,
    hashes: { ...HASHES },
    ...overrides,
  } as WindowsShutdownIntent;
}

// Root evidence binds tempRoot to the approved parent; script evidence binds
// the worker to tempRoot and cross-links root file/volume/SID identities.
function evidence(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    canonicalPath: TEMP_ROOT,
    canonicalRoot: TEMP_PARENT,
    daclPrivate: true,
    fileId: ROOT_FILE_ID,
    linkCount: 1,
    localFilesystem: true,
    ownerSid: SID,
    platform: "win32",
    reparsePoint: false,
    rootFileId: PARENT_FILE_ID,
    rootVolumeId: VOLUME,
    sid: SID,
    volumeId: VOLUME,
    ...overrides,
  };
}

function scriptEvidence(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return evidence({
    canonicalPath: SCRIPT,
    canonicalRoot: TEMP_ROOT,
    fileId: SCRIPT_FILE_ID,
    rootFileId: ROOT_FILE_ID,
    ...overrides,
  });
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

type ProbeFn = (path: string, root: string) => unknown;

type TestPorts = {
  machineId(): string;
  readFile(path: string): Uint8Array;
  executor: OwnedNodeExecutorPort;
};

type World = Readonly<{
  calls: {
    probe: Array<readonly [string, string]>;
    read: string[];
    execute: string[][];
    machine: number;
  };
  probe: Pick<WindowsNativeProbe, "probe">;
  machine: { machineId(): string };
  reader: { readFile(path: string): Uint8Array };
  executor: OwnedNodeExecutorPort;
  test: TestPorts;
  dependencies: WindowsShutdownDependencies;
}>;

function world(
  options: {
    probe?: ProbeFn;
    machineId?: string;
    reply?: unknown;
  } = {},
): World {
  const calls = {
    probe: [] as Array<readonly [string, string]>,
    read: [] as string[],
    execute: [] as string[][],
    machine: 0,
  };
  const probe: Pick<WindowsNativeProbe, "probe"> = {
    async probe(path: string, root: string): Promise<unknown> {
      calls.probe.push([path, root]);
      if (options.probe) return options.probe(path, root);
      if (path === TEMP_ROOT && root === TEMP_PARENT) return evidence();
      if (path === SCRIPT && root === TEMP_ROOT) return scriptEvidence();
      throw new CollaborationError("PROBE_UNEXPECTED");
    },
  };
  const machine = {
    machineId(): string {
      calls.machine += 1;
      return options.machineId ?? MACHINE;
    },
  };
  const reader = {
    readFile(path: string): Uint8Array {
      calls.read.push(path);
      if (path === HELPER) return HELPER_BYTES;
      if (path === NODE_EXE) return NODE_BYTES;
      if (path === SCRIPT) return SCRIPT_BYTES;
      throw new CollaborationError("READ_UNEXPECTED");
    },
  };
  const executor: OwnedNodeExecutorPort = {
    execute(argv: readonly string[]): unknown {
      calls.execute.push([...argv]);
      return options.reply === undefined ? outcome() : options.reply;
    },
  };
  const test: TestPorts = {
    machineId: () => machine.machineId(),
    readFile: (path: string) => reader.readFile(path),
    executor,
  };
  return {
    calls,
    probe,
    machine,
    reader,
    executor,
    test,
    dependencies: { nativeProbe: probe, untrustedTest: test },
  };
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type SpawnCall = Readonly<{
  command: string;
  args: readonly string[];
  options: OwnedHelperSpawnOptions;
}>;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
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
): OwnedHelperSpawn & { calls: SpawnCall[]; children: FakeChild[] } {
  const calls: SpawnCall[] = [];
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
  }) as OwnedHelperSpawn & { calls: SpawnCall[]; children: FakeChild[] };
  spawn.calls = calls;
  spawn.children = children;
  return spawn;
}

function emitHelperResult(
  value: unknown,
  code = 0,
): (child: FakeChild) => void {
  return (child) => {
    child.stdout.write(JSON.stringify(value));
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  };
}

class ProbeWithPrivateState {
  readonly #calls: Array<readonly [string, string]> = [];
  get calls(): ReadonlyArray<readonly [string, string]> {
    return this.#calls;
  }
  async probe(path: string, root: string): Promise<unknown> {
    this.#calls.push([path, root]);
    if (path === TEMP_ROOT) return evidence();
    return scriptEvidence();
  }
}

describe("WindowsShutdownMonitor completed run", () => {
  it("completes a bound fake native outcome with frozen verified state", async () => {
    const input = intent();
    const inputBefore = JSON.stringify(input);
    const w = world();
    const receipt = await new WindowsShutdownMonitor(
      input,
      w.dependencies,
    ).run();

    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.code).toBe("OWNED_CHILD_COMPLETED");
    expect(receipt.attempted).toBe(true);
    expect(receipt.hashesVerified).toBe(true);
    expect(receipt.cleanupConfirmed).toBe(true);
    expect(receipt.productResult).toBe("NOT_RUN");
    expect(receipt.physical).toBe("NOT_RUN");
    expect(receipt.native).toMatchObject({
      status: "PASS",
      ownership: "OWNED",
      nonce: NONCE,
      exited: true,
      processCount: 0,
      exitCode: 0,
      timedOut: false,
    });
    expect(receipt.binding).toEqual({
      machineId: MACHINE,
      childId: CHILD,
      nonce: NONCE,
    });
    expect(receipt.attempt?.binding).toBe(receipt.binding);
    expect(receipt.attempt?.helperPath).toBe(HELPER);
    expect(receipt.attempt?.argv).toEqual([...ARGV]);
    expect(receipt.attempt?.argv).toHaveLength(5);
    expect(receipt.intent).not.toBe(input);
    expect(receipt.intent?.hashes).toEqual(HASHES);

    for (const value of [
      receipt,
      receipt.intent,
      receipt.intent?.hashes,
      receipt.binding,
      receipt.attempt,
      receipt.attempt?.argv,
      receipt.native,
      receipt.evidence,
      receipt.evidence.root,
      receipt.evidence.script,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(receipt.evidence.root).toMatchObject({
      canonicalPath: TEMP_ROOT,
      fileId: ROOT_FILE_ID,
    });
    expect(receipt.evidence.script).toMatchObject({
      canonicalPath: SCRIPT,
      rootFileId: ROOT_FILE_ID,
    });

    expect(w.calls.probe).toEqual([
      [TEMP_ROOT, TEMP_PARENT],
      [SCRIPT, TEMP_ROOT],
    ]);
    expect(w.calls.read).toEqual([HELPER, NODE_EXE, SCRIPT]);
    expect(w.calls.execute).toEqual([[...ARGV]]);
    expect(w.calls.machine).toBe(1);
    expect(JSON.stringify(input)).toBe(inputBefore);
  });
});

describe("WindowsShutdownMonitor native dispositions", () => {
  it("maps a nonzero child exit to PROCESS_FAILED", async () => {
    const w = world({
      reply: outcome({ exitCode: 7, stderrBytes: 40, truncated: true }),
    });
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("PROCESS_FAILED");
    expect(receipt.code).toBe("CHILD_EXIT");
    expect(receipt.attempted).toBe(true);
    expect(receipt.cleanupConfirmed).toBe(false);
    expect(receipt.native).toMatchObject({
      status: "FAILED",
      code: "CHILD_EXIT",
      ownership: "OWNED",
      exitCode: 7,
    });
  });

  it("maps a helper-reported timeout to TIMED_OUT", async () => {
    const w = world({
      reply: outcome({
        exited: false,
        timedOut: true,
        exitCode: null,
        processCount: 1,
      }),
    });
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("TIMED_OUT");
    expect(receipt.code).toBe("TIMEOUT");
    expect(receipt.attempted).toBe(true);
    expect(receipt.cleanupConfirmed).toBe(false);
    expect(receipt.native).toMatchObject({
      status: "FAILED",
      code: "TIMEOUT",
      timedOut: true,
    });
  });

  it("maps a CollaborationError executor rejection to UNKNOWN with its code", async () => {
    const w = world();
    w.test.executor = {
      execute() {
        return Promise.reject(new CollaborationError("EXECUTOR_TIMEOUT"));
      },
    };
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("UNKNOWN");
    expect(receipt.code).toBe("EXECUTOR_TIMEOUT");
    expect(receipt.attempted).toBe(true);
    expect(receipt.cleanupConfirmed).toBe(false);
  });

  it("maps a generic executor rejection to UNKNOWN", async () => {
    const w = world();
    w.test.executor = {
      execute() {
        return Promise.reject(new Error("helper gone"));
      },
    };
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("UNKNOWN");
    expect(receipt.code).toBe("EXECUTOR_FAILED");
    expect(receipt.attempted).toBe(true);
    expect(receipt.cleanupConfirmed).toBe(false);
  });
});

describe("WindowsShutdownMonitor malformed helper results", () => {
  it.each([
    ["null result", null, "UNKNOWN", "UNKNOWN", "INVALID_RESULT_VERSION"],
    [
      "missing result fields",
      { v: 1 },
      "UNKNOWN",
      "UNKNOWN",
      "INVALID_RESULT_FIELD",
    ],
    [
      "numeric result nonce",
      outcome({ nonce: 1 }),
      "UNKNOWN",
      "UNKNOWN",
      "INVALID_RESULT_NONCE",
    ],
    [
      "unsupported version",
      outcome({ v: 2 }),
      "UNKNOWN",
      "UNKNOWN",
      "INVALID_RESULT_VERSION",
    ],
    [
      "foreign nonce",
      outcome({ nonce: "foreign", ownRootNonce: "foreign" }),
      "PROCESS_FAILED",
      "FAILED",
      "NONCE_MISMATCH",
    ],
    [
      "foreign root nonce",
      outcome({ ownRootNonce: "foreign" }),
      "PROCESS_FAILED",
      "FAILED",
      "NONCE_MISMATCH",
    ],
    [
      "unowned job",
      outcome({ owned: false }),
      "PROCESS_FAILED",
      "FAILED",
      "NOT_OWNED",
    ],
    [
      "leftover processes",
      outcome({ processCount: 2 }),
      "PROCESS_FAILED",
      "FAILED",
      "ORPHAN_PROCESS",
    ],
    [
      "unexited child",
      outcome({ exited: false, exitCode: null }),
      "PROCESS_FAILED",
      "FAILED",
      "NOT_EXITED",
    ],
  ] as Array<[string, unknown, string, string, string]>)(
    "never completes on %s",
    async (_label, reply, status, nativeStatus, code) => {
      const w = world({ reply });
      const receipt = await new WindowsShutdownMonitor(
        intent(),
        w.dependencies,
      ).run();
      expect(receipt.status).toBe(status);
      expect(receipt.code).toBe(code);
      expect(receipt.native).toMatchObject({ status: nativeStatus, code });
      expect(receipt.attempted).toBe(true);
      expect(receipt.cleanupConfirmed).toBe(false);
    },
  );

  it("preserves UNKNOWN ownership facts on a nonce mismatch", async () => {
    const w = world({
      reply: outcome({ nonce: "foreign", ownRootNonce: "foreign" }),
    });
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.native).toMatchObject({
      status: "FAILED",
      code: "NONCE_MISMATCH",
      ownership: "UNKNOWN",
      nonce: NONCE,
    });
  });

  it("rejects an accessor result version without invoking the getter", async () => {
    let invoked = 0;
    const reply = outcome();
    Object.defineProperty(reply, "v", {
      enumerable: true,
      get: () => {
        invoked += 1;
        return 1;
      },
    });
    const w = world({ reply });
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("UNKNOWN");
    expect(receipt.code).toBe("INVALID_RESULT_VERSION");
    expect(invoked).toBe(0);
  });
});

describe("WindowsShutdownMonitor single attempt", () => {
  it("retains dispatch and native evidence when an unexpected wrapper failure escapes after launch", async () => {
    const w = world();
    vi.spyOn(ownedNode, "createOwnedNodeJob").mockImplementationOnce(async (_options, executor) => {
      await executor.execute(ARGV);
      throw new Error("unexpected wrapper failure after owned dispatch");
    });
    const monitor = new WindowsShutdownMonitor(intent(), w.dependencies);
    const receipt = await monitor.run();
    expect(receipt).toMatchObject({status: "UNKNOWN", attempted: true, hashesVerified: true, cleanupConfirmed: false,
      attempt: {argv: ARGV, binding: {nonce: NONCE, childId: CHILD}},
      evidence: {root: {fileId: ROOT_FILE_ID}, script: {fileId: SCRIPT_FILE_ID}}});
    expect(await monitor.run()).toBe(receipt); expect(w.calls.execute).toHaveLength(1);
  });
  it("returns the same cached promise and launches once for repeated calls", async () => {
    const w = world();
    const monitor = new WindowsShutdownMonitor(intent(), w.dependencies);
    const first = monitor.run();
    const second = monitor.run();
    expect(first).toBe(second);
    const [a, b, c] = await Promise.all([first, second, monitor.run()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(w.calls.execute).toHaveLength(1);
    expect(w.calls.probe).toHaveLength(2);
  });

  it("does not relaunch on repeated run after a native timeout", async () => {
    const w = world({
      reply: outcome({
        exited: false,
        timedOut: true,
        exitCode: null,
        processCount: 1,
      }),
    });
    const monitor = new WindowsShutdownMonitor(intent(), w.dependencies);
    const receipt = await monitor.run();
    expect(receipt.status).toBe("TIMED_OUT");
    expect(await monitor.run()).toBe(receipt);
    expect(w.calls.execute).toHaveLength(1);
  });

  it("does not relaunch on repeated run after an UNKNOWN outcome", async () => {
    let executions = 0;
    const w = world();
    w.test.executor = {
      execute() {
        executions += 1;
        return Promise.reject(new Error("gone"));
      },
    };
    const monitor = new WindowsShutdownMonitor(intent(), w.dependencies);
    const receipt = await monitor.run();
    expect(receipt.status).toBe("UNKNOWN");
    expect(await monitor.run()).toBe(receipt);
    expect(executions).toBe(1);
  });
});

type PreflightCase = Readonly<{
  intent?: Record<string, unknown>;
  probe?: ProbeFn;
  machineId?: string;
  deps?: (w: World) => WindowsShutdownDependencies;
}>;

const PREFLIGHT: ReadonlyArray<readonly [string, string, PreflightCase]> = [
  ["non-owned intent", "SHUTDOWN_NOT_OWNED", { intent: { ownership: "SHARED" } }],
  [
    "invalid machine label",
    "SHUTDOWN_MACHINE",
    { intent: { machineId: "bad host" } },
  ],
  [
    "invalid child label",
    "SHUTDOWN_CHILD",
    { intent: { childId: "bad child!" } },
  ],
  ["missing hash pins", "SHUTDOWN_HASH_REQUIRED", { intent: { hashes: {} } }],
  [
    "uppercase hash pin",
    "SHUTDOWN_HASH_REQUIRED",
    {
      intent: {
        hashes: {
          helper: HASHES.helper.toUpperCase(),
          node: HASHES.node,
          script: HASHES.script,
        },
      },
    },
  ],
  [
    "extra hash key",
    "SHUTDOWN_HASH_REQUIRED",
    {
      intent: {
        hashes: { ...HASHES, extra: HASHES.script },
      },
    },
  ],
  [
    "hash byte mismatch",
    "SHUTDOWN_HASH_MISMATCH",
    {
      intent: {
        hashes: { ...HASHES, script: "0".repeat(64) },
      },
    },
  ],
  [
    "machine mismatch",
    "SHUTDOWN_MACHINE_MISMATCH",
    { machineId: "OTHER-HOST" },
  ],
  [
    "temp root outside parent",
    "OUTSIDE_ROOT",
    { intent: { tempRoot: "C:\\Other\\owned" } },
  ],
  [
    "temp root equal to parent",
    "SHUTDOWN_TEMP_PARENT",
    { intent: { tempRoot: TEMP_PARENT } },
  ],
  [
    "drive root parent",
    "SHUTDOWN_TEMP_PARENT",
    { intent: { approvedTempParent: "C:\\", tempRoot: "C:\\owned" } },
  ],
  [
    "script outside root",
    "OUTSIDE_ROOT",
    { intent: { ownedScript: "C:\\Folio\\Temp\\other.js" } },
  ],
  [
    "script equal to root",
    "SHUTDOWN_SCRIPT",
    { intent: { ownedScript: TEMP_ROOT } },
  ],
  [
    "UNC temp root",
    "UNC_PATH",
    { intent: { tempRoot: "\\\\server\\share\\owned" } },
  ],
  [
    "POSIX temp root",
    "NOT_ABSOLUTE",
    { intent: { tempRoot: "/tmp/owned" } },
  ],
  [
    "POSIX approved parent",
    "SHUTDOWN_PATH",
    { intent: { approvedTempParent: "/tmp" } },
  ],
  [
    "node without exe suffix",
    "SHUTDOWN_NODE_EXE",
    { intent: { nodeExe: "C:\\Program Files\\nodejs\\node" } },
  ],
  [
    "helper without exe suffix",
    "HELPER_NOT_EXE",
    { intent: { helperPath: "C:\\Folio\\bin\\helper.dll" } },
  ],
  [
    "relative helper path",
    "INVALID_HELPER",
    { intent: { helperPath: "bin\\helper.exe" } },
  ],
  [
    "missing native probe",
    "SHUTDOWN_NATIVE_REQUIRED",
    {
      deps: (w) =>
        ({
          untrustedTest: w.test,
        }) as unknown as WindowsShutdownDependencies,
    },
  ],
  [
    "probe port without probe",
    "SHUTDOWN_NATIVE_REQUIRED",
    {
      deps: (w) =>
        ({
          nativeProbe: {},
          untrustedTest: w.test,
        }) as unknown as WindowsShutdownDependencies,
    },
  ],
  [
    "missing test readFile",
    "SHUTDOWN_TEST_PORTS",
    {
      deps: (w) =>
        ({
          nativeProbe: w.probe,
          untrustedTest: { machineId: () => MACHINE, executor: w.executor },
        }) as unknown as WindowsShutdownDependencies,
    },
  ],
  [
    "missing test executor",
    "SHUTDOWN_TEST_PORTS",
    {
      deps: (w) =>
        ({
          nativeProbe: w.probe,
          untrustedTest: {
            machineId: () => MACHINE,
            readFile: (path: string) => w.reader.readFile(path),
            executor: {},
          },
        }) as unknown as WindowsShutdownDependencies,
    },
  ],
  [
    "probe collaboration error",
    "PROBE_FAILED",
    {
      probe: () => {
        throw new CollaborationError("PROBE_FAILED");
      },
    },
  ],
  [
    "probe generic error",
    "SHUTDOWN_PREFLIGHT_FAILED",
    {
      probe: () => {
        throw new Error("gone");
      },
    },
  ],
  [
    "non-private root evidence",
    "PROBE_DACL",
    {
      probe: (path) =>
        path === TEMP_ROOT
          ? evidence({ daclPrivate: false })
          : scriptEvidence(),
    },
  ],
  [
    "reparse script evidence",
    "PROBE_REPARSE",
    {
      probe: (path) =>
        path === SCRIPT ? scriptEvidence({ reparsePoint: true }) : evidence(),
    },
  ],
  [
    "foreign root file id",
    "SHUTDOWN_NATIVE_IDENTITY",
    {
      probe: (path) =>
        path === SCRIPT
          ? scriptEvidence({ rootFileId: "d".repeat(32) })
          : evidence(),
    },
  ],
  [
    "foreign root volume",
    "SHUTDOWN_NATIVE_IDENTITY",
    {
      probe: (path) =>
        path === SCRIPT
          ? scriptEvidence({
              volumeId: OTHER_VOLUME,
              rootVolumeId: OTHER_VOLUME,
            })
          : evidence(),
    },
  ],
  [
    "foreign sid",
    "SHUTDOWN_NATIVE_IDENTITY",
    {
      probe: (path) =>
        path === SCRIPT
          ? scriptEvidence({ sid: "S-1-5-21-999", ownerSid: "S-1-5-21-999" })
          : evidence(),
    },
  ],
  [
    "explicit non-win32 intent",
    "PLATFORM_UNSUPPORTED",
    { intent: { platform: "darwin" } },
  ],
];

describe("WindowsShutdownMonitor preflight rejection", () => {
  it.each(PREFLIGHT.map((c) => [...c] as [string, string, PreflightCase]))(
    "rejects %s without executing",
    async (_label, code, c) => {
      const w = world({ probe: c.probe, machineId: c.machineId });
      const monitor = new WindowsShutdownMonitor(
        intent(c.intent),
        c.deps ? c.deps(w) : w.dependencies,
      );
      const receipt = await monitor.run();
      expect(receipt.status).toBe("NOT_RUN");
      expect(receipt.code).toBe(code);
      expect(receipt.attempted).toBe(false);
      expect(receipt.attempt).toBeNull();
      expect(receipt.hashesVerified).toBe(false);
      expect(receipt.cleanupConfirmed).toBe(false);
      expect(w.calls.execute).toHaveLength(0);
    },
  );

  it("preserves completed root evidence when the script probe fails", async () => {
    const w = world({
      probe: (path) => {
        if (path === SCRIPT) throw new CollaborationError("PROBE_SCRIPT");
        return evidence();
      },
    });
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("NOT_RUN");
    expect(receipt.code).toBe("PROBE_SCRIPT");
    expect(receipt.evidence.root).toMatchObject({ canonicalPath: TEMP_ROOT });
    expect(receipt.evidence.script).toBeNull();
  });

  it("keeps both evidence records and clears hashesVerified on a hash mismatch", async () => {
    const w = world();
    const receipt = await new WindowsShutdownMonitor(
      intent({
        hashes: { ...HASHES, script: "0".repeat(64) },
      }),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("NOT_RUN");
    expect(receipt.code).toBe("SHUTDOWN_HASH_MISMATCH");
    expect(receipt.evidence.root).not.toBeNull();
    expect(receipt.evidence.script).not.toBeNull();
    expect(receipt.hashesVerified).toBe(false);
  });

  it("does not call any port when the intent itself is invalid", async () => {
    const w = world();
    const receipt = await new WindowsShutdownMonitor(
      intent({ ownership: "SHARED" }),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("NOT_RUN");
    expect(receipt.code).toBe("SHUTDOWN_NOT_OWNED");
    expect(w.calls.machine).toBe(0);
    expect(w.calls.probe).toHaveLength(0);
    expect(w.calls.read).toHaveLength(0);
    expect(w.calls.execute).toHaveLength(0);
  });
});

describe("WindowsShutdownMonitor dependency integrity", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty object", {}],
    ["missing probe member", { nativeProbe: {} }],
    ["non-callable probe member", { nativeProbe: { probe: "x" } }],
  ] as Array<[string, unknown]>)(
    "resolves NOT_RUN instead of rejecting for %s dependencies",
    async (_label, dependencies) => {
      const receipt = await new WindowsShutdownMonitor(
        intent(),
        dependencies as WindowsShutdownDependencies,
      ).run();
      expect(receipt.status).toBe("NOT_RUN");
      expect(receipt.code).toBe("SHUTDOWN_NATIVE_REQUIRED");
      expect(receipt.attempted).toBe(false);
    },
  );

  it("rejects accessor dependency members without invoking them", async () => {
    let invoked = 0;
    const dependencies = Object.defineProperty({}, "nativeProbe", {
      enumerable: true,
      get: () => {
        invoked += 1;
        return { probe: async () => evidence() };
      },
    }) as unknown as WindowsShutdownDependencies;
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      dependencies,
    ).run();
    expect(receipt.status).toBe("NOT_RUN");
    expect(receipt.code).toBe("SHUTDOWN_ACCESSOR");
    expect(invoked).toBe(0);
  });

  it("rejects an accessor probe member without invoking it", async () => {
    let invoked = 0;
    const nativeProbe = Object.defineProperty({}, "probe", {
      enumerable: true,
      get: () => {
        invoked += 1;
        return async () => evidence();
      },
    }) as unknown as WindowsShutdownDependencies["nativeProbe"];
    const w = world();
    const receipt = await new WindowsShutdownMonitor(intent(), {
      nativeProbe,
      untrustedTest: w.test,
    }).run();
    expect(receipt.status).toBe("NOT_RUN");
    expect(receipt.code).toBe("SHUTDOWN_NATIVE_REQUIRED");
    expect(invoked).toBe(0);
  });

  it("binds a class probe instance so private fields resolve", async () => {
    const probe = new ProbeWithPrivateState();
    const w = world();
    const receipt = await new WindowsShutdownMonitor(intent(), {
      nativeProbe: probe,
      untrustedTest: w.test,
    }).run();
    expect(receipt.status).toBe("COMPLETED");
    expect(probe.calls).toHaveLength(2);
  });

  it("fails closed on an unbound class method reference", async () => {
    const instance = new ProbeWithPrivateState();
    const w = world();
    const receipt = await new WindowsShutdownMonitor(intent(), {
      nativeProbe: { probe: instance.probe },
      untrustedTest: w.test,
    }).run();
    expect(receipt.status).toBe("NOT_RUN");
    expect(receipt.code).toBe("SHUTDOWN_PREFLIGHT_FAILED");
  });
});

describe("WindowsShutdownMonitor snapshot isolation", () => {
  it("cannot be retargeted by mutating the intent or ports mid-probe", async () => {
    const gate = deferred<Record<string, unknown>>();
    const w = world({
      probe: (path) => (path === TEMP_ROOT ? gate.promise : scriptEvidence()),
    });
    const foreignCalls: string[][] = [];
    const foreign: OwnedNodeExecutorPort = {
      execute(argv: readonly string[]): unknown {
        foreignCalls.push([...argv]);
        return outcome();
      },
    };
    const input = intent();
    const monitor = new WindowsShutdownMonitor(input, w.dependencies);
    const pending = monitor.run();
    for (let index = 0; index < 50 && w.calls.probe.length === 0; index += 1)
      await Promise.resolve();
    expect(w.calls.probe).toHaveLength(1);

    const mutableInput = input as Record<string, unknown>;
    mutableInput.ownedScript = "C:\\evil\\worker.js";
    mutableInput.nonce = "foreign-nonce";
    (input.hashes as Record<string, string>).script = "f".repeat(64);
    (w.probe as Record<string, unknown>).probe = () => {
      throw new Error("swapped");
    };
    (w.test as Record<string, unknown>).readFile = () => new Uint8Array([0]);
    (w.test as Record<string, unknown>).machineId = () => "FOREIGN-HOST";
    w.test.executor = foreign;
    (w.dependencies as Record<string, unknown>).nativeProbe = {
      probe: () => {
        throw new Error("swapped");
      },
    };

    gate.resolve(evidence());
    const receipt = await pending;
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.attempt?.argv).toEqual([...ARGV]);
    expect(w.calls.probe).toHaveLength(2);
    expect(w.calls.execute).toEqual([[...ARGV]]);
    expect(foreignCalls).toHaveLength(0);
  });

  it("stores frozen evidence copies, not the probe's live objects", async () => {
    const live = evidence();
    const w = world({
      probe: (path) => (path === SCRIPT ? scriptEvidence() : live),
    });
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.evidence.root).not.toBe(live);
    (live as Record<string, unknown>).fileId = "0".repeat(32);
    expect(receipt.evidence.root?.fileId).toBe(ROOT_FILE_ID);
  });
});

describe("WindowsShutdownMonitor real WindowsOwnedExecutor route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function realExecutor(spawn: OwnedHelperSpawn): WindowsOwnedExecutor {
    return new WindowsOwnedExecutor({
      helperPath: HELPER,
      platform: "win32",
      spawn,
      exists: () => true,
      graceMs: 5,
    });
  }

  it("spawns the pinned helper with fixed argv and a sanitized environment", async () => {
    vi.stubEnv("FOLIO_DATA_DIR", "C:\\leak");
    vi.stubEnv("FOLIO_ALLOW_GUI_TESTS", "1");
    vi.stubEnv("NODE_OPTIONS", "--inspect=127.0.0.1");
    vi.stubEnv("FOLIO_SYNC_TOKEN", "leak");
    vi.stubEnv("APP_SECRET", "leak");
    vi.stubEnv("OPENAI_API_KEY", "leak");
    const spawn = fakeSpawn(emitHelperResult(outcome()));
    const w = world();
    w.test.executor = realExecutor(spawn);
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("COMPLETED");
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    expect(call?.command).toBe(HELPER);
    expect(call?.args).toEqual([...ARGV]);
    expect(call?.options.shell).toBe(false);
    expect(call?.options.windowsHide).toBe(true);
    expect(call?.options.cwd).toBe(TEMP_ROOT);
    expect(call?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(call?.options.env.TEMP).toBe(TEMP_ROOT);
    expect(call?.options.env.TMP).toBe(TEMP_ROOT);
    for (const key of Object.keys(call?.options.env ?? {}))
      expect(key).not.toMatch(
        /FOLIO|TOKEN|SECRET|PASSWORD|CREDENTIAL|API|NODE_OPTIONS/i,
      );
    expect(spawn.children[0]?.killed).toBe(false);
  });

  it("maps a nonzero helper exit to UNKNOWN without an early kill", async () => {
    const spawn = fakeSpawn(emitHelperResult("", 3));
    const w = world();
    w.test.executor = realExecutor(spawn);
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("UNKNOWN");
    expect(receipt.code).toBe("HELPER_EXIT");
    expect(spawn.children[0]?.killed).toBe(false);
    expect(receipt.cleanupConfirmed).toBe(false);
  });

  it("maps an unowned helper reply to PROCESS_FAILED without killing the helper", async () => {
    const spawn = fakeSpawn(emitHelperResult(outcome({ owned: false })));
    const w = world();
    w.test.executor = realExecutor(spawn);
    const receipt = await new WindowsShutdownMonitor(
      intent(),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("PROCESS_FAILED");
    expect(receipt.code).toBe("NOT_OWNED");
    expect(spawn.children[0]?.killed).toBe(false);
    expect(receipt.cleanupConfirmed).toBe(false);
  });

  it("kills only its own spawned helper past the bounded deadline", async () => {
    const spawn = fakeSpawn(() => undefined);
    const w = world();
    w.test.executor = realExecutor(spawn);
    const receipt = await new WindowsShutdownMonitor(
      intent({ timeoutMs: 1 }),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("UNKNOWN");
    expect(receipt.code).toBe("EXECUTOR_TIMEOUT");
    expect(spawn.children[0]?.killed).toBe(true);
    expect(receipt.cleanupConfirmed).toBe(false);
  });

  it("buildOwnedEnvironment allowlists and pins TEMP/TMP as a fixture check", () => {
    const environment = buildOwnedEnvironment(
      {
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
        TEMP: "C:\\public",
        FOLIO_DATA_DIR: "C:\\leak",
        NODE_OPTIONS: "--inspect",
        GITHUB_TOKEN: "leak",
        AWS_SECRET_ACCESS_KEY: "leak",
      },
      TEMP_ROOT,
    );
    expect(environment).toEqual({
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      TEMP: TEMP_ROOT,
      TMP: TEMP_ROOT,
    });
  });
});

describe("WindowsShutdownMonitor platform gate", () => {
  it("rejects an explicit non-win32 intent platform before any port call", async () => {
    const w = world();
    const receipt = await new WindowsShutdownMonitor(
      intent({ platform: "darwin" }),
      w.dependencies,
    ).run();
    expect(receipt.status).toBe("NOT_RUN");
    expect(receipt.code).toBe("PLATFORM_UNSUPPORTED");
    expect(w.calls.machine).toBe(0);
    expect(w.calls.probe).toHaveLength(0);
    expect(w.calls.read).toHaveLength(0);
    expect(w.calls.execute).toHaveLength(0);
  });

  it("does not let production opt in to Windows on a non-win32 host", async () => {
    const w = world();
    const receipt = await new WindowsShutdownMonitor(intent(), {
      nativeProbe: w.probe,
    }).run();
    expect(receipt.status).toBe("NOT_RUN");
    // On a real win32 host the machine label, fake paths and missing pinned
    // files still fail preflight before the production executor is built.
    if (process.platform !== "win32")
      expect(receipt.code).toBe("PLATFORM_UNSUPPORTED");
  });
});

describe("WindowsOwnedExecutor startShutdownMonitor", () => {
  function monitorExecutor(spawn: OwnedHelperSpawn): WindowsOwnedExecutor {
    return new WindowsOwnedExecutor({
      helperPath: HELPER,
      platform: "win32",
      spawn,
      exists: () => true,
      graceMs: 5,
    });
  }

  it("launches the pinned helper with the five argv plus the exact marker", () => {
    const spawn = fakeSpawn(() => undefined);
    const executor = monitorExecutor(spawn);
    const argv = [...ARGV, WINDOWS_SHUTDOWN_MONITOR_MARKER];
    const child = executor.startShutdownMonitor(argv);
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    expect(call?.command).toBe(HELPER);
    expect(call?.args).toEqual(argv);
    expect(call?.options.shell).toBe(false);
    expect(call?.options.windowsHide).toBe(true);
    expect(call?.options.cwd).toBe(TEMP_ROOT);
    // Monitor mode pipes stdin instead of ignoring it; the caller owns the
    // returned handle and the helper relays that pipe to the owned child.
    expect(call?.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(call?.options.env.TEMP).toBe(TEMP_ROOT);
    expect(child).toBe(spawn.children[0]);
  });

  it("also accepts the legacy five-field argv without the marker", () => {
    const spawn = fakeSpawn(() => undefined);
    const executor = monitorExecutor(spawn);
    executor.startShutdownMonitor(ARGV);
    expect(spawn.calls[0]?.args).toEqual([...ARGV]);
    expect(spawn.calls[0]?.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("exposes a writable stdin for the owned monitor session", () => {
    const spawn = fakeSpawn(() => undefined);
    const executor = monitorExecutor(spawn);
    const child = executor.startShutdownMonitor([
      ...ARGV,
      WINDOWS_SHUTDOWN_MONITOR_MARKER,
    ]) as unknown as FakeChild;
    child.stdin.write('{"v":1,"type":"init"}\n');
    expect(child.stdin.read()?.toString()).toContain('"init"');
    // The caller never sees a kill for the normal monitor route.
    expect(child.killed).toBe(false);
  });

  it.each([
    ["seven fields", [...ARGV, WINDOWS_SHUTDOWN_MONITOR_MARKER, "extra"]],
    ["four fields", ARGV.slice(0, 4) as unknown as string[]],
    ["wrong marker", [...ARGV, "--other-flag"]],
    ["empty argv", [] as string[]],
  ])("rejects %s without spawning", (_label, argv) => {
    const spawn = fakeSpawn(() => undefined);
    const executor = monitorExecutor(spawn);
    expect(() => executor.startShutdownMonitor(argv)).toThrow(
      CollaborationError,
    );
    expect(spawn.calls).toHaveLength(0);
  });

  it("keeps the helper source protocol: exact marker, no-argument node command line, bounded stdin relay", () => {
    const source = readFileSync(
      new URL("../scripts/platform/windows/OwnedNodeJob.cs", import.meta.url),
      "utf8",
    );
    // Parse accepts 5 or 6 args; the sixth must be the exact marker.
    expect(source).toContain('"--shutdown-monitor-stdin-v1"');
    expect(source).toMatch(/rawArgs\.Length != 5 && rawArgs\.Length != 6/);
    expect(source).toMatch(/rawArgs\[5\] != ShutdownMonitorMarker/);
    // The native command line remains quoted node + script only — no script
    // arguments are ever appended.
    expect(source).toContain(
      'string commandLine = Quote(args.NodeExe) + " " + Quote(args.OwnedScript);',
    );
    // Monitor mode keeps the child stdin open and relays bounded parent
    // stdin asynchronously instead of closing it like the legacy route.
    expect(source).toContain("RelayStandardInput");
    expect(source).toContain("MaxStdinRelayBytes");
    expect(source).toContain("args.ShutdownMonitor");
    // A relay overflow/IO failure must not look like a clean owner EOF: the
    // helper writes a fixed invalid protocol line before closing so the
    // worker retains UNKNOWN.
    expect(source).toContain("OWNED_HELPER_STDIN_ERROR");
    // Monitor mode persists the exact native result as an immutable
    // helper-result.json inside the owned session root before stdout.
    expect(source).toContain("helper-result.json");
    expect(source).toContain("FileMode.CreateNew");
    expect(source).toMatch(/persisted\.Flush\(true\)/);
  });
});
