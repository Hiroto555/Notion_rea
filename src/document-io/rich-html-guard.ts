import type { Doc } from "../shared/types";
import { MarkdownManager } from "@tiptap/markdown";
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS } from "../shared/rich-document";
/** Check HTML before ProseMirror can fit or repair an unsupported table. */
export function assertSupportedRichHTML(html: string): void {
  if (!/<(?:table|aside|img)\b/i.test(html)) return;
  const dom = new DOMParser().parseFromString(html, "text/html");
  for (const img of dom.querySelectorAll("img[src]")) assertImageSource(img.getAttribute("src"));
  for (const callout of dom.querySelectorAll("aside[data-folio-callout]")) {
    const tone = callout.getAttribute("data-tone");
    if (tone !== null && !["note", "tip", "warning"].includes(tone))
      throw new Error("未対応のコールアウトです。元の内容を保持しています。");
  }
  for (const table of dom.querySelectorAll("table")) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (table.closest("td, th") || !rows.length || rows.length > MAX_TABLE_ROWS)
      throw new Error("表は100行・20列までです。入れ子の表は取り込めません。");
    let columns = 0;
    for (const row of rows) {
      const cells = Array.from(row.children);
      if (!columns) columns = cells.length;
      if (
        !columns ||
        columns > MAX_TABLE_COLUMNS ||
        cells.length !== columns ||
        cells.some((cell) => !["TD", "TH"].includes(cell.tagName))
      )
        throw new Error(
          "行ごとの列数が異なる表は取り込めません。元の内容を保持しています。",
        );
      for (const cell of cells) {
        if (
          ["colspan", "rowspan"].some(
            (attr) =>
              cell.hasAttribute(attr) && cell.getAttribute(attr) !== "1",
          )
        )
          throw new Error(
            "結合セルには対応していません。元の表を保持しています。",
          );
        if (
          cell.querySelector(
            "table, aside, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6, img, hr, details",
          )
        )
          throw new Error(
            "表のセルには文章と文字の装飾を入れられます。未対応の内容は取り込まず保持しています。",
          );
      }
    }
  }
}

/** Inspect only Markdown HTML tokens, leaving literal/fenced examples alone. */
export function assertSupportedRichMarkdown(markdown: string): void {
  const manager = new MarkdownManager({ extensions: [] });
  const lexer = new manager.instance.Lexer(manager.instance.defaults);
  const stack: unknown[] = [...lexer.lex(markdown)];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== "object") continue;
    const token = item as { type?: string; text?: string; raw?: string };
    if (token.type === "image") assertImageSource((item as {href?: string}).href);
    if (token.type === "html")
      assertSupportedRichHTML(token.text ?? token.raw ?? "");
    else if (token.type !== "code" && token.type !== "codespan")
      for (const [key, value] of Object.entries(item))
        if (key !== "links" && value && typeof value === "object")
          stack.push(value);
  }
}


// Apply only to incoming content. Historical inline images retain their schema.
export function assertImageSource(src: unknown) {
  if (typeof src === "string" && /^data:/i.test(src.trim().replace(/[\t\n\r]/g, "")))
    throw new Error("埋め込み画像は画像ファイルとして貼り付けるか、添付してください。");
}

export function assertImportedImages(doc: Doc): void {
  if (doc.type === "image") assertImageSource(doc.attrs?.src);
  for (const child of doc.content ?? []) assertImportedImages(child);
}
