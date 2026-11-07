import type { PageOrderRepairResult } from "../shared/page-order-repair";
import type { Request } from "../shared/types";

export type PageOrderRepairAttempt =
  | PageOrderRepairResult
  | {
      status: "not-sent" | "unknown";
      message: string;
    };

/** A failed preflight is safe to dismiss. A lost reply requires reloading
 * saved state before editing because repair may have changed revisions. */
export async function sendPageOrderRepair(
  sourceFingerprint: string,
  prepare: () => Promise<void>,
  send: (
    request: Extract<Request, { type: "pageOrder:apply" }>,
  ) => Promise<PageOrderRepairResult>,
): Promise<PageOrderRepairAttempt> {
  try {
    await prepare();
  } catch (error) {
    return {
      status: "not-sent",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const result = await send({ type: "pageOrder:apply", sourceFingerprint });
    if (
      result?.sourceFingerprint === sourceFingerprint &&
      (result.status === "applied" || result.status === "rejected")
    )
      return result;
  } catch {
    // Never replay a repair automatically after an uncertain response.
  }
  return {
    status: "unknown",
    message:
      "修復結果を確認できません。表示を読み直して並び順を確認してください。",
  };
}
