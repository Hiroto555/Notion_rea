export type KeychainIsolation = "private-temporary-keychain" | "unknown";

export type KeychainReadinessStatus = "READY_FOR_OS_PROBE" | "INFRA_BLOCKED";

export type KeychainReadinessReason =
  | "INVALID_INPUT"
  | "PLATFORM_NOT_DARWIN"
  | "ISOLATION_NOT_PRIVATE"
  | "EFFECTIVE_MOCK_SWITCH"
  | "ARGV_MOCK_SWITCH"
  | "EXPECTED_PATH_HASH_INVALID"
  | "ACCESS_NOT_OBSERVED"
  | "ACCESSED_PATH_HASH_MISSING"
  | "ACCESSED_PATH_HASH_INVALID"
  | "ACCESSED_PATH_MISMATCH"
  | "ITEM_IDENTITY_HASH_MISSING"
  | "ITEM_IDENTITY_HASH_INVALID"
  | "CONTROL_NOT_OBSERVED";

export interface KeychainReadinessInput {
  platform: string;
  effectiveSwitches: readonly string[];
  argv: readonly string[];
  expectedPathSha256: string;
  accessedPathSha256?: string;
  accessObserved: boolean;
  isolation: KeychainIsolation;
  itemIdentitySha256?: string;
  controlObserved: boolean;
}

export interface KeychainReadinessResult {
  status: KeychainReadinessStatus;
  reasons: KeychainReadinessReason[];
  productResult: "NOT_RUN";
}

export const WARM_CACHE_CAVEAT: string;
export const MOCK_KEYCHAIN_SWITCH: string;

export function containsMockKeychainSwitch(values: readonly string[]): boolean;

export function assessKeychainReadiness(
  input: unknown,
): KeychainReadinessResult;
