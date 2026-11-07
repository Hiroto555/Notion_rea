export function assertLinuxGuiCi(options?: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): void;
export function assertCiDataRoot(
  root: string | undefined,
  runnerTemp: string | undefined,
): void;
export function isolatedGuiEnv(
  env: NodeJS.ProcessEnv,
  dataRoot: string,
): Record<string, string>;
