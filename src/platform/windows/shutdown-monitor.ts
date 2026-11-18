import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { canonical } from "../../collaboration/runtime/canonical";
import { CollaborationError } from "../../collaboration/runtime/contract";
import type { WindowsNativeProbe } from "./native-probe";
import {
  createOwnedNodeJob,
  ownedNodeArgv,
  type OwnedNodeExecutorPort,
  type OwnedNodeOptions,
  type OwnedNodeResult,
} from "./owned-node";
import {
  validateOwnedHelperPath,
  WindowsOwnedExecutor,
} from "./owned-executor";
import {
  asciiCaseFold,
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeEvidence,
} from "./path-policy";

export type WindowsShutdownIntent = OwnedNodeOptions & Readonly<{
  ownership: "OWNED";
  /** Expected hostname label, not authenticated hardware identity. */
  machineId: string;
  /** Parent-issued logical child identity, not a PID. */
  childId: string;
  helperPath: string;
  approvedTempParent: string;
  hashes: Readonly<{ helper: string; node: string; script: string }>;
}>;

export type WindowsShutdownDependencies = Readonly<{
  nativeProbe: Pick<WindowsNativeProbe, "probe">;
  /** Contract simulation only. Never establishes Windows physical proof. */
  untrustedTest?: Readonly<{
    machineId(): string;
    readFile(path: string): Uint8Array;
    executor: OwnedNodeExecutorPort;
  }>;
}>;

export type WindowsShutdownBinding = Readonly<{
  machineId: string;
  childId: string;
  nonce: string;
}>;

export type WindowsShutdownAttempt = Readonly<{
  binding: WindowsShutdownBinding;
  helperPath: string;
  argv: readonly string[];
}>;

export type WindowsShutdownReceipt = Readonly<{
  schemaVersion: 1;
  status: "COMPLETED" | "PROCESS_FAILED" | "TIMED_OUT" | "UNKNOWN" | "NOT_RUN";
  code: string;
  reason: string;
  intent: WindowsShutdownIntent | null;
  binding: WindowsShutdownBinding | null;
  attempt: WindowsShutdownAttempt | null;
  attempted: boolean;
  native: OwnedNodeResult | null;
  evidence: Readonly<{
    root: WindowsProbeEvidence | null;
    script: WindowsProbeEvidence | null;
  }>;
  hashesVerified: boolean;
  cleanupConfirmed: boolean;
  productResult: "NOT_RUN";
  physical: "NOT_RUN";
}>;

const HASH = /^[a-f0-9]{64}$/;
const MACHINE = /^[A-Za-z0-9_.-]{1,253}$/;
const CHILD = /^[A-Za-z0-9_-]{1,128}$/;
const INTENT_KEYS = new Set([
  "platform", "ownership", "machineId", "childId", "helperPath",
  "approvedTempParent", "hashes", "nodeExe", "ownedScript", "tempRoot",
  "nonce", "timeoutMs",
]);

function fail(code: string): never {
  throw new CollaborationError(code);
}

function absolute(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z]:[\\/]/.test(value))
    fail("SHUTDOWN_PATH");
  return validateWindowsPath(value, `${value[0]}:\\`).canonical;
}

