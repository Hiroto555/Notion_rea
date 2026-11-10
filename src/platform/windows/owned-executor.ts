import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  CollaborationError,
  wellFormed,
} from "../../collaboration/runtime/contract";
import { validateWindowsPath } from "./path-policy";
import {
  OWNED_NODE_MAX_RESULT_BYTES,
  OWNED_NODE_MAX_STREAM_BYTES,
  OWNED_NODE_MAX_TIMEOUT_MS,
  type OwnedNodeExecutorPort,
} from "./owned-node";

export const WINDOWS_OWNED_HELPER_MAX_OUTPUT_BYTES =
  OWNED_NODE_MAX_RESULT_BYTES;
export const WINDOWS_OWNED_HELPER_MAX_ERROR_BYTES = OWNED_NODE_MAX_STREAM_BYTES;
export const WINDOWS_OWNED_HELPER_DEFAULT_GRACE_MS = 2_000;

const EXE_PATTERN = /\.exe$/i;
const ABSOLUTE_PATTERN = /^(?:[A-Za-z]:[\\/])/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const ALLOWED_ENVIRONMENT_KEYS = [
  "SystemRoot",
  "windir",
  "PATH",
  "PATHEXT",
  "ComSpec",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
] as const;

const FORBIDDEN_ENVIRONMENT_KEY =
  /FOLIO|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY/i;

export type OwnedHelperSpawnOptions = Readonly<{
  shell: false;
  windowsHide: true;
  cwd: string;
  env: Record<string, string>;
  stdio: ["ignore", "pipe", "pipe"];
}>;

export type OwnedHelperSpawn = (
  command: string,
  args: readonly string[],
  options: OwnedHelperSpawnOptions,
) => ChildProcess;

export type WindowsOwnedExecutorOptions = Readonly<{
  helperPath: string;
  platform?: NodeJS.Platform;
  spawn?: OwnedHelperSpawn;
  exists?: (path: string) => boolean;
  graceMs?: number;
}>;

function invalid(code: string): never {
  throw new CollaborationError(code);
}

function canonicalWindowsPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || !wellFormed(value))
    invalid(`INVALID_${label}`);
  const input = value as string;
  if (!ABSOLUTE_PATTERN.test(input)) invalid(`INVALID_${label}`);
  try {
    return validateWindowsPath(input, `${input[0].toUpperCase()}:\\`).canonical;
  } catch (error) {
    if (error instanceof CollaborationError) invalid(`INVALID_${label}`);
    throw error;
  }
}

export function validateOwnedHelperPath(value: unknown): string {
  const canonical = canonicalWindowsPath(value, "HELPER");
  if (!EXE_PATTERN.test(canonical)) invalid("HELPER_NOT_EXE");
  return canonical;
}

export function buildOwnedEnvironment(
  source: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
  tempRoot: string,
): Record<string, string> {
  const canonical = canonicalWindowsPath(tempRoot, "TEMP_ROOT");
  const output: Record<string, string> = {};
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    if (FORBIDDEN_ENVIRONMENT_KEY.test(key)) continue;
    const value = source[key];
    if (typeof value === "string" && value.length > 0 && wellFormed(value))
      output[key] = value;
  }
  output.TEMP = canonical;
  output.TMP = canonical;
  return Object.freeze(output) as Record<string, string>;
}

function parseTimeout(argv: readonly string[]): number {
  const raw = argv[4];
  if (typeof raw !== "string" || !/^\d+$/.test(raw))
    invalid("INVALID_ARGV_TIMEOUT");
  const timeoutMs = Number(raw);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > OWNED_NODE_MAX_TIMEOUT_MS
  ) {
    invalid("INVALID_ARGV_TIMEOUT");
  }
  return timeoutMs;
}

function validateArgv(
  argv: readonly string[],
): Readonly<{ timeoutMs: number; tempRoot: string; script: string }> {
  if (!Array.isArray(argv) || argv.length !== 5) invalid("INVALID_ARGV");
  const nodeExe = canonicalWindowsPath(argv[0], "NODE_EXE");
  const script = canonicalWindowsPath(argv[1], "OWNED_SCRIPT");
  const tempRoot = canonicalWindowsPath(argv[2], "TEMP_ROOT");
  if (
    typeof argv[3] !== "string" ||
    !wellFormed(argv[3]) ||
    !NONCE_PATTERN.test(argv[3])
  ) {
    invalid("INVALID_ARGV_NONCE");
  }
  try {
    validateWindowsPath(script, tempRoot);
  } catch (error) {
    if (error instanceof CollaborationError) invalid("SCRIPT_OUTSIDE_ROOT");
    throw error;
  }
  if (!EXE_PATTERN.test(nodeExe)) invalid("INVALID_NODE_EXE");
  return { timeoutMs: parseTimeout(argv), tempRoot, script };
}

