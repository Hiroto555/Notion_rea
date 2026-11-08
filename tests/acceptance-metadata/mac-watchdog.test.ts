import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
// @ts-expect-error fixed Node ESM probe; no arbitrary executable or GUI entry
import { runNodeProbe } from "../../scripts/mac-acceptance/watchdog/node-probe.mjs";

describe("external watchdog with disposable Node processes", () => {
  it.each([
    ["normal", "COMPLETED", false],
    ["nonzero", "PROCESS_FAILED", false],
    ["hang", "TIMED_OUT", true],
    ["ignore-term", "TIMED_OUT", true],
    ["block", "TIMED_OUT", true],
    ["descendant-hang", "TIMED_OUT", true],
    ["orphan", "DESCENDANTS_LEFT", false],
    ["output-limit", "OUTPUT_LIMIT", false],
  ] as const)(
    "supervises %s outside the child's event loop",
    async (scenario, outcome, expired) => {
      const parent = mkdtempSync(join(tmpdir(), "folio-watchdog-fixture-"));
      try {
        const { root, result } = await runNodeProbe({
          scenario,
          outputParent: parent,
          timeoutMs:
            scenario === "normal" ||
            scenario === "nonzero" ||
            scenario === "output-limit" ||
            scenario === "orphan"
              ? 3000
              : 800,
          graceMs: 100,
        });
        expect(result).toMatchObject({
          observationKind: "NODE_SYNTHETIC",
          productResult: "NOT_RUN",
          outcome,
          expired,
          cleanupConfirmed: true,
        });
        expect(result.durationMs).toBeLessThan(4500);
        expect(
          JSON.parse(readFileSync(join(root, "watchdog.json"), "utf8")),
        ).toEqual(result);
        expect(() => process.kill(result.pid, 0)).toThrow();
        if (
          scenario === "ignore-term" ||
          scenario === "descendant-hang" ||
          scenario === "orphan"
        )
          expect(result.signals).toEqual(["SIGTERM", "SIGKILL"]);
        if (scenario === "descendant-hang" || scenario === "orphan") {
          expect(result.lastPhase).toBe("descendant-ready");
          expect(() => process.kill(result.descendantPid, 0)).toThrow();
        }
        if (scenario === "block") expect(result.lastPhase).toBe("blocking");
        expect(JSON.stringify(result)).not.toContain("synthetic Node probe");
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );
  it("aborts only its own process group and leaves an unrelated Node sentinel alive", async () => {
    const parent = mkdtempSync(join(tmpdir(), "folio-watchdog-abort-fixture-"));
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { env: {}, stdio: "ignore", shell: false },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300);
    try {
      const { result } = await runNodeProbe({
        scenario: "ignore-term",
        outputParent: parent,
        timeoutMs: 3000,
        graceMs: 100,
        signal: controller.signal,
      });
      expect(result).toMatchObject({
        outcome: "ABORTED",
        expired: false,
        cleanupConfirmed: true,
        disposition: "UNRESOLVED",
      });
      expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
      expect(() => process.kill(result.pid, 0)).toThrow();
    } finally {
      clearTimeout(timer);
      const done = new Promise<void>((resolve) =>
        sentinel.once("exit", () => resolve()),
      );
      sentinel.kill("SIGKILL");
      await done;
      rmSync(parent, { recursive: true, force: true });
    }
  });
  it("refuses unknown commands, invalid deadlines and pre-aborted requests before spawning", async () => {
    const parent = mkdtempSync(
      join(tmpdir(), "folio-watchdog-refusal-fixture-"),
    );
    try {
      for (const options of [
        { scenario: "electron" },
        { scenario: "hang", timeoutMs: 0 },
        { scenario: "hang", graceMs: Infinity },
        { scenario: "hang", signal: {} },
        { scenario: "hang", signal: AbortSignal.abort() },
      ])
        await expect(
          runNodeProbe({ outputParent: parent, ...options }),
        ).rejects.toThrow();
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
  it("rejects a temporary alias escaping the approved parent", async () => {
    const parent = mkdtempSync(join(tmpdir(), "folio-watchdog-alias-fixture-"));
    try {
      symlinkSync(process.cwd(), join(parent, "escape"));
      await expect(
        runNodeProbe({
          scenario: "normal",
          outputParent: join(parent, "escape"),
        }),
      ).rejects.toThrow();
      expect(readdirSync(parent)).toEqual(["escape"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
