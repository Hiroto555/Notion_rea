import { useState } from "react";
import type {
  ManagedGrowthLimits,
  WorkspaceLimitView,
} from "../shared/storage-overview";
import type { Request } from "../shared/types";

const MiB = 1024 ** 2;
const fields = [
  ["maxDatabaseBytes", "DB", MiB, "MiB"],
  ["maxAssetBytes", "添付", MiB, "MiB"],
  ["maxBackupBytes", "バックアップ", MiB, "MiB"],
  ["maxReceiptRows", "保存記録", 1, "件"],
] as const;
function call<T>(request: Request): Promise<T> {
  return window.folio.request(request) as Promise<T>;
}

export function WorkspaceLimitsPanel({
  disabled,
  onApplied,
}: {
  disabled: boolean;
  onApplied: () => void;
}) {
  const [view, setView] = useState<WorkspaceLimitView>();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  function display(result: WorkspaceLimitView) {
    setView(result);
    setDraft(
      Object.fromEntries(
        fields.map(([key, , scale]) => [
          key,
          result.configured[key] === undefined
            ? ""
            : String(result.configured[key]! / scale),
        ]),
      ),
    );
  }
  async function load() {
    setBusy(true);
    setMessage("");
    try {
      display(await call<WorkspaceLimitView>({ type: "storage:readLimits" }));
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "上限を読み込めませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!view || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const configured: ManagedGrowthLimits = {};
      for (const [key, label, scale, unit] of fields) {
        const value = draft[key]?.trim() ?? "";
        if (!value) continue;
        const limit = Number(value) * scale;
        if (
          !/^\d+(?:\.\d+)?$/.test(value) ||
          !Number.isSafeInteger(limit) ||
          limit < 0
        )
          throw new Error(
            label + "の上限を0以上の" + unit + "で指定してください。",
          );
        configured[key] = limit;
      }
      const result = await call<WorkspaceLimitView>({
        type: "storage:applyLimits",
        expectedRevision: view.revision,
        configured,
      });
      display(result);
      onApplied();
      setMessage("上限を保存しました。");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "上限を保存できませんでした。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => void load()}
      >
        {view ? "保存済みの上限を再読込" : "使用量の上限を設定"}
      </button>
      {view && (
        <fieldset disabled={disabled || busy}>
          <legend>このワークスペースの上限</legend>
          {fields.map(([key, label, scale, unit]) => (
            <label key={key}>
              {label}（{unit}）
              <input
                type="text"
                inputMode="decimal"
                aria-label={label + "の上限（" + unit + "）"}
                value={draft[key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
              {view.effective[key] !== undefined && (
                <small>
                  {" "}
                  現在の有効値 {view.effective[key]! / scale} {unit}
                </small>
              )}
            </label>
          ))}
          <p>
            空欄で個別設定を解除します。管理者上限がある場合は小さい方が適用されます。DBは設定値に達した後、次の保存を停止します。
          </p>
          <button type="button" onClick={() => void apply()}>
            上限を保存
          </button>
          <button
            type="button"
            onClick={() => {
              setView(undefined);
              setMessage("");
            }}
          >
            閉じる
          </button>
        </fieldset>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