function snapshotIntent(value: WindowsShutdownIntent): WindowsShutdownIntent {
  // canonical rejects accessors, exotic prototypes and non-JSON data first.
  const data = JSON.parse(canonical(value, 16_384)) as WindowsShutdownIntent;
  if (!data || Array.isArray(data) || typeof data !== "object")
    fail("SHUTDOWN_INTENT");
  if (Object.keys(data).some((key) => !INTENT_KEYS.has(key)))
    fail("SHUTDOWN_INTENT");
  if (data.ownership !== "OWNED") fail("SHUTDOWN_NOT_OWNED");
  if (typeof data.machineId !== "string" || !MACHINE.test(data.machineId))
    fail("SHUTDOWN_MACHINE");
  if (typeof data.childId !== "string" || !CHILD.test(data.childId))
    fail("SHUTDOWN_CHILD");
  const hashes = data.hashes;
  if (
    !hashes || typeof hashes !== "object" || Array.isArray(hashes) ||
    Object.keys(hashes).sort().join(",") !== "helper,node,script" ||
    ![hashes.helper, hashes.node, hashes.script].every(
      (hash) => typeof hash === "string" && HASH.test(hash),
    )
  ) fail("SHUTDOWN_HASH_REQUIRED");
  const approvedTempParent = absolute(data.approvedTempParent);
  if (/^[A-Za-z]:\\$/.test(approvedTempParent))
    fail("SHUTDOWN_TEMP_PARENT");
  const tempRoot = validateWindowsPath(data.tempRoot, approvedTempParent);
  if (!tempRoot.relative) fail("SHUTDOWN_TEMP_PARENT");
  const ownedScript = validateWindowsPath(data.ownedScript, tempRoot.canonical);
  if (!ownedScript.relative) fail("SHUTDOWN_SCRIPT");
  const nodeExe = absolute(data.nodeExe);
  if (!/\.exe$/i.test(nodeExe)) fail("SHUTDOWN_NODE_EXE");
  const intent = Object.freeze({
    ...data,
    approvedTempParent,
    tempRoot: tempRoot.canonical,
    ownedScript: ownedScript.canonical,
    nodeExe,
    helperPath: validateOwnedHelperPath(data.helperPath),
    hashes: Object.freeze({ ...hashes }),
  });
  ownedNodeArgv({ ...intent, platform: "win32" });
  return intent;
}

function snapshotProbe(
  value: unknown,
  canonicalPath: string,
  canonicalRoot: string,
): WindowsProbeEvidence {
  const data: unknown = JSON.parse(canonical(value, 16_384));
  assertWindowsProbe(data, { canonicalPath, canonicalRoot });
  return Object.freeze(data as WindowsProbeEvidence);
}

function codeOf(error: unknown): string {
  return error instanceof CollaborationError
    ? error.code
    : "SHUTDOWN_PREFLIGHT_FAILED";
}

type CapturedTestPorts = Readonly<{
  machineId(): unknown;
  readFile(path: string): unknown;
  execute(argv: readonly string[]): unknown;
}>;

type CapturedPorts = Readonly<{
  probe(path: string, root: string): unknown;
  test: CapturedTestPorts | null;
}>;

// Reads one member through the prototype chain as a data descriptor.
// Accessors fail closed without invocation; absent members yield undefined.
function dataMember(container: unknown, key: string): unknown {
  let node = container;
  while (
    node !== null &&
    (typeof node === "object" || typeof node === "function")
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) fail("SHUTDOWN_ACCESSOR");
      return descriptor.value;
    }
    node = Object.getPrototypeOf(node);
  }
  return undefined;
}

// Captures one callable bound to its port object at construction, so later
// port mutation cannot retarget the callback or its receiver between awaits.
// Accessors and non-functions fail closed without being invoked.
function boundMethod(
  container: unknown,
  key: string,
): ((...args: never[]) => unknown) | null {
  let node = container;
  while (
    node !== null &&
    (typeof node === "object" || typeof node === "function")
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (descriptor !== undefined) {
      if (!("value" in descriptor) || typeof descriptor.value !== "function")
        return null;
      const fn = descriptor.value as (...args: never[]) => unknown;
      return (...args: never[]) => fn.apply(container, args);
    }
    node = Object.getPrototypeOf(node);
  }
  return null;
}

/**
 * One parent-approved, no-argument Node child launched in an owned Windows job.
 * No PID adoption, arbitrary argv/env, cancellation or durable retry authority.
 * The parent must authorize the pinned script and provide a trusted live probe.
 */
