import type { DatabaseSync } from "node:sqlite";
export interface StoragePort {
  readonly db: DatabaseSync;
  transaction<T>(work: () => T): T;
  get(namespace: string, key: string): unknown | null;
  set(namespace: string, key: string, value: unknown | null): void;
  all(namespace: string): { key: string; value: unknown }[];
  blobGet(scope: string, hash: string): Uint8Array | null;
  blobPut(scope: string, hash: string, bytes: Uint8Array): void;
  blobDelete(scope: string, hash: string): void;
  close(): void;
}
