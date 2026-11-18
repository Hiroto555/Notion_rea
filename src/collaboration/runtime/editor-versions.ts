import { canonical } from "./canonical";
import { checkedState } from "./document";
import { digest } from "./digest";
import { clone, demand, sameScope, scopeKey, type Scope, type Cut, type DocumentState, type RuntimeEvent } from "./contract";
import type { StoragePort } from "./storage-port";
import { readRetentionCheckpoint } from "./retention";

/** Content addressed, root-bound materializations. Cuts carry no self hash cycle. */
export function rememberEditorVersions(store: StoragePort, cut: Cut): void {
  for (const row of store.all("documents")) {
    const state = checkedState(row.value as DocumentState), hash = digest(state);
    const prefix = row.key + ":" + cut.epoch + ":";
    const versions = store.all("editor.versions").filter(v => v.key.startsWith(prefix));
    const latest = versions.sort((a,b) => a.key.localeCompare(b.key)).at(-1);
    if (latest?.value === hash) continue;
    store.set("editor.states", hash, state);
    store.set("editor.versions", prefix + String(cut.seq).padStart(16, "0"), hash);
  }
}

export function editorBaseState(store: StoragePort, scope: Scope, cut: Cut, events: RuntimeEvent[]): DocumentState {
  const prefix = scopeKey(scope) + ":" + cut.epoch + ":";
  const versions = store.all("editor.versions").filter(v => v.key.startsWith(prefix) && Number(v.key.slice(prefix.length)) <= cut.seq)
    .sort((a,b) => a.key.localeCompare(b.key));
  const found = versions.at(-1);
  if (found) {
    demand(typeof found.value === "string", "EDITOR_VERSION_CORRUPT");
    const state = store.get("editor.states", found.value);
    demand(state && digest(state) === found.value, "EDITOR_VERSION_CORRUPT");
    return checkedState(state as DocumentState);
  }
  // Existing 1003 realms have a verified event chain and checkpoint, but no
  // version index. Never substitute an unrooted history row or client JSON.
  const checkpoint = readRetentionCheckpoint(store);
  let state: DocumentState | null = null;
  if (checkpoint?.body.cut.epoch === cut.epoch && checkpoint.body.cut.seq <= cut.seq)
    state = checkpoint.body.scopes.find(s => sameScope(s.scope, scope))?.state ?? null;
  for (const event of events) {
    if (event.epoch === cut.epoch && event.seq <= cut.seq && sameScope(event.scope, scope) && event.state && event.receipt.status === "SERVER_ACCEPTED")
      state = event.state;
  }
  demand(state, "EDITOR_BASE_UNAVAILABLE");
  canonical(state);
  return checkedState(clone(state));
}
