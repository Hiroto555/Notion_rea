import {
  CollaborationError,
  wellFormed,
} from "../../collaboration/runtime/contract";
import { canonical } from "../../collaboration/runtime/canonical";
import { validateWindowsPath } from "./path-policy";

export const OWNED_NODE_MAX_TIMEOUT_MS = 300_000;
export const OWNED_NODE_MAX_RESULT_BYTES = 64 * 1024;
export const OWNED_NODE_MAX_STREAM_BYTES = 64 * 1024;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LABEL_PATTERN = /^(?:[A-Za-z]:[\\/])/;

export type OwnedNodeOptions = Readonly<{
  platform?: NodeJS.Platform;
  nodeExe: string;
  ownedScript: string;
  tempRoot: string;
  nonce: string;
  timeoutMs: number;
}>;

export type OwnedNodeExecutorPort = Readonly<{
  execute(argv: readonly string[]): Promise<unknown> | unknown;
}>;

export type OwnedNodeFacts = Readonly<{
  ownership: "OWNED" | "UNOWNED" | "UNKNOWN";
  exitCode: number | null;
  processCount: number | null;
  timedOut: boolean;
}>;

export type OwnedNodeResult =
  | Readonly<{
      status: "PASS";
      ownership: "OWNED";
      nonce: string;
      exited: true;
      processCount: 0;
      exitCode: 0;
      timedOut: false;
      stdoutBytes: number;
      stderrBytes: number;
      truncated: boolean;
    }>
  | Readonly<{
      status: "NOT_RUN";
      code: string;
      reason: string;
      nonce: string | null;
    }>
  | Readonly<{
      status: "FAILED";
      code: string;
      reason: string;
      nonce: string | null;
      ownership: "OWNED" | "UNOWNED" | "UNKNOWN";
      exitCode: number | null;
      processCount: number | null;
      timedOut: boolean;
    }>
  | Readonly<{
      status: "UNKNOWN";
      code: string;
      reason: string;
      nonce: string | null;
    }>;

type Validated = Readonly<{
  nodeExe: string;
  ownedScript: string;
  tempRoot: string;
  nonce: string;
  timeoutMs: number;
}>;

function invalid(code: string): never {
  throw new CollaborationError(code);
}

function canonicalAbsolute(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value))
    invalid(`INVALID_${label}`);
  const input = value as string;
  if (!LABEL_PATTERN.test(input)) invalid(`INVALID_${label}`);
  try {
    return validateWindowsPath(input, `${input[0].toUpperCase()}:\\`).canonical;
  } catch (error) {
    if (error instanceof CollaborationError) invalid(`INVALID_${label}`);
    throw error;
  }
}

function canonicalRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value))
    invalid("INVALID_TEMP_ROOT");
  const input = value as string;
  if (!LABEL_PATTERN.test(input)) invalid("INVALID_TEMP_ROOT");
  try {
    return validateWindowsPath(input, `${input[0].toUpperCase()}:\\`).canonical;
  } catch (error) {
    if (error instanceof CollaborationError) invalid("INVALID_TEMP_ROOT");
    throw error;
  }
}

function validateOptions(options: OwnedNodeOptions): Validated {
  if (typeof options !== "object" || options === null)
    invalid("INVALID_OPTIONS");
  if ((options.platform ?? process.platform) !== "win32")
    invalid("PLATFORM_UNSUPPORTED");
  const tempRoot = canonicalRoot(options.tempRoot);
  const nodeExe = canonicalAbsolute(options.nodeExe, "NODE_EXE");
  const ownedScript = canonicalAbsolute(options.ownedScript, "OWNED_SCRIPT");
  try {
    validateWindowsPath(ownedScript, tempRoot);
  } catch (error) {
    if (error instanceof CollaborationError) invalid("SCRIPT_OUTSIDE_ROOT");
    throw error;
  }
  if (
    typeof options.nonce !== "string" ||
    !wellFormed(options.nonce) ||
    !NONCE_PATTERN.test(options.nonce)
  ) {
    invalid("INVALID_NONCE");
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > OWNED_NODE_MAX_TIMEOUT_MS
  ) {
    invalid("INVALID_TIMEOUT");
  }
  return Object.freeze({
    nodeExe,
    ownedScript,
    tempRoot,
    nonce: options.nonce,
    timeoutMs: options.timeoutMs,
  });
}

export function ownedNodeArgv(options: OwnedNodeOptions): readonly string[] {
  const validated = validateOptions(options);
  return Object.freeze([
    validated.nodeExe,
    validated.ownedScript,
    validated.tempRoot,
    validated.nonce,
    String(validated.timeoutMs),
  ]);
}

function notRun(
  code: string,
  reason: string,
  nonce: string | null,
): OwnedNodeResult {
  return Object.freeze({ status: "NOT_RUN", code, reason, nonce });
}

function failed(
  code: string,
  reason: string,
  nonce: string | null,
  facts: Partial<OwnedNodeFacts>,
): OwnedNodeResult {
  return Object.freeze({
    status: "FAILED",
    code,
    reason,
    nonce,
    ownership: facts.ownership ?? "UNKNOWN",
    exitCode: facts.exitCode ?? null,
    processCount: facts.processCount ?? null,
    timedOut: facts.timedOut ?? false,
  });
}

