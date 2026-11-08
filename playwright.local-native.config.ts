import { defineConfig } from "@playwright/test";
import { assertGuiTestAllowed, hasSafeListFlag } from "./tests/gui-test-policy";
import { localGuiDataRoot } from "./scripts/local-gui-batch-policy.mjs";

assertGuiTestAllowed(process.env, process.argv);
if (!hasSafeListFlag(process.argv) && !localGuiDataRoot())
  throw new Error("A separately authorized local Mac batch is required");

export default defineConfig({
  testDir: "tests/acceptance/macos",
  testMatch: "local-native.spec.ts",
  timeout: 240000,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  forbidOnly: true,
  reporter: "list",
});
