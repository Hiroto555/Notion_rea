import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import runtime from "./runtime-semantic.cjs";

const hash = "a".repeat(64),
  url = "folio-asset://" + hash,
  type = { name: "image" };
const image = (src = url) => ({ type, attrs: { src, alt: "画像" } });
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function withDom(work) {
  const previous = globalThis.document;
  const dom = new JSDOM("<!doctype html>");
  globalThis.document = dom.window.document;
  try {
    await work();
  } finally {
    globalThis.document = previous;
    dom.window.close();
  }
}
const view = (resolver, node = image()) =>
  runtime.sharedImage(resolver).config.addNodeView()({ node });

test("shared image resolves scoped bytes without changing JSON or touching the private protocol", () =>
  withDom(async () => {
    const node = image(),
      before = JSON.stringify(node),
      calls = [];
    const result = view(async (value) => {
      calls.push(value);
      return { base64: "iVBORw0KGgo=", mediaType: "image/png" };
    }, node);
    assert.equal(result.dom.querySelector("img"), null);
    await tick();
    assert.deepEqual(calls, [hash]);
    assert.equal(
      result.dom.querySelector("img").getAttribute("src"),
      "data:image/png;base64,iVBORw0KGgo=",
    );
    assert.equal(JSON.stringify(node), before);
    result.destroy();
    assert.equal(result.dom.childNodes.length, 0);
  }));
test("shared image refuses private UUID and external URLs without resolving them", () =>
  withDom(async () => {
    for (const src of [
      "folio-asset://12345678-1234-1234-1234-123456789012",
      "https://example.invalid/private",
      "data:image/svg+xml,<svg/>",
    ]) {
      let calls = 0;
      const result = view(async () => {
        calls++;
        throw new Error("must not run");
      }, image(src));
      await tick();
      assert.equal(calls, 0);
      assert.equal(result.dom.querySelector("img"), null);
      result.destroy();
    }
  }));
test("shared image discards late bytes after its reference changes or its view is destroyed", () =>
  withDom(async () => {
    let release;
    const result = view(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    result.update(image("https://example.invalid/"));
    release({ base64: "iVBORw0KGgo=", mediaType: "image/png" });
    await tick();
    assert.equal(result.dom.querySelector("img"), null);
    let releaseAgain;
    const other = view(
      () =>
        new Promise((resolve) => {
          releaseAgain = resolve;
        }),
    );
    other.destroy();
    releaseAgain({ base64: "iVBORw0KGgo=", mediaType: "image/png" });
    await tick();
    assert.equal(other.dom.childNodes.length, 0);
  }));
test("shared image refuses executable or unsupported media", () =>
  withDom(async () => {
    const result = view(async () => ({
      base64: "PHN2Zy8+",
      mediaType: "image/svg+xml",
    }));
    await tick();
    assert.equal(result.dom.querySelector("img"), null);
    result.destroy();
  }));
