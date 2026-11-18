import { useState } from "react";
import type { Scope, Receipt } from "../../collaboration/runtime/contract";
import type { SharedRuntimeAPI } from "../../shared/shared-runtime-ipc";
export function SharedTrashPanel({api, generation, orgId, workspaceId, writable, disabled, currentScope, onChanged, onClosed}: {
  api: SharedRuntimeAPI; generation: number; orgId: string; workspaceId: string; writable: boolean; disabled: boolean;
  currentScope: Scope | null; onChanged(): void; onClosed(): void;
}) {
  const [entries, setEntries] = useState<{scope: Scope; title: unknown}[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const scope = {orgId, workspaceId, documentId: "__trash", incarnationId: "__trash"};
  const load = () => api.request<typeof entries>({type:"admin",command:{action:"trash",scope}}).then(setEntries);
  async function mutate(target: Scope, restore: boolean) {
    setBusy(true);setError("");
    try {
      const receipt = await api.request<Receipt>({type:"resource",generation,scope:target,command:{kind:"resource",action:restore?"document.restore":"document.trash",payload:restore?{incarnationId:crypto.randomUUID()}:{}}});
      if (receipt.status !== "SERVER_ACCEPTED") throw new Error(receipt.code ?? receipt.status);
      await load();
      if (!restore && currentScope?.documentId === target.documentId) onClosed(); else onChanged();
    } catch (e) {setError(String(e));} finally {setBusy(false);}
  }
  return <details><summary>共有ページのごみ箱</summary><fieldset disabled={disabled || busy}>
    <button onClick={() => void load().catch(e=>setError(String(e)))}>一覧を更新</button>
    {writable && currentScope?.workspaceId === workspaceId && <button onClick={()=>void mutate(currentScope,false)}>開いているページをごみ箱へ</button>}
    {entries.map(entry=><p key={entry.scope.incarnationId}>{typeof entry.title === "string" ? entry.title : "共有ページ"} {writable && <button onClick={()=>void mutate(entry.scope,true)}>新しい世代へ復元</button>}</p>)}
  </fieldset>{error && <p role="alert">{error}</p>}</details>;
}
