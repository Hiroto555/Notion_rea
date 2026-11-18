import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { createSharedHttpServer } from "../src/collaboration/runtime/http-server";
import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import { canonical } from "../src/collaboration/runtime/canonical";
import {
  previewSharedCopy,
  type SharedCopySource,
} from "../src/collaboration/runtime/copy";
import { sharedCopyTransfer } from "../src/main/shared-copy-transfer";
import { runMaintenanceOperator } from "../src/collaboration/runtime/maintenance-operator";
import type { StagingReclaimPreview } from "../src/collaboration/runtime/staging-maintenance";
import type {
  Attempt,
  AuthContext,
  Command,
  Scope,
} from "../src/collaboration/runtime/contract";

const RAW = "PRIVATE-STAGING 原本 😀";
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "folio-stage-maint-")));
  chmodSync(root, 0o700);
  const authorityRoot = join(root, "authority"),
    authority = new SharedAuthority(authorityRoot);
  const boot = authority.bootstrap({
    orgId: "org",
    userId: "owner",
    deviceId: "original",
    workspaceId: "ws",
    documentId: "page",
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "p" },
          content: [{ type: "text", text: "shared" }],
        },
      ],
    },
  });
  const server = createSharedHttpServer(authority),
    { url } = await server.listen();
  const provider = new HttpSharedProvider(url, boot.token);
  const source: SharedCopySource = {
    id: "source",
    parentId: null,
    title: "private",
    raw: canonical({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "private-p" },
          content: [{ type: "text", text: RAW }],
        },
      ],
    }),
    assets: [],
  };
  function attempt(
    auth: AuthContext,
    command: Command,
    scope: Scope = boot.scope,
  ): Attempt {
    return {
      v: 1,
      attemptId: randomUUID(),
      base: authority.head(),
      intent: {
        v: 1,
        intentId: randomUUID(),
        writerId: auth.writerId,
        scope,
        base: authority.head(),
        command,
      },
    };
  }
  async function stage(copyId: string) {
    const preview = previewSharedCopy(
        [source],
        [source.id],
        { orgId: "org", workspaceId: "ws" },
        () => "copied-" + copyId,
      ),
      transfer = sharedCopyTransfer([source], preview, copyId);
    const attempts: Attempt[] = [];
    const prepared = attempt(boot.auth, {
      kind: "resource",
      action: "copy.stage.prepare",
      payload: { manifest: transfer.manifest } as never,
    });
    attempts.push(prepared);
    expect((await provider.submit(prepared)).status).toBe("SERVER_ACCEPTED");
    for (let index = 0; index < transfer.parts.length; index++) {
      const part = attempt(boot.auth, {
        kind: "resource",
        action: "copy.stage.part",
        payload: { copyId, index, raw: transfer.parts[index] },
      });
      attempts.push(part);
      expect((await provider.submit(part)).status).toBe("SERVER_ACCEPTED");
    }
    return { ...transfer, attempts };
  }
  function history(writerId = boot.auth.writerId) {
    return canonical(
      ["authority.events", "authority.intents", "authority.attempts"].map(
        (namespace) => ({
          namespace,
          rows: authority.store
            .all(namespace)
            .filter(
              (row) =>
                (row.value as { writerId?: string; attempt?: Attempt })
                  .writerId === writerId ||
                (row.value as { attempt?: Attempt }).attempt?.intent
                  .writerId === writerId,
            ),
        }),
      ),
    );
  }
  return {
    root,
    authorityRoot,
    authority,
    boot,
    server,
    provider,
    source,
    attempt,
    stage,
    history,
    url,
    async close() {
      provider.close();
      await server.close();
      authority.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function proposal(preview: StagingReclaimPreview, index = 0) {
  const stage = preview.stages[index];
  return {
    action: "stagingAbandon",
    scope: stage.scope,
    writerId: stage.writerId,
    copyId: stage.copyId,
    manifestHash: stage.manifestHash,
    expectedCut: preview.cut,
  };
}

describe("explicit org-owner maintenance of fenced-writer copy staging", () => {
  it("reclaims a recovered owner's exhausted reservation via actualHTTP while preserving oldraw/receipts", async () => {
    const f = await fixture();
    let fresh: HttpSharedProvider | undefined;
    try {
      const transfers = [];
      for (let i = 0; i < 8; i++) transfers.push(await f.stage("copy" + i));
      const old = f.history(),
        raw = f.authority.store
          .all("authority.events")
          .filter(
            (row) =>
              (row.value as { writerId: string }).writerId ===
              f.boot.auth.writerId,
          );
      expect(canonical(raw)).toContain(RAW);
      const recovered = f.authority.recover(
        "org",
        f.boot.recoveryKey,
        "replacement",
      );
      fresh = new HttpSharedProvider(f.url, recovered.token);
      const newPreview = previewSharedCopy(
          [f.source],
          [f.source.id],
          { orgId: "org", workspaceId: "ws" },
          () => "new-copied",
        ),
        next = sharedCopyTransfer([f.source], newPreview, "new-copy");
      expect(
        await fresh.submit(
          f.attempt(recovered.auth, {
            kind: "resource",
            action: "copy.stage.prepare",
            payload: { manifest: next.manifest } as never,
          }),
        ),
      ).toMatchObject({ status: "REJECTED", code: "COPY_STAGING_CAPACITY" });
      const preview = (await fresh.admin({
        action: "stagingPreview",
        scope: f.boot.scope,
      })) as StagingReclaimPreview;
      expect(preview.stages).toHaveLength(8);
      expect(preview.stages.every((s) => s.fenced)).toBe(true);
      expect(canonical(preview)).not.toContain(RAW);
      expect(canonical(preview)).not.toContain("private-p");
      const clean = await fresh.admin(proposal(preview));
      expect(clean).toMatchObject({
        abandoned: true,
        removedParts: 1,
        writerId: f.boot.auth.writerId,
      });
      expect(f.history()).toBe(old);
      expect(
        f.authority.store
          .all("authority.events")
          .filter(
            (row) =>
              (row.value as { writerId: string }).writerId ===
              f.boot.auth.writerId,
          ),
      ).toEqual(raw);
      expect(
        await fresh.submit(
          f.attempt(recovered.auth, {
            kind: "resource",
            action: "copy.stage.prepare",
            payload: { manifest: next.manifest } as never,
          }),
        ),
      ).toMatchObject({ status: "SERVER_ACCEPTED" });
      await expect(
        f.provider.submit(
          f.attempt(f.boot.auth, {
            kind: "resource",
            action: "copy.stage.commit",
            payload: {
              copyId: "copy0",
              manifestHash: transfers[0].manifestHash,
            },
          }),
        ),
      ).rejects.toThrow();
      f.authority.verify();
    } finally {
      fresh?.close();
      await f.close();
    }
  });
  it("refuses active writers and stale plans without removing parts or creating an audit event", async () => {
    const f = await fixture();
    try {
      await f.stage("active");
      const active = (await f.provider.admin({
        action: "stagingPreview",
        scope: f.boot.scope,
      })) as StagingReclaimPreview;
      expect(active.stages[0].fenced).toBe(false);
      const old = f.history();
      await expect(f.provider.admin(proposal(active))).rejects.toThrow(
        "WRITER_NOT_FENCED",
      );
      expect(f.history()).toBe(old);
      const recovered = f.authority.recover(
          "org",
          f.boot.recoveryKey,
          "new-device",
        ),
        provider = new HttpSharedProvider(f.url, recovered.token);
      try {
        const preview = (await provider.admin({
          action: "stagingPreview",
          scope: f.boot.scope,
        })) as StagingReclaimPreview;
        f.authority.invite(recovered.token, "org", "someone");
        const head = f.authority.head();
        await expect(provider.admin(proposal(preview))).rejects.toThrow(
          "STAGING_PLAN_STALE",
        );
        expect(f.authority.head()).toEqual(head);
        expect(
          f.authority.store
            .all("copy.staging")
            .filter((r) => r.key.includes(":part:")),
        ).toHaveLength(1);
      } finally {
        provider.close();
      }
    } finally {
      await f.close();
    }
  });
  it("denies ordinary organization members even when they own the workspace", async () => {
    const f = await fixture();
    try {
      await f.stage("private-stage");
      const invite = f.authority.invite(f.boot.token, "org", "member"),
        member = f.authority.acceptInvite(invite, "member-device");
      f.authority.grant(f.boot.token, f.boot.scope, "member", "owner");
      const provider = new HttpSharedProvider(f.url, member.token);
      try {
        await expect(
          provider.admin({ action: "stagingPreview", scope: f.boot.scope }),
        ).rejects.toThrow("FORBIDDEN");
        const preview = (await f.provider.admin({
          action: "stagingPreview",
          scope: f.boot.scope,
        })) as StagingReclaimPreview;
        await expect(provider.admin(proposal(preview))).rejects.toThrow(
          "FORBIDDEN",
        );
      } finally {
        provider.close();
      }
    } finally {
      await f.close();
    }
  });
  it("allows an inactive scope anchor and binds repeat cleanup to a fresh exact cut", async () => {
    const f = await fixture();
    let provider: HttpSharedProvider | undefined;
    try {
      await f.stage("inactive");
      const recovered = f.authority.recover(
        "org",
        f.boot.recoveryKey,
        "replacement",
      );
      provider = new HttpSharedProvider(f.url, recovered.token);
      expect(
        (
          await provider.submit(
            f.attempt(recovered.auth, {
              kind: "resource",
              action: "document.trash",
              payload: {},
            }),
          )
        ).status,
      ).toBe("SERVER_ACCEPTED");
      const preview = (await provider.admin({
        action: "stagingPreview",
        scope: f.boot.scope,
      })) as StagingReclaimPreview;
      const request = proposal(preview);
      expect(await provider.admin(request)).toMatchObject({
        abandoned: true,
        removedParts: 1,
      });
      await expect(provider.admin(request)).rejects.toThrow(
        "STAGING_PLAN_STALE",
      );
      const refreshed = (await provider.admin({
        action: "stagingPreview",
        scope: f.boot.scope,
      })) as StagingReclaimPreview;
      expect(refreshed.stages).toEqual([]);
      expect(
        await provider.admin({ ...request, expectedCut: refreshed.cut }),
      ).toMatchObject({ abandoned: true, removedParts: 0 });
      f.authority.verify();
    } finally {
      provider?.close();
      await f.close();
    }
  });
  it("refuses committed copies and mismatched manifests", async () => {
    const f = await fixture();
    let provider: HttpSharedProvider | undefined;
    try {
      const transfer = await f.stage("committed");
      expect(
        (
          await f.provider.submit(
            f.attempt(f.boot.auth, {
              kind: "resource",
              action: "copy.stage.commit",
              payload: {
                copyId: "committed",
                manifestHash: transfer.manifestHash,
              },
            }),
          )
        ).status,
      ).toBe("SERVER_ACCEPTED");
      const recovered = f.authority.recover(
        "org",
        f.boot.recoveryKey,
        "replacement",
      );
      provider = new HttpSharedProvider(f.url, recovered.token);
      const preview = (await provider.admin({
        action: "stagingPreview",
        scope: f.boot.scope,
      })) as StagingReclaimPreview;
      expect(preview.stages).toEqual([]);
      const request = {
        action: "stagingAbandon",
        scope: f.boot.scope,
        writerId: f.boot.auth.writerId,
        copyId: "committed",
        manifestHash: transfer.manifestHash,
        expectedCut: preview.cut,
      };
      await expect(
        provider.admin({ ...request, manifestHash: "a".repeat(64) }),
      ).rejects.toThrow("COPY_MANIFEST_HASH_MISMATCH");
      await expect(provider.admin(request)).rejects.toThrow(
        "COPY_ALREADY_COMMITTED",
      );
      expect(
        f.authority.workspaces(recovered.token, "org")[0].documents,
      ).toHaveLength(2);
      f.authority.verify();
    } finally {
      provider?.close();
      await f.close();
    }
  });
  it("connects actual maintenance CLI preview and abandon with only metadata results", async () => {
    const f = await fixture();
    try {
      await f.stage("operator");
      const recovered = f.authority.recover(
          "org",
          f.boot.recoveryKey,
          "replacement",
        ),
        tokenFile = join(f.root, "token.json");
      writeFileSync(
        tokenFile,
        JSON.stringify({
          token: recovered.token,
          recoveryKey: recovered.recoveryKey,
        }),
        { mode: 0o600 },
      );
      const base = [
        "--root",
        f.authorityRoot,
        "--org",
        "org",
        "--token-file",
        tokenFile,
        "--workspace",
        "ws",
        "--document",
        f.boot.scope.documentId,
        "--incarnation",
        f.boot.scope.incarnationId,
      ];
      const handle = await runMaintenanceOperator([
        ...base,
        "--action",
        "staging-preview",
      ]);
      const preview = handle.result as StagingReclaimPreview;
      await handle.close();
      expect(preview.stages).toHaveLength(1);
      expect(canonical(preview)).not.toContain(RAW);
      const stage = preview.stages[0];
      const clean = await runMaintenanceOperator([
        ...base,
        "--action",
        "staging-abandon",
        "--writer",
        stage.writerId,
        "--copy-id",
        stage.copyId,
        "--manifest-hash",
        stage.manifestHash,
        "--expected-cut",
        canonical(preview.cut),
      ]);
      expect(clean.result).toMatchObject({ abandoned: true, removedParts: 1 });
      await clean.close();
      expect(readFileSync(tokenFile, "utf8")).toContain(recovered.token);
      f.authority.verify();
    } finally {
      await f.close();
    }
  });
});
