import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Store, storeInitializationRetainsNativeLease } from "../persistence/store";
import { WorkspaceStoragePressure } from "./storage-pressure";
import type { StartupStatus } from "../shared/startup-status";
import {privatePersistencePort, type PrivatePersistenceOptions, type NativePrivateSqliteLease} from "../platform/private-persistence";
import type { StoreStartupOptions } from "../persistence/schema-startup";
import {retainStartupProtector} from "../persistence/startup-connection-owner";

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
  persistence?: PrivatePersistenceOptions & Pick<StoreStartupOptions, "nativeHotJournalSnapshot">,
): { store: Store; status: StartupStatus } {
  const path = join(directory, "workspace.sqlite");
  let refused: Error | undefined;
  const native = persistence ? privatePersistencePort(persistence) : undefined;
  const open = (options: StoreStartupOptions): Store => {
    if (!native) return new Store(path, options);
    let lease: NativePrivateSqliteLease | undefined;
    let opened: Store | undefined;
    try {
      if (!existsSync(path)) {
        // Admission precedes both protected directory and empty main-file
        // creation. CREATE_NEW remains authoritative about collisions.
        options.beforeOpen?.(0);
        if (existsSync(directory)) native.inspectDirectory(directory);
        else native.createDirectory(directory);
        native.writeNew(path, new Uint8Array(), 0);
      } else native.inspectDirectory(directory);
      if (!native.acquireSqliteLease) throw new Error("Native workspace SQLite lease is required");
      const identity = native.inspectFileIdentity(path);
      lease = native.acquireSqliteLease(path, identity);
      lease.assertHeld();
      opened = new Store(path, {...persistence, ...options, nativeLease: lease});
      lease.assertHeld();
      return opened;
    } catch (error) {
      if (storeInitializationRetainsNativeLease(error)) throw error;
      if (opened || lease) {
        try {if (opened) opened.close(); else lease!.close();}
        catch (cleanup) {
          // Keep a partially opened Store as well as its protector. Its close
          // may have failed while SQLite was still open; outer startup must
          // not release the workspace owner or product factories around it.
          retainStartupProtector(lease!, [error, cleanup], undefined, opened);
        }
      }
      throw error;
    }
  };
  try {
    const store = open({
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
    const store = open({ readOnly: true });
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
