/**
 * Folio Markdown boundary. Keep IO dialogs and editor parsing in App.
 *
 * Folio exports start with a single, versioned HTML-comment marker. The title
 * is percent-encoded so that arbitrary title text (newlines, quotes, "#",
 * "-->", metadata-like text) cannot break the marker or HTML comment.
 *
 *   <!-- folio:markdown:v1 title=<encodeURIComponent(title)> -->
 *
 * A display-only H1 follows the marker when the title is non-empty. On import
 * that H1 is removed only when it matches the wrapper regenerated from the
 * verified marker; an arbitrary external H1 is never stripped.
 *
 * Limitations: Markdown import only recovers title and body text. Body
 * semantics are parsed later by Tiptap, and Folio IDs, hierarchy, revisions
 * and history are not restored by a Markdown round trip.
 */

const FORMAT = "folio:markdown:v1";
const MARKER_PREFIX = "<!-- " + FORMAT + " title=";
const MARKER_SUFFIX = " -->";
const MARKER_PATTERN = /^<!-- folio:markdown:v1 title=(\S*) -->$/;

// Folio page titles are bounded to 500 code units by the shared schema.
const MAX_TITLE_LENGTH = 500;
// encodeURIComponent emits at most 12 characters per UTF-16 code unit.
const MAX_ENCODED_TITLE_LENGTH = MAX_TITLE_LENGTH * 12;
const MAX_MARKER_LENGTH =
  MARKER_PREFIX.length + MAX_ENCODED_TITLE_LENGTH + MARKER_SUFFIX.length;

function encodeTitle(title: string): string | null {
  if (title.length > MAX_TITLE_LENGTH) return null;
  try {
    const encoded = encodeURIComponent(title);
    return encoded.length <= MAX_ENCODED_TITLE_LENGTH ? encoded : null;
  } catch {
    // Lone surrogates cannot be encoded; fall back to ordinary Markdown.
    return null;
  }
}

function displayTitle(title: string): string {
  return title.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");
}

export function exportMarkdown(title: string, body: string): string {
  const encoded = encodeTitle(title);
  if (encoded === null)
    return title.length > 0 ? "# " + displayTitle(title) + "\n\n" + body : body;

  const marker = MARKER_PREFIX + encoded + MARKER_SUFFIX;
  if (title.length === 0) return marker + "\n" + body;
  return marker + "\n# " + displayTitle(title) + "\n\n" + body;
}

type MarkerLine = { line: string; newline: string; rest: string };

function splitFirstLine(content: string): MarkerLine | null {
  const lf = content.indexOf("\n");
  if (lf < 0) return null;
  let line = content.slice(0, lf);
  let newline = "\n";
  if (line.endsWith("\r")) {
    line = line.slice(0, -1);
    newline = "\r\n";
  }
  return { line, newline, rest: content.slice(lf + 1) };
}

function parseFolioMarkdown(
  content: string,
): { title: string; body: string } | null {
  const first = splitFirstLine(content);
  if (!first || first.line.length > MAX_MARKER_LENGTH) return null;

  const match = MARKER_PATTERN.exec(first.line);
  if (!match) return null;

  const encoded = match[1];
  if (encoded.length > MAX_ENCODED_TITLE_LENGTH) return null;

  let title: string;
  try {
    title = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (title.length > MAX_TITLE_LENGTH) return null;
  // Reject non-canonical encodings, e.g. lowercase escapes or raw spaces.
  if (encodeURIComponent(title) !== encoded) return null;

  if (title.length === 0) return { title, body: first.rest };

  // Remove only the wrapper this exporter would have generated. If the H1 was
  // edited or removed, keep the remaining content instead of eating it.
  const wrapper = "# " + displayTitle(title) + first.newline + first.newline;
  return first.rest.startsWith(wrapper)
    ? { title, body: first.rest.slice(wrapper.length) }
    : { title, body: first.rest };
}

export function importMarkdown(
  fileName: string,
  content: string,
): { title: string; body: string } {
  return parseFolioMarkdown(content) ?? { title: fileName, body: content };
}
