import { z } from "zod";
import { sha256 } from "../policy/schema.mjs";

export const WARM_CACHE_CAVEAT =
  "Warm-cache continuation is a caveat, not an availability test.";
export const MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";

const switchList = z.array(z.string().max(4096)).max(256);
const inputSchema = z
  .object({
    platform: z.string().min(1).max(64),
    effectiveSwitches: switchList,
    argv: switchList,
    expectedPathSha256: z.string().min(1).max(128),
    accessedPathSha256: z.string().min(1).max(128).optional(),
    accessObserved: z.boolean(),
    isolation: z.enum(["private-temporary-keychain", "unknown"]),
    itemIdentitySha256: z.string().min(1).max(128).optional(),
    controlObserved: z.boolean(),
  })
  .strict();

const blocked = (reasons) => ({
  status: "INFRA_BLOCKED",
  reasons,
  productResult: "NOT_RUN",
});

const validHash = (value) => sha256.safeParse(value).success;

export function containsMockKeychainSwitch(values) {
  return values.some((value) =>
    value.split(/[\s,]+/).some((part) => {
      const token = part.trim().replace(/^-+/, "");
      const name = token.split("=", 1)[0].toLowerCase();
      return name === MOCK_KEYCHAIN_SWITCH;
    }),
  );
}

export function assessKeychainReadiness(input) {
  try {
    const result = inputSchema.safeParse(input);
    if (!result.success) return blocked(["INVALID_INPUT"]);

    const value = result.data;
    const reasons = [];

    if (value.platform !== "darwin") reasons.push("PLATFORM_NOT_DARWIN");
    if (value.isolation !== "private-temporary-keychain")
      reasons.push("ISOLATION_NOT_PRIVATE");
    if (containsMockKeychainSwitch(value.effectiveSwitches))
      reasons.push("EFFECTIVE_MOCK_SWITCH");
    if (containsMockKeychainSwitch(value.argv))
      reasons.push("ARGV_MOCK_SWITCH");

    const expectedValid = validHash(value.expectedPathSha256);
    if (!expectedValid) reasons.push("EXPECTED_PATH_HASH_INVALID");

    if (!value.accessObserved) reasons.push("ACCESS_NOT_OBSERVED");
    if (value.accessedPathSha256 === undefined)
      reasons.push("ACCESSED_PATH_HASH_MISSING");
    else if (!validHash(value.accessedPathSha256))
      reasons.push("ACCESSED_PATH_HASH_INVALID");
    else if (
      expectedValid &&
      value.accessedPathSha256 !== value.expectedPathSha256
    )
      reasons.push("ACCESSED_PATH_MISMATCH");

    if (value.itemIdentitySha256 === undefined)
      reasons.push("ITEM_IDENTITY_HASH_MISSING");
    else if (!validHash(value.itemIdentitySha256))
      reasons.push("ITEM_IDENTITY_HASH_INVALID");

    if (!value.controlObserved) reasons.push("CONTROL_NOT_OBSERVED");

    return reasons.length
      ? blocked(reasons)
      : {
          status: "READY_FOR_OS_PROBE",
          reasons: [],
          productResult: "NOT_RUN",
        };
  } catch {
    return blocked(["INVALID_INPUT"]);
  }
}
