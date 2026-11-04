import type {
  BacklinkGroup,
  BacklinkOccurrence,
} from "../shared/backlinks";
import type { Doc, Page } from "../shared/types";

const PAGE_LINK_PREFIX = "folio-page://";
/** Normal context window; a longer link keeps its full text visible. */
const CONTEXT_LENGTH = 140;
const ZWJ = 0x200d;
const COMBINING_MARK = /\p{M}/u;

type TextRun = { start: number; end: number };

function isVariationSelector(code: number): boolean {
  return (
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

function isEmojiModifier(code: number): boolean {
  return code >= 0x1f3fb && code <= 0x1f3ff;
}

function isContinuation(code: number): boolean {
  return (
    isVariationSelector(code) ||
    isEmojiModifier(code) ||
    COMBINING_MARK.test(String.fromCodePoint(code))
  );
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function codePointSize(code: number): number {
  return code > 0xffff ? 2 : 1;
}

function sizeBefore(text: string, index: number): number {
  if (index <= 0) return 0;
  return isLowSurrogate(text.charCodeAt(index - 1)) &&
    index >= 2 &&
    text.charCodeAt(index - 2) >= 0xd800 &&
    text.charCodeAt(index - 2) <= 0xdbff
    ? 2
    : 1;
}

/** Move a window start forward to a complete grapheme boundary. */
function safeStart(text: string, index: number, limit: number): number {
  let next = index;
  while (next < limit) {
    const code = text.codePointAt(next);
    if (code === undefined) break;
    const size = codePointSize(code);
    if (
      code === ZWJ ||
      isContinuation(code) ||
      isLowSurrogate(code) ||
      (next > 0 && text.charCodeAt(next - 1) === ZWJ)
    ) {
      next += size;
      continue;
    }
    break;
  }
  return next;
}

/** Move a window end backward to a complete grapheme boundary. */
function safeEnd(text: string, index: number, limit: number): number {
  let next = index;
  while (next > limit) {
    const excluded = next < text.length ? text.codePointAt(next) : undefined;
    if (excluded !== undefined && isContinuation(excluded)) {
      next -= sizeBefore(text, next);
      continue;
    }
    if (excluded !== undefined && isLowSurrogate(excluded)) {
      next -= 1;
      continue;
    }
    if (next > 0 && text.charCodeAt(next - 1) === ZWJ) {
      next -= 1;
      continue;
    }
    break;
  }
  return next;
}

function buildContext(
  text: string,
  run: TextRun,
): { context: string; ranges: { start: number; end: number }[] } {
  if (text.length <= CONTEXT_LENGTH)
    return {
      context: text,
      ranges: [{ start: run.start, end: run.end }],
    };

  const matchLength = Math.max(1, run.end - run.start);
  // Leave room for both ellipses so ordinary context stays within the bound.
  const windowLength = Math.max(CONTEXT_LENGTH - 2, matchLength);
  let from = Math.max(
    0,
    run.start - Math.floor((windowLength - matchLength) / 2),
  );
  from = Math.min(from, Math.max(0, text.length - windowLength));
  let to = Math.min(text.length, from + windowLength);
  if (to < run.end) {
    to = Math.min(text.length, run.end);
    from = Math.max(0, to - windowLength);
  }
  if (from > 0 && from < run.start) from = safeStart(text, from, run.start);
  if (to < text.length && to > run.end) to = safeEnd(text, to, run.end);

  const prefix = from > 0 ? "…" : "";
  const suffix = to < text.length ? "…" : "";
  return {
    context: prefix + text.slice(from, to) + suffix,
    ranges: [
      {
        start: prefix.length + run.start - from,
        end: prefix.length + run.end - from,
      },
    ],
  };
}

function linkMatches(marks: Doc["marks"], targetId: string): boolean {
  const plain = `${PAGE_LINK_PREFIX}${targetId}`;
  return (
    marks?.some(
      (mark) =>
        mark.type === "link" &&
        typeof mark.attrs?.href === "string" &&
        (mark.attrs.href === plain || mark.attrs.href === `${plain}/`),
    ) ?? false
  );
}

function inlineOccurrences(
  children: readonly Doc[],
  targetId: string,
): { text: string; runs: TextRun[] } {
  let text = "";
  const runs: TextRun[] = [];
  let active: TextRun | null = null;

  const flush = () => {
    if (active && active.end > active.start) runs.push(active);
    active = null;
  };

  for (const child of children) {
    if (child.type === "text") {
      const value = typeof child.text === "string" ? child.text : "";
      // An empty inline node does not split the visible text run.
      if (!value) continue;
      if (linkMatches(child.marks, targetId)) {
        if (active) active.end = text.length + value.length;
        else active = { start: text.length, end: text.length + value.length };
      } else {
        flush();
      }
      text += value;
    } else {
      // Hard breaks and inline atoms end a contiguous link run.
      flush();
      if (child.type === "hardBreak") text += "\n";
    }
  }
  flush();
  return { text, runs };
}

function containsInlineText(node: Doc): boolean {
  return (
    Array.isArray(node.content) &&
    node.content.some(
      (child) => child.type === "text" || child.type === "hardBreak",
    )
  );
}

function nodeBlockId(node: Doc, inherited: string | null): string | null {
  if (node.type === "doc") return inherited;
  const id = node.attrs?.id;
  return typeof id === "string" && id ? id : inherited;
}

function collectFromNode(
  node: Doc,
  inheritedBlockId: string | null,
  targetId: string,
  occurrences: BacklinkOccurrence[],
): void {
  if (!Array.isArray(node.content)) return;
  const blockId = nodeBlockId(node, inheritedBlockId);

  // Only leaf inline blocks produce context. Container text is represented by
  // its child paragraph/heading, so ancestor text is never counted twice.
  if (containsInlineText(node)) {
    const { text, runs } = inlineOccurrences(node.content, targetId);
    for (const run of runs) {
      const { context, ranges } = buildContext(text, run);
      occurrences.push({
        blockId,
        context,
        linkText: text.slice(run.start, run.end),
        ranges,
      });
    }
    return;
  }

  for (const child of node.content)
    collectFromNode(child, blockId, targetId, occurrences);
}

/**
 * Read-only contextual backlinks for one page. Each source page is grouped in
 * caller order and each visible link run becomes one occurrence. No store,
 * cache or save state is touched, so live optimistic documents are reflected.
 */
export function queryBacklinks(
  pages: readonly Page[],
  targetId: string,
): BacklinkGroup[] {
  if (!targetId) return [];
  const groups: BacklinkGroup[] = [];
  for (const page of pages) {
    if (
      page.id === targetId ||
      page.deletedAt != null ||
      page.documentError
    )
      continue;
    const occurrences: BacklinkOccurrence[] = [];
    collectFromNode(page.doc, null, targetId, occurrences);
    if (!occurrences.length) continue;
    groups.push({
      pageId: page.id,
      title: page.title,
      icon: page.icon,
      occurrences,
    });
  }
  return groups;
}
