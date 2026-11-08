import { assertPrivateTempDirectory } from "./mac-acceptance/policy/guard.mjs";

// Local GUI acceptance is a separately authorized batch, not a MAC-P05 remote
// run. This helper never launches anything or changes the remote host guard.
export function localGuiDataRoot(
  env = process.env,
  platform = process.platform,
) {
  if (!env.FOLIO_LOCAL_GUI_DATA_ROOT && !env.FOLIO_LOCAL_GUI_BATCH) return;
  if (
    platform !== "darwin" ||
    env.FOLIO_LOCAL_GUI_BATCH !== "1" ||
    env.FOLIO_GUI_TEST_OPT_IN !== "1" ||
    !env.FOLIO_LOCAL_GUI_DATA_ROOT ||
    env.GITHUB_ACTIONS === "true" ||
    env.FOLIO_LINUX_GUI_CI ||
    env.FOLIO_GUI_CI_DATA_ROOT ||
    env.PWDEBUG ||
    env.PWTEST_WATCH ||
    env.FOLIO_DEV_URL
  )
    throw new Error(
      "An explicitly authorized local Mac GUI batch with isolated data is required",
    );
  return assertPrivateTempDirectory(env.FOLIO_LOCAL_GUI_DATA_ROOT);
}
