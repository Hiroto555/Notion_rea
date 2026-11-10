import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { SharedMaintenance } from "../src/collaboration/runtime/maintenance";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import type { Cut, Scope } from "../src/collaboration/runtime/contract";
import type { Doc } from "../src/shared/types";

const directories: string[] = [];

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function initialDocument(): Doc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { id: "intro" },
        content: [{ type: "text", text: "maintenance" }],
      },
    ],
  };
}

function linkedDocument(hash: string): Doc {
  return { type: "doc", content: [{type: "image", attrs: {id: "linked", src: "folio-asset://" + hash, alt: "referenced", title: null, width: null, height: null}}] };
}

async function setup() {
  const directory = await tempDirectory("folio-maintenance-");
  const authority = new SharedAuthority(directory);
  const boot = authority.bootstrap({
    orgId: "org",
    userId: "owner",
    deviceId: "owner-device",
    workspaceId: "workspace",
    documentId: "root",
    document: initialDocument(),
  });
  return { authority, token: boot.token, scope: boot.scope, orgId: "org" };
}

function publishAsset(
  authority: SharedAuthority,
  token: string,
  scope: Scope,
  uploadId: string,
  bytes: Uint8Array,
): string {
  const staged = authority.stageAsset(token, scope, uploadId, bytes);
  const base: Cut = authority.head();
  const auth = authority.session(token, scope.orgId);
  const receipt = authority.submit(token, {
    v: 1,
    attemptId: randomUUID(),
    base,
    intent: {
      v: 1,
      intentId: randomUUID(),
      writerId: auth.writerId,
      scope,
      base,
      command: {
        kind: "resource",
        action: "asset.publish",
        payload: { uploadId, hash: staged.hash },
      },
    },
  });
  expect(receipt.status).toBe("SERVER_ACCEPTED");
  return staged.hash;
}

describe("SharedMaintenance", () => {
  it("classifies actual referenced and unreferenced assets, refuses a wrong plan, and collects only unreferenced assets", async () => {
    const { authority, token, scope } = await setup();
    try {
      const maintenance = new SharedMaintenance(authority);
      const referenced = publishAsset(
        authority,
        token,
        scope,
        "upload-referenced",
        new TextEncoder().encode("referenced bytes"),
      );
      const linkedScope = {
        ...scope,
        documentId: "linked",
        incarnationId: randomUUID(),
      };
      const receipt = authority.createDocument(
        token,
        linkedScope,
        linkedDocument(referenced),
        "Linked",
      );
      expect(receipt.status).toBe("SERVER_ACCEPTED");
      const orphan = publishAsset(
        authority,
        token,
        scope,
        "upload-orphan",
        new TextEncoder().encode("unreferenced bytes"),
      );

      const preview = maintenance.collectPreview(token, scope);
      expect(preview.published).toBe(2);
      expect(preview.referenced).toContain(referenced);
      expect(preview.unreferenced).toEqual([orphan]);

      expect(() =>
        maintenance.collect(token, scope, preview.cut, [referenced]),
      ).toThrow(/COLLECT_PLAN_MISMATCH/);

      const result = maintenance.collect(
        token,
        scope,
        preview.cut,
        preview.unreferenced,
      );
      expect(result.removed).toEqual([orphan]);
      expect(result.bytes).toBeGreaterThan(0);
      expect(() =>
        authority.readAsset(token, linkedScope, referenced),
      ).not.toThrow();
      expect(() =>
        authority.readAsset(token, linkedScope, orphan),
      ).toThrow(/ASSET_NOT_FOUND/);
      expect(() => authority.verify()).not.toThrow();
    } finally {
      authority.close();
    }
  });

  it("re-authenticates each call and denies a revoked workspace role", async () => {
    const { authority, token, scope, orgId } = await setup();
    try {
      const maintenance = new SharedMaintenance(authority);
      const invite = authority.invite(token, orgId, "member");
      const joined = authority.join(invite, orgId, "member-device");
      authority.grant(token, scope, "member", "owner");

      expect(() =>
        maintenance.collectPreview(joined.token, scope),
      ).not.toThrow();

      authority.revokeMember(token, orgId, "member");
      expect(() =>
        maintenance.collectPreview(joined.token, scope),
      ).toThrow();
    } finally {
      authority.close();
    }
  });

  it("performs a real isolated restore verification and persists the catalog only after verification", async () => {
    const { authority, token, orgId } = await setup();
    const destinationDirectory = await tempDirectory("folio-maintenance-restore-");
    const destination = new RuntimeStore(destinationDirectory);
    try {
      const maintenance = new SharedMaintenance(authority);
      const newEpoch = randomUUID();
      const proof = maintenance.verify(token, orgId, destination, newEpoch);
      expect(proof.v).toBe(1);
      expect(proof.backupHash).toMatch(/^[a-f0-9]{64}$/);
      expect(proof.restoreEpoch).toBe(newEpoch);
      expect(proof.restoreCut).toMatchObject({ epoch: newEpoch, seq: 0 });
      expect(destination.get("meta", "head")).toMatchObject({
        epoch: newEpoch,
        seq: 0,
      });

      const auth = authority.session(token, orgId);
      const overview = authority.operations.overview(auth, orgId);
      expect(
        overview.backups.some(
          (backup) =>
            backup.hash === proof.backupHash && backup.verified === true,
        ),
      ).toBe(true);

      expect(() => maintenance.compact(token, orgId, proof)).toThrow(
        /WRITER_NOT_FENCED/,
      );
    } finally {
      destination.close();
      authority.close();
    }
  });

  it("rejects a fabricated verification object before compaction", async () => {
    const { authority, token, orgId } = await setup();
    try {
      const maintenance = new SharedMaintenance(authority);
      const fabricated = {
        v: 1 as const,
        backupHash: "a".repeat(64),
        cut: authority.head(),
        restoreEpoch: "epoch",
        restoreCut: { epoch: "epoch", seq: 0, hash: "b".repeat(64) },
      };
      expect(() => maintenance.compact(token, orgId, fabricated)).toThrow(
        /BACKUP_NOT_VERIFIED/,
      );
    } finally {
      authority.close();
    }
  });
});
