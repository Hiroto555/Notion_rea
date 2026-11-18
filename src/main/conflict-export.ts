import { writePendingJournalFileV3 } from "../persistence/pending-journal-file-v3";
import type { PrivateFileV2Port } from "../platform/private-file-v2";
import type { PrivateFileV3Port } from "../platform/windows/private-recovery-io";
import type { WorkspaceConflictCandidateSnapshot, WorkspaceConflictCandidateTarget } from "../shared/workspace-conflict-view";
import { hashCheckpoint, parseCheckpoint, requireCondition } from "../sync/protocol";
import { validateWorkspaceCheckpoint } from "../sync/workspace-checkpoint";

/** Export only the selected checkpoint JSON. Attachment bytes are not included. */
export function exportConflictCheckpoint(destination: string, candidate: WorkspaceConflictCandidateSnapshot,
  checkDestination: (path: string) => void, privateFilePort?: PrivateFileV2Port | PrivateFileV3Port): string {
  requireCondition(candidate.checkpointJson !== null && candidate.checkpointHash !== null,
    "conflict-head-empty", 409);
  const content = candidate.checkpointJson;
  const expectedHash = candidate.checkpointHash;
  const validate = (text: string) => {
    const checkpoint = parseCheckpoint(JSON.parse(text));
    requireCondition(validateWorkspaceCheckpoint(checkpoint) && hashCheckpoint(checkpoint) === expectedHash,
      "conflict-candidate-hash-mismatch", 409);
  };
  return writePendingJournalFileV3(destination, content, {validate, checkDestination,
    ...(privateFilePort?.contractVersion === 3 ? {privateFilePortV3: privateFilePort} : {privateFilePortV2: privateFilePort})}).path;
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
