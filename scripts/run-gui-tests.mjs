#!/usr/bin/env node
// Explicit opt-in gate for the Playwright suites.
//
// npm run test:e2e        -> refuse unless the invocation is a safe --list dry-run
// npm run test:e2e:batch  -> add the explicit opt-in to the child env and launch
//
// argv is forwarded as an array (never a shell string). Importing this module
// has no side effects; main() only runs when the file is executed directly.
import { spawn as nodeSpawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GUI_TEST_OPT_IN_ENV = "FOLIO_GUI_TEST_OPT_IN";
export const GUI_TEST_OPT_IN_VALUE = "1";

export const GUI_TEST_REFUSAL_MESSAGE = [
  "GUI test execution is disabled by default. Electron/browser launch is not allowed.",
  "GUIテストは既定で拒否されました。Electron/ブラウザの起動は許可されていません。",
  "Only after the user explicitly approves GUI execution, run: npm run test:e2e:batch",
  "ユーザーがGUI実行を明示的に許可した場合だけ `npm run test:e2e:batch` を実行してください。",
  "Safe dry-run (no test execution): npm run test:e2e -- --list",
  "安全なdry-run（テスト実行なし）: `npm run test:e2e -- --list`",
  "Direct npx playwright test and direct playwright.dev-round3.config.ts use are rejected during config evaluation without the opt-in.",
].join("\n");

const VALUE_OPTIONS = new Set([
  "--browser",
  "--config",
  "--grep",
  "--grep-invert",
  "--global-timeout",
  "--max-failures",
  "--only-changed",
  "--output",
  "--project",
  "--repeat-each",
  "--reporter",
  "--retries",
  "--shard",
  "--test-list",
  "--timeout",
  "--tsconfig",
  "--update-snapshots",
  "--update-source-method",
  "--workers",
  "-c",
  "-g",
  "-j",
]);

const BOOLEAN_OPTIONS = new Set([
  "--debug",
  "--fail-on-flaky-tests",
  "--forbid-only",
  "--fully-parallel",
  "--headed",
  "--ignore-snapshots",
  "--last-failed",
  "--list",
  "--pass-with-no-tests",
  "--quiet",
  "--ui",
]);

export function isGuiTestOptedIn(env) {
  return env[GUI_TEST_OPT_IN_ENV] === GUI_TEST_OPT_IN_VALUE;
}

export function hasSafeListFlag(argv) {
  // Playwright dispatches UI mode before list mode. Scan the WHOLE argv first,
  // including tokens after --list, and fail closed for GUI/debug/custom reporter
  // modes. Conservative rejection inside a filter value is intentional.
  if (argv.some((arg) => /^(--ui(?:-host|-port)?|--debug|--headed|--reporter)(?:=|$)/.test(arg))) return false;
  let consumeNext = false;
  let foundList = false;
  for (const arg of argv) {
    if (consumeNext) {
      consumeNext = false;
      continue;
    }
    if (arg === "--") return false;
    if (arg === "--list") { foundList = true; continue; }
    if (!arg.startsWith("-") || arg === "-") continue;

    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals >= 0 ? arg.slice(0, equals) : arg;
      if (equals < 0 && VALUE_OPTIONS.has(name)) {
        consumeNext = true;
      } else if (equals < 0 && !BOOLEAN_OPTIONS.has(name)) {
        consumeNext = true;
      }
      continue;
    }

    // Treat unknown short options as value-taking for safety too.
    consumeNext = true;
  }
  return foundList;
}

export function parseRunnerInvocation(argv) {
  const [head, ...rest] = argv;
  if (head === "--mode=batch") return { batch: true, args: rest };
  if (head === "--mode=refuse") return { batch: false, args: rest };
  return { batch: false, args: argv };
}

export function decideGuiRun({ batch, args, env = {} }) {
  if (batch) return { action: "spawn", optIn: true };
  if (!env.PWTEST_WATCH && !env.PWDEBUG && hasSafeListFlag(args)) return { action: "spawn", optIn: false };
  return { action: "refuse", message: GUI_TEST_REFUSAL_MESSAGE };
}

function resolvePlaywrightCli() {
  const require = createRequire(import.meta.url);
  for (const specifier of ["@playwright/test/cli", "@playwright/test"]) {
    try {
      const resolved = require.resolve(specifier);
      if (resolved.endsWith("cli.js")) return resolved;
      return join(dirname(resolved), "cli.js");
    } catch {
      // Try the next resolution strategy.
    }
  }
  return join(process.cwd(), "node_modules", "@playwright", "test", "cli.js");
}

export function buildPlaywrightInvocation(
  args,
  { cliPath = resolvePlaywrightCli(), execPath = process.execPath } = {},
) {
  return { command: execPath, args: [cliPath, "test", ...args] };
}

export async function runGuiTests({
  batch = false,
  args = [],
  env = process.env,
  spawn = nodeSpawn,
  cliPath,
  cwd = process.cwd(),
  forwardSignals = true,
} = {}) {
  const decision = decideGuiRun({ batch, args, env });
  if (decision.action === "refuse") {
    return { code: 1, signal: null, refused: true, message: decision.message };
  }

  const childEnv = { ...env };
  if (decision.optIn) childEnv[GUI_TEST_OPT_IN_ENV] = GUI_TEST_OPT_IN_VALUE;
  else delete childEnv[GUI_TEST_OPT_IN_ENV];
  // Remote supervision is reachable only through the existing explicit batch
  // entry. It has its own live host guard and accepts no extra Playwright args.
  if (args.some((arg) => /^--mac-acceptance-plan(?:=|$)/.test(arg))) {
    if (
      !batch ||
      args.length !== 2 ||
      args[0] !== "--mac-acceptance-plan" ||
      typeof args[1] !== "string" ||
      !args[1]
    )
      return {
        code: 1,
        signal: null,
        refused: true,
        message:
          "Remote Mac acceptance requires only --mac-acceptance-plan PATH through the batch entry",
      };
    const { runRemoteMacBatch } =
      await import("./mac-acceptance/remote-batch.mjs");
    return runRemoteMacBatch({
      planPath: args[1],
      cwd,
      env: childEnv,
      forwardSignals,
    });
  }
  const invocation = buildPlaywrightInvocation(args, { cliPath });

  return await new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd,
        env: childEnv,
        stdio: "inherit",
        shell: false,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let settled = false;
    const handlers = new Map();
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
    };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({ code, signal, refused: false });
    };

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    });
    child.once("exit", finish);

    if (forwardSignals) {
      for (const signal of ["SIGINT", "SIGTERM"]) {
        const handler = () => child.kill(signal);
        handlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
  });
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  spawn = nodeSpawn,
  cliPath,
  cwd = process.cwd(),
} = {}) {
  const { batch, args } = parseRunnerInvocation(argv);
  const result = await runGuiTests({ batch, args, env, spawn, cliPath, cwd });

  if (result.refused) {
    process.stderr.write(`${result.message}\n`);
    process.exitCode = 1;
    return result;
  }
  if (result.signal) {
    // Re-raise the child's signal so callers see the same termination cause.
    process.kill(process.pid, result.signal);
    return result;
  }
  process.exitCode = result.code ?? 1;
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
