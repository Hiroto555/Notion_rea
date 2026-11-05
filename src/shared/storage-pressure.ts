/**
 * Free-disk safety margin shared by the main-process checker and its callers.
 *
 * This is a pre-write guard, not a workspace quota, a garbage collector or a
 * guarantee against physical disk failure. `reserveBytes` is headroom kept
 * free; it does not bound the size of an entire operation.
 */

export type StoragePressureSnapshot = {
  state: "ready" | "blocked" | "unknown";
  checkedAt: string;
  availableBytes: number | null;
  reserveBytes: number;
  additionalBytes: number;
  /** Fixed code (`capacity-exceeded` / `capacity-unknown`), never a path or
   * exception text. Omitted when the state is ready. */
  reason?: string;
};

export const DEFAULT_STORAGE_RESERVE_BYTES = 256 * 1024 * 1024;
