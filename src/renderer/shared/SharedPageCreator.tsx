import { useRef, useState } from "react";
import type { SharedRuntimeAPI } from "../../shared/shared-runtime-ipc";
import type { Scope, Receipt } from "../../collaboration/runtime/contract";

export function SharedPageCreator({
  api,
  generation,
  orgId,
  workspaceId,
  onCreated,
}: {
  api: SharedRuntimeAPI;
  generation: number;
  orgId: string;
  workspaceId: string;
  onCreated: (scope: Scope) => void;
}) {
  const [title, setTitle] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const active = useRef(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (active.current) return;
        active.current = true;
        setBusy(true);
        setMessage("");
        const scope = {
          orgId,
          workspaceId,
          documentId: crypto.randomUUID(),
          incarnationId: crypto.randomUUID(),
        };
        void api
          .request<Receipt>({
            type: "resource",
            generation,
            scope,
            command: {
              kind: "resource",
              action: "document.create",
              payload: {
                title,
                document: {
                  type: "doc",
                  content: [
                    { type: "paragraph", attrs: { id: crypto.randomUUID() } },
                  ],
                },
              },
            },
          })
          .then((receipt) => {
            if (receipt.status === "SERVER_ACCEPTED") {
              setTitle("");
              onCreated(scope);
            } else setMessage(receipt.status + " / " + receipt.code);
          })
          .catch((error) =>
            setMessage(String(error) + "　受付状態を確認してください。"),
          )
          .finally(() => {
            active.current = false;
            setBusy(false);
          });
      }}
    >
      <label>
        新しい共有ページ名
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={500}
        />
      </label>
      <button disabled={busy || !title.trim()}>
        このワークスペースにページを作成
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