export class WindowsShutdownMonitor {
  readonly #intent: WindowsShutdownIntent | null;
  readonly #invalid: string | null;
  readonly #ports: CapturedPorts | null;
  readonly #portError: string | null;
  #result: Promise<WindowsShutdownReceipt> | undefined;
  #checkpoint: WindowsShutdownReceipt | null = null;
  #attempt: WindowsShutdownAttempt | null = null;
  #nativeResult: OwnedNodeResult | null = null;

  constructor(
    intent: WindowsShutdownIntent,
    dependencies: WindowsShutdownDependencies,
  ) {
    let snapshot: WindowsShutdownIntent | null = null;
    let invalid: string | null = null;
    try {
      snapshot = snapshotIntent(intent);
    } catch (error) {
      invalid = codeOf(error);
    }
    this.#intent = snapshot;
    this.#invalid = invalid;
    // Port callbacks and receivers are captured once here; dependency objects
    // and functions stay outside the canonical JSON snapshots.
    let ports: CapturedPorts | null = null;
    let portError: string | null = null;
    try {
      const probe = boundMethod(
        dataMember(dependencies, "nativeProbe"),
        "probe",
      );
      if (probe === null) fail("SHUTDOWN_NATIVE_REQUIRED");
      const test = dataMember(dependencies, "untrustedTest");
      let capturedTest: CapturedTestPorts | null = null;
      if (test !== undefined && test !== null) {
        const machineId = boundMethod(test, "machineId");
        const readFile = boundMethod(test, "readFile");
        const execute = boundMethod(dataMember(test, "executor"), "execute");
        if (machineId === null || readFile === null || execute === null)
          fail("SHUTDOWN_TEST_PORTS");
        capturedTest = Object.freeze({ machineId, readFile, execute });
      }
      ports = Object.freeze({ probe, test: capturedTest });
    } catch (error) {
      ports = null;
      portError = codeOf(error);
    }
    this.#ports = ports;
    this.#portError = portError;
  }

