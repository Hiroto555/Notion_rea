import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
  const shard = process.env.FOLIO_GUI_CI_SHARD;
  if (shard !== undefined && !/^[1-6]\/6$/.test(shard)) throw new Error("Invalid fixed GUI CI shard.");
  // Disposable Secret Service. Password comes through stdin, never argv/logs.
  // https://wiki.gnome.org/Projects/GnomeKeyring/RunningDaemon
  env.XDG_DATA_HOME = join(root, "keyring-data");
  env.XDG_CONFIG_HOME = join(root, "keyring-config");
  env.XDG_RUNTIME_DIR = join(root, "runtime");
  for (const path of [env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR, join(root, "keyring-control")]) mkdirSync(path, {mode: 0o700});
  const keyring = spawn("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets", "--control-directory=" + join(root, "keyring-control")], {
    env, stdio: ["pipe", "ignore", "inherit"], shell: false,
  });
  let keyringFailed = false;
  keyring.once("error", () => {keyringFailed = true;});
  keyring.stdin.on("error", () => {keyringFailed = true;});
  keyring.stdin.end(randomBytes(32).toString("hex"));
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready && !keyringFailed; attempt++) {
    const probe = spawn("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
      "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.secrets"], {env, shell: false, stdio: ["ignore", "pipe", "ignore"]});
    let output = "";
    probe.stdout.on("data", bytes => {if (output.length < 64) output += bytes.toString();});
    const code = await new Promise(resolve => {probe.once("error", () => resolve(-1)); probe.once("exit", resolve);});
    ready = code === 0 && output.trim() === "(true,)";
    if (!ready) await delay(100);
  }
  if (!ready) {keyring.kill(); throw new Error("The disposable Secret Service did not start.");}
  env.FOLIO_GUI_CI_KEYRING = "1";
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
      ...(shard ? ["--shard", shard] : []),
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
    keyring.kill();
  };
  windowManager.once("error", (error) => {
    console.error(error.message);
    child.kill();
    process.exitCode = 1;
  });
  keyring.once("error", () => {
    child.kill(); process.exitCode = 1;
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
