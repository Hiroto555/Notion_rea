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
