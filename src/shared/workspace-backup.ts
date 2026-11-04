/** Full workspace snapshots preserve identities and SQLite history/receipts.
 * They are distinct from portable recovery bundles that remap content IDs. */
export type BackupFile = { path: string; bytes: number; sha256: string };
export type WorkspaceInventory = {
  pages: number; recordDatabases: number; records: number; versions: number;
  settings: number; saveReceipts: number; registeredAssets: number;
};
export type SnapshotInspection = {
  storeVersion: number; inventory: WorkspaceInventory;
  logicalSha256: string; assets: BackupFile[];
};
export type WorkspaceBackupManifest = SnapshotInspection & {
  format: "folio-workspace-backup"; version: 1; createdAt: string;
  database: BackupFile;
};
export type VerifiedWorkspaceBackup = {
  directory: string; manifest: WorkspaceBackupManifest; fingerprint: string;
};
export type RestoredWorkspace = {
  directory: string; sourceFingerprint: string; manifest: WorkspaceBackupManifest;
};
export type BackupPreview = {
  ticket: string; directory: string; createdAt: string;
  inventory: WorkspaceInventory; bytes: number;
};
export type BackupRestored = BackupPreview & { sourceDirectory: string };
