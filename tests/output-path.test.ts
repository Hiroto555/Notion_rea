import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertExternalOutput } from "../src/persistence/output-path";
it("rejects workspace outputs and aliases but permits an external namesake", () => {
  const root = mkdtempSync(join(process.cwd(), "output/path-boundary-"));
  try {
    const workspace = join(root, "workspace"), exports = join(root, "exports");
    mkdirSync(workspace); mkdirSync(exports); mkdirSync(join(workspace, "assets")); mkdirSync(join(workspace, "backups"));
    for (const name of ["workspace.sqlite", "workspace.sqlite-wal", "workspace.sqlite-shm", "assets/file", "backups/backup"]) {
      const path = join(workspace, name); writeFileSync(path, "protected");
      expect(() => assertExternalOutput(workspace, path)).toThrow();
      expect(readFileSync(path, "utf8")).toBe("protected");
    }
    symlinkSync(workspace, join(root, "alias"));
    expect(() => assertExternalOutput(workspace, join(root, "alias", "new"))).toThrow();
    symlinkSync(join(workspace, "workspace.sqlite"), join(exports, "link"));
    expect(() => assertExternalOutput(workspace, join(exports, "link"))).toThrow();
    linkSync(join(workspace, "workspace.sqlite"), join(exports, "hardlink"));
    expect(() => assertExternalOutput(workspace, join(exports, "hardlink"))).toThrow();
    symlinkSync(join(workspace, "missing"), join(exports, "dangling"));
    expect(() => assertExternalOutput(workspace, join(exports, "dangling"))).toThrow();
    expect(() => assertExternalOutput(workspace, join(exports, "workspace.sqlite"))).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
