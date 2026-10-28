import { useEffect, useState } from "react";
import type { DatabaseProjection, DatabaseCallbacks } from "../shared/types";
import { DatabasePresentation } from "../database/DatabasePresentation";

/** Transitional viewer for registered databases: no rows or settings writes. */
export function RecordDatabaseReadOnly({
  databasePageId,
  onOpenRecord,
}: {
  databasePageId: string;
  onOpenRecord: (pageId: string) => void;
}) {
  const [projection, setProjection] = useState<DatabaseProjection | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setProjection(null);
    setError("");
    void window.folio
      .request<DatabaseProjection>({ type: "database:load", databasePageId })
      .then((result) => {
        if (cancelled) return;
        if (
          result.records.some(
            (record) => record.databasePageId !== databasePageId,
          )
        )
          throw new Error("データベースの所属を確認できません。");
        setProjection(result);
      })
      .catch((failure: unknown) => {
        if (!cancelled)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [databasePageId]);

  const unavailable = async (): Promise<never> => {
    throw new Error("レコードと設定の編集は準備中です。");
  };
  const callbacks: DatabaseCallbacks = {
    openRecord: onOpenRecord,
    createRecord: unavailable,
    patchRecord: unavailable,
    trashRecord: unavailable,
    restoreRecord: unavailable,
    duplicateRecord: unavailable,
    updateSettings: unavailable,
  };
  return (
    <section aria-label="レコード一覧">
      <p>レコード一覧は読み取り専用です。</p>
      {error && <p role="alert">{error}</p>}
      {!projection ? (
        !error && <p role="status">読み込み中…</p>
      ) : (
        <DatabasePresentation
          databasePageId={databasePageId}
          value={projection}
          callbacks={callbacks}
          readOnly
        />
      )}
    </section>
  );
}
