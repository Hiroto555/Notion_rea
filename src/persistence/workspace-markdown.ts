import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { MarkdownManager } from "@tiptap/markdown";
import { extensions } from "../shared/editor-schema";
import { parseAssetURL, ATTACHMENT_MAX_BYTES } from "../shared/assets";
import type {
  Doc,
  Property,
  RecordProjection,
  RecordRow,
} from "../shared/types";
import { exportMarkdown } from "../document-io/markdown";
import { assertExternalOutput, assertOutsideFolioData } from "./output-path";
import { resolveAsset, type Asset } from "./assets";
import { privatePersistencePort } from "../platform/private-persistence";
import { writeNewFileDurably } from "./durable-file";
import type { Store } from "./store";

function slug(title: string) {
  let name =
    Array.from(
      title.normalize("NFC").replace(/[<>:"/\\|?*#%\u0000-\u001f]/g, "_"),
    )
      .slice(0, 48)
      .join("")
      .trim()
      .replace(/[. ]+$/g, "") || "無題";
  if (
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ||
    name.startsWith(".")
  )
    name = "_" + name;
  return name;
}

function recordsCSV(
  properties: Property[],
  rows: readonly Pick<RecordRow, "title" | "values">[],
) {
  const line = (values: unknown[]) =>
    values
      .map((v) => '"' + String(v ?? "").replaceAll('"', '""') + '"')
      .join(",");
  return (
    [
      line(["タイトル", ...properties.map((p) => p.name)]),
      ...rows.map((r) =>
        line([r.title, ...properties.map((p) => r.values[p.id])]),
      ),
    ].join("\r\n") + "\r\n"
  );
}

/** Produce human-readable external files from one committed snapshot. A
 * marked, partial folder remains available if the output volume fills up. */
export function exportWorkspaceMarkdown(
  store: Store,
  assets: string,
  parent: string,
  now = new Date(),
): string {
  assertExternalOutput(dirname(store.path), parent);
  assertOutsideFolioData(parent);
  return store.readSnapshot(() =>
    writeMarkdownSnapshot(store, assets, parent, now),
  );
}

function writeMarkdownSnapshot(
  store: Store,
  assets: string,
  parent: string,
  now: Date,
): string {
  const native = privatePersistencePort();
  const mkdir = (p: string) => {
    if (native) native.createDirectory(p);
    else mkdirSync(p, { mode: 0o700 });
  };
  const write = (p: string, bytes: Buffer) => {
    if (native) return native.writeNew(p, bytes, bytes.length).identity;
    writeNewFileDurably(p, bytes, { mode: 0o600, syncParentDirectory: true });
  };
  const snapshot = store.load();
  if (snapshot.pages.some((p) => p.documentError))
    throw new Error(
      "読めないページがあります。「DB・添付・復旧記録を救出」で原本を保存してください。",
    );
  const pad = (n: number) => String(n).padStart(2, "0");
  const date =
    [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("") +
    "-" +
    [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join("");
  const stem = join(parent, "folio-export-" + date);
  let root = stem;
  for (let n = 2; ; n++) {
    if (!existsSync(root)) {
      try {
        mkdir(root);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    root = stem + "-" + n;
  }
  const markerPath = join(root, "FOLIO-EXPORT-INCOMPLETE");
  const marker = write(
    markerPath,
    Buffer.from("書き出しが完了していません。\n"),
  );
  try {
    const assetDir = join(root, "assets"),
      trashDir = join(root, "ゴミ箱");
    mkdir(assetDir);
    if (snapshot.pages.some((p) => p.deletedAt !== null)) mkdir(trashDir);
    const used = new Map<string, Set<string>>();
    used.set(root, new Set(["assets", "ゴミ箱", "folio-export-incomplete"]));
    function childDirectory(parentPath: string, title: string) {
      let names = used.get(parentPath);
      if (!names)
        used.set(parentPath, (names = new Set(["index.md", "records.csv"])));
      const base = slug(title);
      let name = base;
      for (
        let n = 2;
        names.has(name.toLowerCase()) || existsSync(join(parentPath, name));
        n++
      )
        name = base + "-" + n;
      names.add(name.toLowerCase());
      const path = join(parentPath, name);
      mkdir(path);
      return path;
    }
    const pages = new Map(snapshot.pages.map((p) => [p.id, p]));
    const recordOwners = new Map<string, string>();
    const recordsByOwner = new Map<string, RecordProjection[]>();
    for (const record of snapshot.records ?? []) {
      recordOwners.set(record.pageId, record.databasePageId);
      const group = recordsByOwner.get(record.databasePageId);
      if (group) group.push(record);
      else recordsByOwner.set(record.databasePageId, [record]);
    }
    const paths = new Map<string, string>(),
      visiting = new Set<string>();
    function directory(id: string): string {
      const known = paths.get(id);
      if (known) return known;
      const page = pages.get(id);
      if (!page || visiting.has(id)) throw new Error("ページ階層が不正です。");
      visiting.add(id);
      const owner = recordOwners.get(id) ?? page.parentId;
      const sameTree =
        owner !== null &&
        (pages.get(owner)?.deletedAt === null) === (page.deletedAt === null);
      if (owner !== null && !pages.has(owner))
        throw new Error("ページの親が見つかりません。");
      const folder = childDirectory(
        sameTree
          ? directory(owner!)
          : page.deletedAt === null
            ? root
            : trashDir,
        page.title,
      );
      visiting.delete(id);
      paths.set(id, folder);
      return folder;
    }
    const markdown = new MarkdownManager({ extensions: extensions() });
    const copies = new Map<string, string>();
    function localAsset(url: string, folder: string) {
      const id = parseAssetURL(url);
      if (!id) throw new Error("添付URLが不正です。");
      let target = copies.get(id);
      if (!target) {
        const file = resolveAsset(store.db, assets, url);
        const registry = store.db
          .prepare("SELECT metadata FROM assets WHERE id=?")
          .get(id);
        const metadata: Asset | undefined = registry
          ? JSON.parse(String(registry.metadata))
          : undefined;
        const extension = extname(file.name);
        const fallback: Record<string, string> = {
          "image/png": ".png",
          "image/jpeg": ".jpg",
          "image/gif": ".gif",
          "image/webp": ".webp",
          "application/pdf": ".pdf",
        };
        const suffix = /^\.[a-z0-9]{1,12}$/i.test(extension)
          ? extension.toLowerCase()
          : (fallback[file.mime] ?? ".bin");
        target = join(
          assetDir,
          id.split(".")[0] +
            (id.includes(".")
              ? "-" + createHash("sha256").update(id).digest("hex").slice(0, 16)
              : "") +
            suffix,
        );
        if (statSync(file.path).size > ATTACHMENT_MAX_BYTES)
          throw new Error("添付の上限を超えています。");
        const bytes = native
          ? Buffer.from(
              native.read(
                file.path,
                native.inspectFile(file.path, ATTACHMENT_MAX_BYTES),
                ATTACHMENT_MAX_BYTES,
              ),
            )
          : readFileSync(file.path);
        if (
          metadata &&
          (bytes.length !== metadata.size ||
            createHash("sha256").update(bytes).digest("hex") !==
              metadata.sha256)
        )
          throw new Error("添付の内容が登録情報と一致しません。");
        write(target, bytes);
        copies.set(id, target);
      }
      return relative(folder, target)
        .split(sep)
        .map(encodeURIComponent)
        .join("/");
    }
    function rewrite(node: Doc, folder: string) {
      if (
        node.type === "image" &&
        typeof node.attrs?.src === "string" &&
        node.attrs.src.startsWith("folio-asset://")
      )
        node.attrs.src = localAsset(node.attrs.src, folder);
      for (const mark of node.marks ?? [])
        if (
          mark.type === "link" &&
          typeof mark.attrs?.href === "string" &&
          mark.attrs.href.startsWith("folio-asset://")
        )
          mark.attrs.href = localAsset(mark.attrs.href, folder);
      node.content?.forEach((child) => rewrite(child, folder));
    }
    const registered = new Set(snapshot.recordDatabaseIds);
    for (const page of snapshot.pages) {
      const folder = directory(page.id);
      rewrite(page.doc, folder);
      let body = markdown.serialize(page.doc);
      if (page.cover.startsWith("folio-asset://"))
        body = "![](" + localAsset(page.cover, folder) + ")\n\n" + body;
      write(
        join(folder, "index.md"),
        Buffer.from(exportMarkdown(page.title, body)),
      );
      if (page.database) {
        const rows = registered.has(page.id)
          ? (recordsByOwner.get(page.id) ?? []).filter(
              (r) => page.deletedAt !== null || r.deletedAt === null,
            )
          : page.database.rows;
        write(
          join(folder, "records.csv"),
          Buffer.from(recordsCSV(page.database.properties, rows)),
        );
        if (!registered.has(page.id))
          for (const row of rows) {
            const fields = page.database.properties
              .map((p) => p.name + " = " + String(row.values[p.id] ?? ""))
              .join("\n\n");
            write(
              join(childDirectory(folder, row.title), "index.md"),
              Buffer.from(exportMarkdown(row.title, fields)),
            );
          }
      }
    }
    if (native && marker) native.unlinkExact(markerPath, marker, 4096);
    else unlinkSync(markerPath);
    return root;
  } catch (cause) {
    throw new Error(
      "Markdown書き出しが中断しました。未完了のフォルダー " +
        root +
        " (" +
        (cause instanceof Error ? cause.message : String(cause)) +
        ")",
      { cause },
    );
  }
}
