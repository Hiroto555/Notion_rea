// File payloads use UTF-8 bytes everywhere (not JS UTF-16 string length).
export const FILE_MAX_BYTES = 30_000_000;
export const utf8Bytes = (value: string) =>
  new TextEncoder().encode(value).byteLength;
export const fileFits = (value: string) => utf8Bytes(value) <= FILE_MAX_BYTES;
