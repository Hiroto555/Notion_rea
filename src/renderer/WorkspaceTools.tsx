import { useState, type ReactNode } from "react";
import type { StorageReadPort } from "../shared/app-api";
import { closeDetailsOnEscape } from "./details-keyboard";
import {
  StoragePressurePanel,
  type StoragePressureObservation,
} from "./StoragePressurePanel";
import { WorkspaceMaintenancePanel } from "./WorkspaceMaintenancePanel";

/** The single "保存と復旧" entry point: one always-mounted native disclosure.
 * Closing it only hides the children visually, so running maintenance state,
 * views and drafts survive a closed panel, hidden sidebar, closed inspector,
 * page selection or a record side/full view. The panels themselves are
 * unchanged and keep their existing ports and guards.
 *
 * A blocked/unknown/observation-error result would otherwise become
 * invisible while the disclosure is closed, so the panel mirrors its retained
 * observation into the summary. The chip is display-only: it is not a save
 * authorization, a success proof, and showing it causes no extra reads.
 * `conflictRecovery` lets the caller keep its existing rescue surface mounted
 * here — reachable through the same entry point while a record is open. */
export function WorkspaceTools({
  storage,
  onRepairOrder,
  conflictRecovery,
  markdownExport,
}: {
  storage: StorageReadPort;
  onRepairOrder?: () => void;
  conflictRecovery?: ReactNode;
  markdownExport?: ReactNode;
}) {
  const [pressure, setPressure] = useState<StoragePressureObservation>();
  const pressureLabel =
    pressure === "blocked"
      ? "空き容量が不足"
      : pressure === "unknown" || pressure === "error"
        ? "空き容量を確認"
        : undefined;
  return (
    <details className="workspace-tools" onKeyDown={closeDetailsOnEscape}>
      <summary className="workspace-tools-summary">
        保存と復旧
        {pressureLabel && (
          <span className="workspace-tools-alert" data-pressure={pressure}>
            {pressureLabel}
          </span>
        )}
      </summary>
      <div className="workspace-tools-body">
        <StoragePressurePanel storage={storage} onObservation={setPressure} />
        <WorkspaceMaintenancePanel onRepairOrder={onRepairOrder} />
        {markdownExport}
        {conflictRecovery}
      </div>
    </details>
  );
}
