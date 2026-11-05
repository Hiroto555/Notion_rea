// Pure policy helpers for the GUI test gate. Importing this module has no
// side effects and never starts Electron, Playwright, or any other process.
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

export type EnvLike = Record<string, string | undefined>;

// Options that consume the following argv token. Keep this conservative: an
// unknown option is also treated as value-taking so that a following --list is
// never mistaken for a standalone flag.
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

export function isGuiTestOptedIn(env: EnvLike): boolean {
  // Strict equality: "true", "yes", "01", empty, or whitespace must not opt in.
  return env[GUI_TEST_OPT_IN_ENV] === GUI_TEST_OPT_IN_VALUE;
}

/**
 * True only when argv contains a standalone Playwright `--list` option.
 * A `--list` that is the value of --grep/-g/--config/... is not a flag, and a
 * `--list` inside any ordinary string/test filter is not a flag either.
 */
export function hasSafeListFlag(argv: readonly string[]): boolean {
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
        // Unknown long option: conservatively assume it may take a value.
        consumeNext = true;
      }
      continue;
    }

    // Short options. Known value-taking and unknown short options are treated
    // as value-taking for safety, so a following --list is not accepted.
    consumeNext = true;
  }
  return foundList;
}

export function isGuiTestAllowed(env: EnvLike, argv: readonly string[]): boolean {
  return isGuiTestOptedIn(env) || (!env.PWTEST_WATCH && !env.PWDEBUG && hasSafeListFlag(argv));
}

export function assertGuiTestAllowed(
  env: EnvLike,
  argv: readonly string[],
  message = GUI_TEST_REFUSAL_MESSAGE,
): void {
  if (!isGuiTestAllowed(env, argv)) throw new Error(message);
}
