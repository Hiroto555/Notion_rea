export type SaveStateDetailRow = {
  /** Stable identity within one render. */
  id: string;
  /** The save target this row belongs to (本文/レコード/データベース設定/復旧用保存/…). */
  target: string;
  /** What the row is about: page or record title, held input count, checkpoint. */
  label: string;
  /** The original state string from its owner (coordinator, queue or App). */
  state: string;
  /** An already-bounded diagnostic or short note passed in by App; never derived here. */
  detail?: string;
};

const stateLabels: Record<string, string> = {
  saved: "保存済み",
  saving: "保存中…",
  pending: "保存待ち",
  conflict: "競合を保持",
  unknown: "結果を確認",
  blocked: "保存を停止",
  rejected: "拒否を保持",
  uncheckpointed: "復旧記録待ち",
  error: "エラー",
  none: "対象なし",
};

/** Controlled, display-only view of the per-target save state App already
 * owns. Rows are precomputed from the original Page/DB operation maps,
 * session lanes and the recovery checkpoint status; this component keeps no
 * state and never saves, clears or sends anything itself. */
export function SaveStateDetails({rows}: {rows: readonly SaveStateDetailRow[]}) {
  return (
    <div className="save-state-panel" role="group" aria-label="保存対象ごとの状態">
      <ul className="save-state-targets">
        {rows.map((row) => (
          <li
            key={row.id}
            className="save-state-target"
            data-target={row.target}
            data-state={row.state}
          >
            <span className="save-state-target-head">
              <span className="save-state-target-name">{row.target}</span>
              <span className="save-state-target-label">{row.label}</span>
            </span>
            <span className="save-state-target-state">{stateLabels[row.state] ?? row.state}</span>
            {row.detail ? <span className="save-state-target-detail">{row.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
