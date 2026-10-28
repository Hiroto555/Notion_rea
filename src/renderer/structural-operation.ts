import { operationFingerprint } from "../shared/save-contract";
import type { LegacyMigrationOperation, LegacyMigrationResult } from "../shared/legacy-migration-operation";
import type { PropertyOperation, PropertyOperationResult } from "../shared/property-operation";

export type StructuralOperation = {family: "migration"; operation: LegacyMigrationOperation} |
  {family: "property"; operation: PropertyOperation};
export type StructuralResult = LegacyMigrationResult | PropertyOperationResult;

/** The ACK only authorizes a fresh reload; never install its arbitrary contents.
 * resolve=true is lookup-only, including receipt absence and transport failure.
 * The caller must durably retain the exact operation before its first exchange. */
export async function exchangeStructural(entry: StructuralOperation, resolve = false,
  timeoutMs = 30_000): Promise<StructuralResult> {
  const op = entry.operation, fingerprint = await operationFingerprint(op);
  const owner = entry.family === "migration" ? entry.operation.databasePageId : entry.operation.command.databasePageId;
  const revision = entry.family === "migration" ? entry.operation.revision : entry.operation.command.revision;
  const unknown = (message: string): StructuralResult => ({status: "unknown", operationId: op.operationId,
    sessionId: op.sessionId, seq: op.seq, databasePageId: owner, fingerprint, message});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = entry.family === "migration"
      ? {type: resolve ? "migration:resolve" as const : "migration:commit" as const, operation: entry.operation}
      : {type: resolve ? "property:resolve" as const : "property:commit" as const, operation: entry.operation};
    const result = await Promise.race([
      window.folio.request<StructuralResult>(request),
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error("結果確認がタイムアウトしました。")), timeoutMs);}),
    ]);
    if (!result || result.operationId !== op.operationId || result.sessionId !== op.sessionId ||
      result.seq !== op.seq || result.fingerprint !== fingerprint || result.databasePageId !== owner ||
      !["applied", "rejected", "unknown"].includes(result.status)) return unknown("操作と保存結果が一致しません。");
    if (result.status === "applied" && (!result.page || !result.database ||
      result.page.id !== owner || result.page.kind !== "database" || result.page.deletedAt !== null ||
      result.page.documentError || result.page.revision !== revision + 1 ||
      result.database.revision !== result.page.revision || !result.page.database || result.page.database.rows.length ||
      result.database.records.some(row => row.databasePageId !== owner))) return unknown("保存結果の所属とrevisionを確認できません。");
    return result;
  } catch (error) {return unknown(error instanceof Error ? error.message : String(error));}
  finally {if (timer) clearTimeout(timer);}
}
