import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import type { Scope } from "../src/collaboration/runtime/contract";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import {
  createSharedHttpServer,
  type SharedHttpServer,
} from "../src/collaboration/runtime/http-server";
import type { Doc } from "../src/shared/types";

function paragraph(id: string, text: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    content: [{ type: "text", text }],
  };
}

function documentWith(id: string, text: string): Doc {
  return { type: "doc", content: [paragraph(id, text)] };
}

type Fixture = {
  tmp: string;
  authority: SharedAuthority;
  server: SharedHttpServer;
  url: string;
  ownerToken: string;
  recoveryKey: string;
  scope: Scope;
  cleanup(): Promise<void>;
};

async function setup(): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), "folio-rekey-admin-"));
  const authority = new SharedAuthority(join(tmp, "authority"));
  const boot = authority.bootstrap({
    orgId: "org1",
    userId: "alice",
    deviceId: "alice-device",
    workspaceId: "ws1",
    documentId: "doc1",
    document: documentWith("p1", "Hello"),
  });
  const server = createSharedHttpServer(authority);
  const { url } = await server.listen();
  return {
    tmp,
    authority,
    server,
    url,
    ownerToken: boot.token,
    recoveryKey: boot.recoveryKey,
    scope: boot.scope,
    async cleanup() {
      await server.close();
      authority.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function rotationKey(value: unknown): string {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  const record = value as Record<string, unknown>;
  expect(Object.keys(record)).toEqual(["recoveryKey"]);
  expect(typeof record.recoveryKey).toBe("string");
  const key = record.recoveryKey as string;
  expect(key.length).toBeGreaterThan(0);
  return key;
}

function codeOf(work: () => unknown): string {
  try {
    work();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("shared runtime rekey administration", () => {
  let activeCleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await activeCleanup?.();
    activeCleanup = null;
  });

  async function fixture(): Promise<Fixture> {
    const value = await setup();
    activeCleanup = value.cleanup;
    return value;
  }

  it("strictly validates recovery admin commands and rotates to a single-use key", async () => {
    const f = await fixture();
    const provider = new HttpSharedProvider(f.url, f.ownerToken);

    expect(
      await provider.admin({ action: "recoveryStatus", orgId: "org1" }),
    ).toEqual({
      configured: true,
    });

    await expect(
      provider.admin({ action: "recoveryStatus", orgId: "org1", extra: true }),
    ).rejects.toMatchObject({ code: "INVALID_ADMIN_COMMAND" });
    await expect(
      provider.admin({ action: "rotateRecovery" }),
    ).rejects.toMatchObject({ code: "INVALID_ADMIN_COMMAND" });
    await expect(
      provider.admin({ action: "recoveryStatus", orgId: "not an id" }),
    ).rejects.toMatchObject({ code: "INVALID_ADMIN_COMMAND" });
    await expect(
      provider.admin({
        action: "rotateRecovery",
        orgId: "org1",
        recoveryKey: "caller-supplied",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ADMIN_COMMAND" });
    await expect(
      provider.admin({ action: "rotateRecovery", orgId: 7 }),
    ).rejects.toMatchObject({ code: "INVALID_ADMIN_COMMAND" });

    expect(
      await provider.admin({ action: "recoveryStatus", orgId: "org1" }),
    ).toEqual({
      configured: true,
    });

    const rotated = rotationKey(
      await provider.admin({ action: "rotateRecovery", orgId: "org1" }),
    );
    expect(rotated).not.toBe(f.recoveryKey);
    expect(
      await provider.admin({ action: "recoveryStatus", orgId: "org1" }),
    ).toEqual({
      configured: true,
    });

    expect(
      codeOf(() =>
        f.authority.recover("org1", f.recoveryKey, "old-key-device"),
      ),
    ).toBe("RECOVERY_INVALID");

    const recovered = f.authority.recover("org1", rotated, "new-key-device");
    expect(recovered.recoveryKey).not.toBe(rotated);
    expect(
      codeOf(() => f.authority.recover("org1", rotated, "replayed-key-device")),
    ).toBe("RECOVERY_INVALID");

    provider.close();
  });

  it("removes the old owner's rekey authority after handoff and lets the new owner rotate once", async () => {
    const f = await fixture();
    const owner = new HttpSharedProvider(f.url, f.ownerToken);

    const invited = (await owner.admin({
      action: "invite",
      orgId: "org1",
      userId: "bob",
    })) as { inviteToken: string };
    expect(typeof invited.inviteToken).toBe("string");
    const bob = f.authority.acceptInvite(invited.inviteToken, "bob-device");
    const bobProvider = new HttpSharedProvider(f.url, bob.token);
    await owner.admin({
      action: "grant",
      scope: f.scope,
      userId: "bob",
      role: "editor",
    });

    await expect(
      bobProvider.admin({ action: "recoveryStatus", orgId: "org1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      bobProvider.admin({ action: "rotateRecovery", orgId: "org1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await owner.admin({ action: "recoveryStatus", orgId: "org1" }),
    ).toEqual({
      configured: true,
    });

    await owner.admin({
      action: "handoff",
      orgId: "org1",
      userId: "bob",
      workspaces: [f.scope.workspaceId],
    });

    await expect(
      owner.admin({ action: "recoveryStatus", orgId: "org1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      owner.admin({ action: "rotateRecovery", orgId: "org1" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await bobProvider.admin({ action: "recoveryStatus", orgId: "org1" }),
    ).toEqual({
      configured: false,
    });

    expect(
      codeOf(() =>
        f.authority.recover("org1", f.recoveryKey, "old-owner-recovery-device"),
      ),
    ).toBe("RECOVERY_INVALID");

    const rotated = rotationKey(
      await bobProvider.admin({ action: "rotateRecovery", orgId: "org1" }),
    );
    expect(rotated).not.toBe(f.recoveryKey);
    expect(
      await bobProvider.admin({ action: "recoveryStatus", orgId: "org1" }),
    ).toEqual({
      configured: true,
    });

    const recovered = f.authority.recover(
      "org1",
      rotated,
      "new-owner-recovery-device",
    );
    expect(recovered.recoveryKey).not.toBe(rotated);
    expect(
      codeOf(() =>
        f.authority.recover("org1", rotated, "new-owner-replayed-device"),
      ),
    ).toBe("RECOVERY_INVALID");

    owner.close();
    bobProvider.close();
  });
});
