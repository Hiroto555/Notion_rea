export type DocumentLink =
  | { kind: "page"; id: string }
  | { kind: "asset"; url: string }
  | { kind: "web"; url: string };

export function parseDocumentLink(href: string): DocumentLink | null {
  if (href.startsWith("folio-page://")) {
    const id = href.slice("folio-page://".length).replace(/\/$/, "");
    return id ? { kind: "page", id } : null;
  }
  if (href.startsWith("folio-asset://")) return { kind: "asset", url: href };
  if (/^https?:\/\//i.test(href)) return { kind: "web", url: href };
  return null;
}

export function documentLinkClickAction(input: {
  href: string;
  inEditableEditor: boolean;
  modifier: boolean;
}): "open" | "none" {
  const link = parseDocumentLink(input.href);
  if (!link) return "none";
  if (link.kind === "asset") return "open";
  if (input.inEditableEditor && !input.modifier) return "none";
  return "open";
}

export function normalizeWebLink(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.length || trimmed.length > 2048) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function describeDocumentLink(
  href: string,
  pageTitle: (id: string) => string | undefined,
): string {
  const link = parseDocumentLink(href);
  if (!link) return href;
  if (link.kind === "web") return link.url;
  if (link.kind === "asset") return "添付ファイル";
  const title = pageTitle(link.id);
  return title === undefined
    ? "見つからないページ"
    : `ページ「${title || "無題"}」`;
}
