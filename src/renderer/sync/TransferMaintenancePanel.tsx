import { useState } from "react";
import type { JSX } from "react";
import type {
  TransferMaintenanceEntry,
  TransferMaintenanceView,
  TransferReleasePlanView,
  TransferReleaseResult,
} from "../../shared/sync-management";

export const TRANSFER_GENERIC_ERROR =
  "The transfer operation could not be completed. Please try again.";

export function transferErrorMessage(_error: unknown): string {
  return TRANSFER_GENERIC_ERROR;
}

export function formatTransferBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1024;
    unit += 1;
  } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled.toFixed(1)} ${units[unit]}`;
}

export function transferReleaseConfirmation(entry: TransferMaintenanceEntry) {
  return {
    entryId: entry.entryId,
    assetId: entry.assetId ?? "None",
    scopeHash: entry.scopeHash,
    currentScope: entry.currentScope,
    scopeLabel: entry.currentScope ? "Current scope" : "Old scope",
    bytes: entry.bytes,
    bytesLabel: `${entry.bytes} bytes (${formatTransferBytes(entry.bytes)})`,
    cacheNotice: "Incomplete cache will be re-downloaded.",
  };
}

export type TransferMaintenancePanelProps = {
  view: TransferMaintenanceView;
  busy: boolean;
  onRefresh: (cursor?: string) => Promise<void>;
  onPlan: (entryId: string) => Promise<TransferReleasePlanView>;
  onRelease: (operationId: string) => Promise<TransferReleaseResult>;
  onResolve: (operationId: string) => Promise<TransferReleaseResult>;
};

type Pending = "refresh" | "plan" | "release" | "resolve" | null;
type Notice = { kind: "released" | "held" | "unknown" | "error"; text: string } | null;
type UnknownRelease = { operationId: string; entry: TransferMaintenanceEntry };

export function TransferMaintenancePanel({
  view,
  busy,
  onRefresh,
  onPlan,
  onRelease,
  onResolve,
}: TransferMaintenancePanelProps): JSX.Element {
  const [pending, setPending] = useState<Pending>(null);
  const [confirmation, setConfirmation] = useState<TransferReleasePlanView | null>(null);
  const [unknown, setUnknown] = useState<UnknownRelease | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const isBusy = busy || pending !== null;
  const releaseLocked = unknown !== null;
  const nextCursor = view.nextCursor;
  const confirm = confirmation ? transferReleaseConfirmation(confirmation.entry) : null;

  const refresh = async (cursor?: string) => {
    setPending("refresh");
    setNotice(null);
    try {
      await onRefresh(cursor);
    } catch (error) {
      setNotice({ kind: "error", text: transferErrorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const plan = async (entryId: string) => {
    setPending("plan");
    setNotice(null);
    try {
      const result = await onPlan(entryId);
      setConfirmation(result);
    } catch (error) {
      setNotice({ kind: "error", text: transferErrorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const release = async () => {
    if (!confirmation || releaseLocked) return;
    const operationId = confirmation.operationId;
    setPending("release");
    setNotice(null);
    try {
      const result = await onRelease(operationId);
      if (result.outcome === "outcome-unknown") {
        setUnknown({ operationId, entry: confirmation.entry });
        setNotice({
          kind: "unknown",
          text: `Release outcome is unknown for operation ${operationId}. Keep this operation ID and query the result before starting another release.`,
        });
      } else if (result.outcome === "held") {
        setNotice({
          kind: "held",
          text: `Release held for operation ${operationId}: ${result.reason ?? "no reason supplied"}. Keep the entry; no bytes were released.`,
        });
      } else {
        setNotice({
          kind: "released",
          text: `Released ${result.releasedBytes} bytes (${formatTransferBytes(result.releasedBytes)}) for operation ${operationId}.`,
        });
      }
      setConfirmation(null);
    } catch (error) {
      setNotice({ kind: "error", text: transferErrorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const resolve = async () => {
    if (!unknown) return;
    const operationId = unknown.operationId;
    setPending("resolve");
    setNotice(null);
    try {
      const result = await onResolve(operationId);
      if (result.outcome === "outcome-unknown") {
        setNotice({
          kind: "unknown",
          text: `Release outcome is still unknown for operation ${operationId}. Keep this operation ID and query again.`,
        });
      } else {
        setUnknown(null);
        if (result.outcome === "released") {
          setNotice({
            kind: "released",
            text: `Released ${result.releasedBytes} bytes (${formatTransferBytes(result.releasedBytes)}) for operation ${operationId}.`,
          });
        } else {
          setNotice({
            kind: "held",
            text: `Release held for operation ${operationId}: ${result.reason ?? "no reason supplied"}. Keep the entry; no bytes were released.`,
          });
        }
      }
    } catch (error) {
      setNotice({ kind: "error", text: transferErrorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby="transfer-maintenance-title" aria-busy={isBusy}>
      <h2 id="transfer-maintenance-title">Transfer maintenance</h2>

      <dl>
        <div>
          <dt>Retained bytes</dt>
          <dd>
            {view.usedBytes} bytes ({formatTransferBytes(view.usedBytes)})
          </dd>
        </div>
        <div>
          <dt>Over limit</dt>
          <dd>{view.overLimit ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{view.held ?? "No"}</dd>
        </div>
      </dl>

      <div>
        <button type="button" onClick={() => refresh()} disabled={isBusy}>
          Refresh
        </button>
        {nextCursor ? (
          <button
            type="button"
            onClick={() => refresh(nextCursor)}
            disabled={isBusy}
            data-cursor={nextCursor}
          >
            Load more
          </button>
        ) : null}
        {view.held ? <p>Refresh is available while maintenance is held: {view.held}</p> : null}
      </div>

      {isBusy ? <p role="status">Working...</p> : null}

      {unknown ? (
        <section aria-labelledby="transfer-unknown-title">
          <h3 id="transfer-unknown-title">Release outcome unknown</h3>
          <p>
            Keep this operation ID: <code>{unknown.operationId}</code>. No new release can start
            until the result is resolved.
          </p>
          <p>
            Entry <code>{unknown.entry.entryId}</code>, asset{" "}
            <code>{unknown.entry.assetId ?? "None"}</code>, scope{" "}
            <code>{unknown.entry.scopeHash}</code>.
          </p>
          <button type="button" onClick={resolve} disabled={isBusy}>
            Query result
          </button>
        </section>
      ) : null}

      {notice ? (
        <p role={notice.kind === "error" ? "alert" : "status"} aria-live="polite">
          {notice.text}
        </p>
      ) : null}

      {confirm && confirmation ? (
        <section aria-labelledby="transfer-confirm-title">
          <h3 id="transfer-confirm-title">Confirm release (dry run)</h3>
          <p>
            Only this exact entry will be released. Paths and blanket deletion are not accepted.
          </p>
          <p>{confirm.cacheNotice}</p>
          <dl>
            <div>
              <dt>Entry ID</dt>
              <dd>{confirm.entryId}</dd>
            </div>
            <div>
              <dt>Asset ID</dt>
              <dd>{confirm.assetId}</dd>
            </div>
            <div>
              <dt>Scope</dt>
              <dd>{confirm.scopeHash}</dd>
            </div>
            <div>
              <dt>Scope state</dt>
              <dd>{confirm.scopeLabel}</dd>
            </div>
            <div>
              <dt>Retained bytes</dt>
              <dd>{confirm.bytesLabel}</dd>
            </div>
          </dl>
          <p>
            Opaque operation ID: <code>{confirmation.operationId}</code>
          </p>
          <button type="button" onClick={release} disabled={isBusy || releaseLocked}>
            Confirm release
          </button>
          <button type="button" onClick={() => setConfirmation(null)} disabled={isBusy}>
            Cancel
          </button>
        </section>
      ) : null}

      <table>
        <caption>Transfer maintenance entries</caption>
        <thead>
          <tr>
            <th scope="col">Entry</th>
            <th scope="col">Asset</th>
            <th scope="col">Scope</th>
            <th scope="col">State</th>
            <th scope="col">Retained bytes</th>
            <th scope="col">Reason</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {view.entries.map((entry) => (
            <tr
              key={entry.entryId}
              data-entry-id={entry.entryId}
              data-state={entry.state}
              data-scope={entry.currentScope ? "current" : "old"}
            >
              <th scope="row">{entry.entryId}</th>
              <td>{entry.assetId ?? "None"}</td>
              <td>
                {entry.currentScope ? "Current scope" : "Old scope"}{" "}
                <code>{entry.scopeHash}</code>
              </td>
              <td>{entry.state}</td>
              <td>
                {entry.bytes} bytes ({formatTransferBytes(entry.bytes)})
              </td>
              <td>{entry.reason ?? "No reason supplied"}</td>
              <td>
                {entry.canRelease ? (
                  <button
                    type="button"
                    onClick={() => plan(entry.entryId)}
                    disabled={isBusy || releaseLocked}
                    aria-label={`Preview release for ${entry.entryId}`}
                  >
                    Preview release
                  </button>
                ) : (
                  <span>Keep this entry. Release is unavailable.</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.entries.length === 0 ? <p>No transfer entries.</p> : null}
    </section>
  );
}

export default TransferMaintenancePanel;
