import { describe, expect, it } from "vitest";
import {
  WARM_CACHE_CAVEAT,
  assessKeychainReadiness,
  containsMockKeychainSwitch,
} from "../../scripts/mac-acceptance/preflight/keychain.mjs";
import type { KeychainReadinessInput } from "../../scripts/mac-acceptance/preflight/keychain.mjs";

const HASH = "a".repeat(64);
const ITEM_HASH = "b".repeat(64);
const SECRET = "synthetic-secret-token-must-not-be-echoed";

function input(
  overrides: Partial<KeychainReadinessInput> = {},
): KeychainReadinessInput {
  return {
    platform: "darwin",
    effectiveSwitches: [],
    argv: [],
    expectedPathSha256: HASH,
    accessedPathSha256: HASH,
    accessObserved: true,
    isolation: "private-temporary-keychain",
    itemIdentitySha256: ITEM_HASH,
    controlObserved: true,
    ...overrides,
  };
}

describe("Keychain readiness preflight (pure metadata only)", () => {
  it("is ready only for a future OS probe, never as product acceptance", () => {
    const result = assessKeychainReadiness(input());
    expect(result).toEqual({
      status: "READY_FOR_OS_PROBE",
      reasons: [],
      productResult: "NOT_RUN",
    });
    expect(Object.keys(result).sort()).toEqual([
      "productResult",
      "reasons",
      "status",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/PASS|E[123]/);
  });

  it.each([
    ["double-dash", ["--use-mock-keychain"]],
    ["name-only", ["use-mock-keychain"]],
    ["equal-value", ["--use-mock-keychain=true"]],
    ["single-dash equal false", ["-use-mock-keychain=false"]],
    ["uppercase", ["--USE-MOCK-KEYCHAIN"]],
    ["mixed argv", ["--remote-debugging-port=0", "--use-mock-keychain"]],
  ])("detects a %s mock switch", (_name, values) => {
    expect(containsMockKeychainSwitch(values)).toBe(true);
    for (const result of [
      assessKeychainReadiness(input({ effectiveSwitches: values })),
      assessKeychainReadiness(input({ argv: values })),
    ])
      expect(result).toMatchObject({
        status: "INFRA_BLOCKED",
        productResult: "NOT_RUN",
      });
  });

  it.each([
    ["non-Darwin platform", { platform: "linux" }, "PLATFORM_NOT_DARWIN"],
    ["unknown isolation", { isolation: "unknown" }, "ISOLATION_NOT_PRIVATE"],
    [
      "effective mock switch",
      { effectiveSwitches: ["--use-mock-keychain"] },
      "EFFECTIVE_MOCK_SWITCH",
    ],
    ["argv mock switch", { argv: ["--use-mock-keychain"] }, "ARGV_MOCK_SWITCH"],
    [
      "invalid expected path hash",
      { expectedPathSha256: "A".repeat(64) },
      "EXPECTED_PATH_HASH_INVALID",
    ],
    [
      "missing accessed path hash",
      { accessedPathSha256: undefined },
      "ACCESSED_PATH_HASH_MISSING",
    ],
    [
      "invalid accessed path hash",
      { accessedPathSha256: "short" },
      "ACCESSED_PATH_HASH_INVALID",
    ],
    [
      "different accessed path",
      { accessedPathSha256: "c".repeat(64) },
      "ACCESSED_PATH_MISMATCH",
    ],
    [
      "absent access observation",
      { accessObserved: false },
      "ACCESS_NOT_OBSERVED",
    ],
    [
      "missing item identity",
      { itemIdentitySha256: undefined },
      "ITEM_IDENTITY_HASH_MISSING",
    ],
    [
      "invalid item identity",
      { itemIdentitySha256: "not-a-hash" },
      "ITEM_IDENTITY_HASH_INVALID",
    ],
    [
      "absent control observation",
      { controlObserved: false },
      "CONTROL_NOT_OBSERVED",
    ],
    [
      "warm/cold cache caveat",
      { controlObserved: false },
      "CONTROL_NOT_OBSERVED",
    ],
  ] as const)("blocks %s", (_name, overrides, reason) => {
    const result = assessKeychainReadiness(input(overrides));
    expect(result.status).toBe("INFRA_BLOCKED");
    expect(result.reasons).toContain(reason);
    expect(result.productResult).toBe("NOT_RUN");
    expect(JSON.stringify(result)).not.toMatch(/PASS|E[123]/);
  });

  it("does not treat an empty argv or absent mock switch as proof", () => {
    expect(containsMockKeychainSwitch([])).toBe(false);
    expect(
      assessKeychainReadiness(
        input({ argv: [], accessObserved: false, controlObserved: false }),
      ),
    ).toMatchObject({
      status: "INFRA_BLOCKED",
      reasons: ["ACCESS_NOT_OBSERVED", "CONTROL_NOT_OBSERVED"],
      productResult: "NOT_RUN",
    });
  });

  it("keeps warm-cache continuation as a caveat, not an availability test", () => {
    const result = assessKeychainReadiness(input({ controlObserved: false }));
    expect(result.status).toBe("INFRA_BLOCKED");
    expect(result.reasons).toContain("CONTROL_NOT_OBSERVED");
    expect(WARM_CACHE_CAVEAT).toMatch(/warm[- ]cache/i);
    expect(WARM_CACHE_CAVEAT).toMatch(/not\b.*\bavailability/i);
    expect(JSON.stringify(result)).not.toMatch(/availability|PASS|E[123]/);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "darwin"],
    ["missing required field", { platform: "darwin" }],
    ["wrong switch type", { ...input(), effectiveSwitches: [1] }],
    ["wrong boolean type", { ...input(), accessObserved: "true" }],
    ["unknown field", { ...input(), rawItem: SECRET }],
    ["token-like field", { ...input(), token: SECRET }],
    ["unknown field with secret key", { ...input(), [SECRET]: true }],
  ])("rejects malformed or unknown input: %s", (_name, value) => {
    const result = assessKeychainReadiness(value);
    expect(result).toEqual({
      status: "INFRA_BLOCKED",
      reasons: ["INVALID_INPUT"],
      productResult: "NOT_RUN",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toMatch(/PASS|E[123]/);
  });

  it("never echoes input hashes, paths, switches or unknown values", () => {
    const result = assessKeychainReadiness(
      input({
        argv: [`--some-secret=${SECRET}`, "--use-mock-keychain"],
        expectedPathSha256: HASH,
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(HASH);
    expect(serialized).not.toContain("--use-mock-keychain");
  });

  it("does not mutate its input", () => {
    const value = input();
    const before = structuredClone(value);
    assessKeychainReadiness(value);
    expect(value).toEqual(before);
  });
});
