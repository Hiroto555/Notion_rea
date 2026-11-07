import type { Request } from "../shared/types";
import type {
  ArchivePage,
  ArchiveTarget,
  RecoveryActionResult,
  RecoveryPanelPort,
  RecoveryRequestContext,
} from "../shared/conflict-recovery";
import { targetIdentityMatches } from "./conflict-recovery-model";

export function recoveryResultConfirmed(
  context: RecoveryRequestContext,
  result: RecoveryActionResult | null,
): boolean {
  if (!result || result.kind === "outcome-unknown") return false;
  if (result.kind === "cancelled") return true;
  if (context.directory && result.directory !== context.directory) return false;
  if (result.kind === "blocked")
    return (
      ![
        "recovery-operation-pending",
        "recovery-operation-not-found",
        "previous-recovery-result-unconfirmed",
      ].includes(result.reason) &&
      (!result.target || targetIdentityMatches(context.target, result.target))
    );
  return (
    result.checkpointHash === context.target.checkpointHash &&
    result.kind === (context.mode === "restore" ? "restored" : context.mode)
  );
}

/** Keep the request independently of the mounted panel. A lost RPC response
 * never releases its ID or permits a second effect before a status response. */
export function createConflictRecoveryPort(
  request: <T>(value: Request) => Promise<T>,
  newId: () => string = () => crypto.randomUUID(),
): RecoveryPanelPort {
  let current:
    { context: RecoveryRequestContext; unresolved: boolean } | undefined;
  function observe(
    entry: { context: RecoveryRequestContext; unresolved: boolean },
    result: RecoveryActionResult | null,
  ): void {
    if (
      result?.kind === "outcome-unknown" &&
      targetIdentityMatches(entry.context.target, result.target) &&
      (!entry.context.directory || entry.context.directory === result.directory)
    )
      entry.context.directory = result.directory;
    if (recoveryResultConfirmed(entry.context, result))
      entry.unresolved = false;
  }
  function run(
    target: ArchiveTarget,
    mode: RecoveryRequestContext["mode"],
  ): Promise<RecoveryActionResult> {
    if (current?.unresolved)
      return Promise.reject(new Error("recovery-request-unconfirmed"));
    const entry = {
      context: { operationId: newId(), target: structuredClone(target), mode },
      unresolved: true,
    };
    current = entry;
    const value: Request =
      mode === "restore"
        ? {
            type: "recovery:restore",
            target: entry.context.target,
            operationId: entry.context.operationId,
          }
        : {
            type: "recovery:export",
            target: entry.context.target,
            mode,
            operationId: entry.context.operationId,
          };
    return Promise.resolve()
      .then(() => request<RecoveryActionResult>(value))
      .then((result) => {
        observe(entry, result);
        return result;
      });
  }
  return {
    list: (cursor) => request<ArchivePage>({ type: "recovery:list", cursor }),
    currentRequest: () => (current ? structuredClone(current.context) : null),
    export: (target, mode) => run(target, mode),
    restore: (target) => run(target, "restore"),
    status: () => {
      const entry = current;
      return request<RecoveryActionResult | null>({
        type: "recovery:status",
        operationId: entry?.context.operationId,
      }).then((result) => {
        if (entry) observe(entry, result);
        return result;
      });
    },
  };
}
export const conflictRecoveryPort = createConflictRecoveryPort((value) =>
  window.folio.request(value),
);
