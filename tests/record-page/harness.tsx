import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { Editor } from "../../src/editor/Editor";
import {
  RecordPage,
  type RecordPageMode,
  type RecordSaveState,
} from "../../src/database/RecordPage";
import type { RecordDraft } from "../../src/database/database-ui";
import type { Doc, RecordProjection } from "../../src/shared/types";
import "../../src/renderer/styles.css";

const record: RecordProjection = {
  pageId: "fixture-record",
  databasePageId: "fixture-database",
  revision: 1,
  title: "合成タスク",
  icon: "📄",
  values: { note: "メモ" },
  deletedAt: null,
};
const initialDoc: Doc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "元の本文" }] },
  ],
};
const calls = { ready: 0, close: 0, resolve: 0, retry: 0, doc: initialDoc };
declare global {
  interface Window {
    __recordPresentation: {
      calls: typeof calls;
      setSaveState: (state: RecordSaveState) => void;
      setBlocked: (blocked: boolean) => void;
    };
  }
}
function Harness() {
  const [mode, setMode] = useState<RecordPageMode>("side");
  const [state, setState] = useState<RecordSaveState>("saved");
  const [blocked, setBlocked] = useState(false);
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<RecordDraft>({
    title: record.title,
    values: {},
  });
  const editor = useRef<TiptapEditor | null>(null);
  const origin = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    editor.current?.setEditable(!blocked);
  }, [blocked]);
  window.__recordPresentation = { calls, setSaveState: setState, setBlocked };
  const close = () => {
    calls.close++;
    setOpen(false);
    requestAnimationFrame(() => origin.current?.focus());
  };
  return (
    <main style={{ position: "relative", height: "100vh", overflow: "hidden" }}>
      <button ref={origin} onClick={() => setOpen(true)}>
        元の行
      </button>
      {open && (
        <RecordPage
          pageId={record.pageId}
          record={record}
          draft={draft}
          properties={[{ id: "note", name: "メモ", type: "text" }]}
          mode={mode}
          onModeChange={setMode}
          onClose={close}
          onBack={close}
          editingBlocked={blocked}
          saveState={state}
          onResolve={() => {
            calls.resolve++;
          }}
          onRetry={() => {
            calls.retry++;
          }}
          onTitleChange={(title) =>
            setDraft((previous) => ({ ...previous, title }))
          }
          onValueChange={(id, value) =>
            setDraft((previous) => ({
              ...previous,
              values: { ...previous.values, [id]: value },
            }))
          }
          body={
            <Editor
              documentId={record.pageId}
              doc={initialDoc}
              onReady={(instance) => {
                editor.current = instance;
                calls.ready++;
                instance.setEditable(!blocked);
              }}
              onChange={(doc) => {
                calls.doc = doc;
              }}
              onLink={() => {}}
              onError={(error) => {
                throw error;
              }}
            />
          }
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
