import { lstatSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Resolve existing ancestors too, including symlinked parent directories. A broken
// link or inaccessible ancestor is an error, not a reason to allow the write.
function actualPath(path: string): string {
  const absolute = resolve(path);
  try {
    lstatSync(absolute);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(actualPath(parent), basename(absolute));
  }
  return realpathSync(absolute);
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}
function containsInode(dir: string, target: { dev: number; ino: number }): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), s = lstatSync(path);
    if (s.dev === target.dev && s.ino === target.ino) return true;
    if (s.isDirectory() && containsInode(path, target)) return true;
  }
  return false;
}
export function assertExternalOutput(workspace: string, destination: string) {
  const root = realpathSync(workspace), target = actualPath(destination);
  if (inside(root, target)) throw new Error("ワークスペース内には出力できません");
  try {
    const s = statSync(destination);
    if (containsInode(root, s)) throw new Error("ワークスペースのファイルには出力できません");
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}
