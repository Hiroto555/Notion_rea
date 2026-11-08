export type BlobTransferScope = Readonly<{
  baseUrlHash: string;
  workspaceId: string;
  clientId: string;
  bindingId: string;
  serverEpoch: string;
}>;
export type BlobTransferDescriptor = Readonly<{
  direction: "download" | "upload";
  assetId: string;
  sha256: string;
  bytes: number;
}>;
export type BlobTransferRecord = BlobTransferDescriptor &
  Readonly<{
    key: string;
    scopeHash: string;
    partialName: string;
    offset: number;
    prefixHash: string;
    state: "active" | "completed" | "blocked";
    reason: string | null;
    updatedAt: number;
  }>;
export type BlobTransferLimits = Readonly<{
  maxEntries: number;
  maxBytes: number;
}>;
