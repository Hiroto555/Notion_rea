export interface ArtifactFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArtifactSnapshot {
  schemaVersion: 1;
  files: ArtifactFile[];
  sha256: string;
}

export interface SnapshotFilesInput {
  root: string;
  paths: readonly string[];
}

export interface VerifySnapshotInput {
  root: string;
  snapshot: ArtifactSnapshot;
}

export function snapshotFiles(input: SnapshotFilesInput): ArtifactSnapshot;
export function verifySnapshot(input: VerifySnapshotInput): ArtifactSnapshot;