function appendBounded(
  current: Buffer[],
  chunk: Buffer,
  limit: number,
  state: { total: number; overflow: boolean },
): void {
  if (state.overflow) return;
  state.total += chunk.length;
  if (state.total > limit) {
    state.overflow = true;
    return;
  }
  current.push(chunk);
}

export class WindowsOwnedExecutor implements OwnedNodeExecutorPort {
  readonly #helperPath: string;
  readonly #spawn: OwnedHelperSpawn;
  readonly #graceMs: number;

  constructor(options: WindowsOwnedExecutorOptions) {
    if (typeof options !== "object" || options === null)
      throw new CollaborationError("INVALID_OPTIONS");
    if ((options.platform ?? process.platform) !== "win32")
      throw new CollaborationError("PLATFORM_UNSUPPORTED");
    this.#helperPath = validateOwnedHelperPath(options.helperPath);
    const exists = options.exists ?? existsSync;
    if (!exists(this.#helperPath))
      throw new CollaborationError("HELPER_MISSING");
    this.#spawn =
      options.spawn ??
      ((command, args, spawnOptions) =>
        defaultSpawn(command, [...args], {
          shell: spawnOptions.shell,
          windowsHide: spawnOptions.windowsHide,
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: spawnOptions.stdio,
        }));
    const graceMs = options.graceMs ?? WINDOWS_OWNED_HELPER_DEFAULT_GRACE_MS;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 30_000) {
      throw new CollaborationError("INVALID_GRACE");
    }
    this.#graceMs = graceMs;
  }

  execute(argv: readonly string[]): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let validated: ReturnType<typeof validateArgv>;
      let child: ChildProcess;
      try {
        validated = validateArgv(argv);
        const environment = buildOwnedEnvironment(
          process.env,
          validated.tempRoot,
        );
        child = this.#spawn(this.#helperPath, [...argv], {
          shell: false,
          windowsHide: true,
          cwd: validated.tempRoot,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          error instanceof CollaborationError
            ? error
            : new CollaborationError("EXECUTOR_FAILED"),
        );
        return;
      }

      const out = child ? child.stdout : null;
      const err = child ? child.stderr : null;
      if (!out || !err) {
        reject(new CollaborationError("EXECUTOR_PIPE"));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const stdoutState = { total: 0, overflow: false };
      const stderrState = { total: 0, overflow: false };
      let settled = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (
        error: CollaborationError | null,
        value?: unknown,
      ): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };

      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          timedOut = true;
        }
        finish(new CollaborationError("EXECUTOR_TIMEOUT"));
      }, validated.timeoutMs + this.#graceMs);

      out.on("data", (chunk: Buffer) =>
        appendBounded(
          stdout,
          chunk,
          WINDOWS_OWNED_HELPER_MAX_OUTPUT_BYTES,
          stdoutState,
        ),
      );
      err.on("data", (chunk: Buffer) =>
        appendBounded(
          stderr,
          chunk,
          WINDOWS_OWNED_HELPER_MAX_ERROR_BYTES,
          stderrState,
        ),
      );

      child.on("error", () => {
        finish(new CollaborationError("EXECUTOR_FAILED"));
      });

      child.on("close", (code: number | null) => {
        if (settled) return;
        if (timedOut) {
          finish(new CollaborationError("EXECUTOR_TIMEOUT"));
          return;
        }
        if (stdoutState.overflow || stderrState.overflow) {
          finish(new CollaborationError("EXECUTOR_OUTPUT_LIMIT"));
          return;
        }
        if (code !== 0) {
          finish(new CollaborationError("HELPER_EXIT"));
          return;
        }
        const text = Buffer.concat(stdout).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          finish(new CollaborationError("HELPER_INVALID_RESULT"));
          return;
        }
        finish(null, parsed);
      });
    });
  }
}
