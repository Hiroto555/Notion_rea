import { spawnSync } from "node:child_process";
import {
  CollaborationError,
  wellFormed,
} from "../../collaboration/runtime/contract";
import {
  assertWindowsProbe,
  validateWindowsPath,
  type WindowsProbeExpectation,
} from "./path-policy";
import {
  WINDOWS_PROBE_MAX_OUTPUT_BYTES,
  WINDOWS_PROBE_TIMEOUT_MS,
  windowsPowerShellCommand,
  type WindowsProbeCommandOptions,
} from "./private-root";

export type WindowsProbeExecRequest = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxBuffer: number;
  windowsHide: true;
  shell: false;
  encoding: "utf8";
}>;

export type WindowsProbeExecResult = Readonly<{
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
}>;

export type UntrustedTestExecPort = Readonly<{
  exec(request: WindowsProbeExecRequest): WindowsProbeExecResult;
}>;

export type WindowsNativeProbeOptions = Readonly<{
  systemRoot: string;
  scriptPath: string;
  untrustedTestExec?: UntrustedTestExecPort;
}>;

const PROBE_SCRIPT_SUFFIX = /\\probe-private-root\.ps1$/i;
const RESULT_KEYS = [
  "status",
  "signal",
  "stdout",
  "stderr",
  "errorCode",
] as const;

function fail(code: string): never {
  throw new CollaborationError(code);
}

function requireAbsolute(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value))
    fail(code);
  const drive = /^[A-Za-z]:/.exec(value);
  if (!drive) fail(code);
  try {
    return validateWindowsPath(value, `${drive[0][0].toUpperCase()}:\\`)
      .canonical;
  } catch {
    fail(code);
  }
}

function productionExec(
  request: WindowsProbeExecRequest,
): WindowsProbeExecResult {
  const result = spawnSync(request.command, [...request.args], {
    cwd: request.cwd,
    env: { ...request.env },
    timeout: request.timeoutMs,
    maxBuffer: request.maxBuffer,
    windowsHide: true,
    shell: false,
    encoding: "utf8",
  });
  const errorCode =
    result.error === undefined
      ? undefined
      : ((result.error as NodeJS.ErrnoException).code ?? "SPAWN_ERROR");
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  return Object.freeze({
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}

function readResultField(result: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(result, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) fail("PROBE_EXEC_RESULT");
  return descriptor.value;
}

function validateResult(value: unknown): WindowsProbeExecResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("PROBE_EXEC_RESULT");
  }
  const result = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(result);
  if (prototype !== Object.prototype && prototype !== null)
    fail("PROBE_EXEC_RESULT");
  if (Object.getOwnPropertySymbols(result).length !== 0)
    fail("PROBE_EXEC_RESULT");
  const keys = Object.keys(result);
  if (keys.some((key) => !(RESULT_KEYS as readonly string[]).includes(key)))
    fail("PROBE_EXEC_RESULT");
  const status = readResultField(result, "status");
  if (
    status !== null &&
    (!Number.isSafeInteger(status) || (status as number) < 0)
  ) {
    fail("PROBE_EXEC_RESULT");
  }
  const signal = readResultField(result, "signal");
  if (signal !== null && typeof signal !== "string") fail("PROBE_EXEC_RESULT");
  const stdout = readResultField(result, "stdout");
  if (typeof stdout !== "string" || !wellFormed(stdout))
    fail("PROBE_EXEC_RESULT");
  const stderr = readResultField(result, "stderr");
  if (typeof stderr !== "string" || !wellFormed(stderr))
    fail("PROBE_EXEC_RESULT");
  const errorCode = readResultField(result, "errorCode");
  if (
    errorCode !== undefined &&
    (typeof errorCode !== "string" || errorCode.length === 0)
  ) {
    fail("PROBE_EXEC_RESULT");
  }
  return {
    status: status as number | null,
    signal: signal as NodeJS.Signals | null,
    stdout,
    stderr,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export class WindowsNativeProbe {
  readonly #commandOptions: WindowsProbeCommandOptions;
  readonly #exec: (request: WindowsProbeExecRequest) => WindowsProbeExecResult;
  readonly #env: Readonly<Record<string, string>>;

  constructor(options: WindowsNativeProbeOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      fail("PROBE_OPTIONS");
    }
    const systemRoot = requireAbsolute(options.systemRoot, "PROBE_SYSTEM_ROOT");
    const scriptPath = requireAbsolute(options.scriptPath, "PROBE_SCRIPT_PATH");
    if (!PROBE_SCRIPT_SUFFIX.test(scriptPath)) fail("PROBE_SCRIPT_PATH");
    this.#commandOptions = Object.freeze({ systemRoot, scriptPath });
    this.#env = Object.freeze({
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      PATH: `${systemRoot}\\System32;${systemRoot}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: `${systemRoot}\\Temp`,
      TMP: `${systemRoot}\\Temp`,
    });
    const untrusted = options.untrustedTestExec;
    if (untrusted !== undefined) {
      if (
        typeof untrusted !== "object" ||
        untrusted === null ||
        typeof untrusted.exec !== "function"
      ) {
        fail("PROBE_TEST_EXEC");
      }
      this.#exec = (request) => validateResult(untrusted.exec(request));
      return;
    }
    if (process.platform !== "win32") fail("PROBE_PLATFORM");
    this.#exec = productionExec;
  }

  async probe(path: string, root: string): Promise<unknown> {
    const target = validateWindowsPath(path, root);
    const canonicalRoot = validateWindowsPath(root, root).canonical;
    const expectation: WindowsProbeExpectation = Object.freeze({
      canonicalPath: target.canonical,
      canonicalRoot,
    });
    const command = windowsPowerShellCommand(
      expectation.canonicalPath,
      expectation.canonicalRoot,
      this.#commandOptions,
    );
    const request: WindowsProbeExecRequest = Object.freeze({
      command: command.command,
      args: command.args,
      cwd: command.cwd,
      env: this.#env,
      timeoutMs: WINDOWS_PROBE_TIMEOUT_MS,
      maxBuffer: WINDOWS_PROBE_MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    });

    let raw: WindowsProbeExecResult;
    try {
      raw = this.#exec(request);
    } catch (error) {
      if (error instanceof CollaborationError) throw error;
      fail("PROBE_EXEC_FAILED");
    }
    const result = validateResult(raw);

    if (result.errorCode !== undefined) {
      if (result.errorCode === "ETIMEDOUT") fail("PROBE_TIMEOUT");
      if (result.errorCode === "ENOBUFS") fail("PROBE_OUTPUT_LIMIT");
      fail("PROBE_EXEC_FAILED");
    }
    if (result.status !== 0) fail("PROBE_EXIT");
    if (result.signal !== null) fail("PROBE_SIGNAL");
    if (result.stderr !== "") fail("PROBE_STDERR");
    if (result.stdout.length === 0) fail("PROBE_OUTPUT");
    if (
      new TextEncoder().encode(result.stdout).byteLength >
      WINDOWS_PROBE_MAX_OUTPUT_BYTES
    ) {
      fail("PROBE_OUTPUT_LIMIT");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      fail("PROBE_JSON");
    }
    assertWindowsProbe(parsed, expectation);
    return parsed;
  }
}
