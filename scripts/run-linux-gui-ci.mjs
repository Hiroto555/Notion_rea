import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  assertCiDataRoot,
  assertLinuxGuiCi,
  isolatedGuiEnv,
} from "./linux-gui-ci-policy.mjs";

// Validate before spawning npm/Playwright. This entry has no configurable
// command or test path and always goes through the existing explicit batch gate.
try {
  if (process.argv.length !== 2)
    throw new Error("The Linux GUI CI entry accepts no arguments.");
  assertLinuxGuiCi();
  const temp = realpathSync(process.env.RUNNER_TEMP);
  const root = mkdtempSync(join(temp, "folio-gui-ci-"));
  assertCiDataRoot(root, temp);
  mkdirSync("output", { recursive: true });
  const env = isolatedGuiEnv(process.env, root);
  const windowManager = spawn("openbox", ["--sm-disable"], {
    env,
    stdio: "ignore",
    shell: false,
  });
  const child = spawn(
    "npm",
    [
      "run",
      "test:e2e:batch",
      "--",
      "--config",
      "playwright.linux-ci.config.ts",
    ],
    {
      env,
      stdio: "inherit",
      shell: false,
    },
  );
  const handlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [signal, () => child.kill(signal)]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const cleanup = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    windowManager.kill();
  };
  windowManager.once("error", (error) => {
    console.error(error.message);
    child.kill();
    process.exitCode = 1;
  });
  child.once("error", (error) => {
    cleanup();
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
