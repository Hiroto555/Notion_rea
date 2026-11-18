import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({onMissing: undefined as ((path: string) => void) | undefined}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {...actual, lstatSync: (...args: any[]) => {
    try {return (actual.lstatSync as any)(...args);} catch (error) {
      if (typeof args[0] === "string") hooks.onMissing?.(args[0]);
      throw error;
    }
  }};
});

import { startCheckpointServer } from "../src/sync/checkpoint-server";
import { inspectCheckpointServerBackup } from "../src/sync/server-backup-inspection";

it("does not create SQLite sidecars if a WAL database replaces the path after preflight", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "folio-backup-race-")));
  let server: Awaited<ReturnType<typeof startCheckpointServer>> | undefined;
  try {
    server = await startCheckpointServer({databasePath: join(root, "server.sqlite"), capabilities: [],
      workspaces: [{workspaceId: "workspace", ownerId: "owner"}], validateCheckpoint: () => true});
    const directory = join(root, "backup #?% 日本語");
    server.backup(directory);
    await server.close(); server = undefined;
    const path = join(directory, "server.sqlite"), replacement = join(root, "replacement.sqlite");
    fs.copyFileSync(path, replacement);
    const wal = new DatabaseSync(replacement);
    try {wal.exec("PRAGMA journal_mode=WAL");} finally {wal.close();}
    let probes = 0, swapped = false;
    let afterSwap: {hash: string; mode: number; size: number; mtime: number} | undefined;
    const observe = () => {const s = fs.lstatSync(path); return {hash: createHash("sha256").update(fs.readFileSync(path)).digest("hex"),
      mode: s.mode, size: s.size, mtime: s.mtimeMs};};
    hooks.onMissing = (missing) => {
      if (missing === path + "-journal" && ++probes === 2) {
        swapped = true;
        fs.renameSync(path, join(root, "preserved.sqlite"));
        fs.renameSync(replacement, path);
        afterSwap = observe();
      }
    };
    try {expect(() => inspectCheckpointServerBackup(directory)).toThrow();}
    finally {hooks.onMissing = undefined;}
    expect(swapped).toBe(true);
    expect(fs.readdirSync(directory).filter((name) => /-(wal|shm|journal)$/.test(name))).toEqual([]);
    expect(observe()).toEqual(afterSwap);
  } finally {hooks.onMissing = undefined; if (server) await server.close(); fs.rmSync(root, {recursive: true, force: true});}
});
