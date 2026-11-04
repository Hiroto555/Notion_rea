import type { JSONContent } from "@tiptap/core";

/**
 * Serialize a rich block subtree (callout or simple table) to a small, static
 * subset of standard HTML. The result is embedded in Markdown and parsed again
 * by TipTap's DOMParser in the renderer.
 *
 * This module is intentionally DOM-free and loss-aware: block IDs are not
 * emitted (clipboard identity owns those), literal rich JSON is never hidden
 * in the output, and a node or mark this serializer cannot represent throws
 * instead of being silently flattened.
 */

type RenderContext = {
  /** A table must never be nested inside one of its own cells. */
  insideTable?: boolean;
};

const CALLOUT_TONES = new Set(["note", "tip", "warning"]);
const ORDERED_LIST_TYPES = new Set(["1", "a", "A", "i", "I"]);
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLUMNS = 20;

/** Characters that are unsafe in both text and quoted attribute values. */
function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/**
 * Escape text. Newlines are emitted as character references so a rich block
 * never contains a literal blank line, which would terminate a CommonMark
 * type-6 HTML block before its closing tag.
 */
function escapeText(value: string): string {
  return escapeMarkup(value).replace(/\r/g, "&#13;").replace(/\n/g, "&#10;");
}

function escapeAttribute(value: string): string {
  return escapeText(value);
}

/**
 * Return a safe URL string, or null when the value is missing or uses a
 * dangerous scheme. Whitespace/control characters are ignored while checking
 * the scheme, matching how browsers normalize `java\nscript:` URLs.
 */
function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (!url) return null;
  const scheme = url.replace(/[\u0000-\u0020\u007f\s]+/g, "").toLowerCase();
  if (scheme.startsWith("javascript:") || scheme.startsWith("vbscript:")) {
    return null;
  }
  return url;
}

function attrsOf(node: JSONContent): Record<string, any> {
  return node.attrs ?? {};
}

function contentOf(node: JSONContent): JSONContent[] {
  return Array.isArray(node.content) ? node.content : [];
}

function renderInlineContent(
  nodes: JSONContent[],
  context: RenderContext,
): string {
  return nodes.map((node) => renderInline(node, context)).join("");
}

function renderBlocks(nodes: JSONContent[], context: RenderContext): string {
  return nodes.map((node) => renderBlock(node, context)).join("\n");
}

function wrapContainer(open: string, body: string, close: string): string {
  return body ? `${open}\n${body}\n${close}` : `${open}${close}`;
}

function renderMark(
  mark: NonNullable<JSONContent["marks"]>[number],
  inner: string,
): string {
  switch (mark.type) {
    case "bold":
      return `<strong>${inner}</strong>`;
    case "italic":
      return `<em>${inner}</em>`;
    case "strike":
      return `<s>${inner}</s>`;
    case "underline":
      return `<u>${inner}</u>`;
    case "code":
      return `<code>${inner}</code>`;
    case "link": {
      const attrs = mark.attrs ?? {};
      if (typeof attrs.href !== "string") {
        throw new Error("Link mark requires a string href");
      }
      const target = safeUrl(attrs.href);
      let htmlAttributes = "";
      // An unsafe scheme is dropped, not copied into the exported document.
      if (target !== null)
        htmlAttributes += ` href="${escapeAttribute(target)}"`;
      for (const name of ["target", "rel", "class"] as const) {
        const value = attrs[name];
        if (typeof value === "string" && value !== "") {
          htmlAttributes += ` ${name}="${escapeAttribute(value)}"`;
        }
      }
      return `<a${htmlAttributes}>${inner}</a>`;
    }
    default:
      throw new Error(`Unsupported rich block mark: ${String(mark.type)}`);
  }
}

function renderText(node: JSONContent): string {
  const text = typeof node.text === "string" ? node.text : "";
  const marks = node.marks ?? [];
  return marks.reduceRight(
    (inner, mark) => renderMark(mark, inner),
    escapeText(text),
  );
}

function renderInline(node: JSONContent, context: RenderContext): string {
  if (!node || typeof node !== "object") {
    throw new Error("Rich block contains an invalid inline node");
  }
  if (node.type === "text") return renderText(node);
  if (node.type === "hardBreak") return "<br>";
  throw new Error(
    `Unsupported inline node in rich block: ${String(node.type)}`,
  );
}

/**
 * Encode code-block text without introducing a literal blank line. Blank or
 * whitespace-only lines are represented with character references so the whole
 * callout/table remains a single HTML block to the Markdown lexer.
 */
function encodeCodeText(value: string): string {
  const lines = value.split("\n");
  const encodeLine = (line: string): string => {
    const escaped = escapeMarkup(line).replace(/\r/g, "&#13;");
    if (line !== "" && line.trim() === "") {
      return escaped.replace(/ /g, "&#32;").replace(/\t/g, "&#9;");
    }
    return escaped;
  };

  let output = encodeLine(lines[0]);
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    output += previous.trim() === "" ? "&#10;" : "\n";
    output += encodeLine(lines[index]);
  }
  return output;
}

