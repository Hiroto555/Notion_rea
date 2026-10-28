import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
const git = (...args) => spawnSync("git", args, { encoding: "utf8" }).stdout.trim();
const dirty = git("status", "--porcelain");
if (dirty) throw new Error("Verification requires a clean fixed commit");
const directory = resolve("output/r6-final-verification");
mkdirSync(directory, { recursive: true });
const report = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty,
  environment: { node: process.version, platform: process.platform, arch: process.arch, release: os.release(), cpuCount: os.cpus().length },
  workers: 1, retries: 0, syntheticDataOnly: true, runs: [] };
for (const args of [["build"], ["test", "--maxWorkers=1", "--no-file-parallelism"], ["test:e2e", "--workers=1", "--retries=0"]]) {
  const run = { command: [process.execPath, "scripts/folio-agent.mjs", ...args], started: new Date().toISOString() };
  const result = spawnSync(process.execPath, ["scripts/folio-agent.mjs", ...args], { stdio: "inherit" });
  run.finished = new Date().toISOString(); run.exitCode = result.status; run.signal = result.signal;
  report.runs.push(run);
  writeFileSync(resolve(directory, "manifest.json"), JSON.stringify(report, null, 2) + "\n");
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
