import { defineConfig } from "@playwright/test";
import { assertGuiTestAllowed } from "./tests/gui-test-policy";

// Refuse untrusted GUI starts at config evaluation time. The explicit
// test:e2e:batch launcher adds FOLIO_GUI_TEST_OPT_IN=1 to the child env;
// a standalone --list dry-run is allowed without that opt-in.
assertGuiTestAllowed(process.env, process.argv);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/report", open: "never" }],
  ],
  outputDir: "output/playwright/results",
  use: { trace: "retain-on-failure" },
});
