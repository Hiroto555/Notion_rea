import { defineConfig } from "@playwright/test";
import { assertGuiTestAllowed, hasSafeListFlag } from "./tests/gui-test-policy";
import {
  assertCiDataRoot,
  assertLinuxGuiCi,
} from "./scripts/linux-gui-ci-policy.mjs";

assertGuiTestAllowed(process.env, process.argv);
if (!hasSafeListFlag(process.argv)) {
  assertLinuxGuiCi();
  assertCiDataRoot(process.env.FOLIO_GUI_CI_DATA_ROOT, process.env.RUNNER_TEMP);
}

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  globalTimeout: 12 * 60_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  outputDir: "output/playwright-linux/results",
  reporter: [
    ["list"],
    ["json", { outputFile: "output/playwright-linux/results.json" }],
    ["html", { outputFolder: "output/playwright-linux/report", open: "never" }],
  ],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "electron-linux-real-ipc",
      testMatch: [
        "**/linux-ci/*.spec.ts",
        "**/page-order-repair.spec.ts",
        "**/page-move.spec.ts",
        "**/output-boundary.spec.ts",
      ],
    },
    {
      name: "electron-linux-presentation-mocked",
      testMatch: "**/lv4-sync-presentation.spec.ts",
    },
    {
      name: "chromium-presentation-mocked",
      testMatch: [
        "**/db-ui.spec.ts",
        "**/db-ui-readonly.spec.ts",
        "**/db-ui-legacy.spec.ts",
      ],
    },
  ],
});
