import { readFileSync, statSync, lstatSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_BASE64, parseAssetURL } from "../shared/assets";
import { writeNewFileDurably } from "./durable-file";
import { privatePersistencePort, type PrivatePersistenceOptions } from "../platform/private-persistence";
const mimes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".pdf": "application/pdf",
};
export type Asset = {
  id: string;
  name: string;
  extension: string;
  mime: string;
  storageName: string;
  size: number;
  sha256: string;
};
export function attachFile(db: DatabaseSync, assets: string, file: string, beforeWrite?: (actualBytes: number) => void,
  options?: PrivatePersistenceOptions) {
  if (statSync(file).size > ATTACHMENT_MAX_BYTES) throw new Error("添付の上限は20MBです");
  return attachBuffer(db, assets, basename(file), "", readFileSync(file), beforeWrite, options);
}

export function decodeAttachment(data: string): Buffer {
  if (data.length > ATTACHMENT_MAX_BASE64 || data.length % 4 !== 0)
    throw new Error("添付データの長さが不正です。");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > ATTACHMENT_MAX_BYTES || bytes.toString("base64") !== data)
    throw new Error("添付データが不正です。");
  return bytes;
}

export function attachBuffer(db: DatabaseSync, assets: string, name: string, mediaType: string, bytes: Buffer,
  beforeWrite?: (actualBytes: number) => void, options?: PrivatePersistenceOptions) {
  const native = privatePersistencePort(options);
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw new Error("添付の上限は20MBです");
  if (!name || name === "." || name === ".." || /[\/\\\x00-\x1f]/.test(name)) throw new Error("添付名が不正です。");
  // Admission runs after the exact bytes are known but before the asset file
  // or its metadata row is changed. A refusal therefore leaves no trace.
  beforeWrite?.(bytes.length);
  const id = randomUUID(),
    extension = extname(name),
    mime = mimes[extension.toLowerCase()] || (Object.values(mimes).includes(mediaType) ? mediaType : "application/octet-stream");
  const metadata: Asset = {
    id,
    name,
    extension,
    mime,
    storageName: id,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const dest = join(assets, id);
  // The attachment body and its directory entry must be durable before the
  // metadata row can reference them. An existing file is never replaced
  // (exclusive create), and a failed write/fsync removes only this new file.
  if (native) native.writeNew(dest, bytes, ATTACHMENT_MAX_BYTES);
  else writeNewFileDurably(dest, bytes, {
    mode: 0o600,
    syncParentDirectory: true,
  });
  // An INSERT exception does not prove that no row became durable. Keep dest
  // conservatively rather than turn an uncertain outcome into a dangling
  // reference. A rolled-back insert may therefore leave an orphan file.
  db.prepare("INSERT INTO assets(id,metadata) VALUES(?,?)").run(
    id,
    JSON.stringify(metadata),
  );
  return {
    url: "folio-asset://" + id,
    image: mime.startsWith("image/"),
    ...metadata,
  };
}
export function resolveAsset(db: DatabaseSync, assets: string, url: string, options?: PrivatePersistenceOptions) {
  const native = privatePersistencePort(options);
  const id = parseAssetURL(url);
  if (!id) throw new Error("添付URLが不正です");
  const row = db.prepare("SELECT metadata FROM assets WHERE id=?").get(id) as
    { metadata: string } | undefined;
  const metadata: Asset | undefined = row
    ? JSON.parse(row.metadata)
    : undefined;
  // Registry values are never accepted as arbitrary filesystem paths.
  if (metadata && (metadata.storageName !== id || metadata.id !== id))
    throw new Error("添付情報が不正です");
  const path = join(assets, id);
  if (native) native.inspectFileIdentity(path);
  else if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile())
    throw new Error("添付ファイルを開けません");
  return {
    path,
    name: metadata?.name || id,
    mime:
      metadata?.mime ||
      mimes[extname(id).toLowerCase()] ||
      "application/octet-stream",
  };
}
