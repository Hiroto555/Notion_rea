import type { UsageState } from "./storage-usage";

export type ManagedGrowthLimits = {
  maxDatabaseBytes?: number;
  maxAssetBytes?: number;
  maxBackupBytes?: number;
  maxReceiptRows?: number;
};
export type AssetRegistryObservation = {
  state: "complete" | "partial";
  unregisteredFiles: number | null;
  missingFiles: number | null;
};
export type StorageOverview = {
  checkedAt: string;
  state: UsageState;
  totalBytes: number | null;
  databaseBytes: number | null;
  databaseLogicalBytes: number | null;
  assetBytes: number | null;
  syncStagingBytes: number | null;
  backupBytes: number | null;
  receiptRows: number | null;
  receiptBytes: number | null;
  completeBackups: number;
  incompleteBackups: number;
  unknownBackups: number;
  registry: AssetRegistryObservation;
};
export type ManagedStorageOverview = StorageOverview & {
  limits: ManagedGrowthLimits | null;
};
export type ArchiveProposal = { ticket: string; name: string; bytes: number };

export type WorkspaceLimitView = {
  revision: string | null;
  configured: ManagedGrowthLimits;
  effective: ManagedGrowthLimits;
};
