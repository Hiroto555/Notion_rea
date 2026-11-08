export type RemoteH1Options = {
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
};

export type MacSandbox = {
  root: string;
  data: string;
  vault: string;
  evidence: string;
};

export type RemoteH1Plan = {
  caseIds: string[];
  provenance: { artifactSha256: string };
  tempParent: string;
  [key: string]: unknown;
};

export type RemoteH1Preparation = {
  plan: RemoteH1Plan;
  sandbox: MacSandbox;
  artifactPath: string;
  electron: { args: string[]; env: Record<string, string> };
};

export function assertRemoteH1Selection<T extends { caseIds?: unknown }>(
  plan: T,
): T;

export function canonicalWorkspaceRoot(workspaceRoot: string): string;

export function validateRemoteH1Artifact(
  workspaceRoot: string,
  expectedSha256: string,
): { artifactPath: string; sha256: string };

export function remoteH1Environment(
  env: NodeJS.ProcessEnv | undefined,
  sandbox: MacSandbox,
): Record<string, string>;

export function prepareRemoteH1(
  planInput: unknown,
  options?: RemoteH1Options,
): RemoteH1Preparation;
