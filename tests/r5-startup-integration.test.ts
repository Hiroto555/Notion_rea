import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/persistence/store";
import { openWorkspaceAtStartup } from "../src/main/workspace-startup";
import { assertReadOnlyRequest } from "../src/main/read-only-workspace";
import { preparePageCreation } from "../src/shared/page-operation";
import { createRawWorkspaceSalvage } from "../src/persistence/raw-workspace-salvage";
import { emptyCrashRecoverySnapshot } from "../src/shared/crash-recovery";
import { requestSchema } from "../src/shared/types";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-r5-startup-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace: join(root, "workspace") };
}
const denied = () => {
  throw new Error("capacity-exceeded");
};

it("keeps a new workspace absent if capacity is refused before startup", () => {
  const f = fixture();
  expect(() => openWorkspaceAtStartup(f.workspace, denied)).toThrow(/保存容量/);
  expect(existsSync(f.workspace)).toBe(false);
});
it("opens an existing supported workspace for reading and raw rescue when writable startup is refused", () => {
  const f = fixture();
  const source = new Store(join(f.workspace, "workspace.sqlite"));
  const page = source.create(null, "page", "保存済み");
  source.close();
  const before = readFileSync(join(f.workspace, "workspace.sqlite"));
  const opened = openWorkspaceAtStartup(f.workspace, denied);
  cleanup.push(() => opened.store.close());
  expect(opened.status.mode).toBe("readOnly");
  const req = { type: "load" } as const;
  assertReadOnlyRequest(req);
  expect(opened.store.handle(req)).toMatchObject({
    pages: [{ id: page.id, title: "保存済み" }],
  });
  expect(
    opened.store.handle({ type: "search", query: "保存済み" }),
  ).toMatchObject([{ id: page.id }]);
  const op = preparePageCreation("失ってはいけない入力", null);
  expect(() =>
    assertReadOnlyRequest({ type: "page:commit", operation: op }),
  ).toThrow(/読み取り専用/);
  expect(() => opened.store.commitPageOperation(op)).toThrow();
  const dest = join(f.root, "exports");
  mkdirSync(dest);
  const rescue = createRawWorkspaceSalvage(opened.store.db, f.workspace, dest);
  expect(existsSync(join(rescue.directory, "workspace.raw.sqlite"))).toBe(true);
  expect(opened.store.db.prepare("PRAGMA query_only").get()?.query_only).toBe(
    1,
  );
  expect(readFileSync(join(f.workspace, "workspace.sqlite"))).toEqual(before);
});
it("enforces readonly restrictions on mutation and checkpoint families without consuming input", () => {
  const input = requestSchema.parse({
    type: "recovery:write",
    expectedGeneration: 0,
    snapshot: emptyCrashRecoverySnapshot(),
  });
  expect(() => assertReadOnlyRequest(input)).toThrow();
  expect(() =>
    assertReadOnlyRequest({
      type: "storage:applyLimits",
      expectedRevision: null,
      configured: { maxReceiptRows: 1 },
    }),
  ).toThrow();
  expect(() =>
    assertReadOnlyRequest({ type: "workspaceBackup:release" }),
  ).toThrow();
  expect(() =>
    assertReadOnlyRequest({ type: "storage:rawSalvage" }),
  ).not.toThrow();
});
it("does not convert a future schema or ordinary source failure into a writable startup", () => {
  const f = fixture();
  mkdirSync(f.workspace);
  const path = join(f.workspace, "workspace.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA user_version=999; CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('raw')",
  );
  db.close();
  const original = readFileSync(path),
    files = readdirSync(f.workspace);
  expect(() => openWorkspaceAtStartup(f.workspace, () => {})).toThrow();
  expect(readFileSync(path)).toEqual(original);
  expect(readdirSync(f.workspace)).toEqual(files);
});
