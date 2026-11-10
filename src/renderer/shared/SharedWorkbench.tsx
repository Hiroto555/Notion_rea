import { SharedTrashPanel } from "./SharedTrashPanel";
import { SharedPageCreator } from "./SharedPageCreator";
import { SharedCopyPanel } from "./SharedCopyPanel";
import { SharedAssetsPanel } from "./SharedAssetsPanel";
import { SharedDatabasePanel } from "./SharedDatabasePanel";
import { SharedDocumentActions } from "./SharedDocumentActions";
import { SharedDraftLane } from "../../shared/shared-draft-lane";
import { SharedAdministration } from "./SharedAdministration";
import { useEffect, useRef, useState } from "react";
import { Editor } from "../../editor/Editor";
import type { Editor as TiptapEditor } from "@tiptap/react";
import type { Doc } from "../../shared/types";
import type {
  SharedRuntimeAPI,
  SharedRuntimeRequest,
  SharedRuntimeSession,
} from "../../shared/shared-runtime-ipc";
import { sharedRuntimeStateLabel } from "./runtime-state";
import { canonical } from "../../collaboration/runtime/canonical";
import "./shared-workbench.css";
/** Explicit shared route; no private save API is passed to this editor. */
export function SharedWorkbench({
  api,
  onClose,
  privatePages = [],
}: {
  api: SharedRuntimeAPI | undefined;
  onClose: () => void;
  privatePages?: { id: string; title: string; kind?: "page" | "record" | "database" }[];
}) {
  const [session, setSession] = useState<SharedRuntimeSession | null>(null),
    [connections, setConnections] = useState<
      { connectionId: string; url: string; orgId: string; deviceId: string }[]
    >([]),
    [url, setUrl] = useState("http://127.0.0.1:"),
    [orgId, setOrgId] = useState(""),
    [token, setToken] = useState(""),
    [invite, setInvite] = useState(""),
    [deviceId, setDeviceId] = useState(""),
    [remember, setRemember] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [recovery, setRecovery] = useState(""),
    [oldDrafts, setOldDrafts] = useState<{entryId: string; writerId: string; pendingCount: number; status: string}[]>([]),
    [draft, setDraft] = useState<Doc | null>(null),
    [composingNow, setComposingNow] = useState(false);
  const editor = useRef<TiptapEditor | null>(null),
    composition = useRef(false),
    mounted = useRef(true),
    fence = useRef(0),
    deferred = useRef<Doc | null>(null),
    sending = useRef(false),
    imeGeneration = useRef(0),
    pendingSession = useRef<SharedRuntimeSession | null>(null),
    rootElement = useRef<HTMLElement | null>(null),
    apiRef = useRef(api),
    draftLane = useRef<SharedDraftLane | null>(null);
  apiRef.current = api;
  if (!draftLane.current)
    draftLane.current = new SharedDraftLane((input) => {
      if (!apiRef.current)
        return Promise.reject(new Error("SHARED_UNAVAILABLE"));
      return apiRef.current.request(input);
    });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rootElement.current?.focus();
    mounted.current = true;
    return () => {
      mounted.current = false;
      fence.current++;
      queueMicrotask(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, []);
  async function request(input: SharedRuntimeRequest) {
    if (!api) {
      setError("共有機能を利用できるアプリで開いてください。");
      return;
    }
    const ticket = ++fence.current;
    editor.current?.setEditable(false, false);
    setBusy(true);
    setError("");
    try {
      const next = await api.request<SharedRuntimeSession>(input);
      if (mounted.current && ticket === fence.current) {
        if (composition.current) pendingSession.current = next;
        else setSession(next);
        if (
          (["document", "editorDocument"].includes(input.type) &&
            next.view.state === "CLIENT_RECEIPT_DURABLE") ||
          [
            "open",
            "connect",
            "join",
            "resume",
            "disconnect",
            "parkDraft",
          ].includes(input.type)
        )
          setDraft(null);
      }
    } catch (e) {
      if (mounted.current && ticket === fence.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current && ticket === fence.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (
      !session?.snapshot ||
      busy ||
      draft ||
      composingNow ||
      session.view.state !== "CLIENT_RECEIPT_DURABLE"
    )
      return;
    const timer = setInterval(() => {
      if (!composition.current && !sending.current)
        void request({ type: "refresh", generation: session.generation });
    }, 2000);
    return () => clearInterval(timer);
  }, [
    session?.generation,
    session?.view.state,
    !!session?.snapshot,
    busy,
    !!draft,
    composingNow,
  ]);
  const snapshot = session?.snapshot;
  async function change(document: Doc) {
    setDraft(document);
    if (!session?.snapshot || !api) return;
    if (composition.current) {
      deferred.current = document;
      try {
        await draftLane.current!.retain(
          session.generation,
          JSON.stringify(document),
        );
      } catch (e) {
        if (mounted.current)
          setError("端末への原稿保存に失敗しました: " + String(e));
      }
      return;
    }
    if (sending.current) {
      deferred.current = document;
      return;
    }
    sending.current = true;
    editor.current?.setEditable(false, false);
    try {
      await request({
        type: "editorDocument",
        generation: session.generation,
        base: session.snapshot.cut,
        document,
      });
    } finally {
      sending.current = false;
    }
  }
  function compositionEnd() {
    const generation = imeGeneration.current;
    setTimeout(() => {
      void (async () => {
        if (!mounted.current || generation !== imeGeneration.current) return;
        const document = editor.current?.getJSON() as Doc | undefined;
        const next = document ?? deferred.current;
        deferred.current = null;
        try {
          if (next && session)
            await draftLane.current!.retain(
              session.generation,
              JSON.stringify(next),
            );
          if (!mounted.current || generation !== imeGeneration.current) return;
          composition.current = false;
          setComposingNow(false);
          if (next) await change(next);
        } catch (e) {
          composition.current = false;
          setComposingNow(false);
          setError(
            "原稿はこの画面に保持しています。端末への保存に失敗しました: " +
              String(e),
          );
        }
      })();
    }, 0);
  }

  async function recover() {
    if (!api || !session) return;
    setBusy(true);
    try {
      const raw = await api.request<string>({
        type: session.scope ? "recover" : "resourceRecover",
        generation: session.generation,
      });
      if (mounted.current) setRecovery(raw);
    } catch (e) {
      setError(String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      ref={rootElement}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      className="shared-workbench"
      aria-label="共有ワークスペース"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const items = Array.from(
          rootElement.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
          ) ?? [],
        ).filter((el) => !el.closest("[hidden]"));
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      <header>
        <h1>共有ワークスペース</h1>
        <button
          onClick={() => {
            if (draft && api && session) {
              setBusy(true);
              void api
                .request({
                  type: "draft",
                  generation: session.generation,
                  raw: JSON.stringify(draft),
                })
                .then(() => onClose())
                .catch((e) =>
                  setError("原稿の端末保存に失敗しました: " + String(e)),
                )
                .finally(() => setBusy(false));
              return;
            }
            onClose();
          }}
          disabled={busy || composingNow}
        >
          個人ワークスペースへ戻る
        </button>
      </header>
      <details open={!session}>
        <summary>共有サーバーに接続</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void request({ type: "connect", url, orgId, token, remember }).then(
              () => setToken(""),
            );
          }}
        >
          <label>
            サーバーURL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            組織ID
            <input value={orgId} onChange={(e) => setOrgId(e.target.value)} />
          </label>
          <label>
            接続トークン
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            この端末に資格情報を暗号化して保存
          </label>
          <button disabled={busy || !!draft}>接続</button>
        </form>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void request({
              type: "join",
              url,
              orgId,
              deviceId,
              inviteToken: invite,
              remember,
            }).then(() => setInvite(""));
          }}
        >
          <label>
            招待トークン
            <input
              type="password"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            新しい端末ID
            <input
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
            />
          </label>
          <button disabled={busy || !!draft}>招待で参加</button>
        </form>
        <button
          disabled={busy || !!draft}
          onClick={() => {
            if (!api) return;
            setBusy(true);
            void api
              .request<typeof connections>({ type: "connections" })
              .then(setConnections)
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          保存済み接続を表示
        </button>
        {connections.map((connection) => (
          <button
            key={connection.connectionId}
            disabled={busy || !!draft}
            onClick={() => {
              setOrgId(connection.orgId);
              setUrl(connection.url);
              void request({
                type: "resume",
                connectionId: connection.connectionId,
              });
            }}
          >
            {connection.orgId} / {connection.deviceId}
          </button>
        ))}
      </details>
      {composingNow && <p role="status">入力中・サーバーへ未送信です。</p>}
      <p>
        本文・装飾・複数ブロック・改行・移動・表の行列変更を共有保存します。競合や未対応の変更は原稿を端末に保全し、確認できるまで送信を止めます。
      </p>
      {error && (
        <p role="alert">
          {error}
          　入力内容はこの画面に保持しています。「原本を表示」で端末の保全内容を確認できます。
        </p>
      )}
      <nav aria-label="共有文書">
        {session?.workspaces.map((w) => (
          <section key={w.workspaceId}>
            <h2>
              {w.name}（{w.role}）
            </h2>
            {api && session && (w.role === "owner" || w.role === "editor") && (
              <SharedPageCreator
                api={api}
                generation={session.generation}
                orgId={session.orgId ?? orgId}
                workspaceId={w.workspaceId}
                onCreated={(scope) =>
                  void request({ type: "list" }).then(() =>
                    request({ type: "open", scope }),
                  )
                }
              />
            )}
            {api && session && <SharedTrashPanel api={api} generation={session.generation} orgId={session.orgId ?? orgId} workspaceId={w.workspaceId} writable={w.role === "owner" || w.role === "editor"} disabled={busy || !!draft || composingNow} onChanged={() => void request({type: "list"})} onClosed={() => void request({type: "closeDocument", generation: session.generation}).then(() => request({type: "list"}))} currentScope={session.scope} />}
            {w.documents.map((d) => (
              <button
                key={d.incarnationId}
                disabled={busy || !!draft || composition.current}
                onClick={() =>
                  void request({
                    type: "open",
                    scope: {
                      orgId: session.orgId ?? orgId,
                      workspaceId: w.workspaceId,
                      documentId: d.documentId,
                      incarnationId: d.incarnationId,
                    },
                  })
                }
              >
                {d.title}
              </button>
            ))}
          </section>
        ))}
        <button
          disabled={busy || composingNow}
          onClick={() => void request({ type: "list" })}
        >
          一覧を取得
        </button>
      </nav>
      {session && (
        <section aria-label="共有保存状態">
          <p role="status">
            {sharedRuntimeStateLabel(session.view.state)}：
            {session.view.message}
          </p>
          <button
            disabled={busy || composition.current || !!draft}
            onClick={() =>
              void request({ type: "refresh", generation: session.generation })
            }
          >
            他の変更を取得
          </button>
          <button
            disabled={busy || composingNow}
            onClick={() =>
              void request({
                type: "reconcile",
                generation: session.generation,
              })
            }
          >
            受付状態を再確認
          </button>
          <button disabled={busy} onClick={() => void recover()}>
            原本を表示
          </button>
        </section>
      )}
      {session?.pendingIntents?.map((item) => (
        <section key={item.intentId}>
          <p>
            {item.kind} / {item.state} / {item.intentId}
          </p>
          <button
            disabled={busy || composingNow || item.state !== "UNKNOWN"}
            onClick={() =>
              void request(
                item.kind === "resource"
                  ? {
                      type: "resourceInvalidate",
                      generation: session.generation,
                      scope: item.scope,
                      intentId: item.intentId,
                    }
                  : {
                      type: "invalidate",
                      generation: session.generation,
                      intentId: item.intentId,
                    },
              )
            }
          >
            この未確定試行を照会して封鎖
          </button>
          <button
            disabled={busy || composingNow || item.state === "UNKNOWN"}
            onClick={() =>
              void request(
                item.kind === "resource"
                  ? {
                      type: "resourceArchive",
                      generation: session.generation,
                      scope: item.scope,
                      intentId: item.intentId,
                    }
                  : {
                      type: "archive",
                      generation: session.generation,
                      intentId: item.intentId,
                    },
              )
            }
          >
            不適用が証明された試行を保全して閉じる
          </button>
        </section>
      ))}
      {draft && session && (
        <button
          disabled={busy || composingNow}
          onClick={() =>
            void request({ type: "parkDraft", generation: session.generation })
          }
        >
          原稿を端末に保全してサーバー表示へ戻る
        </button>
      )}
      {snapshot && session && (
        <div
          onCompositionStartCapture={() => {
            imeGeneration.current++;
            composition.current = true;
            setComposingNow(true);
          }}
          onCompositionEndCapture={compositionEnd}
        >
          <Editor
            key={session.generation}
            documentId={"shared:" + canonical(session.scope)}
            doc={draft ?? snapshot.state.document}
            editable={!busy && session.view.canEdit && (!error || composingNow)}
            shared={{
              resolveImage: async (hash) => {
                if (!api) throw new Error("SHARED_UNAVAILABLE");
                return api.request<{ base64: string; mediaType: string }>({
                  type: "assetRead",
                  generation: session.generation,
                  hash,
                });
              },
              isComposing: () => composition.current,
              revision: snapshot.cut.hash,
              onUndo: () =>
                void request({ type: "undo", generation: session.generation }),
              onRedo: () =>
                void request({ type: "redo", generation: session.generation }),
            }}
            onChange={(d) => void change(d)}
            onReady={(e) => {
              editor.current = e;
            }}
            onLink={() =>
              setError("共有リンクの挿入は現在の接続では未対応です。")
            }
            onError={(e) => setError(String(e))}
          />
        </div>
      )}
      {session?.scope && api && (
        <fieldset
          key={"tools:" + session.generation}
          disabled={busy || composingNow || !!draft}
        >
          <SharedCopyPanel
            api={api}
            generation={session.generation}
            pages={privatePages}
            onChanged={() => void request({ type: "list" })}
          />
          <SharedAssetsPanel
            api={api}
            session={session}
            onChanged={() =>
              void request({ type: "refresh", generation: session.generation })
            }
          />
          <SharedDocumentActions
            api={api}
            session={session}
            onChanged={() =>
              void request({ type: "refresh", generation: session.generation })
            }
          />
          <SharedDatabasePanel
            api={api}
            scope={session.scope}
            generation={session.generation}
            onChanged={() => void request({ type: "list" })}
            onOpen={(scope) => void request({ type: "open", scope })}
          />
          <button
            onClick={() => {
              setBusy(true);
              void api
                .request<{ state: string }>({
                  type: "backupExport",
                  orgId: session.scope!.orgId,
                })
                .then((value) =>
                  setError(
                    value.state === "EXPORTED"
                      ? "バックアップを書き出しました。"
                      : value.state === "UNKNOWN"
                        ? "保存結果が未確定です。出力先を保全して確認してください。"
                        : "",
                  ),
                )
                .catch((e) => setError(String(e)))
                .finally(() => setBusy(false));
            }}
          >
            組織バックアップを書き出す
          </button>
        </fieldset>
      )}
      {session?.scope && (
        <fieldset
          key={"admin:" + session.generation}
          disabled={busy || composingNow || !!draft}
        >
          <SharedAdministration
            api={api}
            orgId={session.scope.orgId}
            scope={session.scope}
            onChanged={() => void request({ type: "list" })}
          />
        </fieldset>
      )}
      {api && session?.orgId && <details>
        <summary>端末に残る以前の接続の原稿</summary>
        <button disabled={busy || composingNow} onClick={() => void api.request<typeof oldDrafts>({type: "recoveryList", generation: session.generation}).then(setOldDrafts).catch(e => setError(String(e)))}>原稿の一覧を読む</button>
        {oldDrafts.map(item => <p key={item.entryId}>{item.writerId} / {item.status} / 保留 {item.pendingCount} 件 <button disabled={busy || composingNow} onClick={() => void api.request<string>({type: "recoveryRead", generation: session.generation, entryId: item.entryId}).then(setRecovery).catch(e => setError(String(e)))}>原本を表示</button></p>)}
      </details>}
      {recovery && (
        <section aria-label="共有原本">
          <h2>端末に保全した原本</h2>
          <pre>{recovery}</pre>
        </section>
      )}
    </section>
  );
}
