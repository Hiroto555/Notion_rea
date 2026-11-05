import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateWorkspace } from "../src/persistence/workspace";
import { runRawRescueCli } from "../src/main/raw-rescue-cli";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "folio-source-readers-"),
  );
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "source");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "assets"));
  const path = join(workspace, "workspace.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL;CREATE TABLE payload(value TEXT);INSERT INTO payload VALUES('preserved')",
  );
  db.close();
  expect(existsSync(path + "-shm")).toBe(false);
  return { root, workspace, path };
}
it("startup import retains the shared-memory index while another source reader is still open", () => {
  const f = fixture();
  let observer: DatabaseSync | undefined;
  cleanup.push(() => observer?.close());
  migrateWorkspace(f.workspace, join(f.root, "imported"), {
    beforeCopy() {
      observer = new DatabaseSync(f.path, { readOnly: true });
      observer.prepare("SELECT * FROM payload").all();
    },
  });
  expect(observer?.isOpen).toBe(true);
  expect(existsSync(f.path + "-shm")).toBe(true);
  expect(observer?.prepare("SELECT value FROM payload").get()?.value).toBe(
    "preserved",
  );
});
it("standalone rescue does not unlink a source SQLite index used by another reader", () => {
  const f = fixture(),
    dest = join(f.root, "exports");
  mkdirSync(dest);
  let observer: DatabaseSync | undefined;
  cleanup.push(() => observer?.close());
  const errors: string[] = [];
  const result = runRawRescueCli(
    ["--workspace", f.workspace, "--destination", dest, "--workspace-closed"],
    {
      cwd: () => f.root,
      out: () => {
        observer = new DatabaseSync(f.path, { readOnly: true });
        observer.prepare("SELECT * FROM payload").all();
      },
      err: (text) => errors.push(text),
    },
  );
  expect({ result, errors }).toEqual({ result: 0, errors: [] });
  expect(existsSync(f.path + "-shm")).toBe(true);
  expect(observer?.prepare("SELECT value FROM payload").get()?.value).toBe(
    "preserved",
  );
});
