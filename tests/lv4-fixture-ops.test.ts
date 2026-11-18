import { expect, it } from "vitest";
import { CheckpointRemote } from "../src/sync/client";
import { MemoryFixtureSecretStore, startFixtureSyncOps } from "../src/sync/lv4-fixture-ops";

it("registers and revokes loopback fixture devices without exposing tokens in status", async () => {
  const secrets = new MemoryFixtureSecretStore();
  const ops = await startFixtureSyncOps({workspaceId: "workspace", ownerId: "owner", secrets});
  try {
    expect(new URL(ops.url).hostname).toBe("127.0.0.1");
    expect(await ops.register("client-a")).toEqual({clientId: "client-a"});
    const token = (await ops.credential("client-a"))!;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(JSON.stringify(ops.status())).not.toContain(token);
    expect(ops.url).not.toContain(token);
    const remote = new CheckpointRemote({baseUrl: ops.url, workspaceId: "workspace", token});
    expect((await remote.head()).head.revision).toBe(0);
    await ops.revoke("client-a");
    expect(ops.status().devices).toEqual([{clientId: "client-a", state: "revoked"}]);
    await expect(remote.head()).rejects.toThrow();
    await expect(ops.credential("client-a")).rejects.toThrow("fixture-device-unavailable");
    await expect(ops.register("client-a")).rejects.toThrow("fixture-device-exists");
  } finally {await ops.close();}
});

it("serializes concurrent fixture administration", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {release = resolve;});
  class SlowSecrets extends MemoryFixtureSecretStore {
    override async set(key: string, secret: string) {await wait; return super.set(key, secret);}
  }
  const ops = await startFixtureSyncOps({workspaceId: "workspace", ownerId: "owner", secrets: new SlowSecrets()});
  try {
    const first = ops.register("client-a");
    await expect(ops.register("client-a")).rejects.toThrow("fixture-ops-busy");
    release(); await first;
    expect(ops.status().devices).toEqual([{clientId: "client-a", state: "active"}]);
  } finally {release(); await ops.close();}
});

it("isolates credentials for identical devices on separate fixture servers", async () => {
  const secrets = new MemoryFixtureSecretStore();
  const first = await startFixtureSyncOps({workspaceId: "workspace", ownerId: "owner", secrets});
  const second = await startFixtureSyncOps({workspaceId: "workspace", ownerId: "owner", secrets});
  try {
    await first.register("client-a"); await second.register("client-a");
    const a = await first.credential("client-a"), b = await second.credential("client-a");
    expect(a).not.toBe(b);
    await first.revoke("client-a");
    expect(await second.credential("client-a")).toBe(b);
    expect((await new CheckpointRemote({baseUrl: second.url, workspaceId: "workspace", token: b!}).head()).head.revision).toBe(0);
  } finally {await first.close(); await second.close();}
});
