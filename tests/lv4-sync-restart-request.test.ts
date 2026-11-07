import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceSyncIntentFile } from "../src/main/workspace-sync-intent";
import { WorkspaceSyncRestartRequest, type RestartObservation } from "../src/main/workspace-sync-restart-request";
const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-lv4-restart-request-"))); roots.push(root);
  const file = new WorkspaceSyncIntentFile(root);
  const target = {workspaceId: "workspace", clientId: "client", bindingId: "binding", serverEpoch: "epoch", revision: 1, checkpointHash: "a".repeat(64)};
  const observation: RestartObservation = {target, clean: true, idle: true, windowsClosed: false};
  return {file, target, observation};
}
it("cancels a requested restart without publishing an intent", () => {
  const {file, observation} = fixture(); const request = new WorkspaceSyncRestartRequest(file, () => observation);
  expect(request.prepare()).toBe("prepared"); expect(file.read().status).toBe("empty");
  expect(request.cancel()).toBe("cancelled"); expect(file.read().status).toBe("empty");
});
it("publishes only after windows close and fresh state matches", () => {
  const {file, target, observation} = fixture(); const request = new WorkspaceSyncRestartRequest(file, () => observation);
  expect(request.prepare()).toBe("prepared"); expect(request.commitAfterWindowsClosed()).toBe("blocked");
  observation.windowsClosed = true; observation.clean = false;
  expect(request.commitAfterWindowsClosed()).toBe("blocked");
  observation.clean = true; observation.idle = false;
  expect(request.commitAfterWindowsClosed()).toBe("blocked");
  observation.idle = true; observation.target = {...target, revision: 2};
  expect(request.commitAfterWindowsClosed()).toBe("blocked"); expect(file.read().status).toBe("empty");
  observation.target = target; expect(request.commitAfterWindowsClosed()).toBe("committed");
  expect(file.read()).toEqual({status: "ready", target});
  expect(request.cancel()).toBe("cancelled"); expect(file.read().status).toBe("empty");
});
it("cleans only its own intent after uncertain publication", () => {
  const {file, observation} = fixture();
  const uncertain = {read: () => file.read(), cancelIfMatches: (target: typeof observation.target & {}) => file.cancelIfMatches(target),
    create: (target: typeof observation.target & {}) => {file.create(target); throw new Error("lost acknowledgement");}};
  const request = new WorkspaceSyncRestartRequest(uncertain, () => observation);
  expect(request.prepare()).toBe("prepared"); observation.windowsClosed = true;
  expect(request.commitAfterWindowsClosed()).toBe("blocked"); expect(file.read().status).toBe("ready");
  expect(request.cancel()).toBe("cancelled"); expect(file.read().status).toBe("empty");
});
it("does not delete a different intent after uncertain publication", () => {
  const {file, target, observation} = fixture();
  const foreign = {...target, revision: 2};
  const uncertain = {read: () => file.read(), cancelIfMatches: (candidate: typeof target) => file.cancelIfMatches(candidate),
    create: (_candidate: typeof target) => {file.create(foreign); throw new Error("unknown outcome");}};
  const request = new WorkspaceSyncRestartRequest(uncertain, () => observation);
  expect(request.prepare()).toBe("prepared"); observation.windowsClosed = true;
  expect(request.commitAfterWindowsClosed()).toBe("blocked");
  expect(request.cancel()).toBe("blocked"); expect(file.read()).toEqual({status: "ready", target: foreign});
});
it("fails closed when the host cannot observe restart safety", () => {
  const {file, observation} = fixture(); let fail = true;
  const request = new WorkspaceSyncRestartRequest(file, () => {if (fail) throw new Error("unavailable"); return observation;});
  expect(request.prepare()).toBe("blocked"); expect(file.read().status).toBe("empty");
  fail = false; expect(request.prepare()).toBe("prepared");
  observation.windowsClosed = true; fail = true;
  expect(request.commitAfterWindowsClosed()).toBe("blocked"); expect(file.read().status).toBe("empty");
});
