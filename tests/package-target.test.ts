import { describe, expect, it } from "vitest";
import {
  PackageTargetError,
  planPackage,
  validateArtifactEvidence,
  type ArtifactEvidenceInput,
  type PackagePlanInput,
} from "../scripts/platform/package-target.mjs";

const HASH = "a".repeat(64);

function planInput(
  overrides: Partial<PackagePlanInput> = {},
): PackagePlanInput {
  return {
    platform: "darwin",
    arch: "arm64",
    version: "0.1.0",
    outputRoot: "/tmp/folio-package-out",
    ...overrides,
  };
}

function refusal(input: unknown): PackageTargetError {
  try {
    planPackage(input as PackagePlanInput);
  } catch (error) {
    expect(error).toBeInstanceOf(PackageTargetError);
    return error as PackageTargetError;
  }
  throw new Error("expected planPackage to refuse input");
}

function evidenceRefusal(input: unknown): PackageTargetError {
  try {
    validateArtifactEvidence(input as ArtifactEvidenceInput);
  } catch (error) {
    expect(error).toBeInstanceOf(PackageTargetError);
    return error as PackageTargetError;
  }
  throw new Error("expected validateArtifactEvidence to refuse input");
}

describe("planPackage successful targets", () => {
  it("plans darwin arm64 without executing the packager", () => {
    const input = planInput();
    const plan = planPackage(input);

    expect(plan.schema).toBe("folio.package-target.v1");
    expect(plan.platform).toBe("darwin");
    expect(plan.arch).toBe("arm64");
    expect(plan.appVersion).toBe("0.1.0");
    expect(plan.packagerOptions).toEqual({
      name: "Folio",
      appVersion: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      out: "/tmp/folio-package-out",
      overwrite: false,
      asar: true,
      prune: true,
    });
    expect(plan.artifactName).toBe("Folio-0.1.0-darwin-arm64.zip");
    expect(plan.manifestName).toBe("Folio-0.1.0-darwin-arm64.manifest.json");
    expect(plan.outputDir).toBe("/tmp/folio-package-out/Folio-darwin-arm64");
    expect(plan.artifactPath).toBe(
      "/tmp/folio-package-out/Folio-0.1.0-darwin-arm64.zip",
    );
    expect(plan.manifestPath).toBe(
      "/tmp/folio-package-out/Folio-0.1.0-darwin-arm64.manifest.json",
    );
    expect(plan.artifactBuilt).toBe(false);
    expect(plan.osExecuted).toBe(false);
    expect(plan.signed).toBe(false);
    expect(plan.claims).toEqual({
      artifactBuilt: false,
      osExecuted: false,
      signed: false,
    });
    expect(plan.deterministicBase).toMatch(/^[0-9a-f]{64}$/);
  });

  it("plans both supported win32 architectures", () => {
    for (const arch of ["x64", "arm64"] as const) {
      const plan = planPackage(planInput({ platform: "win32", arch }));
      expect(plan.platform).toBe("win32");
      expect(plan.arch).toBe(arch);
      expect(plan.packagerOptions.platform).toBe("win32");
      expect(plan.packagerOptions.arch).toBe(arch);
      expect(plan.outputDir).toBe(`/tmp/folio-package-out/Folio-win32-${arch}`);
    }
  });

  it("accepts Windows absolute output roots without probing the live OS", () => {
    const plan = planPackage(
      planInput({
        platform: "win32",
        arch: "x64",
        outputRoot: "C:\\build\\folio",
      }),
    );
    expect(plan.outputRoot).toBe("C:\\build\\folio");
    expect(plan.outputDir).toBe("C:\\build\\folio\\Folio-win32-x64");
    expect(plan.packagerOptions.out).toBe("C:\\build\\folio");
  });

  it("keeps every generated path inside the owned output root", () => {
    for (const input of [
      planInput(),
      planInput({ platform: "win32", arch: "arm64" }),
      planInput({ outputRoot: "/tmp/trailing/" }),
    ]) {
      const plan = planPackage(input);
      const separator = plan.outputRoot.includes("\\") ? "\\" : "/";
      const prefix = plan.outputRoot.endsWith(separator)
        ? plan.outputRoot
        : plan.outputRoot + separator;
      expect(plan.outputDir.startsWith(prefix)).toBe(true);
      expect(plan.artifactPath.startsWith(prefix)).toBe(true);
      expect(plan.manifestPath.startsWith(prefix)).toBe(true);
    }
  });

  it("is deterministic and deeply frozen", () => {
    const first = planPackage(planInput());
    const second = planPackage(planInput());
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.packagerOptions)).toBe(true);
    expect(Object.isFrozen(first.claims)).toBe(true);
  });

  it("omits a Windows icon unless the caller explicitly provides one", () => {
    const withoutIcon = planPackage(
      planInput({ platform: "win32", arch: "x64" }),
    );
    expect("icon" in withoutIcon.packagerOptions).toBe(false);

    const withIcon = planPackage(
      planInput({
        platform: "win32",
        arch: "x64",
        icon: "C:\\assets\\folio.ico",
      }),
    );
    expect(withIcon.packagerOptions.icon).toBe("C:\\assets\\folio.ico");
    expect(withIcon.packagerOptions).not.toEqual(withoutIcon.packagerOptions);
    expect(withIcon.deterministicBase).not.toBe(withoutIcon.deterministicBase);
  });
});

