import { readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertMacExecution,
  assertPrivateTempDirectory,
} from "./policy/guard.mjs";
import { planDigest, readMetadataFile } from "./validate.mjs";
import { prepareRemoteH1 } from "./preflight/remote-h1.mjs";
import { snapshotFiles } from "./preflight/artifacts.mjs";
import { superviseOwnedProcess } from "./watchdog/owned-process.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Pure description of one fixed suite, never an arbitrary executable/PID CLI.
export function remoteBatchArguments({ cwd, evidenceRoot, timeoutMs }) {
  if (
    !isAbsolute(cwd) ||
    !isAbsolute(evidenceRoot) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 900000
  )
    throw new Error("Invalid bounded remote batch invocation");
  return [
    resolve(cwd, "scripts/run-gui-tests.mjs"),
    "--mode=batch",
    "--config",
    resolve(cwd, "playwright.remote-mac.config.ts"),
    "--workers=1",
    "--retries=0",
    "--max-failures=1",
    "--global-timeout=" + timeoutMs,
    "--reporter=json",
    "--output",
    join(evidenceRoot, "playwright"),
  ];
}

// No direct CLI or import-time execution. The caller is run-gui-tests batch.
export async function runRemoteMacBatch({
  planPath,
  cwd,
  env,
  forwardSignals = true,
}) {
  let context;
  try {
    if (!isAbsolute(planPath) || realpathSync(cwd) !== realpathSync(repository))
      throw new Error("Remote workspace mismatch");
    const plan = assertMacExecution(
      JSON.parse(readMetadataFile(planPath).toString("utf8")),
      env,
    );
    assertPrivateTempDirectory(dirname(planPath), plan.tempParent);
    // The real OS identity is checked inside this function before any allocation.
    context = prepareRemoteH1(plan, { env, workspaceRoot: cwd });
  } catch {
    return {
      code: 1,
      signal: null,
      refused: true,
      message:
        "Remote Mac acceptance preflight refused; no process was started",
    };
  }
  const { plan, sandbox } = context;
  // Capture the actual renderer/preload and auxiliary outputs as well as main.
  // This is a file observation, not a claim that the GUI/Keychain has passed.
  const outputs = readdirSync(join(cwd, "dist"))
    .filter((name) => /\.(?:cjs|map)$/.test(name))
    .map((name) => "dist/" + name);
  outputs.push("dist/renderer/index.html");
  for (const name of readdirSync(join(cwd, "dist/renderer/assets")))
    outputs.push("dist/renderer/assets/" + name);
  const snapshot = snapshotFiles({ root: cwd, paths: outputs });
  writeFileSync(
    join(sandbox.evidence, "artifact-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      planSha256: planDigest(plan),
      snapshot,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const controller = new AbortController();
  const handlers = new Map();
  if (forwardSignals) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => controller.abort();
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
  }
  try {
    const childEnv = {
      ...context.electron.env,
      FOLIO_MAC_PLAN_PATH: realpathSync(planPath),
      FOLIO_MAC_EVIDENCE_ROOT: sandbox.evidence,
    };
    const observed = await superviseOwnedProcess({
      executable: process.execPath,
      args: remoteBatchArguments({
        cwd,
        evidenceRoot: sandbox.evidence,
        timeoutMs: plan.timeoutMs,
      }),
      cwd,
      env: childEnv,
      outputParent: sandbox.evidence,
      temporaryParent: plan.tempParent,
      timeoutMs: plan.timeoutMs,
      graceMs: plan.graceMs,
      signal: controller.signal,
      observationKind: "MAC_REMOTE",
      binding: {
        runId: plan.runId,
        caseId: "MAC-H1",
        hostHash: plan.host.hostHash,
        artifactSha256: plan.provenance.artifactSha256,
      },
    });
    const { result } = observed;
    const code =
      result.outcome === "COMPLETED"
        ? 0
        : result.outcome === "TIMED_OUT"
          ? 124
          : result.outcome === "ABORTED"
            ? 130
            : Number.isInteger(result.exitCode) && result.exitCode > 0
              ? result.exitCode
              : 1;
    return {
      code,
      signal: null,
      refused: false,
      productResult: "NOT_RUN",
      watchdog: observed,
    };
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}
