import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-ignore Node-only launcher; GUI spawn is never reached in these tests.
import { runGuiTests } from "../scripts/run-gui-tests.mjs";
// @ts-ignore Import-only remote adapter, guarded by actual host identity.
import { remoteBatchArguments } from "../scripts/mac-acceptance/remote-batch.mjs";
import { planFixture } from "./acceptance-metadata/fixtures";

describe("remote Mac batch integration without any GUI", () => {
  it("describes only the fixed guarded suite with bounded settings", () => {
    const args = remoteBatchArguments({
      cwd: "/repo",
      evidenceRoot: "/tmp/private",
      timeoutMs: 10000,
    });
    expect(args).toEqual([
      "/repo/scripts/run-gui-tests.mjs",
      "--mode=batch",
      "--config",
      "/repo/playwright.remote-mac.config.ts",
      "--workers=1",
      "--retries=0",
      "--max-failures=1",
      "--global-timeout=10000",
      "--reporter=json",
      "--output",
      "/tmp/private/playwright",
    ]);
    for (const timeoutMs of [0, Infinity, 900001])
      expect(() =>
        remoteBatchArguments({
          cwd: "/repo",
          evidenceRoot: "/tmp/private",
          timeoutMs,
        }),
      ).toThrow();
  });
  it("rejects extra args and list-mode use before spawning", async () => {
    for (const [batch, args] of [
      [true, ["--mac-acceptance-plan=/tmp/plan.json"]],
      [true, ["--mac-acceptance-plan", "/tmp/plan.json", "--headed"]],
      [true, ["--mac-acceptance-plan"]],
      [false, ["--mac-acceptance-plan", "/tmp/plan.json", "--list"]],
    ] as const) {
      const spawn = vi.fn();
      const result = await runGuiTests({
        batch,
        args: [...args],
        env: {},
        spawn,
        forwardSignals: false,
      });
      expect(result.refused).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
    }
  });
  it("refuses this Mac with fake CI and opt-ins, without touching the plan or starting a process", async () => {
    const parent = mkdtempSync(join(tmpdir(), "folio-remote-batch-refusal-"));
    try {
      const file = join(parent, "plan.json"),
        bytes = JSON.stringify(planFixture());
      writeFileSync(file, bytes, { mode: 0o600 });
      const spawn = vi.fn();
      const result = await runGuiTests({
        batch: true,
        args: ["--mac-acceptance-plan", file],
        cwd: process.cwd(),
        env: {
          FOLIO_MAC_ACCEPTANCE_OPT_IN: "1",
          GITHUB_ACTIONS: "true",
          CI: "true",
          RUNNER_OS: "macOS",
          RUNNER_ENVIRONMENT: "github-hosted",
          RUNNER_NAME: "synthetic-runner",
          RUNNER_TEMP: tmpdir(),
        },
        spawn,
        forwardSignals: false,
      });
      expect(result).toMatchObject({ code: 1, refused: true });
      expect(spawn).not.toHaveBeenCalled();
      expect(readFileSync(file, "utf8")).toBe(bytes);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