function renderCodeBlock(node: JSONContent): string {
  let source = "";
  for (const child of contentOf(node)) {
    if (child.type === "text") {
      if (child.marks && child.marks.length > 0) {
        throw new Error("Marks inside a code block are not supported");
      }
      source += typeof child.text === "string" ? child.text : "";
    } else if (child.type === "hardBreak") {
      source += "\n";
    } else {
      throw new Error(
        `Unsupported node inside a code block: ${String(child.type)}`,
      );
    }
  }

  const language = attrsOf(node).language;
  let htmlAttributes = "";
  if (typeof language === "string" && language !== "") {
    htmlAttributes = ` class="language-${escapeAttribute(language)}"`;
  } else if (language !== null && language !== undefined) {
    throw new Error("Unsupported code block language value");
  }

  return `<pre><code${htmlAttributes}>${encodeCodeText(source)}</code></pre>`;
}

function renderImage(node: JSONContent): string {
  const attrs = attrsOf(node);
  let htmlAttributes = "";
  const src = safeUrl(attrs.src);
  if (src !== null) htmlAttributes += ` src="${escapeAttribute(src)}"`;

  for (const name of ["alt", "title"] as const) {
    const value = attrs[name];
    if (typeof value === "string") {
      htmlAttributes += ` ${name}="${escapeAttribute(value)}"`;
    }
  }
  for (const name of ["width", "height"] as const) {
    const value = attrs[name];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      htmlAttributes += ` ${name}="${value}"`;
    }
  }
  return `<img${htmlAttributes}>`;
}

function renderList(node: JSONContent, context: RenderContext): string {
  const itemType = node.type === "taskList" ? "taskItem" : "listItem";
  const items = contentOf(node);
  if (items.length === 0) {
    throw new Error(`${String(node.type)} requires at least one item`);
  }
  if (items.some((item) => item.type !== itemType)) {
    throw new Error(`${String(node.type)} may only contain ${itemType} nodes`);
  }

  const listAttributes =
    node.type === "orderedList" ? orderedListAttributes(attrsOf(node)) : "";
  const tag = node.type === "orderedList" ? "ol" : "ul";
  const typeAttribute = node.type === "taskList" ? ` data-type="taskList"` : "";
  const body = items
    .map((item) => renderListItem(item, context, node.type === "taskList"))
    .join("\n");
  return wrapContainer(
    `<${tag}${typeAttribute}${listAttributes}>`,
    body,
    `</${tag}>`,
  );
}

function orderedListAttributes(attrs: Record<string, any>): string {
  let attributes = "";

  const start = attrs.start;
  if (start !== null && start !== undefined) {
    if (typeof start !== "number" || !Number.isInteger(start)) {
      throw new Error("Unsupported ordered list start value");
    }
    if (start !== 1) attributes += ` start="${start}"`;
  }

  const type = attrs.type;
  if (type !== null && type !== undefined) {
    if (typeof type !== "string" || !ORDERED_LIST_TYPES.has(type)) {
      throw new Error("Unsupported ordered list type value");
    }
    if (type !== "1") attributes += ` type="${type}"`;
  }

  return attributes;
}

function renderListItem(
  node: JSONContent,
  context: RenderContext,
  isTask: boolean,
): string {
  const body = renderBlocks(contentOf(node), context);
  if (isTask) {
    const checked = attrsOf(node).checked === true ? "true" : "false";
    return wrapContainer(
      `<li data-type="taskItem" data-checked="${checked}">`,
      body,
      "</li>",
    );
  }
  return wrapContainer("<li>", body, "</li>");
}

function assertSimpleCell(attrs: Record<string, any>): void {
  for (const name of ["colspan", "rowspan"] as const) {
    const value = attrs[name];
    if (value !== null && value !== undefined && value !== 1) {
      throw new Error("Merged table cells are not supported");
    }
  }
  const colwidth = attrs.colwidth;
  if (colwidth !== null && colwidth !== undefined) {
    throw new Error("Table column widths are not supported");
  }
}

function renderTableCell(node: JSONContent, context: RenderContext): string {
  if (context.insideTable) {
    throw new Error("Nested tables are not supported");
  }
  assertSimpleCell(attrsOf(node));

  const children = contentOf(node);
  if (children.length === 0) {
    throw new Error(`${String(node.type)} requires at least one paragraph`);
  }
  if (children.some((child) => child.type !== "paragraph")) {
    throw new Error(`Table cells may only contain paragraphs`);
  }

  const body = renderBlocks(children, { ...context, insideTable: true });
  const tag = node.type === "tableHeader" ? "th" : "td";
  return wrapContainer(`<${tag}>`, body, `</${tag}>`);
}

