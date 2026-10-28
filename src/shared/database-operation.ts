import type { z } from "zod";
import { emptyDatabase, type databaseOperationSchema, type DatabaseProjection, type DatabaseSettings, type Page, type RecordProjection } from "./types";

export type DatabaseOperation = z.infer<typeof databaseOperationSchema>;
export type DatabaseOperationResult = {
  status: "applied" | "rejected" | "unknown";
  operationId: string;
  sessionId: string;
  seq: number;
  fingerprint: string;
  commandKind: DatabaseOperation["command"]["kind"];
  /** Created DB/record Page, or the updated owner Page. */
  page?: Page;
  record?: RecordProjection;
  database?: DatabaseProjection;
  message?: string;
};
export type DatabaseReadSnapshot = {page: Page; database: DatabaseProjection};

/** Prepare once per explicit create action. Retain this operation while the
 * outcome is unknown; only query it, never generate another ID to retry. */
export function prepareDatabaseCreation(title: string, parentId: string | null = null,
  settings?: DatabaseSettings): DatabaseOperation {
  const {rows: _rows, ...defaults} = emptyDatabase();
  return {operationId: crypto.randomUUID(), sessionId: crypto.randomUUID(), seq: 1,
    command: {kind: "createDatabase", title, parentId, settings: structuredClone(settings ?? defaults)}};
}
