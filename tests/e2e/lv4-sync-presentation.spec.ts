import { test, expect } from "./next-round-fixture";

// Presentation-only fixtures. These do not establish network, native dialog,
// restart, or data-preservation behavior; those need separate acceptance.
test("shows bounded conflict excerpts and explains what is excluded", async ({folio}) => {
  await folio.app.evaluate(({ipcMain}) => {
    const ipc = ipcMain as any;
    const original = ipc._invokeHandlers.get("folio:request");
    const page = (title: string, text: string) => JSON.stringify({payload: {tables: {pages: [["page-1", JSON.stringify({
      id: "page-1", title, deletedAt: null, doc: {type: "doc", content: [{type: "paragraph", content: [{type: "text", text}]}]},
    })], ["record-1", JSON.stringify({id: "record-1", title: "レコード", deletedAt: null, doc: {type: "doc"}})]],
      record_memberships: [["record-1", "database-1", 0, JSON.stringify({status: text})]]}}});
    const local = {side: "local", revision: 1, checkpointHash: "a".repeat(64), pages: 1, assets: 0, bytes: 10};
    const remote = {side: "remote", revision: 2, checkpointHash: "b".repeat(64), pages: 1, assets: 0, bytes: 10};
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, req: any) => {
      if (req.type === "sync:status") return {available: true, connection: "connected", running: false, lastSuccessAt: null, lastError: null,
        workspace: {receivedCursor: 2, appliedRevision: 1, generation: 2, cleanGeneration: 1, pending: false, conflict: true}};
      if (req.type === "sync:restartStatus") return {available: false};
      if (req.type === "sync:conflict") return {available: true, archives: [], archiveCount: 0,
        conflict: {operationId: "conflict-1", localGeneration: 1, local, remote,
          status: {receivedCursor: 2, appliedRevision: 1, generation: 2, cleanGeneration: 1, pending: false}}};
      if (req.type === "sync:conflictCandidate") return {operationId: "conflict-1", side: req.side,
        revision: req.expectedRevision, checkpointHash: req.expectedCheckpointHash, bytes: 10,
        checkpointJson: req.side === "local" ? page("ローカル題名", "ローカル本文") : page("リモート題名", "リモート本文")};
      return original(event, req);
    });
  });
  await folio.window.reload();
  await folio.window.getByRole("button", {name: "競合候補"}).click();
  const panel = folio.window.getByRole("region", {name: "同期競合の候補"});
  await expect(panel).toContainText("競合後に保存したローカル編集");
  await panel.getByRole("button", {name: "ページを比較"}).click();
  await expect(panel).toContainText("ローカル本文");
  await expect(panel).toContainText("リモート本文");
  await expect(panel).toContainText("添付本体・DBレコード・履歴の比較は含みません");
  await expect(panel).toContainText("最大50件");
  await panel.getByRole("button", {name: "移行済みDBレコードを比較"}).click();
  await expect(panel).toContainText("変更のある移行済みレコード 1 件");
  await expect(panel).toContainText("旧形式のDB行・DB設定・本文・履歴・添付本体は含みません");
});

test("shows restart reservation and cancellation as provisional", async ({folio}) => {
  await folio.app.evaluate(({ipcMain}) => {
    const ipc = ipcMain as any;
    const original = ipc._invokeHandlers.get("folio:request");
    let requested = false;
    const reservationId = "00000000-0000-4000-8000-000000000001";
    const view = () => ({available: true, state: requested ? "requested" : "idle", scheduled: false,
      targetRevision: 3, reservationId: requested ? reservationId : undefined, canRequest: !requested, canCancel: requested, reason: null});
    ipc.removeHandler("folio:request");
    ipc.handle("folio:request", async (event: any, req: any) => {
      if (req.type === "sync:status") return {available: true, connection: "connected", running: false, lastSuccessAt: null, lastError: null,
        workspace: {receivedCursor: 3, appliedRevision: 2, generation: 1, cleanGeneration: 1, pending: false, conflict: false}};
      if (req.type === "sync:restartStatus") return view();
      if (req.type === "sync:restartRequest") {requested = true; return {result: "prepared", view: view()};}
      if (req.type === "sync:restartCancel") {if (req.reservationId !== reservationId) throw new Error("fixture reservation ID changed"); requested = false; return {result: "cancelled", view: view()};}
      return original(event, req);
    });
  });
  await folio.window.reload();
  await folio.window.getByRole("button", {name: "適用を予約"}).click();
  await expect(folio.window.getByText("終了時に安全条件を確認して予約を確定します。")).toBeVisible();
  await folio.window.getByRole("button", {name: "予約を取り消す", exact: true}).click();
  await expect(folio.window.getByText("予約を取り消しました。")).toBeVisible();
});
