import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "fixed-collision",
}));
import { writeRecoveryFile } from "../src/persistence/recovery-file";

it("does not remove a temporary file that it failed to create", () => {
  const root = mkdtempSync(resolve("output/recovery-ownership-"));
  try {
    const destination = join(root, "recovery.json");
    const collision = destination + ".folio-fixed-collision.tmp";
    writeFileSync(collision, "other owner's file");
    const content = JSON.stringify({ format: "folio-recovery", schemaVersion: 1, pages: [], pendingPatches: [] });
    expect(() => writeRecoveryFile(destination, content)).toThrow();
    expect(readFileSync(collision, "utf8")).toBe("other owner's file");
    expect(existsSync(destination)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
