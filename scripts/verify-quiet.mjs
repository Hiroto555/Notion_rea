#!/usr/bin/env node
// Quiet verification entry point: type check -> unit tests -> production build.
//
// This entry point is deliberately limited to non-GUI checks. It never starts
// Electron, Playwright, a dev server, packaging, screenshot tools, clipboard
// commands, or the GUI E2E gate. Ambient GUI opt-in/debug environment variables
// are removed from the child processes instead of being forwarded.
//
// The stage list is data (never a shell string), every stage is validated
// against a deny list before the first process starts, and argv is forwarded as
// an array with shell:false. The first failing stage stops the run; its exit
// code and signal are preserved in the result and in the process exit status.
import { spawn as nodeSpawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep this worker count conservative so the scheduled quiet check does not
// starve the user's machine and stays close to the interactive test run.
export const QUIET_TEST_WORKERS = 2;

export const QUIET_STAGES = Object.freeze([
  Object.freeze({
    id: "typecheck",
    title: "TypeScript type check",
    script: "check",
    args: Object.freeze([]),
  }),
  Object.freeze({
    id: "test",
    title: "Vitest unit tests",
    script: "test",
    args: Object.freeze([`--maxWorkers=${QUIET_TEST_WORKERS}`]),
  }),
  Object.freeze({
    id: "build",
    title: "Production build",
    script: "build",
    args: Object.freeze([]),
  }),
]);

// Environment variables that could silently turn quiet checks into GUI checks.
export const QUIET_ENV_DENYLIST = Object.freeze([
  "FOLIO_GUI_TEST_OPT_IN",
  "PWTEST_WATCH",
  "PWDEBUG",
]);

// npm scripts that mean "start a GUI, server, installer, or GUI test run".
const FORBIDDEN_SCRIPTS = new Set([
  "dev",
  "start",
  "package",
  "test:e2e",
  "test:e2e:batch",
  "test:e2e:linux-ci",
]);

// Token-level deny list. This is intentionally broader than the current stage
// list so future edits fail closed before an unwanted process is spawned.
const FORBIDDEN_TOKEN_PATTERN =
  /electron|playwright|puppeteer|chromium|google-chrome|screenshot|clipboard|osascript|pbcopy|pbpaste|gui-test/i;

function defaultLog(line) {
  process.stdout.write(`${line}\n`);
}

function defaultErrorLog(line) {
  process.stderr.write(`${line}\n`);
}

function formatDuration(durationMs) {
  return durationMs < 1000
    ? `${durationMs}ms`
    : `${(durationMs / 1000).toFixed(1)}s`;
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate one stage description. Returns a human-readable problem, or null
 * when the stage is allowed. Pure function; it never spawns anything.
 */
export function validateQuietStage(stage) {
  if (!stage || typeof stage !== "object") return "stage must be an object";
  if (typeof stage.id !== "string" || stage.id.length === 0) {
    return "stage.id must be a non-empty string";
  }
  if (
    typeof stage.script !== "string" ||
    !/^[a-zA-Z0-9:_-]+$/.test(stage.script)
  ) {
    return `stage ${stage.id} has an invalid npm script name`;
  }
  if (!Array.isArray(stage.args))
    return `stage ${stage.id} args must be an array`;
  if (
    FORBIDDEN_SCRIPTS.has(stage.script.toLowerCase()) ||
    FORBIDDEN_TOKEN_PATTERN.test(stage.script)
  ) {
    return `stage ${stage.id} uses a GUI-capable npm script: ${stage.script}`;
  }
  for (const arg of stage.args) {
    if (typeof arg !== "string") {
      return `stage ${stage.id} args must contain only strings`;
    }
    if (
      FORBIDDEN_SCRIPTS.has(arg.toLowerCase()) ||
      FORBIDDEN_TOKEN_PATTERN.test(arg)
    ) {
      return `stage ${stage.id} contains a GUI-capable argument: ${arg}`;
    }
  }
  return null;
}

/**
 * Validate the executable used for npm itself. A path is allowed as long as its
 * basename is not a GUI/browser/clipboard executable.
 */
export function validateQuietCommand(command) {
  if (typeof command !== "string" || command.length === 0) {
    return "command must be a non-empty string";
  }
  const basename = command.split(/[\\/]/).pop() ?? "";
  if (FORBIDDEN_TOKEN_PATTERN.test(basename)) {
    return `command is GUI-capable: ${command}`;
  }
  return null;
}

/** Throwing wrapper used by tests and by callers that want to preflight. */
export function assertQuietStage(stage) {
  const problem = validateQuietStage(stage);
  if (problem) throw new Error(`Quiet check policy violation: ${problem}`);
}

/** Build the environment used for every quiet child process. */
export function buildQuietEnv(env = process.env) {
  const quietEnv = { ...env };
  for (const name of QUIET_ENV_DENYLIST) delete quietEnv[name];
  return quietEnv;
}

/** Map a stage to a shell-free npm invocation. */
export function buildStageInvocation(stage, { npmCommand = "npm" } = {}) {
  const problem = validateQuietStage(stage);
  if (problem) throw new Error(`Quiet check policy violation: ${problem}`);
  const commandProblem = validateQuietCommand(npmCommand);
  if (commandProblem)
    throw new Error(`Quiet check policy violation: ${commandProblem}`);
  const args = ["run", stage.script];
  if (stage.args.length > 0) args.push("--", ...stage.args);
  return { command: npmCommand, args };
}

function runStage({ stage, invocation, spawn, cwd, env, forwardSignals }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        stdio: "inherit",
        shell: false,
      });
    } catch (error) {
      resolvePromise({ exitCode: null, signal: null, error });
      return;
    }
    if (!child || typeof child.once !== "function") {
      resolvePromise({
        exitCode: null,
        signal: null,
        error: new Error(
          `spawn for stage ${stage.id} returned no child process`,
        ),
      });
      return;
    }

    let settled = false;
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
    };
    const finish = (code, signal, error = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        exitCode: typeof code === "number" ? code : null,
        signal: signal ?? null,
        error,
      });
    };

    child.once("error", (error) => finish(null, null, error));
    child.once("exit", (code, signal) => finish(code, signal, null));

    if (forwardSignals && typeof child.kill === "function") {
      for (const signal of ["SIGINT", "SIGTERM"]) {
        const handler = () => {
          try {
            child.kill(signal);
          } catch {
            // The child may already be gone; its exit event settles the stage.
          }
        };
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
  });
}

