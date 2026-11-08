import { defineConfig } from "@playwright/test";
import { assertGuiTestAllowed, hasSafeListFlag } from "./tests/gui-test-policy";
// @ts-expect-error pure Node ESM execution guard; importing it launches nothing
import { assertMacExecution } from "./scripts/mac-acceptance/policy/guard.mjs";
// @ts-expect-error bounded Node metadata reader; never launches a process
import { readMetadataFile } from "./scripts/mac-acceptance/validate.mjs";

const listing = hasSafeListFlag(process.argv);
assertGuiTestAllowed(process.env, process.argv);

let approvedTimeout = 15 * 60_000;
if (!listing) {
  if (
    process.env.FOLIO_LOCAL_GUI_BATCH ||
    process.env.FOLIO_LOCAL_GUI_DATA_ROOT
  )
    throw new Error(
      "Local GUI authorization does not apply to the remote Mac suite",
    );
  const planPath = process.env.FOLIO_MAC_PLAN_PATH;
  if (!planPath)
    throw new Error(
      "FOLIO_MAC_PLAN_PATH must name the approved remote MAC-H1 plan",
    );
  const plan = assertMacExecution(
    JSON.parse(readMetadataFile(planPath).toString("utf8")),
    process.env,
  );
  if (plan.caseIds.length !== 1 || plan.caseIds[0] !== "MAC-H1")
    throw new Error("The remote suite accepts only the MAC-H1 case");
  if (plan.workers !== 1 || plan.retries !== 0)
    throw new Error("The remote suite requires workers=1 and retries=0");
  approvedTimeout = plan.timeoutMs;
}

export default defineConfig({
  testDir: "tests/acceptance/macos",
  testMatch: "remote-h1.spec.ts",
  timeout: approvedTimeout,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  reporter: "list",
  outputDir: "output/playwright-remote-mac/results",
});
