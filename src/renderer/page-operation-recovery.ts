import {
  describePageOperation,
  type PageOperation,
} from "../shared/page-operation";
import {
  validateCrashRecoverySnapshot,
  type CrashRecoverySnapshot,
} from "../shared/crash-recovery";
import type { SaveTransport } from "./reliable-save";
import {
  resolvePageOperation,
  retryPageOperation,
} from "./page-operation-coordinator";

export type PageOperationRecoveryReport = {
  /** Receipts already proved applied; no second commit was sent. */
  resolvedApplied: number;
  /** Unknown results committed with the exact retained operation. */
  committed: number;
  /** Still unknown after the explicit retry; the input is retained. */
  retainedUnknown: number;
  /** Terminal rejections reported without being converted into success. */
  rejected: number;
};

/**
 * Explicit, user-triggered retry of page create/duplicate operations retained
 * in a crash checkpoint. Each operation is first resolved with its exact
 * retained identity; only an unknown result is re-sent with the same
 * operationId/sessionId/seq and payload. Applied operations are never
 * committed again, and rejected operations are reported with their reason
 * instead of being discarded or treated as success.
 *
 * Startup recovery must call this only after an explicit user choice. Other
 * recovery lanes (save/database/property/migration) are deliberately not
 * retried here.
 */
export async function retryUnconfirmedPageOperations(
  input: CrashRecoverySnapshot,
  api: SaveTransport,
  timeoutMs?: number,
): Promise<PageOperationRecoveryReport> {
  const snapshot = validateCrashRecoverySnapshot(input);
  const report: PageOperationRecoveryReport = {
    resolvedApplied: 0,
    committed: 0,
    retainedUnknown: 0,
    rejected: 0,
  };
  const problems: string[] = [];
  for (const operation of snapshot.pageOperations ?? []) {
    const resolved = await resolvePageOperation(operation, api, timeoutMs);
    if (resolved.status === "applied") {
      report.resolvedApplied++;
      continue;
    }
    if (resolved.status === "rejected") {
      report.rejected++;
      problems.push(rejection(operation, resolved.message));
      continue;
    }
    const committed = await retryPageOperation(operation, api, timeoutMs);
    if (committed.status === "applied") {
      report.committed++;
      continue;
    }
    if (committed.status === "rejected") {
      report.rejected++;
      problems.push(rejection(operation, committed.message));
      continue;
    }
    report.retainedUnknown++;
    problems.push(
      `${describePageOperation(operation)}: ${
        committed.message || "作成結果を確認できません。"
      }`,
    );
  }
  if (problems.length)
    throw new Error(
      "ページ操作の結果を確認できませんでした。入力を保持しています。 " +
        problems.join(" / "),
    );
  return report;
}

function rejection(operation: PageOperation, message?: string): string {
  return `${describePageOperation(operation)}: ${
    message || "ページ操作は拒否されました。"
  }`;
}
