import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { textOf } from "../shared/types";
import type {
  SearchRange,
  SearchResultPage,
} from "../shared/search-snippet";
import "./search-panel.css";

function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly SearchRange[];
}) {
  if (!ranges.length) return <>{text}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) parts.push(text.slice(cursor, start));
    if (end > start)
      parts.push(<mark key={`match-${index}`}>{text.slice(start, end)}</mark>);
    cursor = Math.max(cursor, end);
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function SearchResults({
  results,
  query,
  searchIndex,
  onSelect,
}: {
  results: readonly SearchResultPage[];
  query: string;
  searchIndex: number;
  onSelect: (page: SearchResultPage) => void;
}) {
  return (
    <div
      className="search-results"
      role="group"
      aria-label={query ? "検索結果" : "すべてのページ"}
    >
      {results.length ? (
        results.map((p, i) => {
          const match = p.searchMatch;
          const titleRanges = match?.kind === "title" ? match.ranges : [];
          let matchDetail: ReactNode = null;
          if (match?.kind === "title") {
            matchDetail = (
              <span className="result-match">
                <span className="result-match-kind">タイトル</span>
                <span className="result-match-text">タイトルに一致</span>
              </span>
            );
          } else if (match) {
            const label =
              match.kind === "body"
                ? "本文"
                : !match.label || match.label === "プロパティ"
                  ? "プロパティ"
                  : `プロパティ · ${match.label}`;
            matchDetail = (
              <span className="result-match">
                <span className="result-match-kind">{label}</span>
                <span className="result-match-text">
                  <Highlighted text={match.snippet} ranges={match.ranges} />
                </span>
              </span>
            );
          }

          let detail: ReactNode;
          if (p.documentError) {
            const notice = (
              <span className="result-warning">
                未対応の文書（原本を保全）
              </span>
            );
            detail = matchDetail ? (
              <span className="result-detail">
                {notice}
                {matchDetail}
              </span>
            ) : (
              notice
            );
          } else {
            detail =
              matchDetail ?? (textOf(p.doc).slice(0, 85) || "空のページ");
          }
          return (
            <button
              key={p.id}
              className={i === searchIndex ? "active" : ""}
              aria-current={i === searchIndex ? "true" : undefined}
              title={p.title || "無題"}
              onClick={() => onSelect(p)}
            >
              <span className="result-icon">{p.icon}</span>
              <span className="result-text">
                <strong>
                  <Highlighted text={p.title || "無題"} ranges={titleRanges} />
                </strong>
                <small>{detail}</small>
              </span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          );
        })
      ) : (
        <p className="empty">見つかりませんでした</p>
      )}
    </div>
  );
}
