import type { Page } from "./types";

/**
 * Transient search metadata. It is attached to search results only and is never
 * persisted as part of a Page, so the Page schema stays unchanged.
 */
export type SearchMatchKind = "title" | "body" | "property";

export type SearchRange = Readonly<{ start: number; end: number }>;

export type SearchMatch = Readonly<{
  kind: SearchMatchKind;
  /** Title, or a window of text around the matched body/property value. */
  snippet: string;
  /** Ranges are relative to `snippet` and are safe to render as React text. */
  ranges: readonly SearchRange[];
  /** Optional property/row label for property matches. */
  label?: string;
}>;

/** A Page-shaped result with optional transient metadata. */
export type SearchResultPage = Page & { readonly searchMatch?: SearchMatch };

const SNIPPET_LENGTH = 90;
const SNIPPET_LEAD = 30;

type Folded = Readonly<{ lower: string; originalAt: number[] }>;

const SURROGATE = /[\uD800-\uDFFF]/;

/**
 * Locale-aware lower-casing that also remembers where each lowered code unit
 * came from. This keeps highlight ranges correct when a character changes
 * length while being folded.
 *
 * For ordinary text without surrogate pairs, an equal-length whole-string
 * lower-case is a one-code-unit-to-one-code-unit mapping, so source offsets
 * are already correct and the per-character walk can be skipped.
 */
function fold(text: string): Folded {
  const wholeLower = text.toLocaleLowerCase();
  if (wholeLower.length === text.length && !SURROGATE.test(text)) {
    const originalAt = new Array<number>(text.length + 1);
    for (let index = 0; index <= text.length; index += 1)
      originalAt[index] = index;
    return { lower: wholeLower, originalAt };
  }

  let lower = "";
  const originalAt: number[] = [];
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index);
    if (code === undefined) break;
    const character = String.fromCodePoint(code);
    const folded = character.toLocaleLowerCase();
    for (let offset = 0; offset < folded.length; offset += 1)
      originalAt.push(index);
    lower += folded;
    index += character.length;
  }
  originalAt.push(text.length);
  return { lower, originalAt };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** All case-insensitive occurrences of `query` in `text`, in source offsets. */
export function searchRanges(text: string, query: string): SearchRange[] {
  const term = query.trim();
  if (!text || !term) return [];
  const foldedText = fold(text);
  const foldedTerm = term.toLocaleLowerCase();
  if (!foldedTerm) return [];

  const ranges: SearchRange[] = [];
  let from = 0;
  while (from <= foldedText.lower.length) {
    const at = foldedText.lower.indexOf(foldedTerm, from);
    if (at < 0) break;
    const start = foldedText.originalAt[at] ?? text.length;
    const mappedEnd = foldedText.originalAt[at + foldedTerm.length] ?? text.length;
    ranges.push({ start, end: Math.max(start + 1, mappedEnd) });
    from = at + Math.max(1, foldedTerm.length);
  }
  return ranges;
}

/** True when the page source contains the trimmed, case-insensitive query. */
export function containsSearchTerm(text: string, query: string): boolean {
  const term = query.trim();
  if (!text || !term) return false;
  const foldedText = fold(text);
  return foldedText.lower.includes(term.toLocaleLowerCase());
}

type MatchSpan = Readonly<{ start: number; end: number }>;

function firstMatch(text: string, query: string): MatchSpan | null {
  const term = query.trim();
  if (!text || !term) return null;
  const foldedText = fold(text);
  const foldedTerm = term.toLocaleLowerCase();
  if (!foldedTerm) return null;

  const at = foldedText.lower.indexOf(foldedTerm);
  if (at < 0) return null;
  const start = foldedText.originalAt[at] ?? text.length;
  const mappedEnd = foldedText.originalAt[at + foldedTerm.length] ?? text.length;
  return { start, end: Math.max(start + 1, mappedEnd) };
}

/**
 * Build a readable window around the first actual match. A late match therefore
 * still shows the matching text instead of only the start of the document.
 *
 * `maxLength` is the normal window size. The window grows when the matched
 * query is longer than it so that the complete match stays visible and
 * highlightable, even for queries up to the 500-character input limit.
 */
export function buildSnippet(
  text: string,
  query: string,
  maxLength = SNIPPET_LENGTH,
): { snippet: string; ranges: SearchRange[] } | null {
  const match = firstMatch(text, query);
  if (!match) return null;

  const matchLength = Math.max(1, match.end - match.start);
  const length = Math.max(1, maxLength, matchLength);
  const lead = Math.max(0, Math.min(SNIPPET_LEAD, length - matchLength));
  let start = Math.max(0, match.start - lead);
  let end = Math.min(text.length, start + length);
  if (end - start < length) start = Math.max(0, end - length);

  // Do not split a surrogate pair at either edge of the window. Never move an
  // edge inside the match itself.
  if (
    start > 0 &&
    start < match.start &&
    isLowSurrogate(text.charCodeAt(start))
  )
    start += 1;
  if (
    end < text.length &&
    end > match.end &&
    isLowSurrogate(text.charCodeAt(end))
  )
    end -= 1;

  const snippet =
    (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  return { snippet, ranges: searchRanges(snippet, query) };
}

/** A title match keeps the full title so the result row can highlight it. */
export function buildTitleMatch(
  title: string,
  query: string,
): SearchMatch | null {
  if (!containsSearchTerm(title, query)) return null;
  return { kind: "title", snippet: title, ranges: searchRanges(title, query) };
}
