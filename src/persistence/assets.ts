import { readFileSync, statSync, lstatSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseAssetURL } from "../shared/assets";
import { writeNewFileDurably } from "./durable-file";
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
export function attachFile(db: DatabaseSync, assets: string, file: string, beforeWrite?: (actualBytes: number) => void) {
  const size = statSync(file).size;
  if (size > 20_000_000) throw new Error("添付の上限は20MBです");
  const bytes = readFileSync(file);
  if (bytes.length > 20_000_000) throw new Error("添付の上限は20MBです");
  // Admission runs after the exact bytes are known but before the asset file
  // or its metadata row is changed. A refusal therefore leaves no trace.
  beforeWrite?.(bytes.length);
  const id = randomUUID(),
    extension = extname(file),
    mime = mimes[extension.toLowerCase()] || "application/octet-stream";
  const metadata: Asset = {
    id,
    name: basename(file),
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
  writeNewFileDurably(dest, bytes, {
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
export function resolveAsset(db: DatabaseSync, assets: string, url: string) {
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
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile())
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
