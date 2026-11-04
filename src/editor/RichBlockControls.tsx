import { closeHistory } from "@tiptap/pm/history";
import {
  useEffect,
  useReducer,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Editor as TiptapEditor } from "@tiptap/react";

export type CalloutTone = "note" | "tip" | "warning";

export type RichBlockControlsProps = {
  editor: TiptapEditor;
  disabled?: boolean;
  onError: (error: unknown) => void;
};

type RichBlockCommand =
  | "setCalloutTone"
  | "unsetCallout"
  | "addSimpleRow"
  | "deleteSimpleRow"
  | "addSimpleColumn"
  | "deleteSimpleColumn"
  | "toggleSimpleHeader"
  | "deleteSimpleTable";

type RunnableChain = { run: () => boolean };
type CommandMethod = (...args: unknown[]) => RunnableChain;
type CommandHolder = Record<string, CommandMethod | undefined>;

const calloutTones: { tone: CalloutTone; label: string }[] = [
  { tone: "note", label: "メモ" },
  { tone: "tip", label: "ヒント" },
  { tone: "warning", label: "注意" },
];

const tableControls: {
  command: RichBlockCommand;
  label: string;
  danger?: boolean;
}[] = [
  { command: "addSimpleRow", label: "行を追加" },
  { command: "deleteSimpleRow", label: "行を削除" },
  { command: "addSimpleColumn", label: "列を追加" },
  { command: "deleteSimpleColumn", label: "列を削除" },
  { command: "toggleSimpleHeader", label: "見出し行" },
  { command: "deleteSimpleTable", label: "表を削除", danger: true },
];

/**
 * The commands live in the new rich-block extensions. The component is kept
 * deliberately tolerant of a build where those extensions are not registered
 * yet: a missing command disables its button instead of mutating the document.
 */
function canRunCommand(
  editor: TiptapEditor,
  command: RichBlockCommand,
  args: unknown[] = [],
): boolean {
  try {
    const can = editor.can() as unknown as { chain: () => CommandHolder };
    const chain = can.chain();
    const method = chain[command];
    return typeof method === "function" && method.apply(chain, args).run();
  } catch {
    return false;
  }
}

function runCommand(
  editor: TiptapEditor,
  command: RichBlockCommand,
  args: unknown[] = [],
): boolean {
  const chain = editor.chain() as unknown as CommandHolder;
  const method = chain[command];
  if (typeof method !== "function")
    throw new Error("ブロック操作を実行できません。");
  return method.apply(chain, args).run();
}

function isNodeActive(editor: TiptapEditor, nodeName: string): boolean {
  try {
    return editor.isActive(nodeName);
  } catch {
    return false;
  }
}

function firstRowIsHeader(editor: TiptapEditor): boolean {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "table") continue;
    const row = node.firstChild;
    if (!row) return false;
    let header = true;
    row.forEach((cell) => {
      if (cell.type.name !== "tableHeader") header = false;
    });
    return header;
  }
  return false;
}

function nodeAttributes(
  editor: TiptapEditor,
  nodeName: string,
): Record<string, unknown> {
  try {
    return editor.getAttributes(nodeName) ?? {};
  } catch {
    return {};
  }
}

