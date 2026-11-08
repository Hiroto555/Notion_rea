export type OwnedProcessOutcome =
  | "COMPLETED"
  | "PROCESS_FAILED"
  | "TIMED_OUT"
  | "ABORTED"
  | "SPAWN_FAILED"
  | "OUTPUT_LIMIT"
  | "DESCENDANTS_LEFT"
  | "CLEANUP_FAILED";

export type OwnedProcessPhase = "ready" | "blocking" | "descendant-ready";

export interface OwnedProcessOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  outputParent: string;
  /** Must come from the live host guard for remote use; defaults to OS temp. */
  temporaryParent?: string;
  timeoutMs?: number;
  graceMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  observationKind?: "NODE_SYNTHETIC" | "MAC_REMOTE";
  binding?: Readonly<Record<string, unknown>>;
}

export interface OwnedProcessResult {
  schemaVersion: 1;
  observationKind: "NODE_SYNTHETIC" | "MAC_REMOTE";
  productResult: "NOT_RUN";
  runId: string;
  binding: Readonly<Record<string, unknown>> | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timeoutMs: number;
  graceMs: number;
  maxOutputBytes: number;
  pid: number | null;
  descendantPid: number | null;
  lastPhase: OwnedProcessPhase | null;
  outcome: OwnedProcessOutcome;
  expired: boolean;
  cleanupConfirmed: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  signals: NodeJS.Signals[];
  disposition: "NOT_RUN" | "UNRESOLVED";
  stdout: { bytes: number; sha256: string };
  stderr: { bytes: number; sha256: string };
  stack: "NOT_COLLECTED";
}

export function superviseOwnedProcess(
  options: OwnedProcessOptions,
): Promise<{ root: string; result: OwnedProcessResult }>;