function unknown(
  code: string,
  reason: string,
  nonce: string | null,
): OwnedNodeResult {
  return Object.freeze({ status: "UNKNOWN", code, reason, nonce });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function field(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
    invalid("INVALID_RESULT_FIELD");
  return descriptor.value;
}

function boundedBytes(value: unknown, key: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > OWNED_NODE_MAX_STREAM_BYTES
  ) {
    invalid(`INVALID_RESULT_${key.toUpperCase()}`);
  }
  return value as number;
}

function readResult(reply: unknown, nonce: string): OwnedNodeResult {
  if (!isRecord(reply)) invalid("INVALID_RESULT");
  const record = reply;
  try {
    canonical(record, OWNED_NODE_MAX_RESULT_BYTES);
  } catch (error) {
    if (error instanceof CollaborationError) invalid("INVALID_RESULT");
    throw error;
  }

  const replyNonce = field(record, "nonce");
  if (typeof replyNonce !== "string" || !wellFormed(replyNonce))
    invalid("INVALID_RESULT_NONCE");
  const rootNonce = field(record, "ownRootNonce");
  if (typeof rootNonce !== "string" || !wellFormed(rootNonce))
    invalid("INVALID_RESULT_ROOT_NONCE");
  if (replyNonce !== nonce || rootNonce !== nonce) {
    return failed(
      "NONCE_MISMATCH",
      "helper outcome nonce does not match request",
      nonce,
      {
        ownership: "UNKNOWN",
      },
    );
  }

  const owned = field(record, "owned");
  if (typeof owned !== "boolean") invalid("INVALID_RESULT_OWNED");
  const timedOut = field(record, "timedOut");
  if (typeof timedOut !== "boolean") invalid("INVALID_RESULT_TIMED_OUT");
  const exited = field(record, "exited");
  if (typeof exited !== "boolean") invalid("INVALID_RESULT_EXITED");
  const processCount = field(record, "processCount");
  if (!Number.isSafeInteger(processCount) || (processCount as number) < 0)
    invalid("INVALID_RESULT_PROCESS_COUNT");

  const rawExitCode = field(record, "exitCode");
  let exitCode: number | null = null;
  if (rawExitCode !== null) {
    if (!Number.isSafeInteger(rawExitCode) || (rawExitCode as number) < 0)
      invalid("INVALID_RESULT_EXIT_CODE");
    exitCode = rawExitCode as number;
  }

  const stdoutBytes = boundedBytes(field(record, "stdoutBytes"), "stdout");
  const stderrBytes = boundedBytes(field(record, "stderrBytes"), "stderr");
  const truncated = field(record, "truncated");
  if (typeof truncated !== "boolean") invalid("INVALID_RESULT_TRUNCATED");

  const facts: OwnedNodeFacts = {
    ownership: owned ? "OWNED" : "UNOWNED",
    exitCode,
    processCount: processCount as number,
    timedOut,
  };

  if (!owned)
    return failed(
      "NOT_OWNED",
      "helper did not confirm job ownership",
      nonce,
      facts,
    );
  if (timedOut)
    return failed(
      "TIMEOUT",
      "owned node exceeded the bounded deadline",
      nonce,
      facts,
    );
  if (!exited)
    return failed(
      "NOT_EXITED",
      "owned node did not report an exited process",
      nonce,
      facts,
    );
  if ((processCount as number) !== 0) {
    return failed(
      "ORPHAN_PROCESS",
      "owned job still reports live processes",
      nonce,
      facts,
    );
  }
  if (exitCode !== 0) {
    return failed(
      "CHILD_EXIT",
      "owned node exited with a nonzero status",
      nonce,
      facts,
    );
  }

  return Object.freeze({
    status: "PASS",
    ownership: "OWNED",
    nonce,
    exited: true,
    processCount: 0,
    exitCode: 0,
    timedOut: false,
    stdoutBytes,
    stderrBytes,
    truncated,
  });
}

export async function createOwnedNodeJob(
  options: OwnedNodeOptions,
  executorPort: OwnedNodeExecutorPort,
): Promise<OwnedNodeResult> {
  let candidateNonce: string | null = null;
  if (typeof options === "object" && options !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(options, "nonce");
    if (
      descriptor &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
    )
      candidateNonce = descriptor.value;
  }
  let argv: readonly string[];
  try {
    if (
      typeof executorPort !== "object" ||
      executorPort === null ||
      typeof executorPort.execute !== "function"
    ) {
      return notRun(
        "EXECUTOR_INVALID",
        "executor port does not provide execute(argv)",
        candidateNonce,
      );
    }
    argv = ownedNodeArgv(options);
  } catch (error) {
    if (error instanceof CollaborationError)
      return notRun(
        error.code,
        "owned node options were rejected before execution",
        candidateNonce,
      );
    return notRun(
      "INVALID_OPTIONS",
      "owned node options could not be validated",
      candidateNonce,
    );
  }

  let reply: unknown;
  try {
    reply = await executorPort.execute(argv);
  } catch (error) {
    const code =
      error instanceof CollaborationError ? error.code : "EXECUTOR_FAILED";
    return unknown(
      code,
      "executor did not return a determined outcome after launch",
      argv[3],
    );
  }

  try {
    return readResult(reply, argv[3]);
  } catch (error) {
    if (error instanceof CollaborationError)
      return unknown(error.code, "helper outcome was rejected", argv[3]);
    return unknown(
      "INVALID_RESULT",
      "helper outcome could not be read",
      argv[3],
    );
  }
}
