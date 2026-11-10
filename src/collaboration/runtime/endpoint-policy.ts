import { CollaborationError, wellFormed } from "./contract";

const MAX_ENDPOINT_LENGTH = 2048;
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function fail(): never {
  throw new CollaborationError("INVALID_URL");
}

function isIPv6(value: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;
  const halves = value.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right =
    halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  let groups = left.concat(right);
  let width = 0;
  if (groups.length > 0 && groups[groups.length - 1].includes(".")) {
    const tail = groups[groups.length - 1];
    if (!IPV4.test(tail)) return false;
    groups = groups.slice(0, -1);
    width = 2;
  }
  if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return false;
  const used = groups.length + width;
  if (halves.length === 2) return used <= 7;
  return used === 8;
}

function isBracketedIPv6(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const inner = hostname.slice(1, -1).toLowerCase();
  if (inner === "::") return false;
  return isIPv6(inner);
}

function isDnsHost(hostname: string): boolean {
  if (hostname.length < 1 || hostname.length > 253) return false;
  if (hostname.endsWith(".")) return false;
  if (/^[0-9.]+$/.test(hostname)) return false;
  return hostname.split(".").every((label) => DNS_LABEL.test(label));
}

function isHttpsHost(hostname: string): boolean {
  if (hostname === "0.0.0.0") return false;
  if (hostname.startsWith("[")) return isBracketedIPv6(hostname);
  if (IPV4.test(hostname)) return true;
  return isDnsHost(hostname);
}

export function normalizeSharedEndpoint(url: string): string {
  if (
    typeof url !== "string" ||
    url.length < 1 ||
    url.length > MAX_ENDPOINT_LENGTH ||
    !wellFormed(url)
  )
    return fail();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail();
  }
  if (parsed.username !== "" || parsed.password !== "") return fail();
  if (parsed.search !== "" || parsed.hash !== "") return fail();
  if (parsed.pathname !== "/") return fail();
  const port = parsed.port;
  if (port === "") return fail();
  const numericPort = Number(port);
  if (
    !Number.isSafeInteger(numericPort) ||
    numericPort < 1 ||
    numericPort > 65535
  )
    return fail();
  const hostname = parsed.hostname;
  if (parsed.protocol === "http:") {
    if (hostname !== "127.0.0.1") return fail();
  } else if (parsed.protocol === "https:") {
    if (!isHttpsHost(hostname)) return fail();
  } else {
    return fail();
  }
  const canonicalUrl = `${parsed.protocol}//${hostname}:${port}`;
  if (url !== canonicalUrl && url !== `${canonicalUrl}/`) return fail();
  return canonicalUrl;
}
