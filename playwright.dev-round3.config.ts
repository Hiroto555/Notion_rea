import { defineConfig } from "@playwright/test";
import { assertGuiTestAllowed } from "./tests/gui-test-policy";

assertGuiTestAllowed(process.env, process.argv);

export default defineConfig({
  testDir: "tests/dev",
  timeout: 60000,
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
