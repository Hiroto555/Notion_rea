import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import {
  lstatSync,
  realpathSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { isAbsolute, relative, sep, join } from "node:path";
import { planSchema } from "./schema.mjs";

// Hash of the management Mac's hostname, observed 2026-11-08. This deny always
// wins, including when CI/opt-in variables have been copied into a local shell.
// Hostname registration is an operational guard, not hardware attestation.
export const PROTECTED_HOST_HASH =
  "448108c7115801cad1095223d961c4ebe4a43675c043995d8ee3b6b443f8e70e";
export const hostHash = (name) =>
  createHash("sha256").update(name.toLowerCase()).digest("hex");

export function isStrictChild(parent, child) {
  const rel = relative(parent, child);
  return (
    !!rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)
  );
}

export function assertPrivateTempDirectory(directory, parent = tmpdir()) {
  if (!isAbsolute(directory) || !isAbsolute(parent))
    throw new Error("Absolute temporary paths required");
  const base = realpathSync(parent);
  const actual = realpathSync(directory);
  const stat = lstatSync(actual);
  if (
    !isStrictChild(base, actual) ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error(
      "Expected a private, owned child of the approved temporary parent",
    );
  return actual;
}

export function runtimeIdentity() {
  return {
    platform: process.platform,
    arch: process.arch,
    hostHash: hostHash(hostname()),
  };
}

// Pure policy evaluation is exported for synthetic unit tests. Launchers must
// call assertMacExecution(), whose identity is read from the OS, never from env.
export function evaluateMacPolicy(planInput, runtime, env) {
  if (runtime.hostHash === PROTECTED_HOST_HASH)
    throw new Error("Management Mac is forbidden");
  const plan = planSchema.parse(planInput);
  if (
    runtime.platform !== "darwin" ||
    runtime.arch !== "arm64" ||
    runtime.hostHash !== plan.host.hostHash
  )
    throw new Error("Host is not the registered Darwin arm64 target");
  if (
    env.FOLIO_GUI_TEST_OPT_IN !== "1" ||
    env.FOLIO_MAC_ACCEPTANCE_OPT_IN !== "1"
  )
    throw new Error(
      "Explicit Mac authorization and existing batch opt-in required",
    );
  if (env.PWDEBUG || env.PWTEST_WATCH || env.FOLIO_DEV_URL)
    throw new Error("Interactive debug/watch/dev execution is forbidden");
  if (env.RUNNER_NAME !== plan.host.runnerName)
    throw new Error("Runner registration mismatch");
  if (!isAbsolute(plan.tempParent))
    throw new Error("Absolute temporary parent required");
  if (plan.host.kind === "github-hosted-macos") {
    if (
      env.GITHUB_ACTIONS !== "true" ||
      env.CI !== "true" ||
      env.RUNNER_OS !== "macOS" ||
      env.RUNNER_ENVIRONMENT !== "github-hosted" ||
      !env.RUNNER_TEMP ||
      !isAbsolute(env.RUNNER_TEMP)
    )
      throw new Error("Expected a GitHub-hosted macOS runner");
  } else if (env.RUNNER_ENVIRONMENT !== "self-hosted") {
    throw new Error("Expected a registered dedicated Mac runner");
  }
  return plan;
}

export function assertMacExecution(planInput, env = process.env) {
  const plan = evaluateMacPolicy(planInput, runtimeIdentity(), env);
  assertTemporaryParent(plan, env);
  return plan;
}

// Filesystem-only half of the guard; safe to exercise without a Mac launch.
export function assertTemporaryParent(plan, env, systemTemp = tmpdir()) {
  const approved = realpathSync(
    plan.host.kind === "github-hosted-macos" ? env.RUNNER_TEMP : systemTemp,
  );
  if (
    !isAbsolute(plan.tempParent) ||
    realpathSync(plan.tempParent) !== approved ||
    !lstatSync(approved).isDirectory()
  )
    throw new Error("Temporary parent is not the runner temporary directory");
  return approved;
}

// Not a launcher: remote integration must still use test:e2e:batch. This
// allocator cannot run on the management Mac and never reuses a supplied data dir.
export function allocateMacSandbox(planInput, env = process.env) {
  const plan = assertMacExecution(planInput, env);
  const parent = realpathSync(plan.tempParent);
  const root = mkdtempSync(join(parent, "folio-mac-"));
  chmodSync(root, 0o700);
  const result = { root };
  for (const name of ["data", "vault", "evidence"]) {
    result[name] = join(root, name);
    mkdirSync(result[name], { mode: 0o700 });
    assertPrivateTempDirectory(result[name], root);
  }
  return result;
}
