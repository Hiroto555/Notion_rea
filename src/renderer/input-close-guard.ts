export type InputCloseState = {
  composing: boolean;
  backupBusy: boolean;
  pendingSaves: number;
  retainedEdits: number;
  unsavedSessions: boolean;
  numberDrafts: boolean;
  databasePending: boolean;
  retainedPageOperations: boolean;
  restoringPages: number;
  structuralOperation: boolean;
  recoverySaved: boolean;
  captureError: boolean;
};
/** Shared by the unload veto and conflict preview/confirm readiness. */
export function inputReadyToClose(state: InputCloseState): boolean {
  return (
    !state.composing &&
    !state.backupBusy &&
    state.pendingSaves === 0 &&
    state.retainedEdits === 0 &&
    !state.unsavedSessions &&
    !state.numberDrafts &&
    !state.databasePending &&
    !state.retainedPageOperations &&
    state.restoringPages === 0 &&
    !state.structuralOperation &&
    state.recoverySaved &&
    !state.captureError
  );
}
