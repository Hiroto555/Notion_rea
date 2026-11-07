import type { RestartRequestResult } from "./workspace-sync-restart-request";

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
  options.closeStore();
  return "quit";
}