describe("planPackage refusals", () => {
  it("refuses unknown platforms and unsupported architecture pairs", () => {
    expect(refusal(planInput({ platform: "linux" })).code).toBe(
      "UNKNOWN_PLATFORM",
    );
    expect(refusal(planInput({ arch: "x64" })).code).toBe("UNSUPPORTED_TARGET");
    expect(refusal(planInput({ platform: "win32", arch: "ia32" })).code).toBe(
      "UNSUPPORTED_TARGET",
    );
  });

  it("refuses missing or non-object inputs", () => {
    expect(refusal(undefined).code).toBe("INVALID_INPUT");
    expect(refusal(null).code).toBe("INVALID_INPUT");
    expect(refusal([]).code).toBe("INVALID_INPUT");
  });

  it("refuses unsafe output roots", () => {
    for (const outputRoot of [
      "",
      "relative/out",
      "/tmp/../escape",
      "/tmp/./out",
      "/tmp//out",
      "/tmp/out\u0000",
      "\\\\server\\share",
    ]) {
      expect(refusal(planInput({ outputRoot })).code).toBe(
        "UNSAFE_OUTPUT_ROOT",
      );
    }
  });

  it("refuses invalid versions", () => {
    for (const version of [
      "",
      "1.2",
      "01.2.3",
      "1.2.3/../../x",
      "1.2.3 beta",
      "1.2.3\n",
      "v1.2.3",
    ]) {
      expect(refusal(planInput({ version })).code).toBe("INVALID_VERSION");
    }
  });

  it("refuses unsafe icon paths instead of probing the filesystem", () => {
    expect(
      refusal(
        planInput({ platform: "win32", arch: "x64", icon: "assets/icon.ico" }),
      ).code,
    ).toBe("UNSAFE_ICON_PATH");
    expect(
      refusal(
        planInput({ platform: "win32", arch: "x64", icon: "/tmp/../icon.ico" }),
      ).code,
    ).toBe("UNSAFE_ICON_PATH");
    expect(
      refusal(
        planInput({ platform: "win32", arch: "x64", icon: "/tmp/icon.icns" }),
      ).code,
    ).toBe("UNSAFE_ICON_PATH");
  });

  it("retains the original input and does not mutate it on failure", () => {
    const input = planInput({ platform: "linux" });
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    const error = refusal(input);
    expect(error.input).toBe(input);
    expect(input).toEqual(snapshot);
  });
});

