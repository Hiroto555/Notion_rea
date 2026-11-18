import r from "../runtime/bundle.cjs";
import { JSDOM } from "jsdom";

const FRAGMENT = "prosemirror";
const REMOTE_ORIGIN = "adapter-b-remote-sync";
const MAX_SYNC_ROUNDS = 64;

const METHOD_GLOBALS = new Set([
  "getSelection",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
]);

let realm = null;
let realmUsers = 0;
const realmGlobals = [];
const GLOBAL_NAMES = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLDocument",
  "Text",
  "Comment",
  "Document",
  "DocumentFragment",
  "ShadowRoot",
  "Attr",
  "Range",
  "Selection",
  "DOMRect",
  "DOMRectReadOnly",
  "DOMParser",
  "XMLSerializer",
  "MutationObserver",
  "IntersectionObserver",
  "ResizeObserver",
  "getSelection",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "Event",
  "UIEvent",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "InputEvent",
  "CompositionEvent",
  "DragEvent",
  "ClipboardEvent",
  "FocusEvent",
  "WheelEvent",
  "NodeFilter",
  "NodeList",
  "HTMLCollection",
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripSchemaVersion(value) {
  const doc = cloneJson(value);
  if (doc && Object.prototype.hasOwnProperty.call(doc, "schemaVersion")) {
    delete doc.schemaVersion;
  }
  return doc;
}

function defineGlobal(name, value, saved) {
  const hadOwn = Object.prototype.hasOwnProperty.call(globalThis, name);
  const descriptor = hadOwn
    ? Object.getOwnPropertyDescriptor(globalThis, name)
    : undefined;
  let applied = false;
  try {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
    applied = true;
  } catch {
    applied = false;
  }
  if (!applied) {
    try {
      globalThis[name] = value;
      applied = true;
    } catch {
      applied = false;
    }
  }
  if (applied) saved.push({ name, hadOwn, descriptor });
}

function bindDomGlobals(win, saved) {
  for (const name of GLOBAL_NAMES) {
    const source = name === "window" ? win : win[name];
    if (source === undefined) continue;
    const value =
      METHOD_GLOBALS.has(name) && typeof source === "function"
        ? source.bind(win)
        : source;
    defineGlobal(name, value, saved);
  }
}

