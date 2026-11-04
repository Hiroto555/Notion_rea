import { textOf, type Doc } from "../shared/types";

/** Visible text budget for a board/gallery card body. */
export const CARD_EXCERPT_LIMIT = 120;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** Keep block boundaries but collapse presentation-only whitespace. Empty
 * lines are dropped so a document with only blank paragraphs has no excerpt. */
function normalizeExcerpt(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** Clip by grapheme cluster rather than UTF-16 code unit so emoji and
 * combining marks are never split. The ellipsis is part of the budget. */
function clipExcerpt(text: string, limit: number): string {
  if (!Number.isFinite(limit)) return "";
  const size = Math.floor(limit);
  if (size <= 0) return "";
  const cluster = graphemes(text);
  if (cluster.length <= size) return text;
  if (size === 1) return "…";
  return cluster.slice(0, size - 1).join("").trimEnd() + "…";
}

/**
 * Plain, bounded body preview for read-only database cards. Only text content
 * is read; attrs, marks and HTML-like strings are never interpreted. A missing
 * body or one containing only blank blocks yields an empty string.
 */
export function cardExcerpt(
  doc: Doc | null | undefined,
  limit = CARD_EXCERPT_LIMIT,
): string {
  if (!doc) return "";
  const plain = normalizeExcerpt(textOf(doc));
  return plain ? clipExcerpt(plain, limit) : "";
}
