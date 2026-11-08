import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertCiDataRoot,
  assertLinuxGuiCi,
} from "../../scripts/linux-gui-ci-policy.mjs";

function ciRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (env.FOLIO_LINUX_GUI_CI !== "1" && !env.FOLIO_GUI_CI_DATA_ROOT) return;
  assertLinuxGuiCi({ env, platform });
  assertCiDataRoot(env.FOLIO_GUI_CI_DATA_ROOT, env.RUNNER_TEMP);
  return realpathSync(env.FOLIO_GUI_CI_DATA_ROOT!);
}

export function fixtureRoot(
  prefix: string,
  env = process.env,
  platform = process.platform,
) {
  if (!/^[a-z0-9-]+-$/.test(prefix)) throw new Error("Invalid fixture prefix");
  const base = ciRoot(env, platform) ?? resolve("output");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

// Pure launch options: this module never imports or launches Electron.
export function fixtureElectronOptions(
  directory: string,
  env = process.env,
  platform = process.platform,
) {
  const base = ciRoot(env, platform);
  if (base) assertCiDataRoot(realpathSync(directory), base);
  const child: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const key of Object.keys(child))
    if (
      key.startsWith("FOLIO_SYNC_") ||
      [
        "FOLIO_DATA_DIR",
        "FOLIO_DEV_URL",
        "FOLIO_TEST_FORCE_READY_FAILURE",
      ].includes(key)
    )
      delete child[key];
  child.FOLIO_DATA_DIR = directory;
  return {
    args: [...(base ? ["--no-sandbox"] : []), resolve("dist/main.cjs")],
    env: child,
  };
}
