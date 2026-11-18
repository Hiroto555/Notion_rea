import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertCiDataRoot,
  assertLinuxGuiCi,
} from "../../scripts/linux-gui-ci-policy.mjs";
import { localGuiDataRoot } from "../../scripts/local-gui-batch-policy.mjs";
// The additive Windows policy module is an .mjs sibling without a .d.mts (the
// owned file set cannot add one); keep its surface narrowly typed here.
// @ts-ignore: missing type declaration for scripts/windows-gui-batch-policy.mjs
import { assertWindowsGuiChild as assertWindowsGuiChildImpl, createWindowsGuiFixtureRoot as createWindowsGuiFixtureRootImpl, windowsGuiDataRoot as windowsGuiDataRootImpl } from "../../scripts/windows-gui-batch-policy.mjs";

// Optional fake-exec seam for Windows policy unit tests only. Fake probe
// results are a contract check, never OS proof of filesystem safety.
export type WindowsGuiTestSeam = {
  platform: "win32";
  exec: (request: unknown) => unknown;
  windowsTempRoot?: string;
};

const windowsGuiDataRoot = windowsGuiDataRootImpl as (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  untrustedWindowsTest?: WindowsGuiTestSeam,
) => string | undefined;
const assertWindowsGuiChild = assertWindowsGuiChildImpl as (
  directory: string,
  base: string,
  env: NodeJS.ProcessEnv,
  untrustedWindowsTest?: WindowsGuiTestSeam,
) => string;
const createWindowsGuiFixtureRoot = createWindowsGuiFixtureRootImpl as (
  prefix: string,
  base: string,
  env: NodeJS.ProcessEnv,
  untrustedWindowsTest?: WindowsGuiTestSeam,
) => string;

function ciRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (env.FOLIO_LINUX_GUI_CI !== "1" && !env.FOLIO_GUI_CI_DATA_ROOT) return;
  assertLinuxGuiCi({ env, platform });
  assertCiDataRoot(env.FOLIO_GUI_CI_DATA_ROOT, env.RUNNER_TEMP);
  return realpathSync(env.FOLIO_GUI_CI_DATA_ROOT!);
}

function dataRoot(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  untrustedWindowsTest?: WindowsGuiTestSeam,
) {
  const windows = windowsGuiDataRoot(env, platform, untrustedWindowsTest);
  if (windows !== undefined) return windows;
  const local = localGuiDataRoot(env, platform);
  return ciRoot(env, platform) ?? local;
}

export function fixtureRoot(
  prefix: string,
  env = process.env,
  platform = process.platform,
  untrustedWindowsTest?: WindowsGuiTestSeam,
) {
  if (!/^[a-z0-9-]+-$/.test(prefix)) throw new Error("Invalid fixture prefix");
  const windows = windowsGuiDataRoot(env, platform, untrustedWindowsTest);
  if (windows !== undefined) {
    // Windows never mkdirs an arbitrary base: the fixture is created directly
    // below the natively verified root, then re-proved against it.
    return createWindowsGuiFixtureRoot(prefix, windows, env, untrustedWindowsTest);
  }
  const base =
    dataRoot(env, platform, untrustedWindowsTest) ?? resolve("output");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

// Launch options only: no Electron import/launch. An explicit Windows batch
// also validates metadata using the independently pinned native probe.
export function fixtureElectronOptions(
  directory: string,
  env = process.env,
  platform = process.platform,
  untrustedWindowsTest?: WindowsGuiTestSeam,
) {
  const windows = windowsGuiDataRoot(env, platform, untrustedWindowsTest);
  let dataDirectory = directory;
  const base = windows ?? dataRoot(env, platform);
  if (windows !== undefined) {
    // Native-root proof plus strict descendant check; the credential sibling
    // stays inside the root and is validated only if it already exists.
    dataDirectory = assertWindowsGuiChild(
      directory,
      windows,
      env,
      untrustedWindowsTest,
    );
  } else if (base) {
    assertCiDataRoot(realpathSync(directory), base);
  }
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
        "FOLIO_TEST_FORCE_READY_FAILURE", "FOLIO_CREDENTIAL_DIR", "FOLIO_EMPTY_WORKSPACE",
      ].includes(key)
    )
      delete child[key];
  child.FOLIO_DATA_DIR = dataDirectory;
  child.FOLIO_CREDENTIAL_DIR = dataDirectory + "-credentials";
  const linuxCi = base && platform === "linux" && env.FOLIO_LINUX_GUI_CI === "1";
  return {
    args: [...(linuxCi ? ["--no-sandbox"] : []),
      ...(linuxCi && env.FOLIO_GUI_CI_KEYRING === "1" ? ["--password-store=gnome-libsecret"] : []), resolve("dist/main.cjs")],
    env: child,
  };
}
