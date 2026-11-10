import Image from "@tiptap/extension-image";
export type SharedImageResolver = (
  hash: string,
) => Promise<{ base64: string; mediaType: string }>;
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** A shared image never falls through to the private folio-asset handler or an
 * external URL. Resolved bytes affect this node view only, never document JSON. */
export function sharedImage(resolver: SharedImageResolver) {
  return Image.extend({
    addNodeView() {
      return ({ node: initial }) => {
        const dom = document.createElement("span"),
          img = document.createElement("img");
        let live = true,
          ticket = 0,
          source: unknown;
        dom.contentEditable = "false";
        dom.setAttribute("data-shared-image", "");
        const load = (node: typeof initial) => {
          img.alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
          if (source === node.attrs.src) return;
          source = node.attrs.src;
          const current = ++ticket;
          img.removeAttribute("src");
          dom.replaceChildren(document.createTextNode("共有画像を取得中…"));
          const match =
            typeof source === "string"
              ? /^folio-asset:\/\/([a-f0-9]{64})\/?$/.exec(source)
              : null;
          if (!match) {
            dom.textContent = "この共有画像の参照形式は未対応です。";
            return;
          }
          void resolver(match[1])
            .then((value) => {
              if (!live || ticket !== current) return;
              if (
                !imageTypes.has(value.mediaType) ||
                value.base64.length > 28_000_000 ||
                value.base64.length % 4 !== 0 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)
              )
                throw new Error("UNSUPPORTED_SHARED_IMAGE");
              img.src = "data:" + value.mediaType + ";base64," + value.base64;
              dom.replaceChildren(img);
            })
            .catch(() => {
              if (live && ticket === current)
                dom.textContent =
                  "共有画像を取得できません。権限と接続を確認してください。";
            });
        };
        load(initial);
        return {
          dom,
          update(node) {
            if (node.type !== initial.type) return false;
            load(node);
            return true;
          },
          destroy() {
            live = false;
            ticket++;
            img.removeAttribute("src");
            dom.replaceChildren();
          },
          ignoreMutation: () => true,
        };
      };
    },
  }).configure({ allowBase64: true });
}
