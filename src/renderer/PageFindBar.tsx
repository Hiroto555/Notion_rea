import { Search } from "lucide-react";
import { composing } from "../shared/keyboard";

export type PageFindBarProps = {
  query: string;
  label: string;
  onQueryChange: (query: string) => void;
  onStep: (direction: 1 | -1) => void;
  onShow: () => void;
  onClose: () => void;
  isComposing: () => boolean;
};

export function PageFindBar({
  query,
  label,
  onQueryChange,
  onStep,
  onShow,
  onClose,
  isComposing,
}: PageFindBarProps) {
  return (
    <div className="page-find">
      <Search size={14} />
      <input
        autoFocus
        aria-label="ページ内検索"
        placeholder="ページ内を検索"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.defaultPrevented || composing(event.nativeEvent, isComposing())) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span>{label}</span>
      <button
        type="button"
        aria-label="前の一致"
        title="前の一致 (⇧Enter)"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStep(-1)}
      >
        前へ
      </button>
      <button
        type="button"
        aria-label="次の一致"
        title="次の一致 (Enter)"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onStep(1)}
      >
        次へ
      </button>
      <button type="button" onClick={onShow}>
        表示
      </button>
      <button
        type="button"
        aria-label="ページ内検索を閉じる"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
