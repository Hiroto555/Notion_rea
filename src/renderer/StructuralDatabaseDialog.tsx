import { useEffect, useRef, useState } from "react";
import type { Page } from "../shared/types";
import type { DatabaseReadSnapshot } from "../shared/database-operation";
import { prepareLegacyMigration, type LegacyMigrationPreview, type LegacyMigrationResult } from "../shared/legacy-migration-operation";
import { preparePropertyOperation, type PropertyChange, type PropertyPreviewResult } from "../shared/property-operation";
import { PropertySchemaPanel } from "./PropertySchemaPanel";
import type { PropertySchemaDraft } from "./property-schema-draft";
import { LegacyMigrationDialog } from "./LegacyMigrationDialog";
import { DialogFrame } from "./Modal";
import { exchangeStructural, type StructuralOperation, type StructuralResult } from "./structural-operation";
import { validateOwnerPage } from "./settings-save-coordinator";
import "./r6-structural.css";

export function StructuralDatabaseDialog({family, owner, onClose, retain, onApplied}: {
  family: "property" | "migration"; owner: Page; onClose: () => void;
  retain: (operation: StructuralOperation | null) => Promise<void>;
  onApplied: () => Promise<void>;
}) {
  const [state, setState] = useState<"idle"|"previewing"|"ready"|"saving"|"unknown"|"rejected"|"applied">("idle");
  const [migration, setMigration] = useState<LegacyMigrationPreview>();
  const [property, setProperty] = useState<PropertyPreviewResult>();
  const [draft, setDraft] = useState<PropertySchemaDraft | null>(null);
  const [result, setResult] = useState<StructuralResult>();
  const [error, setError] = useState("");
  const [currentOwner, setCurrentOwner] = useState(owner);
  const [retentionBlocked, setRetentionBlocked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const operation = useRef<StructuralOperation | undefined>(undefined);
  // Entering exchange makes the send outcome uncertain. From then on this
  // identity is lookup-only, even if no receipt is found after restart.
  const sent = useRef(false);
  const applied = useRef(false);
  const busy = useRef(false);
  async function preview(change?: PropertyChange) {
    if (busy.current || operation.current) return;
    busy.current = true; setError(""); setState("previewing");
    setProperty(undefined); setMigration(undefined);
    try {
      if (family === "migration") setMigration(await window.folio.request<LegacyMigrationPreview>({type: "migration:preview", databasePageId: owner.id}));
      else if (change) {
        // A user-requested preview observes a fresh baseline. It does not
        // install into App's existing edit lanes or apply the requested change.
        const fresh = await window.folio.request<DatabaseReadSnapshot>({type: "database:read", databasePageId: owner.id});
        validateOwnerPage(fresh.page, owner.id, fresh.database.revision, fresh.database.settings);
        if (fresh.database.records.some((record) => record.databasePageId !== owner.id))
          throw new Error("所属が一致しないためプレビューを停止しました。");
        setCurrentOwner(fresh.page);
        setProperty(await window.folio.request<PropertyPreviewResult>({type: "property:preview", databasePageId: owner.id, revision: fresh.page.revision, change}));
      }
      setState("ready");
    } catch (error) {setError(String(error)); setState("rejected");}
    finally {busy.current = false;}
  }
  useEffect(() => {if (family === "migration") void preview();}, []);
  async function finishApplied() {
    setRefreshing(true); setError("");
    try {
      // App checks every lane, clears its durable journal and then reloads.
      // Keep this operation until that transition has been accepted by App.
      await onApplied();
      operation.current = undefined;
    } catch (error) {setError(String(error));}
    finally {setRefreshing(false); setState("applied");}
  }
  async function retryReload() {
    if (busy.current || !applied.current) return;
    busy.current = true;
    try {await finishApplied();} finally {busy.current = false;}
  }
  async function send(resolve: boolean) {
    if (busy.current || applied.current || (sent.current && !resolve)) return;
    busy.current = true; setState("saving"); setError("");
    try {
      if (!operation.current) {
        operation.current = family === "migration"
          ? {family, operation: prepareLegacyMigration(migration!)}
          : {family, operation: preparePropertyOperation(property!.command!)};
      }
      try {
        await retain(operation.current);
        setRetentionBlocked(false);
      } catch (error) {
        // Nothing has been sent on this mount. Preserve the prepared identity,
        // retry only durable retention, then perform its first send once.
        setRetentionBlocked(!sent.current);
        throw error;
      }
      const lookupOnly = sent.current;
      sent.current = true;
      const value = await exchangeStructural(operation.current, lookupOnly);
      setResult(value); setError(value.message ?? "");
      if (value.status === "applied") {
        applied.current = true;
        setState("applied");
        await finishApplied();
      } else if (value.status === "rejected") {
        await retain(null); operation.current = undefined; sent.current = false;
        setState("rejected");
      } else setState("unknown");
    } catch (error) {
      setError(String(error));
      setState(applied.current ? "applied" : operation.current ? "unknown" : "rejected");
    }
    finally {busy.current = false;}
  }
  const locked = state === "saving" || state === "unknown" || state === "applied" || !!operation.current;
  const close = () => {if (!busy.current && !locked) onClose();};
  if (retentionBlocked || state === "applied") return <DialogFrame modal
    name={family === "migration" ? "旧形式データベースを移行" : "列の設定"}
    className={family === "migration" ? "legacy-migration-dialog" : "r6-schema-dialog"} onClose={() => {}}>
    <header><h2>{family === "migration" ? "旧形式データベースを移行" : "列の設定"}</h2></header>
    {retentionBlocked ? <>
      <p>操作を送信する前の復旧用保存に失敗しました。入力と同じ操作IDを保持しています。</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={state === "saving"} onClick={() => void send(false)}>復旧用保存を再試行</button>
    </> : <>
      <p role="status">変更は適用済みです。画面の更新が完了するまで編集を停止しています。</p>
      {error && <p role="alert">{error}</p>}
      {family === "migration" && (result as LegacyMigrationResult | undefined)?.snapshotPath &&
        <p>移行前コピー: {(result as LegacyMigrationResult).snapshotPath}</p>}
      <button type="button" disabled={refreshing} onClick={() => void retryReload()}>画面を再読み込み</button>
    </>}
  </DialogFrame>;
  if (family === "migration") return <LegacyMigrationDialog databaseTitle={owner.title}
    state={state === "previewing" || state === "idle" ? "loading" : state === "ready" ? "preview" : state}
    preview={migration} result={result as LegacyMigrationResult | undefined} error={error} closeBlocked={locked}
    onPreview={() => void preview()} onApply={() => void send(false)} onResolve={() => void send(true)} onClose={close} />;
  const {rows: _rows, ...settings} = currentOwner.database!;
  return <DialogFrame modal name="列の設定" className="r6-schema-dialog" onClose={close}>
    <header><h2>列の設定</h2><button type="button" disabled={locked || state === "previewing"} onClick={close} aria-label="列の設定を閉じる">閉じる</button></header>
    <PropertySchemaPanel settings={settings} draft={draft} preview={property} status={state} error={error}
      onDraftChange={(value) => {if (!locked) {setDraft(value); setProperty(undefined); setError(""); setState("idle");}}}
      onPreview={(change) => void preview(change)} onApply={() => void send(false)} onResolve={() => void send(true)} />
  </DialogFrame>;
}
