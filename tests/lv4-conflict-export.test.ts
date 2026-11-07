import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { exportConflictAfterPicker, exportConflictCheckpoint } from "../src/main/conflict-export";
import { Store } from "../src/persistence/store";
import { canonicalJson, hashCheckpoint } from "../src/sync/protocol";
import { buildWorkspaceCheckpoint } from "../src/sync/workspace-checkpoint";
import { conflictCandidateText } from "../src/renderer/WorkspaceConflictPanel";

it("exports the exact validated candidate without overwriting existing files", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-conflict-export-")));
  const store = new Store(join(root, "workspace.sqlite"));
  try {
    store.create(null, "page", "saved candidate");
    const checkpoint = buildWorkspaceCheckpoint(store.db);
    const content = canonicalJson(checkpoint), hash = hashCheckpoint(checkpoint);
    const candidate = {operationId: "operation", side: "local" as const, revision: 1,
      checkpointHash: hash, checkpointJson: content, bytes: Buffer.byteLength(content)};
    const output = join(root, "candidate.json");
    const checked: string[] = [];
    expect(exportConflictCheckpoint(output, candidate, (path) => {checked.push(path);})).toBe(output);
    expect(readFileSync(output, "utf8")).toBe(content);
    expect(checked.length).toBeGreaterThan(0);
    const existing = join(root, "existing.json"); writeFileSync(existing, "keep");
    expect(() => exportConflictCheckpoint(existing, candidate, () => {})).toThrow();
    expect(readFileSync(existing, "utf8")).toBe("keep");
    expect(() => exportConflictCheckpoint(join(root, "bad.json"), {...candidate, checkpointHash: "0".repeat(64)}, () => {}))
      .toThrow("conflict-candidate-hash-mismatch");
    const denied = join(root, "denied.json");
    expect(() => exportConflictCheckpoint(denied, candidate, () => {throw new Error("forbidden destination");}))
      .toThrow("forbidden destination");
    expect(existsSync(denied)).toBe(false);
    expect(conflictCandidateText({side: "local", revision: 1, pages: 1, assets: 0,
      checkpointHash: hash, bytes: candidate.bytes})).toContain(hash.slice(0, 12));
  } finally {store.close(); rmSync(root, {recursive: true, force: true});}
});

it("does not write when the candidate or renderer changes while the picker is open", async () => {
  const target = {operationId: "op", side: "local" as const, expectedRevision: 1,
    expectedCheckpointHash: "a".repeat(64)};
  const candidate = {operationId: "op", side: "local" as const, revision: 1,
    checkpointHash: target.expectedCheckpointHash, checkpointJson: "{}", bytes: 2};
  for (const changed of ["candidate", "renderer"] as const) {
    let finish!: (path: string) => void;
    const pick = () => new Promise<string>((resolve) => {finish = resolve;});
    let calls = 0;
    const read = () => {if (++calls > 1 && changed === "candidate") throw new Error("stale candidate"); return candidate;};
    let authorized = true;
    const save = vi.fn(() => "saved");
    const result = exportConflictAfterPicker({target, candidate: read, pick, authorized: () => authorized, save});
    if (changed === "renderer") authorized = false;
    finish("/unused/output.json");
    await expect(result).rejects.toThrow(changed === "candidate" ? "stale candidate" : "unauthorized");
    expect(save).not.toHaveBeenCalled();
  }
});