describe("validateArtifactEvidence", () => {
  const base: ArtifactEvidenceInput = {
    deterministicBase: HASH,
    sourceHashes: ["b".repeat(64)],
    artifactHashes: ["c".repeat(64)],
  };

  it("accepts unbuilt, unexecuted and unsigned evidence", () => {
    const result = validateArtifactEvidence({
      deterministicBase: HASH,
      artifactBuilt: false,
      osExecuted: false,
      signed: false,
    });
    expect(result).toEqual({
      artifactBuilt: false,
      osExecuted: false,
      signed: false,
      deterministicBase: HASH,
      sourceHashes: [],
      artifactHashes: [],
      osObservations: [],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sourceHashes)).toBe(true);
  });

  it("accepts fully evidenced built, observed and signed claims", () => {
    const result = validateArtifactEvidence({
      ...base,
      artifactBuilt: true,
      osExecuted: true,
      signed: true,
      osObservations: [
        { platform: "darwin", arch: "arm64", artifactHash: "c".repeat(64) },
      ],
    });
    expect(result.artifactBuilt).toBe(true);
    expect(result.osExecuted).toBe(true);
    expect(result.signed).toBe(true);
    expect(result.osObservations).toEqual([
      { platform: "darwin", arch: "arm64", artifactHash: "c".repeat(64) },
    ]);
  });

  it("normalizes hexadecimal hashes to lowercase", () => {
    const result = validateArtifactEvidence({
      ...base,
      deterministicBase: "A".repeat(64),
      sourceHashes: ["B".repeat(64)],
      artifactHashes: ["C".repeat(64)],
    });
    expect(result.deterministicBase).toBe(HASH);
    expect(result.sourceHashes).toEqual(["b".repeat(64)]);
    expect(result.artifactHashes).toEqual(["c".repeat(64)]);
  });

  it("rejects malformed hashes", () => {
    expect(
      evidenceRefusal({ ...base, deterministicBase: "a".repeat(63) }).code,
    ).toBe("INVALID_HASH");
    expect(
      evidenceRefusal({ ...base, deterministicBase: "g".repeat(64) }).code,
    ).toBe("INVALID_HASH");
    expect(evidenceRefusal({ ...base, sourceHashes: ["short"] }).code).toBe(
      "INVALID_HASH",
    );
    expect(
      evidenceRefusal({
        ...base,
        artifactHashes: ["c".repeat(64), "c".repeat(64)],
      }).code,
    ).toBe("INVALID_HASH");
  });

  it("rejects built claims without source and artifact hashes", () => {
    expect(
      evidenceRefusal({ deterministicBase: HASH, artifactBuilt: true }).code,
    ).toBe("MISSING_ARTIFACT_EVIDENCE");
    expect(
      evidenceRefusal({
        deterministicBase: HASH,
        artifactBuilt: true,
        sourceHashes: ["b".repeat(64)],
      }).code,
    ).toBe("MISSING_ARTIFACT_EVIDENCE");
  });

  it("rejects OS execution claims without observations or artifact hashes", () => {
    expect(
      evidenceRefusal({
        ...base,
        artifactBuilt: true,
        osExecuted: true,
      }).code,
    ).toBe("MISSING_OS_EVIDENCE");
    expect(
      evidenceRefusal({
        ...base,
        artifactBuilt: true,
        osExecuted: true,
        osObservations: [{ platform: "linux", arch: "x64" }],
      }).code,
    ).toBe("INVALID_OBSERVATION");
    expect(
      evidenceRefusal({
        ...base,
        artifactBuilt: true,
        osExecuted: true,
        osObservations: [
          { platform: "darwin", arch: "arm64", artifactHash: "d".repeat(64) },
        ],
      }).code,
    ).toBe("INVALID_OBSERVATION");
  });

  it("rejects signed claims without a built artifact and hashes", () => {
    expect(evidenceRefusal({ ...base, signed: true }).code).toBe(
      "MISSING_SIGNATURE_EVIDENCE",
    );
    expect(
      evidenceRefusal({
        deterministicBase: HASH,
        artifactBuilt: true,
        sourceHashes: ["b".repeat(64)],
        signed: true,
      }).code,
    ).toBe("MISSING_ARTIFACT_EVIDENCE");
  });

  it("rejects non-boolean claims and non-object evidence", () => {
    expect(evidenceRefusal(undefined).code).toBe("INVALID_EVIDENCE");
    expect(
      evidenceRefusal({ ...base, artifactBuilt: "true" as unknown as boolean })
        .code,
    ).toBe("INVALID_EVIDENCE");
  });
});
