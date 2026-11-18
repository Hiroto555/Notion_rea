import type { PreparedRestoreHandoff } from "./windows-maintenance-selection";

/** Structural minimum a relaunched child must satisfy; Electron-free so tests
 * inject a fake EventEmitter child and never reach a real OS spawn. */
export type RestoredWorkspaceChild = {
  once(event: string, listener: (error?: unknown) => void): unknown;
  unref(): void;
};
export type RestoredWorkspaceSpawn = (
  executable: string,
  args: readonly string[],
  options: {env: NodeJS.ProcessEnv; detached: boolean; stdio: "ignore"},
) => RestoredWorkspaceChild;
export type RestoredWorkspaceLaunchConfig = {
  directory: string;
  handoff?: PreparedRestoreHandoff;
  parentEnv: NodeJS.ProcessEnv;
  executable: string;
  args: readonly string[];
  spawn: RestoredWorkspaceSpawn;
  markStarted?: () => void;
};

/** Detached relaunch of a verified restored workspace. The handoff builds the
 * child environment and re-checks currency BEFORE filtering: every sync,
 * enrollment, output-parent and development variable is removed folded so the
 * child can never inherit private channel state. markStarted runs immediately
 * before the injected spawn — the single dispatch observation point. A
 * throwing unref rejects rather than leaking an uncaught listener failure;
 * the started fact is already recorded by then. */
export function launchRestoredWorkspace(config: RestoredWorkspaceLaunchConfig): Promise<void> {
  return new Promise<void>((resolveLaunch, reject) => {
    const env: NodeJS.ProcessEnv = config.handoff ?
      config.handoff.childEnvironment(config.parentEnv) :
      {...config.parentEnv, FOLIO_DATA_DIR: config.directory};
    config.handoff?.assertCurrent();
    delete env.FOLIO_DEV_URL;
    delete env.FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES;
    delete env.FOLIO_WINDOWS_OUTPUT_PARENT;
    for (const key of Object.keys(env)) {
      const folded = key.toUpperCase();
      if (folded.startsWith("FOLIO_SYNC_") ||
          ["FOLIO_DEV_URL", "FOLIO_WINDOWS_ENROLL_EXISTING_SOURCES", "FOLIO_WINDOWS_OUTPUT_PARENT"].includes(folded))
        delete env[key];
    }
    config.markStarted?.();
    const child = config.spawn(config.executable, config.args, {env, detached: true, stdio: "ignore"});
    child.once("error", reject);
    child.once("spawn", () => {
      try {child.unref();} catch (error) {reject(error); return;}
      resolveLaunch();
    });
  });
}
