export type ServerAssetRequirement = Readonly<{ workspaceId: string; sha256: string; bytes: number }>;
export type ServerHistoryInventory = {
  serverEpoch: string;
  workspaces: { workspaceId: string; ownerId: string; revision: number; checkpointHash: string | null }[];
  changes: number; operations: number; devices: number; activeDevices: number; revokedDevices: number;
  assets: ServerAssetRequirement[];
};
export type ServerFullBackupManifest = {
  format: "folio-server-full/v1"; createdAt: string; serverEpoch: string;
  database: { path: "server.sqlite"; bytes: number; sha256: string };
  assets: (ServerAssetRequirement & { path: string })[];
  workspaces: ServerHistoryInventory["workspaces"];
  counts: Pick<ServerHistoryInventory, "changes" | "operations" | "devices" | "activeDevices" | "revokedDevices">;
};
export const SERVER_FULL_MARKER = "FOLIO-SERVER-FULL-INCOMPLETE";
export const SERVER_FULL_MANIFEST = "full-manifest.json";
