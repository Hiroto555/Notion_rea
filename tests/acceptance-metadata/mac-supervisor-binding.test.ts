import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { superviseOwnedProcess } from "../../scripts/mac-acceptance/watchdog/owned-process.mjs";

const binding = () => ({
  runId: "00000000-0000-4000-8000-000000000001",
  caseId: "MAC-H1",
  hostHash: "a".repeat(64),
  artifactSha256: "b".repeat(64),
});

it("refuses metadata that could persist secrets or claim an unbound remote run before spawning", async () => {
  const parent = mkdtempSync(join(tmpdir(), "folio-binding-reject-"));
  try {
    const options = {
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: parent,
      env: {},
      outputParent: parent,
    };
    for (const invalid of [
      { binding: { token: "synthetic-secret-canary" } },
      { binding: { ...binding(), token: "synthetic-secret-canary" } },
      { observationKind: "MAC_REMOTE" },
      { observationKind: "arbitrary-diagnostic-text" },
    ]) {
      await expect(
        superviseOwnedProcess({ ...options, ...invalid } as any),
      ).rejects.toThrow();
      expect(readdirSync(parent)).toEqual([]);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

it("detaches the validated binding from caller mutation while only an owned Node child runs", async () => {
  const parent = mkdtempSync(join(tmpdir(), "folio-binding-snapshot-"));
  try {
    const original = binding();
    const expected = { ...original };
    const pending = superviseOwnedProcess({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(0), 50)"],
      cwd: parent,
      env: {},
      outputParent: parent,
      timeoutMs: 3000,
      binding: original,
    });
    original.hostHash = "c".repeat(64);
    (original as any).token = "synthetic-secret-canary";
    const { result } = await pending;
    expect(result.binding).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-canary");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
