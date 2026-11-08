import { isAbsolute, relative, resolve, sep } from "node:path";

// This is an execution guard, not a security sandbox. It deliberately refuses
// local macOS execution even when a GUI opt-in environment variable is set.
export function assertLinuxGuiCi({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (
    platform !== "linux" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_OS !== "Linux" ||
    env.CI !== "true"
  )
    throw new Error(
      "Linux GUI tests run only on a GitHub Actions Linux runner; local GUI execution is refused.",
    );
  if (!env.DISPLAY || env.PWDEBUG || env.PWTEST_WATCH)
    throw new Error(
      "An isolated Xvfb DISPLAY is required; interactive debug/watch is refused.",
    );
  if (!env.RUNNER_TEMP || !isAbsolute(env.RUNNER_TEMP))
    throw new Error("An absolute RUNNER_TEMP is required.");
}

export function assertCiDataRoot(root, runnerTemp) {
  if (!root || !runnerTemp || !isAbsolute(root) || !isAbsolute(runnerTemp))
    throw new Error("Missing isolated GUI data root.");
  const rel = relative(resolve(runnerTemp), resolve(root));
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep))
    throw new Error("GUI data must be a fresh child of RUNNER_TEMP.");
}

export function isolatedGuiEnv(env, dataRoot) {
  const child = {
    ...Object.fromEntries(
      Object.entries(env).filter(([, value]) => typeof value === "string"),
    ),
    FOLIO_GUI_CI_DATA_ROOT: dataRoot,
    FOLIO_LINUX_GUI_CI: "1",
  };
  for (const key of Object.keys(child))
    if (
      key.startsWith("FOLIO_SYNC_") ||
      [
        "FOLIO_DATA_DIR",
        "FOLIO_DEV_URL",
        "FOLIO_TEST_FORCE_READY_FAILURE",
        "FOLIO_CREDENTIAL_DIR", "FOLIO_EMPTY_WORKSPACE", "FOLIO_GUI_CI_KEYRING",
        "PWDEBUG",
        "PWTEST_WATCH",
      ].includes(key)
    )
      delete child[key];
  return child;
}
