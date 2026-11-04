import type { ReactNode } from "react";
import type {
  BacklinkGroup,
  BacklinkOccurrence,
} from "../shared/backlinks";
import "./backlinks-panel.css";

function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: BacklinkOccurrence["ranges"];
}) {
  if (!ranges.length) return <>{text}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    const start = Math.max(cursor, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) parts.push(text.slice(cursor, start));
    if (end > start)
      parts.push(<mark key={`backlink-match-${index}`}>{text.slice(start, end)}</mark>);
    cursor = Math.max(cursor, end);
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function BacklinksPanel({
  groups,
  onNavigate,
}: {
  groups: readonly BacklinkGroup[];
  onNavigate: (pageId: string, blockId: string | null) => void;
}) {
  return (
    <section className="backlinks-panel" aria-label="バックリンク">
      <h3 className="backlinks-heading">
        バックリンク{" "}
        <small aria-label={`${groups.length}ページ`}>{groups.length}</small>
      </h3>
      {groups.length ? (
        <div className="backlinks-groups">
          {groups.map((group) => {
            const title = group.title || "無題";
            return (
              <div className="backlinks-group" key={group.pageId}>
                <button
                  type="button"
                  className="backlinks-source"
                  onClick={() => onNavigate(group.pageId, null)}
                  aria-label={`${title} を開く`}
                >
                  <span className="backlinks-source-icon" aria-hidden="true">
                    {group.icon || "📄"}
                  </span>
                  <span className="backlinks-source-title">{title}</span>
                </button>
                <ul
                  className="backlinks-occurrences"
                  aria-label={`${title} の参照箇所`}
                >
                  {group.occurrences.map((occurrence, index) => (
                    <li key={`${occurrence.blockId ?? "page"}-${index}`}>
                      <button
                        type="button"
                        className="backlinks-occurrence"
                        onClick={() =>
                          onNavigate(group.pageId, occurrence.blockId)
                        }
                        aria-label={`${title} の参照箇所を開く: ${occurrence.context}`}
                      >
                        <span className="backlinks-context">
                          <Highlighted
                            text={occurrence.context}
                            ranges={occurrence.ranges}
                          />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="backlinks-empty">
          このページへのリンクはまだありません。他のページからリンクすると、ここに表示されます。
        </p>
      )}
    </section>
  );
}
