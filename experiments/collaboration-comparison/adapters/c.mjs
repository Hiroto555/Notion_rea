import r from "../runtime/bundle.cjs";

// C comparison adapter: a server-ordered ProseMirror step log with client-side
// prosemirror-collab rebasing and prosemirror-history undo/redo. No EditorView,
// DOM, network, persistence, retry timer, or random block-id repair is used.
const MAX_SYNC_ROUNDS = 10000;
const MAX_REJECTION_RECORDS = 100;

function assertIndex(index, length) {
  if (!Number.isInteger(index) || index < 0 || index >= length)
    throw new RangeError(`client index out of range: ${index}`);
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stepJSON(step) {
  try {
    return step.toJSON();
  } catch {
    return { stepType: "UNSERIALIZABLE" };
  }
}

export function createHarness({ document, clients = 2 } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new TypeError("document must be a Folio document object");
  if (!r.inspectSharedDocument(JSON.stringify(document)).ok)
    throw new Error(
      "INVALID_DOCUMENT: initial document is not a valid Folio document",
    );
  if (!Number.isInteger(clients) || clients < 1 || clients > 5)
    throw new RangeError("clients must be a positive integer");

  // The seed is materialized once and shared by every client. Block IDs are
  // never regenerated or repaired by this adapter.
  let seed;
  try {
    seed = r.documentSchema.nodeFromJSON(document);
    seed.check();
  } catch {
    throw new Error(
      "INVALID_DOCUMENT: ProseMirror rejected the initial document",
    );
  }

  const clientIDs = Array.from({ length: clients }, (_, index) => index + 1);
  const states = clientIDs.map((clientID) =>
    r.EditorState.create({
      doc: seed,
      plugins: [
        r.richStructureGuardPlugin(),
        r.history(),
        r.collab({ version: 0, clientID }),
      ],
    }),
  );

  let serverDoc = seed;
  let serverVersion = 0;
  const serverSteps = [];
  const serverStepClientIDs = [];

  const diagnostics = {
    engine: "C",
    mechanism: "prosemirror-collab+history",
    clients,
    clientIDs: clientIDs.slice(),
    syncCalls: 0,
    syncRounds: 0,
    acceptedSteps: 0,
    serverVersion: 0,
    serverStepCount: 0,
    rejections: [],
    truncated: false,
    closed: false,
  };

  function reject(clientIndex, reason, detail = {}) {
    if (diagnostics.rejections.length >= MAX_REJECTION_RECORDS) return;
    diagnostics.rejections.push({
      clientIndex,
      reason,
      atServerVersion: serverVersion,
      ...detail,
    });
  }

  function projectServer(steps) {
    let next = serverDoc;
    for (let i = 0; i < steps.length; i++) {
      const result = steps[i].apply(next);
      if (result.failed)
        return { ok: false, reason: `STEP_FAILED:${result.failed}`, index: i };
      next = result.doc;
    }
    let json;
    try {
      json = next.toJSON();
    } catch {
      return { ok: false, reason: "PROJECTION_NOT_SERIALIZABLE" };
    }
    // A candidate is accepted only when the resulting Folio projection is
    // valid. Rejection leaves the client's unconfirmed steps untouched.
    if (!r.validDocument(json))
      return { ok: false, reason: "INVALID_FOLIO_PROJECTION" };
    return { ok: true, doc: next };
  }

  function sync() {
    diagnostics.syncCalls++;
    const blocked = new Set();
    let rounds = 0;

    while (rounds < MAX_SYNC_ROUNDS) {
      rounds++;
      diagnostics.syncRounds++;
      let progressed = false;
      let caughtUp = false;

      // 1. Pull the accepted server log into every lagging client before asking
      //    any client for sendable steps. receiveTransaction rebases the
      //    client's unconfirmed steps over the accepted log.
      for (let index = 0; index < states.length; index++) {
        const version = r.getVersion(states[index]);
        if (version > serverVersion) {
          reject(index, "CLIENT_AHEAD_OF_SERVER", { clientVersion: version });
          blocked.add(index);
          continue;
        }
        if (version === serverVersion) continue;
        const steps = serverSteps.slice(version);
        const ids = serverStepClientIDs.slice(version);
        try {
          states[index] = states[index].apply(
            r.receiveTransaction(states[index], steps, ids),
          );
          caughtUp = true;
          progressed = true;
        } catch (error) {
          reject(index, "RECEIVE_FAILED", { message: String(error) });
          blocked.add(index);
        }
      }
      if (caughtUp) {
        blocked.clear();
        continue;
      }

      // 2. Choose one client in stable index order, project its current
      //    sendable steps onto the server document, then broadcast the accepted
      //    steps to all replicas (the sender's own prefix is confirmed by
      //    receiveTransaction).
      let accepted = false;
      for (let index = 0; index < states.length; index++) {
        if (blocked.has(index)) continue;
        const pending = r.sendableSteps(states[index]);
        if (!pending || pending.steps.length === 0) continue;
        if (pending.version !== serverVersion) {
          reject(index, "PENDING_BASE_MISMATCH", {
            pendingVersion: pending.version,
          });
          blocked.add(index);
          continue;
        }

        const projection = projectServer(pending.steps);
        if (!projection.ok) {
          reject(index, projection.reason, {
            failedStepIndex: projection.index,
            stepCount: pending.steps.length,
            steps: pending.steps.map(stepJSON),
          });
          blocked.add(index);
          continue;
        }

        const steps = pending.steps;
        const ids = steps.map(() => pending.clientID);
        serverDoc = projection.doc;
        serverVersion += steps.length;
        for (let i = 0; i < steps.length; i++) {
          serverSteps.push(steps[i]);
          serverStepClientIDs.push(ids[i]);
        }
        diagnostics.acceptedSteps += steps.length;
        diagnostics.serverVersion = serverVersion;
        diagnostics.serverStepCount = serverSteps.length;

        for (let target = 0; target < states.length; target++) {
          try {
            states[target] = states[target].apply(
              r.receiveTransaction(states[target], steps, ids),
            );
          } catch (error) {
            reject(target, "BROADCAST_FAILED", { message: String(error) });
          }
        }
        accepted = true;
        progressed = true;
        blocked.clear();
        break;
      }

      if (!progressed) break;
      if (!accepted && caughtUp) continue;
    }

    if (rounds >= MAX_SYNC_ROUNDS) diagnostics.truncated = true;
  }

  function undo(index) {
    assertIndex(index, states.length);
    let dispatched = false;
    const changed = r.undo(states[index], (tr) => {
      states[index] = states[index].apply(tr);
      dispatched = true;
    });
    return Boolean(changed && dispatched);
  }

  function redo(index) {
    assertIndex(index, states.length);
    let dispatched = false;
    const changed = r.redo(states[index], (tr) => {
      states[index] = states[index].apply(tr);
      dispatched = true;
    });
    return Boolean(changed && dispatched);
  }

  function normalizedDoc(state) {
    return jsonClone({
      ...r.versionDocument(state.doc.toJSON()),
      ...(document.schemaVersion !== undefined
        ? { schemaVersion: document.schemaVersion }
        : {}),
    });
  }

  function serverJSON() {
    return jsonClone({
      ...r.versionDocument(serverDoc.toJSON()),
      ...(document.schemaVersion !== undefined
        ? { schemaVersion: document.schemaVersion }
        : {}),
    });
  }

  return {
    state(index) {
      assertIndex(index, states.length);
      return states[index];
    },

    doc(index) {
      assertIndex(index, states.length);
      return normalizedDoc(states[index]);
    },

    local(index, fn) {
      assertIndex(index, states.length);
      if (typeof fn !== "function")
        throw new TypeError("local(index, fn) requires a transaction factory");
      const tr = fn(states[index]);
      if (!tr || !Array.isArray(tr.steps) || !tr.doc)
        throw new TypeError(
          "local transaction factory must return a Transaction",
        );
      states[index] = states[index].apply(tr);
      return states[index];
    },

    sync,

    undo,
    redo,

    close() {
      // No DOM globals, views, timers, or listeners are installed by C.
      diagnostics.closed = true;
    },

    serverDoc() {
      return serverJSON();
    },

    diagnostics() {
      const docs = states.map((state) => JSON.stringify(normalizedDoc(state)));
      const server = JSON.stringify(serverJSON());
      return jsonClone({
        ...diagnostics,
        serverVersion,
        serverStepCount: serverSteps.length,
        converged: docs.every((json) => json === server),
        pending: states.map((state, index) => {
          const pending = r.sendableSteps(state);
          return {
            index,
            version: r.getVersion(state),
            steps: pending ? pending.steps.length : 0,
          };
        }),
      });
    },
  };
}
