import { afterEach, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PrivateLedger } from "../src/sync/private-ledger";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { runMaintenanceOperator } from "../src/collaboration/runtime/maintenance-operator";
const roots: string[] = [], writers: DatabaseSync[] = [];
function root() {const p = realpathSync(mkdtempSync(join(tmpdir(), "folio-role-preflight-"))); chmodSync(p, 0o700); roots.push(p); return p;}
afterEach(() => {for (const db of writers.splice(0)) db.close(); for (const p of roots.splice(0)) rmSync(p, {recursive: true, force: true});});
function walCopy(source: string, destination: string, sql: string) {
  const writer = new DatabaseSync(source); writers.push(writer);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;" + sql);
  copyFileSync(source, destination); copyFileSync(source + "-wal", destination + "-wal");
  chmodSync(destination, 0o600); chmodSync(destination + "-wal", 0o600);
}
it.each(["wrong role", "foreign schema"])("preserves main and outstanding WAL when a private ledger has %s", kind => {
  const source = join(root(), "state.sqlite"), targetRoot = root(), target = join(targetRoot, "state.sqlite");
  if (kind === "wrong role") {new PrivateLedger(source.slice(0, source.lastIndexOf("/")), "state.sqlite", "connections").close();}
  else {const db = new DatabaseSync(source); db.exec("CREATE TABLE foreign_data(value TEXT)"); db.close(); chmodSync(source, 0o600);}
  walCopy(source, target, kind === "wrong role" ? "INSERT INTO m3_private_records VALUES('raw:one','immutable-original')" : "INSERT INTO foreign_data VALUES('immutable-original')");
  const main = readFileSync(target), wal = readFileSync(target + "-wal");
  expect(() => new PrivateLedger(targetRoot, "state.sqlite", "other-role")).toThrow();
  expect(readFileSync(target)).toEqual(main); expect(readFileSync(target + "-wal")).toEqual(wal);
});
it("does not convert a closed wrong-role WAL-mode ledger to DELETE", () => {
  const directory = root(), path = join(directory, "state.sqlite"); new PrivateLedger(directory, "state.sqlite", "connections").close();
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL"); db.close(); const bytes = readFileSync(path);
  expect(() => new PrivateLedger(directory, "state.sqlite", "wrong")).toThrow(); expect(readFileSync(path)).toEqual(bytes);
  const probe = new DatabaseSync(path, {readOnly: true}); try {expect(probe.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");} finally {probe.close();}
});
it.each(["client", "unassigned"])("normal maintenance rejects %s authority source before normalizing its WAL", async kind => {
  const sourceRoot = root(), source = join(sourceRoot, "shared-runtime.sqlite"), targetRoot = root(), target = join(targetRoot, "shared-runtime.sqlite");
  const store = new RuntimeStore(sourceRoot); if (kind === "client") store.transaction(() => store.set("meta", "role", "client")); store.close();
  walCopy(source, target, "INSERT INTO runtime_records VALUES('evidence','raw','\"unchanged\"')");
  const tokenFile = join(root(), "token.txt"); writeFileSync(tokenFile, "synthetic-token", {mode: 0o600});
  const main = readFileSync(target), wal = readFileSync(target + "-wal");
  await expect(runMaintenanceOperator(["--root", targetRoot, "--org", "org", "--token-file", tokenFile, "--action", "preview"])).rejects.toThrow("WRONG_STORE_ROLE");
  expect(readFileSync(target)).toEqual(main); expect(readFileSync(target + "-wal")).toEqual(wal);
});
