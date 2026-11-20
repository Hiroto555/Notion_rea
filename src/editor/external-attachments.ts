import type { JSONContent } from "@tiptap/core";
import { ATTACHMENT_MAX_BYTES, parseAssetURL, type AttachedFile } from "../shared/assets";

export async function attachmentPayload(file: File) {
  if (file.size > ATTACHMENT_MAX_BYTES) throw new Error("添付の上限は20MBです。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw new Error("添付の読み取り中にサイズが変わりました。");
  // Chunk size is divisible by three, so padding occurs only in the final chunk.
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 24_576)
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24_576))));
  return {name: file.name, mime: file.type, dataBase64: chunks.join("")};
}

export function attachmentNode(file: AttachedFile): JSONContent {
  if (!file || !parseAssetURL(file.url) || typeof file.name !== "string" || typeof file.image !== "boolean")
    throw new Error("添付の保存結果を確認できません。");
  return file.image ? {type: "image", attrs: {src: file.url, alt: file.name}} :
    {type: "paragraph", content: [{type: "text", text: "📎 " + file.name,
      marks: [{type: "link", attrs: {href: file.url}}]}]};
}
