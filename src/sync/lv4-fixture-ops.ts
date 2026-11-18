import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCheckpointServer } from "./checkpoint-server";
import { identifier, requireCondition } from "./protocol";
import { WorkspaceBlobStore } from "./workspace-blobs";
import { validateWorkspaceCheckpoint } from "./workspace-checkpoint";

/** Credential interface for test fixtures; an OS-backed adapter is separate. */
export interface FixtureSecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, secret: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export class MemoryFixtureSecretStore implements FixtureSecretStore {
  private readonly values = new Map<string, string>();
  async get(key: string) {return this.values.get(key);}
  async set(key: string, secret: string) {this.values.set(key, secret);}
  async delete(key: string) {this.values.delete(key);}
}
const credentialKey = (fixtureEpoch: string, workspaceId: string, clientId: string) =>
  "device-" + createHash("sha256").update(JSON.stringify([fixtureEpoch, workspaceId, clientId])).digest("hex");

/** Creates only an isolated temporary fixture, never accepts an existing
 * server directory, and never puts credentials in URLs, arguments, or status.
 * Backup, restore, real deployment and OS secret stores are deliberately not
 * exposed by this fixture-only seam. */
export async function startFixtureSyncOps(input: {workspaceId: string; ownerId: string; secrets: FixtureSecretStore}) {
  const workspaceId = identifier(input.workspaceId), ownerId = identifier(input.ownerId);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "folio-lv4-ops-"));
  let server: Awaited<ReturnType<typeof startCheckpointServer>>;
  try {
    server = await startCheckpointServer({databasePath: join(root, "server.sqlite"), capabilities: [],
      workspaces: [{workspaceId, ownerId}], validateCheckpoint: validateWorkspaceCheckpoint,
      blobs: new WorkspaceBlobStore(join(root, "blobs"))});
  } catch (error) {rmSync(root, {recursive: true, force: true}); throw error;}
  const devices = new Map<string, "active" | "revoked">();
  let closed = false;
  let running = false;
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    requireCondition(!running, "fixture-ops-busy", 409);
    running = true;
    try {return await work();} finally {running = false;}
  }
  return {
    url: server.url,
    status() {return {workspaceId, serverEpoch: server.serverEpoch, devices: [...devices].map(([clientId, state]) => ({clientId, state}))};},
    async register(clientId: string) {
      return exclusive(async () => {
      identifier(clientId);
      requireCondition(!closed && !devices.has(clientId), "fixture-device-exists", 409);
      const key = credentialKey(server.serverEpoch, workspaceId, clientId), token = randomBytes(32).toString("base64url");
      await input.secrets.set(key, token);
      try {server.registerDevice({workspaceId, ownerId, clientId, token});}
      catch (error) {await input.secrets.delete(key); throw error;}
      devices.set(clientId, "active");
      return {clientId};
      });
    },
    async credential(clientId: string) {
      identifier(clientId);
      requireCondition(!closed && devices.get(clientId) === "active", "fixture-device-unavailable", 409);
      return input.secrets.get(credentialKey(server.serverEpoch, workspaceId, clientId));
    },
    async revoke(clientId: string) {
      return exclusive(async () => {
      identifier(clientId);
      requireCondition(!closed && devices.get(clientId) === "active", "fixture-device-unavailable", 409);
      server.revokeDevice(workspaceId, clientId);
      devices.set(clientId, "revoked");
      await input.secrets.delete(credentialKey(server.serverEpoch, workspaceId, clientId));
      });
    },
    async close() {
      return exclusive(async () => {
        if (!closed) {await server.close(); closed = true;}
        for (const clientId of devices.keys()) await input.secrets.delete(credentialKey(server.serverEpoch, workspaceId, clientId));
        rmSync(root, {recursive: true, force: true});
      });
    },
  };
}