function renderTableRow(node: JSONContent, context: RenderContext): string {
  const cells = contentOf(node);
  if (cells.length === 0) {
    throw new Error("A table row requires at least one cell");
  }
  if (
    cells.some(
      (cell) => cell.type !== "tableCell" && cell.type !== "tableHeader",
    )
  ) {
    throw new Error("A table row may only contain table cells");
  }
  const body = cells.map((cell) => renderTableCell(cell, context)).join("\n");
  return wrapContainer("<tr>", body, "</tr>");
}

function renderTable(node: JSONContent, context: RenderContext): string {
  if (context.insideTable) {
    throw new Error("Nested tables are not supported");
  }
  const rows = contentOf(node);
  if (rows.length === 0) {
    throw new Error("A table requires at least one row");
  }
  if (rows.length > MAX_TABLE_ROWS) {
    throw new Error(`A table may not exceed ${MAX_TABLE_ROWS} rows`);
  }
  if (rows.some((row) => row.type !== "tableRow")) {
    throw new Error("A table may only contain table rows");
  }

  const columnCounts = rows.map((row) => contentOf(row).length);
  const columns = columnCounts[0];
  if (columns < 1 || columns > MAX_TABLE_COLUMNS) {
    throw new Error(
      `A table must have between 1 and ${MAX_TABLE_COLUMNS} columns`,
    );
  }
  if (columnCounts.some((count) => count !== columns)) {
    throw new Error("Table rows must have the same number of cells");
  }

  const body = rows.map((row) => renderTableRow(row, context)).join("\n");
  return wrapContainer("<table>\n<tbody>", body, "</tbody>\n</table>");
}

function renderDetails(node: JSONContent, context: RenderContext): string {
  const children = contentOf(node);
  if (
    children.length !== 2 ||
    children[0].type !== "detailsSummary" ||
    children[1].type !== "detailsContent"
  ) {
    throw new Error(
      "A details block requires exactly a summary and details content",
    );
  }

  const summary = renderInlineContent(contentOf(children[0]), context);
  const body = renderBlocks(contentOf(children[1]), context);
  const open = attrsOf(node).open === true ? " open" : "";
  const content = wrapContainer(
    '<div data-type="detailsContent">',
    body,
    "</div>",
  );
  return `<details${open}>\n<summary>${summary}</summary>\n${content}\n</details>`;
}

function renderBlock(node: JSONContent, context: RenderContext): string {
  if (!node || typeof node !== "object") {
    throw new Error("Rich block contains an invalid node");
  }
  switch (node.type) {
    case "doc":
      return renderBlocks(contentOf(node), context);
    case "callout": {
      const tone = attrsOf(node).tone ?? "note";
      if (typeof tone !== "string" || !CALLOUT_TONES.has(tone)) {
        throw new Error(`Unsupported callout tone: ${String(tone)}`);
      }
      const body = renderBlocks(contentOf(node), context);
      return wrapContainer(
        `<aside data-folio-callout="" data-tone="${tone}">`,
        body,
        "</aside>",
      );
    }
    case "paragraph":
      return `<p>${renderInlineContent(contentOf(node), context)}</p>`;
    case "heading": {
      const level = attrsOf(node).level;
      if (
        typeof level !== "number" ||
        !Number.isInteger(level) ||
        level < 1 ||
        level > 6
      ) {
        throw new Error(`Unsupported heading level: ${String(level)}`);
      }
      return `<h${level}>${renderInlineContent(contentOf(node), context)}</h${level}>`;
    }
    case "blockquote":
      return wrapContainer(
        "<blockquote>",
        renderBlocks(contentOf(node), context),
        "</blockquote>",
      );
    case "bulletList":
    case "orderedList":
    case "taskList":
      return renderList(node, context);
    case "listItem":
      return renderListItem(node, context, false);
    case "taskItem":
      return renderListItem(node, context, true);
    case "codeBlock":
      return renderCodeBlock(node);
    case "horizontalRule":
      return "<hr>";
    case "image":
      return renderImage(node);
    case "details":
      return renderDetails(node, context);
    case "detailsSummary":
      return `<summary>${renderInlineContent(contentOf(node), context)}</summary>`;
    case "detailsContent":
      return wrapContainer(
        '<div data-type="detailsContent">',
        renderBlocks(contentOf(node), context),
        "</div>",
      );
    case "table":
      return renderTable(node, context);
    case "tableRow":
      return renderTableRow(node, context);
    case "tableCell":
    case "tableHeader":
      return renderTableCell(node, context);
    default:
      throw new Error(`Unsupported rich block node: ${String(node.type)}`);
  }
}

/**
 * Render a callout/table subtree as readable, standard HTML.
 *
 * The output contains no block IDs and no hidden JSON copy. Unsupported node
 * or mark types throw so an export dialog can surface a real failure instead
 * of saving a lossy document.
 */
export function renderRichBlockHTML(node: JSONContent): string {
  if (!node || typeof node !== "object") {
    throw new Error("Rich block is not a node");
  }
  return renderBlock(node, {});
}
