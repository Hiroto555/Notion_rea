import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Store } from "../persistence/store";
import { WorkspaceStoragePressure } from "./storage-pressure";
import type { StartupStatus } from "../shared/startup-status";

export function existingStartupParent(path: string): string {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (candidate === parent)
      throw new Error("保存先のボリュームを確認できません。");
    candidate = parent;
  }
  return realpathSync(candidate);
}

type Admission = (directory: string, additionalBytes: number) => void;
export function admitStartupStorage(
  directory: string,
  additionalBytes: number,
): void {
  new WorkspaceStoragePressure(existingStartupParent(directory)).assertWritable(
    additionalBytes,
  );
}

/** Capacity refusal opens only a previously readable, supported workspace in
 * read-only mode. Migration and arbitrary I/O failures retain their own error. */
export function openWorkspaceAtStartup(
  directory: string,
  admit: Admission = admitStartupStorage,
): { store: Store; status: StartupStatus } {
  const path = join(directory, "workspace.sqlite");
  let refused: Error | undefined;
  try {
    const store = new Store(path, {
      beforeOpen: (bytes) => {
        try {
          admit(directory, bytes);
        } catch {
          refused = new Error(
            "起動時の保存容量を確認できないか、必要な余裕が不足しています。",
          );
          throw refused;
        }
      },
    });
    return { store, status: { mode: "writable" } };
  } catch (error) {
    if (!refused || error !== refused || !existsSync(path)) throw error;
    const store = new Store(path, { readOnly: true });
    return {
      store,
      status: {
        mode: "readOnly",
        message:
          refused.message +
          " ページの閲覧と原本の書き出しを利用できます。容量を確保して再起動してください。",
      },
    };
  }
}
