import { useRef, useState } from "react";
import type {
  SharedRuntimeAPI,
  SharedRuntimeSession,
} from "../../shared/shared-runtime-ipc";
import type { Receipt } from "../../collaboration/runtime/contract";

export function SharedAssetsPanel({
  api,
  session,
  onChanged,
}: {
  api: SharedRuntimeAPI;
  session: SharedRuntimeSession;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [hash, setHash] = useState(""),
    [download, setDownload] = useState(""),
    [imageReady, setImageReady] = useState(false);
  const source = useRef<File | null>(null),
    upload = useRef("");
  async function publish() {
    if (!source.current || !session.scope) return;
    setBusy(true);
    setStatus("");
    try {
      const bytes = new Uint8Array(await source.current.arrayBuffer());
      if (bytes.length > 20_000_000) throw new Error("添付の上限は20MBです。");
      let raw = "";
      for (let i = 0; i < bytes.length; i += 8192)
        raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const staged = await api.request<{ hash: string }>({
        type: "assetStage",
        generation: session.generation,
        uploadId: upload.current,
        base64: btoa(raw),
      });
      setHash(staged.hash);
      const receipt = await api.request<Receipt>({
        type: "resource",
        generation: session.generation,
        scope: session.scope,
        command: {
          kind: "resource",
          action: "asset.publish",
          payload: { uploadId: upload.current, hash: staged.hash },
        },
      });
      setStatus(
        receipt.status === "SERVER_ACCEPTED"
          ? "添付を公開しました。"
          : receipt.status + " / " + receipt.code,
      );
      onChanged();
    } catch (e) {
      setStatus(
        String(e) +
          "　元のファイルは変更していません。受付状態を確認してください。",
      );
    } finally {
      setBusy(false);
    }
  }
  async function read() {
    setBusy(true);
    setStatus("");
    setDownload("");
    setImageReady(false);
    try {
      const body = await api.request<{
        base64: string;
        bytes: number;
        mediaType: string;
      }>({
        type: "assetRead",
        generation: session.generation,
        hash,
      });
      setImageReady(
        ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          body.mediaType,
        ),
      );
      setDownload("data:application/octet-stream;base64," + body.base64);
      setStatus(body.bytes + " bytes / 内容のSHA-256を検証しました。");
    } catch (e) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>共有添付</summary>
      <fieldset disabled={busy || !session.view.canEdit}>
        <label>
          添付ファイル（20MB以下）
          <input
            type="file"
            onChange={(e) => {
              source.current = e.target.files?.[0] ?? null;
              upload.current = crypto.randomUUID();
              setDownload("");
            }}
          />
        </label>
        <button onClick={() => void publish()}>選んだ添付を公開</button>
      </fieldset>
      <label>
        添付のSHA-256
        <input
          value={hash}
          maxLength={64}
          onChange={(e) => {
            setHash(e.target.value);
            setImageReady(false);
            setDownload("");
          }}
        />
      </label>
      <button
        disabled={busy || !/^[a-f0-9]{64}$/.test(hash)}
        onClick={() => void read()}
      >
        添付を取得・検証
      </button>
      <button
        disabled={busy || !imageReady || !session.view.canEdit}
        onClick={() => {
          setBusy(true);
          void api
            .request({
              type: "command",
              generation: session.generation,
              command: {
                kind: "block.insert",
                parentId: null,
                beforeId: null,
                node: {
                  type: "image",
                  attrs: {
                    id: crypto.randomUUID(),
                    src: "folio-asset://" + hash,
                    alt: source.current?.name ?? "共有画像",
                  },
                },
              },
            })
            .then(() => onChanged())
            .catch((e) => setStatus(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        取得・検証した画像を本文へ追加
      </button>
      {download && (
        <a href={download} download={"folio-shared-" + hash}>
          取得した添付を保存
        </a>
      )}
      {status && <p role="status">{status}</p>}
    </details>
  );
}
