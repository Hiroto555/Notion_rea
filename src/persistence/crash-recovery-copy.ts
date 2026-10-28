import { createHash } from "node:crypto";
import type { Store } from "./store";
import { canonicalOperation } from "../shared/save-contract";
import { assertRecoveryJson, CRASH_RECOVERY_MAX_BYTES } from "../shared/crash-recovery";
import { blankDoc, isDocument, type Doc, type Page } from "../shared/types";

export type RecoveryCopyInput = {title: string; doc?: Doc; sourcePageId?: string; payload: unknown};

/** Explicit fallback: preserve the rendered body plus complete recovery input in
 * a new ordinary Page. Never changes the source or executes retained requests.
 * A stable caller-provided ID makes a lost copy ACK safe to reconcile by retry. */
export function createRecoveryCopy(store: Store, recoveryId: string, input: RecoveryCopyInput): Page {
  if (typeof recoveryId !== "string" || !/^[a-zA-Z0-9:_-]{1,200}$/.test(recoveryId) || !input ||
    typeof input.title !== "string" || input.title.length > 500 ||
    (input.sourcePageId !== undefined && (typeof input.sourcePageId !== "string" || input.sourcePageId.length > 500)) ||
    (input.doc !== undefined && !isDocument(input.doc)) ||
    Object.keys(input).some((key) => !["title", "doc", "sourcePageId", "payload"].includes(key))) throw new Error("Invalid recovery copy");
  assertRecoveryJson(input);
  const canonical = canonicalOperation(input);
  if (Buffer.byteLength(canonical, "utf8") > CRASH_RECOVERY_MAX_BYTES) throw new Error("Recovery copy exceeds limit");
  const fingerprint = createHash("sha256").update(canonical).digest("hex");
  const doc: Doc = {...structuredClone(input.doc ?? blankDoc()), content: [
    ...structuredClone((input.doc ?? blankDoc()).content ?? []),
    {type: "paragraph", content: [{type: "text", text: "復旧入力（元のページは変更していません）"}]},
    {type: "codeBlock", attrs: {language: "json"}, content: [{type: "text", text: JSON.stringify(input.payload, null, 2)}]},
  ]};
  if (!isDocument(doc)) throw new Error("Recovery copy document exceeds supported limits");
  return store.transaction(() => {
    store.db.exec("CREATE TABLE IF NOT EXISTS crash_recovery_copies(recovery_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, page_json TEXT NOT NULL)");
    const prior = store.db.prepare("SELECT fingerprint,page_json FROM crash_recovery_copies WHERE recovery_id=?").get(recoveryId) as {fingerprint: string; page_json: string} | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("Recovery copy ID already belongs to different input");
      return JSON.parse(prior.page_json) as Page;
    }
    const created = store.create(null, "page", input.title);
    const page = store.write({...created, doc,
      ...(input.sourcePageId ? {recoveredFrom: {pageId: input.sourcePageId, recoveredAt: Date.now()}} : {})});
    store.db.prepare("INSERT INTO crash_recovery_copies(recovery_id,fingerprint,page_json) VALUES(?,?,?)")
      .run(recoveryId, fingerprint, JSON.stringify(page));
    return page;
  });
}
