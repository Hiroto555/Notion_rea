import { DatabaseSync } from "node:sqlite";
import { join, resolve, dirname } from "node:path";
import {
  existsSync,
  mkdirSync,
  cpSync,
  renameSync,
  writeFileSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
export function workspacePath(userData: string, override?: string) {
  return resolve(override || join(userData, "workspace"));
}
function checkTree(path: string) {
  const root = lstatSync(path);
  if (root.isSymbolicLink()) throw new Error("移行元にシンボリックリンクがあります: " + path);
  if (!root.isDirectory()) throw new Error("移行元のassetsがディレクトリではありません");
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (lstatSync(child).isSymbolicLink())
      throw new Error("移行元にシンボリックリンクがあります: " + entry.name);
    if (entry.isDirectory()) checkTree(child);
  }
}
export function backupWorkspace(source: string, destination: string) {
  if (existsSync(destination))
    throw new Error("バックアップ先が既に存在します");
  const sourceStat = lstatSync(source);
  const dbStat = lstatSync(join(source, "workspace.sqlite"));
  if (sourceStat.isSymbolicLink() || dbStat.isSymbolicLink())
    throw new Error("移行元にシンボリックリンクがあります");
  if (!sourceStat.isDirectory() || !dbStat.isFile())
    throw new Error("移行元の形式が不正です");
  checkTree(join(source, "assets"));
  mkdirSync(destination, { recursive: true });
  const db = new DatabaseSync(join(source, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("移行元のSQLite整合性エラー");
    db.prepare("VACUUM INTO ?").run(join(destination, "workspace.sqlite"));
  } finally {
    db.close();
  }
  cpSync(join(source, "assets"), join(destination, "assets"), {
    recursive: true,
  });
  writeFileSync(
    join(destination, "manifest.json"),
    JSON.stringify(
      { app: "Folio", format: 1, createdAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  return destination;
}
// Copy only into a new location. A failed staging copy and its backup remain
// available for diagnosis; neither source nor an existing destination is erased.
export function migrateWorkspace(source: string, destination: string) {
  source = resolve(source);
  destination = resolve(destination);
  if (existsSync(destination))
    throw new Error("移行先は未作成のフォルダを指定してください");
  if (destination.startsWith(source + "/"))
    throw new Error("移行元の中へは移行できません");
  mkdirSync(dirname(destination), { recursive: true });
  const backup = destination + ".backup-" + randomUUID(),
    staging = destination + ".staging-" + randomUUID();
  backupWorkspace(source, backup);
  cpSync(backup, staging, { recursive: true });
  const db = new DatabaseSync(join(staging, "workspace.sqlite"), {
    readOnly: true,
  });
  try {
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("移行先のSQLite整合性エラー");
  } finally {
    db.close();
  }
  renameSync(staging, destination);
  return { destination, backup };
}
