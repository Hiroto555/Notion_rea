import type { RestartRequestResult } from "./workspace-sync-restart-request";

// Main-only diagnostic; never sent over IPC. Keep the original close cause
// while quit is held, without accumulating an unbounded failure history.
let retainedCloseFailure: unknown;
export function workspaceQuitCloseFailure(): unknown {return retainedCloseFailure;}

/** Called from Electron's will-quit, after normal window close/unload. A
 * prepared restart that cannot be safely committed keeps the process alive;
 * the caller reopens a window so the user can inspect or cancel it. */
export function finishWorkspaceQuit(options: {
  commitRestart?: () => RestartRequestResult;
  preventQuit: () => void;
  reopenWindow: () => void;
  closeStore: () => void;
}): "quit" | "held" {
  let outcome: RestartRequestResult;
  try { outcome = options.commitRestart?.() ?? "not-prepared"; }
  catch { outcome = "blocked"; }
  if (outcome !== "not-prepared" && outcome !== "committed") {
    options.preventQuit();
    try { options.reopenWindow(); } catch { /* Quit stays prevented on failure. */ }
    return "held";
  }
  try {options.closeStore();}
  catch (error) {
    retainedCloseFailure = error;
    // A failed SQLite close has not authorized the accepted-quit listeners
    // to tear down its owner/helper graph. Keep the process and its leases.
    options.preventQuit();
    try {options.reopenWindow();} catch { /* Quit remains prevented. */ }
    return "held";
  }
  retainedCloseFailure = undefined;
  return "quit";
}

/** The non-vetoable quit event occurs only after every will-quit decision. */
export function registerAcceptedQuitCleanup(lifecycle: {once(event: "quit", listener: () => void): unknown}, cleanup: () => void): void {
  lifecycle.once("quit", cleanup);
}
