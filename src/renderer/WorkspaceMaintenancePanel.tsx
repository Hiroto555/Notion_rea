import { useState, useRef } from "react";
import type {
  ArchiveProposal,
  ManagedStorageOverview,
} from "../shared/storage-overview";
import type { Request } from "../shared/types";
import { WorkspaceLimitsPanel } from "./WorkspaceLimitsPanel";
import { formatBackupBytes } from "./workspace-backup/WorkspaceBackupDialog";

function bytes(n: number | null) {
  return n === null ? "未確認" : formatBackupBytes(n);
}
function call<T>(request: Request): Promise<T> {
  return window.folio.request(request) as Promise<T>;
}

export function WorkspaceMaintenancePanel() {
  const [overview, setOverview] = useState<ManagedStorageOverview>();
  const [baseline, setBaseline] = useState<ManagedStorageOverview>();
  const previous = useRef<ManagedStorageOverview>(undefined);
  const [plan, setPlan] = useState<
    ArchiveProposal & { kind: "backup" | "asset" }
  >();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "操作を完了できませんでした。",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function refresh() {
    setOverview(undefined);
    setBaseline(undefined);
    try {
      const result = await call<ManagedStorageOverview>({
        type: "storage:overview",
      });
      if (result.state === "complete") setBaseline(previous.current);
      previous.current = result.state === "complete" ? result : undefined;
      setOverview(result);
    } catch (error) {
      previous.current = undefined;
      throw error;
    }
  }

  function usage(
    key:
      | "totalBytes"
      | "databaseBytes"
      | "receiptBytes"
      | "assetBytes"
      | "backupBytes",
  ) {
    const current = overview?.[key] ?? null;
    const prior = baseline?.[key] ?? null;
    if (current === null || prior === null) return bytes(current);
    const delta = current - prior;
    const percent =
      prior > 0 ? "、" + ((100 * delta) / prior).toFixed(1) + "%" : "";
    return (
      bytes(current) +
      "（前回比 " +
      (delta < 0 ? "−" : "+") +
      bytes(Math.abs(delta)) +
      percent +
      "）"
    );
  }

  async function selectArchive(kind: "backup" | "asset") {
    setPlan(undefined);
    const next = await call<ArchiveProposal | null>({
      type: kind === "backup" ? "storage:archivePlan" : "storage:orphanPlan",
    });
    if (next) setPlan({ ...next, kind });
  }

  async function move() {
    if (!plan) return;
    const ticket = plan.ticket;
    setPlan(undefined);
    const result = await call<{ destination: string } | null>({
      type:
        plan.kind === "backup" ? "storage:archiveMove" : "storage:orphanMove",
      ticket,
    });
    if (result) {
      setOverview(undefined);
      setMessage("移動先: " + result.destination);
    }
  }

  async function salvage() {
    const result = await call<{ directory: string } | null>({
      type: "storage:rawSalvage",
    });
    if (result) setMessage("救出先: " + result.directory);
  }

  return (
    <section
      className="inspector-section workspace-maintenance"
      aria-label="ワークスペースの保守"
      aria-busy={busy}
    >
      <details>
        <summary>ワークスペースの保守</summary>
        <button type="button" disabled={busy} onClick={() => void run(refresh)}>
          使用量を集計
        </button>
        {overview && (
          <div role="status">
            <p>
              {new Date(overview.checkedAt).toLocaleString("ja-JP")} ·{" "}
              {overview.state === "complete" ? "集計完了" : "一部未計測"}
            </p>
            <dl>
              <dt>管理対象ファイル</dt>
              <dd>{usage("totalBytes")}</dd>
              <dt>DB・サイドカー</dt>
              <dd>{usage("databaseBytes")}</dd>
              <dt>上限判定に使うDB容量</dt>
              <dd>{bytes(overview.databaseLogicalBytes)}</dd>
              <dt>保存記録</dt>
              <dd>
                {overview.receiptRows ?? "未確認"} 件 / {usage("receiptBytes")}
              </dd>
              <dt>添付</dt>
              <dd>{usage("assetBytes")}</dd>
              <dt>添付の照合</dt>
              <dd>
                {overview.registry.state === "complete"
                  ? `台帳にないファイル ${overview.registry.unregisteredFiles} 件、実体がない登録 ${overview.registry.missingFiles} 件`
                  : "未確認"}
              </dd>
              <dt>バックアップ</dt>
              <dd>
                {usage("backupBytes")} · 完成候補 {overview.completeBackups} /
                未完 {overview.incompleteBackups} / 未確認{" "}
                {overview.unknownBackups}
              </dd>
              <dt>設定した上限</dt>
              <dd>
                {!overview.limits
                  ? "設定値を確認してください"
                  : Object.keys(overview.limits).length === 0
                    ? "未設定"
                    : [
                        ["DB", overview.limits.maxDatabaseBytes],
                        ["添付", overview.limits.maxAssetBytes],
                        ["バックアップ", overview.limits.maxBackupBytes],
                        ["保存記録", overview.limits.maxReceiptRows],
                      ]
                        .filter(([, v]) => v !== undefined)
                        .map(
                          ([k, v]) =>
                            k +
                            " " +
                            (k === "保存記録" ? v + " 件" : bytes(v as number)),
                        )
                        .join(" / ")}
              </dd>
            </dl>
          </div>
        )}
        <WorkspaceLimitsPanel
          disabled={busy}
          onApplied={() => setOverview(undefined)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => selectArchive("backup"))}
        >
          退避する古いバックアップを選択
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => selectArchive("asset"))}
        >
          台帳外の補助ファイルを選択
        </button>
        <p>添付URLで開ける名前のファイルは元の場所に保持します。</p>
        {plan && (
          <div>
            <p>
              {plan.name}（{bytes(plan.bytes)}
              ）を同じボリュームのワークスペース外へ移動します。
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(move)}
            >
              移動先を選んで退避
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setPlan(undefined)}
            >
              キャンセル
            </button>
          </div>
        )}
        <button type="button" disabled={busy} onClick={() => void run(salvage)}>
          診断用の原本を救出
        </button>
        <p>
          救出先に、保存済みのDB・添付・復旧記録をまとめます。破損調査用のコピーです。
        </p>
        {message && <p role="status">{message}</p>}
      </details>
    </section>
  );
}
