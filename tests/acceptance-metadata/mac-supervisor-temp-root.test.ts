import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { superviseOwnedProcess } from "../../scripts/mac-acceptance/watchdog/owned-process.mjs";

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-runner-temp-root-"),
  );
  const runner = join(root, "registered-runner-temp");
  const system = join(root, "different-os-temp");
  mkdirSync(runner, { mode: 0o700 });
  mkdirSync(system, { mode: 0o700 });
  const evidence = join(runner, "evidence");
  const outside = join(system, "outside");
  mkdirSync(evidence, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  vi.stubEnv("TMPDIR", system);
  const options = {
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: root,
    env: {},
    outputParent: evidence,
    timeoutMs: 3000,
  };
  return { root, runner, evidence, outside, options };
}

it("supervises a fixed Node child under the approved runner temp even when OS temp differs", async () => {
  const f = fixture();
  try {
    // The default still confines ordinary Node probes to the actual OS temp.
    await expect(superviseOwnedProcess(f.options)).rejects.toThrow();
    expect(readdirSync(f.evidence)).toEqual([]);
    const { root, result } = await superviseOwnedProcess({
      ...f.options,
      temporaryParent: f.runner,
    });
    expect(root.startsWith(realpathSync(f.evidence) + "/")).toBe(true);
    expect(result).toMatchObject({
      outcome: "COMPLETED",
      cleanupConfirmed: true,
      productResult: "NOT_RUN",
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

it("rejects the parent itself and an escaping sibling rather than silently reverting to OS temp", async () => {
  const f = fixture();
  try {
    for (const outputParent of [f.runner, f.outside])
      await expect(
        superviseOwnedProcess({
          ...f.options,
          outputParent,
          temporaryParent: f.runner,
        }),
      ).rejects.toThrow();
    expect(readdirSync(f.evidence)).toEqual([]);
    expect(readdirSync(f.outside)).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
