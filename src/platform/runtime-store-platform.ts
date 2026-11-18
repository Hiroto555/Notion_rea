/** OS-specific filesystem boundary. Injected contract results are not OS acceptance.
 * A Windows held wrapper acquires its native authority hold inside the first
 * successful `assertDatabase`/`createExclusiveDurably`, before any SQLite
 * open, and releases it only inside `close` after owned SQLite cleanup. */
export interface RuntimeStorePlatform {
  bind(directory: string): string;
  assertRoot(): void;
  assertDatabase(path: string): void;
  /** Native exclusive create/open plus an explicit empty-file proof. Windows
   * initialization must never fall back to Node's POSIX mode argument. */
  createExclusiveDurably?(path: string): void;
  assertEmptyFile?(path: string): void;
  syncCreatedDatabase(path: string): void;
  /** Semantic validation of a hot journal uses a private native snapshot. */
  withHotJournalSnapshot?(path: string, callback: (snapshotPath: string) => void): void;
  close(): void;
}
