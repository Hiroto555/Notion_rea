export type PackagePlatform = "darwin" | "win32";
export type PackageArch = "arm64" | "x64";

export interface PackagePlanInput {
  platform: PackagePlatform | string;
  arch: PackageArch | string;
  version: string;
  outputRoot: string;
  icon?: string;
}

export interface PackageClaims {
  readonly artifactBuilt: false;
  readonly osExecuted: false;
  readonly signed: false;
}

export interface PackagerOptions {
  readonly name: "Folio";
  readonly appVersion: string;
  readonly platform: PackagePlatform;
  readonly arch: PackageArch;
  readonly out: string;
  readonly overwrite: false;
  readonly asar: true;
  readonly prune: true;
  readonly icon?: string;
}

export interface PackagePlan {
  readonly schema: "folio.package-target.v1";
  readonly platform: PackagePlatform;
  readonly arch: PackageArch;
  readonly appVersion: string;
  readonly outputRoot: string;
  readonly outputDir: string;
  readonly artifactName: string;
  readonly artifactPath: string;
  readonly manifestName: string;
  readonly manifestPath: string;
  readonly deterministicBase: string;
  readonly packagerOptions: PackagerOptions;
  readonly claims: PackageClaims;
  readonly artifactBuilt: false;
  readonly osExecuted: false;
  readonly signed: false;
}

export interface OsObservationInput {
  platform: PackagePlatform | string;
  arch: PackageArch | string;
  artifactHash?: string;
}

export interface OsObservation {
  readonly platform: PackagePlatform;
  readonly arch: PackageArch;
  readonly artifactHash?: string;
}

export interface ArtifactEvidenceInput {
  artifactBuilt?: boolean;
  osExecuted?: boolean;
  signed?: boolean;
  deterministicBase: string;
  sourceHashes?: readonly string[];
  artifactHashes?: readonly string[];
  osObservations?: readonly OsObservationInput[];
}

export interface ValidatedArtifactEvidence {
  readonly artifactBuilt: boolean;
  readonly osExecuted: boolean;
  readonly signed: boolean;
  readonly deterministicBase: string;
  readonly sourceHashes: readonly string[];
  readonly artifactHashes: readonly string[];
  readonly osObservations: readonly OsObservation[];
}

export declare class PackageTargetError extends Error {
  readonly code: string;
  readonly input: unknown;
  constructor(code: string, message: string, input?: unknown);
}

export declare function planPackage(input: PackagePlanInput): PackagePlan;
export declare function validateArtifactEvidence(input: ArtifactEvidenceInput): ValidatedArtifactEvidence;