  run(): Promise<WindowsShutdownReceipt> {
    // Cache before any port runs, including a synchronously reentrant port.
    return this.#result ??= Promise.resolve()
      .then(() => this.#runOnce())
      .catch((error: unknown) => this.#unhandled(error));
  }

  // Backstop: run() resolves a receipt even if a defect escapes the staged
  // receipt paths below; it never becomes an uncaught rejection.
  #unhandled(error: unknown): WindowsShutdownReceipt {
    if (this.#attempt !== null && this.#checkpoint !== null)
      return Object.freeze({
        ...this.#checkpoint, status: "UNKNOWN", code: "SHUTDOWN_OUTCOME_UNKNOWN",
        reason: "Owned dispatch outcome could not be recorded", attempt: this.#attempt,
        attempted: true, native: this.#nativeResult, cleanupConfirmed: false,
      });
    const intent = this.#intent;
    const fallback: WindowsShutdownReceipt = {
      schemaVersion: 1,
      status: "NOT_RUN",
      code: codeOf(error),
      reason: "Owned shutdown rejected before a determined outcome",
      intent,
      binding: intent
        ? Object.freeze({
            machineId: intent.machineId,
            childId: intent.childId,
            nonce: intent.nonce,
          })
        : null,
      attempt: null,
      attempted: false,
      native: null,
      evidence: Object.freeze({ root: null, script: null }),
      hashesVerified: false,
      cleanupConfirmed: false,
      productResult: "NOT_RUN",
      physical: "NOT_RUN",
    };
    return Object.freeze(fallback);
  }

  async #runOnce(): Promise<WindowsShutdownReceipt> {
    const intent = this.#intent;
    const binding = intent ? Object.freeze({
      machineId: intent.machineId, childId: intent.childId, nonce: intent.nonce,
    }) : null;
    let root: WindowsProbeEvidence | null = null;
    let script: WindowsProbeEvidence | null = null;
    let hashesVerified = false;
    let attempt: WindowsShutdownAttempt | null = null;
    const receipt = (
      status: WindowsShutdownReceipt["status"],
      code: string,
      reason: string,
      native: OwnedNodeResult | null = null,
    ): WindowsShutdownReceipt => {
      const value: WindowsShutdownReceipt = {
      schemaVersion: 1, status, code, reason, intent, binding, attempt,
      attempted: attempt !== null, native,
      evidence: { root, script }, hashesVerified,
      cleanupConfirmed: native?.status === "PASS",
      productResult: "NOT_RUN", physical: "NOT_RUN",
      };
      this.#checkpoint = value;
      Object.freeze(value.evidence);
      return Object.freeze(value);
    };
    let execute: OwnedNodeExecutorPort["execute"] | null = null;
    let platform: NodeJS.Platform = process.platform;
    try {
      if (!intent) fail(this.#invalid ?? "SHUTDOWN_INTENT");
      const ports = this.#ports;
      if (ports === null)
        fail(this.#portError ?? "SHUTDOWN_NATIVE_REQUIRED");
      const test = ports.test;
      platform = test ? (intent.platform ?? process.platform) : process.platform;
      if (platform !== "win32" ||
          (intent.platform !== undefined && intent.platform !== "win32"))
        fail("PLATFORM_UNSUPPORTED");
      if ((test ? test.machineId() : hostname()) !== intent.machineId)
        fail("SHUTDOWN_MACHINE_MISMATCH");
      root = snapshotProbe(
        await ports.probe(intent.tempRoot, intent.approvedTempParent),
        intent.tempRoot, intent.approvedTempParent,
      );
      script = snapshotProbe(
        await ports.probe(intent.ownedScript, intent.tempRoot),
        intent.ownedScript, intent.tempRoot,
      );
      if (
        asciiCaseFold(script.rootFileId) !== asciiCaseFold(root.fileId) ||
        asciiCaseFold(script.rootVolumeId) !== asciiCaseFold(root.volumeId) ||
        script.sid !== root.sid || script.ownerSid !== root.ownerSid
      ) fail("SHUTDOWN_NATIVE_IDENTITY");
      for (const [path, expected] of [
        [intent.helperPath, intent.hashes.helper],
        [intent.nodeExe, intent.hashes.node],
        [intent.ownedScript, intent.hashes.script],
      ]) {
        const bytes = test
          ? (test.readFile(path) as Uint8Array)
          : readFileSync(path);
        if (createHash("sha256").update(bytes).digest("hex") !== expected)
          fail("SHUTDOWN_HASH_MISMATCH");
      }
      hashesVerified = true;
      if (test) {
        execute = test.execute;
      } else {
        const production = new WindowsOwnedExecutor({
          helperPath: intent.helperPath,
          platform,
        });
        execute = (argv: readonly string[]) => production.execute(argv);
      }
    } catch (error) {
      return receipt("NOT_RUN", codeOf(error), "Owned shutdown preflight rejected");
    }
    // No exception after this boundary is permission to retry the task.
    const native = await createOwnedNodeJob({ ...intent!, platform }, {
      execute: async (argv) => {
        attempt = Object.freeze({
          binding: binding!, helperPath: intent!.helperPath, argv,
        });
        this.#attempt = attempt;
        receipt("UNKNOWN", "OWNED_CHILD_IN_FLIGHT", "Owned dispatch is unresolved");
        const reply: unknown = await execute!(argv);
        const version = typeof reply === "object" && reply !== null
          ? Object.getOwnPropertyDescriptor(reply, "v") : undefined;
        if (!version || !("value" in version) ||
            !version.enumerable || version.value !== 1)
          fail("INVALID_RESULT_VERSION");
        return reply;
      },
    });
    this.#nativeResult = native;
    if (native.status === "PASS")
      return receipt("COMPLETED", "OWNED_CHILD_COMPLETED",
        "Owned child exited; product shutdown is not established", native);
    return receipt(
      native.status === "FAILED"
        ? (native.code === "TIMEOUT" ? "TIMED_OUT" : "PROCESS_FAILED")
        : native.status,
      native.code, native.reason, native,
    );
  }
}
