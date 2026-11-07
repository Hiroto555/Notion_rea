import { writePendingJournalFile } from "../persistence/pending-journal-file";
import type { WorkspaceConflictCandidateSnapshot, WorkspaceConflictCandidateTarget } from "../shared/workspace-conflict-view";
import { hashCheckpoint, parseCheckpoint, requireCondition } from "../sync/protocol";
import { validateWorkspaceCheckpoint } from "../sync/workspace-checkpoint";

/** Export only the selected checkpoint JSON. Attachment bytes are not included. */
export function exportConflictCheckpoint(destination: string, candidate: WorkspaceConflictCandidateSnapshot,
  checkDestination: (path: string) => void): string {
  requireCondition(candidate.checkpointJson !== null && candidate.checkpointHash !== null,
    "conflict-head-empty", 409);
  const content = candidate.checkpointJson;
  const expectedHash = candidate.checkpointHash;
  const validate = (text: string) => {
    const checkpoint = parseCheckpoint(JSON.parse(text));
    requireCondition(validateWorkspaceCheckpoint(checkpoint) && hashCheckpoint(checkpoint) === expectedHash,
      "conflict-candidate-hash-mismatch", 409);
  };
  return writePendingJournalFile(destination, content, {validate, checkDestination}).path;
}

/** Re-read the exact candidate after the asynchronous picker and recheck the
 * originating renderer before any external file is created. */
export async function exportConflictAfterPicker(options: {
  target: WorkspaceConflictCandidateTarget;
  candidate: (target: WorkspaceConflictCandidateTarget) => WorkspaceConflictCandidateSnapshot;
  pick: () => Promise<string | null>;
  authorized: () => boolean;
  save: (path: string, candidate: WorkspaceConflictCandidateSnapshot) => string;
}): Promise<string | null> {
  const before = options.candidate(options.target);
  requireCondition(before.checkpointJson !== null, "conflict-head-empty", 409);
  const path = await options.pick();
  if (!path) return null;
  requireCondition(options.authorized(), "unauthorized", 403);
  const candidate = options.candidate(options.target);
  return options.save(path, candidate);
}