function restoreGlobals(saved) {
  for (let i = saved.length - 1; i >= 0; i -= 1) {
    const { name, hadOwn, descriptor } = saved[i];
    try {
      if (hadOwn && descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    } catch {
      try {
        if (hadOwn && descriptor && "value" in descriptor) {
          globalThis[name] = descriptor.value;
        }
      } catch {
        // A locked-down host global can only be left as it is.
      }
    }
  }
  saved.length = 0;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function normalizeDocumentBase(nodeOrJson) {
  const json =
    nodeOrJson && typeof nodeOrJson.toJSON === "function"
      ? nodeOrJson.toJSON()
      : nodeOrJson;
  return cloneJson(r.versionDocument(json));
}

export function createHarness({ document: inputDocument, clients = 2 } = {}) {
  const normalizeDocument = (node) => {
    const doc = normalizeDocumentBase(node);
    if (inputDocument.schemaVersion !== undefined)
      doc.schemaVersion = inputDocument.schemaVersion;
    return doc;
  };
  if (!Number.isInteger(clients) || clients < 1 || clients > 5) {
    throw new TypeError("B_INVALID_CLIENTS");
  }

  if (!r.inspectSharedDocument(JSON.stringify(inputDocument)).ok)
    throw new Error("B_INVALID_DOCUMENT");
  if (!realm) {
    realm = new JSDOM(
      "<!doctype html><html><head></head><body></body></html>",
      { url: "http://localhost/" },
    );
    bindDomGlobals(realm.window, realmGlobals);
  }
  const dom = realm;
  realmUsers++;
  const savedGlobals = realmGlobals;
  const views = [];
  const ydocs = [];
  const mounts = [];
  const cleanupErrors = [];
  let closed = false;
  let syncCalls = 0;
  let syncRounds = 0;
  let syncUpdates = 0;
  let syncConverged = true;

  function recordCleanupError(error) {
    cleanupErrors.push(String(error && error.message ? error.message : error));
  }

  function close() {
    if (closed) return;
    closed = true;

    const liveViews = views.splice(0).reverse();
    for (const view of liveViews) {
      try {
        view.destroy();
      } catch (error) {
        recordCleanupError(error);
      }
    }
    for (const ydoc of ydocs.splice(0)) {
      try {
        ydoc.destroy();
      } catch (error) {
        recordCleanupError(error);
      }
    }
    for (const mount of mounts.splice(0)) {
      try {
        mount.remove();
      } catch (error) {
        recordCleanupError(error);
      }
    }
    try {
      if (--realmUsers === 0) {
        restoreGlobals(realmGlobals);
        dom.window.close();
        realm = null;
      }
    } catch (error) {
      recordCleanupError(error);
    }
  }

  try {
    const stripped = stripSchemaVersion(inputDocument);
    const seedNode = r.documentSchema.nodeFromJSON(stripped);
    seedNode.check();

    const seedDoc = new r.Y.Doc();
    seedDoc.clientID = 1;
    r.prosemirrorToYXmlFragment(seedNode, seedDoc.getXmlFragment(FRAGMENT));
    const seedUpdate = r.Y.encodeStateAsUpdate(seedDoc);
    try {
      seedDoc.destroy();
    } catch (error) {
      recordCleanupError(error);
    }

    for (let index = 0; index < clients; index += 1) {
      const ydoc = new r.Y.Doc();
      ydoc.clientID = 1000 + index;
      r.Y.applyUpdate(ydoc, seedUpdate);
      ydocs.push(ydoc);

      const fragment = ydoc.getXmlFragment(FRAGMENT);
      const state = r.EditorState.create({
        schema: r.documentSchema,
        doc: r.documentSchema.nodeFromJSON(stripped),
        plugins: [
          r.richStructureGuardPlugin(),
          r.ySyncPlugin(fragment),
          r.yUndoPlugin(),
        ],
      });

      const mount = dom.window.document.createElement("div");
      dom.window.document.body.appendChild(mount);
      mounts.push(mount);

      const view = new r.EditorView(mount, { state });
      views.push(view);
    }
  } catch (error) {
    close();
    throw error;
  }

  function assertOpen() {
    if (closed) throw new Error("B_HARNESS_CLOSED");
  }

  function assertIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= views.length) {
      throw new RangeError("B_INVALID_INDEX");
    }
  }

  function allConverged() {
    if (views.length === 0) return true;
    const first = JSON.stringify(normalizeDocument(views[0].state.doc));
    for (let index = 1; index < views.length; index += 1) {
      if (JSON.stringify(normalizeDocument(views[index].state.doc)) !== first)
        return false;
    }
    return true;
  }

  function state(index) {
    assertOpen();
    assertIndex(index);
    return views[index].state;
  }

  function doc(index) {
    assertOpen();
    assertIndex(index);
    return normalizeDocument(views[index].state.doc);
  }

  function local(index, fn) {
    assertOpen();
    assertIndex(index);
    if (typeof fn !== "function") throw new TypeError("B_INVALID_LOCAL");
    const tr = fn(views[index].state);
    if (
      !tr ||
      !Array.isArray(tr.steps) ||
      !tr.doc ||
      typeof tr.docChanged !== "boolean"
    ) {
      throw new TypeError("B_EXPECTED_TRANSACTION");
    }
    views[index].dispatch(tr);
    return true;
  }

  function sync() {
    assertOpen();
    syncCalls += 1;
    let rounds = 0;
    let updates = 0;
    let changed = true;

    while (rounds < MAX_SYNC_ROUNDS) {
      rounds += 1;
      changed = false;
      for (let source = 0; source < ydocs.length; source += 1) {
        const update = r.Y.encodeStateAsUpdate(ydocs[source]);
        for (let target = 0; target < ydocs.length; target += 1) {
          if (target === source) continue;
          const before = r.Y.encodeStateAsUpdate(ydocs[target]);
          r.Y.applyUpdate(ydocs[target], update, REMOTE_ORIGIN);
          updates += 1;
          const after = r.Y.encodeStateAsUpdate(ydocs[target]);
          if (!bytesEqual(before, after)) changed = true;
        }
      }
      if (!changed) break;
    }

    syncRounds += rounds;
    syncUpdates += updates;
    syncConverged = allConverged();
    return undefined;
  }

  function undo(index) {
    assertOpen();
    assertIndex(index);
    return r.yUndo(views[index].state) === true;
  }

  function redo(index) {
    assertOpen();
    assertIndex(index);
    return r.yRedo(views[index].state) === true;
  }

  function serverDoc() {
    assertOpen();
    if (views.length === 0) throw new Error("B_NO_REPLICA");
    return normalizeDocument(views[views.length - 1].state.doc);
  }

  function diagnostics() {
    return {
      engine: "B",
      runtime: "y-prosemirror",
      dom: "jsdom",
      gui: "none",
      hiddenGui: false,
      nativeGui: false,
      browser: false,
      closed,
      clients,
      replicas: views.length,
      globalsBound: savedGlobals.map((entry) => entry.name),
      globalBindingCount: savedGlobals.length,
      sync: {
        calls: syncCalls,
        rounds: syncRounds,
        updates: syncUpdates,
        cap: MAX_SYNC_ROUNDS,
        converged: syncConverged,
      },
      syncCap: MAX_SYNC_ROUNDS,
      undoManager: "yUndoPlugin",
      blockIdentityRepair: false,
      volatile: true,
      schemaVersions: views.map(
        (view) => r.versionDocument(view.state.doc.toJSON()).schemaVersion,
      ),
      cleanupErrors: cleanupErrors.slice(),
    };
  }

  return {
    state,
    doc,
    local,
    sync,
    undo,
    redo,
    close,
    serverDoc,
    diagnostics,
  };
}