export function RichBlockControls({
  editor,
  disabled = false,
  onError,
}: RichBlockControlsProps) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    if (!editor || editor.isDestroyed || typeof editor.on !== "function")
      return;
    const update = () => refresh();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  if (!editor) return null;

  const editable = editor.isEditable !== false;
  const locked = disabled || !editable || editor.view.composing;
  const inCallout = !editor.isDestroyed && isNodeActive(editor, "callout");
  const inTable = !editor.isDestroyed && isNodeActive(editor, "table");
  if (!inCallout && !inTable) return null;

  const attributes = inCallout ? nodeAttributes(editor, "callout") : {};
  const tone = attributes.tone;
  const currentTone: CalloutTone =
    tone === "tip" || tone === "warning" ? tone : "note";

  function keepEditorFocus(event: ReactMouseEvent<HTMLButtonElement>) {
    // Pointer focus must never leave the document while a command is running.
    event.preventDefault();
  }

  function execute(command: RichBlockCommand, args: unknown[] = []) {
    if (!editor) return;
    const readOnly = editor.isEditable === false;
    if (editor.view.composing) {
      onError(
        "文字の変換を確定してから操作してください。入力を保持しています。",
      );
      return;
    }
    if (editor.isDestroyed || disabled || readOnly) {
      onError(
        disabled
          ? "現在はブロック操作を実行できません。"
          : "読み取り専用の文書は変更できません。",
      );
      return;
    }
    if (!canRunCommand(editor, command, args)) {
      onError(new Error("この位置ではブロック操作を実行できません。"));
      return;
    }
    try {
      editor.view.dispatch(closeHistory(editor.state.tr));
      if (!runCommand(editor, command, args)) {
        onError(new Error("この位置ではブロック操作を実行できません。"));
        return;
      }
    } catch (error) {
      onError(error);
      return;
    }
    editor.view.dispatch(closeHistory(editor.state.tr));
    // Restore document focus only after a successful transaction. Read-only
    // documents must never be focused or changed by these controls.
    if (!disabled) {
      try {
        if (typeof editor.commands?.focus === "function") {
          editor.commands.focus(undefined, { scrollIntoView: false });
        }
      } catch (error) {
        onError(error);
      }
    }
  }

  const calloutLabel = "コールアウトの操作";
  const tableLabel = "表の操作";

  return (
    <div className="rich-block-controls">
      {inCallout && (
        <div
          className="rich-block-toolbar rich-block-toolbar--callout"
          role="toolbar"
          aria-label={calloutLabel}
        >
          <span className="rich-block-toolbar__label" aria-hidden="true">
            {calloutLabel}
          </span>
          <div
            className="rich-block-toolbar__group"
            role="group"
            aria-label="種類"
          >
            {calloutTones.map(({ tone: nextTone, label }) => {
              const canChange =
                !locked && canRunCommand(editor, "setCalloutTone", [nextTone]);
              return (
                <button
                  key={nextTone}
                  type="button"
                  className="rich-block-toolbar__button"
                  aria-pressed={currentTone === nextTone}
                  disabled={locked || !canChange}
                  title={label}
                  onMouseDown={keepEditorFocus}
                  onClick={() => execute("setCalloutTone", [nextTone])}
                >
                  <span
                    className="rich-block-toolbar__tone"
                    data-tone={nextTone}
                    aria-hidden="true"
                  />
                  {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="rich-block-toolbar__button rich-block-toolbar__button--quiet"
            disabled={locked || !canRunCommand(editor, "unsetCallout")}
            title="コールアウトを解除"
            onMouseDown={keepEditorFocus}
            onClick={() => execute("unsetCallout")}
          >
            コールアウトを解除
          </button>
        </div>
      )}
      {inTable && (
        <div
          className="rich-block-toolbar rich-block-toolbar--table"
          role="toolbar"
          aria-label={tableLabel}
        >
          <span className="rich-block-toolbar__label" aria-hidden="true">
            {tableLabel}
          </span>
          <div
            className="rich-block-toolbar__group"
            role="group"
            aria-label="表の編集"
          >
            {tableControls.map(({ command, label, danger }) => (
              <button
                key={command}
                type="button"
                className={
                  "rich-block-toolbar__button" +
                  (danger ? " rich-block-toolbar__button--danger" : "")
                }
                aria-pressed={
                  command === "toggleSimpleHeader"
                    ? firstRowIsHeader(editor)
                    : undefined
                }
                disabled={locked || !canRunCommand(editor, command)}
                title={label}
                onMouseDown={keepEditorFocus}
                onClick={() => execute(command)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