/**
 * Run the quiet stage list in order, stopping at the first failure.
 *
 * Result shape:
 *   { ok, failedStage, exitCode, signal, results, refused? }
 * Each result entry records { id, status, exitCode, signal, durationMs, error }.
 */
export async function runQuietChecks({
  stages = QUIET_STAGES,
  spawn = nodeSpawn,
  env = process.env,
  cwd = process.cwd(),
  npmCommand = "npm",
  log = defaultLog,
  errorLog = defaultErrorLog,
  forwardSignals = true,
} = {}) {
  // Validate every stage before spawning anything so a later GUI-capable stage
  // cannot run after earlier checks have already started.
  for (const stage of stages) {
    const problem = validateQuietStage(stage);
    if (problem) {
      const stageId = typeof stage?.id === "string" ? stage.id : null;
      errorLog(
        `[quiet] FAIL stage=${stageId ?? "unknown"} exit=1 (${problem})`,
      );
      return {
        ok: false,
        failedStage: stageId,
        exitCode: 1,
        signal: null,
        results: [],
        refused: true,
        message: problem,
      };
    }
  }

  const commandProblem = validateQuietCommand(npmCommand);
  if (commandProblem) {
    errorLog(`[quiet] FAIL stage=unknown exit=1 (${commandProblem})`);
    return {
      ok: false,
      failedStage: null,
      exitCode: 1,
      signal: null,
      results: [],
      refused: true,
      message: commandProblem,
    };
  }

  const childEnv = buildQuietEnv(env);
  const results = [];
  const runStartedAt = Date.now();

  for (const stage of stages) {
    const invocation = buildStageInvocation(stage, { npmCommand });
    log(
      `[quiet] ==> ${stage.id}: ${invocation.command} ${invocation.args.join(" ")}`,
    );
    const stageStartedAt = Date.now();
    const outcome = await runStage({
      stage,
      invocation,
      spawn,
      cwd,
      env: childEnv,
      forwardSignals,
    });
    const durationMs = Date.now() - stageStartedAt;
    const failed =
      Boolean(outcome.error) ||
      outcome.exitCode !== 0 ||
      Boolean(outcome.signal);
    const record = {
      id: stage.id,
      title: stage.title,
      status: failed ? "fail" : "pass",
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      durationMs,
    };
    if (outcome.error) record.error = describeError(outcome.error);
    results.push(record);

    if (failed) {
      const reason = outcome.error
        ? `error=${describeError(outcome.error)}`
        : outcome.signal
          ? `signal=${outcome.signal}`
          : `exit=${outcome.exitCode}`;
      errorLog(
        `[quiet] FAIL stage=${stage.id} ${reason} in ${formatDuration(durationMs)}`,
      );
      const remaining = stages.length - results.length;
      if (remaining > 0) {
        errorLog(`[quiet] STOP: ${remaining} later stage(s) were not run`);
      }
      return {
        ok: false,
        failedStage: stage.id,
        exitCode: outcome.exitCode ?? 1,
        signal: outcome.signal,
        results,
      };
    }

    log(`[quiet] PASS stage=${stage.id} in ${formatDuration(durationMs)}`);
  }

  log(
    `[quiet] PASS all ${results.length} stages in ${formatDuration(Date.now() - runStartedAt)}`,
  );
  return { ok: true, failedStage: null, exitCode: 0, signal: null, results };
}

export async function main({
  argv = process.argv.slice(2),
  spawn = nodeSpawn,
  env = process.env,
  cwd = process.cwd(),
  npmCommand = "npm",
  forwardSignals = true,
  log = defaultLog,
  errorLog = defaultErrorLog,
} = {}) {
  if (argv.length > 0) {
    errorLog(
      "[quiet] this entry point has a fixed stage list and accepts no arguments.",
    );
    process.exitCode = 2;
    return {
      ok: false,
      failedStage: null,
      exitCode: 2,
      signal: null,
      results: [],
    };
  }

  const result = await runQuietChecks({
    spawn,
    env,
    cwd,
    npmCommand,
    forwardSignals,
    log,
    errorLog,
  });
  if (result.signal) {
    // Mirror the child's termination cause after its stage has been reported.
    process.kill(process.pid, result.signal);
    return result;
  }
  process.exitCode = result.exitCode;
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
