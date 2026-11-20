export const ATTACHMENT_MAX_BYTES = 20_000_000;
export const ATTACHMENT_MAX_BASE64 = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;
export type AttachedFile = {url: string; name: string; image: boolean};

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const safeName = new RegExp(
  "^" + uuid + "(?:\\.[^/\\\\\\x00-\\x20%?#:]{1,200})?$",
  "i",
);
export function parseAssetURL(value: string): string | null {
  try {
    if (!value.startsWith("folio-asset://")) return null;
    const url = new URL(value),
      name = decodeURIComponent(url.hostname);
    if (
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname) ||
      !safeName.test(name)
    )
      return null;
    return name;
  } catch {
    return null;
  }
}
