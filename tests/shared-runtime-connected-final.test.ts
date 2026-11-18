import { HttpSharedProvider } from "../src/collaboration/runtime/http-provider";
import { SharedRuntimeClient } from "../src/collaboration/runtime/client";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Doc } from "../src/shared/types";
import { SharedAuthority } from "../src/collaboration/runtime/authority";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import {
  CollaborationError,
  scopeKey,
  type Attempt,
  type AuthContext,
  type Receipt,
  type Scope,
  type Snapshot,
} from "../src/collaboration/runtime/contract";
import { digest } from "../src/collaboration/runtime/digest";
import {
  createSharedHttpServer,
  type SharedHttpServer,
} from "../src/collaboration/runtime/http-server";
import { SharedRuntimeService } from "../src/main/shared-runtime-service";
import { readPrivateCopySources } from "../src/main/shared-copy-source";
import { Store } from "../src/persistence/store";

const TEST_TIMEOUT = 30_000;
const ORG = "org1";
const WORKSPACE = "ws1";
const OWNER = "owner";
const ASSET_A = "11111111-1111-4111-8111-111111111111";
const ASSET_B = "22222222-2222-4222-8222-222222222222";
const ASSET_SECRET = "33333333-3333-4333-8333-333333333333";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function paragraph(id: string, text: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    ...(text.length > 0 ? { content: [{ type: "text", text }] } : {}),
  };
}

function linkedParagraph(id: string, text: string, href: string): Doc {
  return {
    type: "paragraph",
    attrs: { id },
    content: [
      { type: "text", text, marks: [{ type: "link", attrs: { href } }] },
    ],
  };
}

function image(id: string, src: string): Doc {
  return { type: "image", attrs: { id, src } };
}

function documentWith(...content: Doc[]): Doc {
  return { type: "doc", content };
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function codeOf(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    return error instanceof CollaborationError ? error.code : String(error);
  }
}

function walk(document: Doc, visit: (node: Doc) => void): void {
  visit(document);
  for (const child of document.content ?? []) walk(child, visit);
}

function inlineText(document: Doc, id: string): string {
  let text = "";
  walk(document, (node) => {
    if (node.attrs?.id === id)
      text = (node.content ?? []).map((child) => child.text ?? "").join("");
  });
  return text;
}

function collectBlockIds(document: Doc): string[] {
  const ids: string[] = [];
  walk(document, (node) => {
    if (typeof node.attrs?.id === "string") ids.push(node.attrs.id);
  });
  return ids;
}

function pageData(
  id: string,
  doc: Doc,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    schemaVersion: 1,
    parentId: null,
    title: `Page ${id}`,
    icon: "",
    cover: "",
    position: 0,
    doc,
    kind: "page",
    database: null,
    favorite: false,
    createdAt: 0,
    updatedAt: 0,
    revision: 0,
    deletedAt: null,
    ...overrides,
  };
}

function insertPage(store: Store, id: string, doc: Doc): void {
  store.db
    .prepare("INSERT INTO pages(id,data,body) VALUES(?,?,?)")
    .run(id, JSON.stringify(pageData(id, doc)), "");
}

function updatePage(store: Store, id: string, doc: Doc): void {
  store.db
    .prepare("UPDATE pages SET data=? WHERE id=?")
    .run(JSON.stringify(pageData(id, doc)), id);
}

function pageRow(store: Store, id: string): string {
  const row = store.db.prepare("SELECT data FROM pages WHERE id=?").get(id) as
    { data: string } | undefined;
  return row!.data;
}

function insertAsset(
  store: Store,
  assetsDirectory: string,
  id: string,
  bytes: Uint8Array,
): void {
  const path = join(assetsDirectory, id);
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  store.db.prepare("INSERT INTO assets(id,metadata) VALUES(?,?)").run(
    id,
    JSON.stringify({
      id,
      storageName: id,
      name: `${id}.png`,
      extension: ".png",
      mime: "image/png",
      size: bytes.byteLength,
      sha256: sha(bytes),
    }),
  );
}

type AttemptRow = {
  attempt: Attempt;
  attemptHash: string;
  intentHash: string;
  userId: string;
  deviceId: string;
  state: string;
  receipt: Receipt;
};

type Fixture = {
  tmp: string;
  authority: SharedAuthority;
  server: SharedHttpServer;
  url: string;
  token: string;
  auth: AuthContext;
  scope: Scope;
  attempts: Attempt[];
  services: SharedRuntimeService[];
  cleanup(): Promise<void>;
};

async function setup(): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), "folio-connected-final-"));
  const authority = new SharedAuthority(join(tmp, "authority"));
  const boot = authority.bootstrap({
    orgId: ORG,
    userId: OWNER,
    deviceId: "owner-device",
    workspaceId: WORKSPACE,
    documentId: "doc1",
    document: documentWith(paragraph("p1", "Hello")),
  });
  const attempts: Attempt[] = [];
  const server = createSharedHttpServer({
    admin: (token, input) => authority.admin(token, input),
    stageAsset: (token, scope, uploadId, bytes) =>
      authority.stageAsset(token, scope, uploadId, bytes),
    readAsset: (token, scope, hash) => authority.readAsset(token, scope, hash),
    session: (token, orgId) => authority.session(token, orgId),
    snapshot: (token, scope, after) => authority.snapshot(token, scope, after),
    submit: (token, attempt) => {
      attempts.push(attempt);
      return authority.submit(token, attempt);
    },
    receipt: (token, attempt) => authority.receipt(token, attempt),
    invalidate: (token, attempt) => authority.invalidate(token, attempt),
    proof: (token, scope, seq) => authority.proof(token, scope, seq),
    workspaces: (token, orgId) => authority.workspaces(token, orgId),
    join: (token, orgId, deviceId) => authority.join(token, orgId, deviceId),
  });
  const { url } = await server.listen();
  const services: SharedRuntimeService[] = [];
  return {
    tmp,
    authority,
    server,
    url,
    token: boot.token,
    auth: boot.auth,
    scope: boot.scope,
    attempts,
    services,
    async cleanup() {
      for (const service of services.splice(0)) {
        try {
          service.close();
        } catch {}
      }
      await server.close();
      try {
        authority.close();
      } catch {}
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

async function fixture(): Promise<Fixture> {
  const value = await setup();
  cleanups.push(value.cleanup);
  return value;
}

async function openService(
  f: Fixture,
  copySources?: (ids: string[]) => ReturnType<typeof readPrivateCopySources>,
): Promise<{
  service: SharedRuntimeService;
  generation: number;
  snapshot: Snapshot;
}> {
  const service = new SharedRuntimeService(
    join(f.tmp, `service-${f.services.length}`),
    undefined,
    copySources ? { copySources } : {},
  );
  f.services.push(service);
  await service.handle({
    type: "connect",
    url: f.url,
    token: f.token,
    orgId: ORG,
  });
  const opened = (await service.handle({
    type: "open",
    scope: f.scope,
  })) as { generation: number; snapshot: Snapshot };
  return { service, generation: opened.generation, snapshot: opened.snapshot };
}

function directHarness(): {
  dir: string;
  authority: SharedAuthority;
  token: string;
  recoveryKey: string;
  scope: Scope;
} {
  const dir = mkdtempSync(join(tmpdir(), "folio-connected-direct-"));
  const authority = new SharedAuthority(join(dir, "authority"));
  const boot = authority.bootstrap({
    orgId: "org_root",
    userId: "user_root",
    deviceId: "device_root",
    workspaceId: "ws_root",
    documentId: "doc_root",
    document: documentWith(paragraph("seed", "seed")),
  });
  cleanups.push(() => {
    try {
      authority.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    authority,
    token: boot.token,
    recoveryKey: boot.recoveryKey,
    scope: boot.scope,
  };
}

function reopenCode(dir: string): string | null {
  return codeOf(() => {
    const value = new SharedAuthority(join(dir, "authority"));
    value.close();
  });
}

function attemptRows(
  authority: SharedAuthority,
): { key: string; row: AttemptRow }[] {
  return authority.store
    .all("authority.attempts")
    .map((entry) => ({ key: entry.key, row: entry.value as AttemptRow }));
}

function rewriteAttempt(
  authority: SharedAuthority,
  key: string,
  create: (row: AttemptRow) => Attempt,
): void {
  authority.store.transaction(() => {
    const row = authority.store.get("authority.attempts", key) as AttemptRow;
    const attempt = create(row);
    const attemptHash = digest(attempt);
    const intentHash = digest(attempt.intent);
    authority.store.set("authority.attempts", key, {
      ...row,
      attempt,
      attemptHash,
      intentHash,
      receipt: { ...row.receipt, attemptHash, intentHash },
    });
  });
}

describe("main connected copy and asset operations", () => {
  it(
    "commits a previewed private copy through the real resource client with remapped ids, assets and history",
    async () => {
      const f = await fixture();
      const privateDir = mkdtempSync(join(tmpdir(), "folio-private-copy-"));
      const assetsDirectory = join(privateDir, "assets");
      mkdirSync(assetsDirectory, { recursive: true, mode: 0o700 });
      const store = new Store(join(privateDir, "folio.sqlite"));
      cleanups.push(() => {
        try {
          store.close();
        } catch {}
        rmSync(privateDir, { recursive: true, force: true });
      });

      const assetA = new TextEncoder().encode("asset-a-bytes");
      const assetB = new TextEncoder().encode("asset-b-bytes");
      const assetSecret = new TextEncoder().encode("unselected-asset-bytes");
      insertAsset(store, assetsDirectory, ASSET_A, assetA);
      insertAsset(store, assetsDirectory, ASSET_B, assetB);
      insertAsset(store, assetsDirectory, ASSET_SECRET, assetSecret);
      insertPage(
        store,
        "page_a",
        documentWith(
          paragraph("a1", "alpha-private-body"),
          linkedParagraph("a2", "jump-to-b", "folio-page://page_b"),
          image("a3", `folio-asset://${ASSET_A}`),
        ),
      );
      insertPage(
        store,
        "page_b",
        documentWith(
          paragraph("b1", "beta-private-body"),
          image("b2", `folio-asset://${ASSET_B}`),
        ),
      );
      insertPage(
        store,
        "page_secret",
        documentWith(
          paragraph("s1", "UNSELECTED_PRIVATE_SECRET"),
          image("s2", `folio-asset://${ASSET_SECRET}`),
        ),
      );
      const selectedIds = ["page_a", "page_b"];
      const privatePageIds = [...selectedIds, "page_secret"];
      const assetIds = [ASSET_A, ASSET_B, ASSET_SECRET];
      const pagesBefore = new Map<string, string>(
        privatePageIds.map((id) => [id, pageRow(store, id)] as const),
      );
      const assetsBefore = new Map<string, Buffer>(
        assetIds.map(
          (id) => [id, readFileSync(join(assetsDirectory, id))] as const,
        ),
      );

      const opened = await openService(f, (ids) =>
        readPrivateCopySources(store, assetsDirectory, ids),
      );
      const before = f.authority.head();
      const preview = (await opened.service.handle({
        type: "copyPreview",
        generation: opened.generation,
        sourceIds: selectedIds,
      })) as {
        previewId: string;
        documents: { sourceId: string; title: string; scope: Scope }[];
        assets: { sourceId: string; hash: string; bytes: number }[];
      };
      expect(preview.documents.map((entry) => entry.sourceId)).toEqual(
        selectedIds,
      );
      expect(preview.assets.map((entry) => entry.hash).sort()).toEqual(
        [sha(assetA), sha(assetB)].sort(),
      );

      const receipt = (await opened.service.handle({
        type: "copyCommit",
        generation: opened.generation,
        previewId: preview.previewId,
      })) as Receipt;
      expect(receipt.status).toBe("SERVER_ACCEPTED");
      expect(f.authority.head()).toEqual(receipt.cut);
      expect(receipt.cut.seq).toBe(before.seq + 1);

      const scopeBySource = new Map<string, Scope>(
        preview.documents.map(
          (entry) => [entry.sourceId, entry.scope] as const,
        ),
      );
      const scopeA = scopeBySource.get("page_a")!;
      const scopeB = scopeBySource.get("page_b")!;
      const documentA = f.authority.snapshot(f.token, scopeA).state.document;
      const documentB = f.authority.snapshot(f.token, scopeB).state.document;
      expect(
        inlineText(documentA, String(documentA.content?.[0].attrs?.id)),
      ).toBe("alpha-private-body");
      expect(
        inlineText(documentB, String(documentB.content?.[0].attrs?.id)),
      ).toBe("beta-private-body");

      const blockIds = [
        ...collectBlockIds(documentA),
        ...collectBlockIds(documentB),
      ];
      expect(blockIds).not.toContain("a1");
      expect(blockIds).not.toContain("a2");
      expect(blockIds).not.toContain("a3");
      expect(blockIds).not.toContain("b1");
      expect(blockIds).not.toContain("b2");
      expect(new Set(blockIds).size).toBe(blockIds.length);

      let linkedHref: string | null = null;
      walk(documentA, (node) => {
        for (const mark of node.marks ?? [])
          if (mark.type === "link" && typeof mark.attrs?.href === "string")
            linkedHref = mark.attrs.href;
      });
      expect(linkedHref).toBe(`folio-page://${scopeB.documentId}`);

      let imageSrc: string | null = null;
      walk(documentA, (node) => {
        if (node.type === "image" && typeof node.attrs?.src === "string")
          imageSrc = node.attrs.src;
      });
      expect(imageSrc).toBe(`folio-asset://${sha(assetA)}`);

      const expectedHashBytes = new Map<string, Uint8Array>([
        [sha(assetA), assetA],
        [sha(assetB), assetB],
      ]);
      for (const entry of preview.documents) {
        const lifecycle = f.authority.store.get(
          "doclifecycles",
          [
            entry.scope.orgId,
            entry.scope.workspaceId,
            entry.scope.documentId,
          ].join(":"),
        ) as { activeIncarnation: string; deleted: boolean; cut: unknown };
        expect(lifecycle).toMatchObject({
          activeIncarnation: entry.scope.incarnationId,
          deleted: false,
        });
        expect(lifecycle.cut).toEqual(receipt.cut);
        expect(
          f.authority.store.get("documents", scopeKey(entry.scope)),
        ).not.toBeNull();
        const history = f.authority.store.get(
          "history",
          `${scopeKey(entry.scope)}:${receipt.cut.seq}`,
        ) as { cut: unknown; state: { document: Doc } };
        expect(history.cut).toEqual(receipt.cut);
        expect(
          inlineText(
            history.state.document,
            String(history.state.document.content?.[0].attrs?.id),
          ),
        ).toBe(
          entry.sourceId === "page_a"
            ? "alpha-private-body"
            : "beta-private-body",
        );
      }
      for (const hash of expectedHashBytes.keys()) {
        expect(
          f.authority.store.get("asset", `${ORG}:${WORKSPACE}:${hash}`),
        ).not.toBeNull();
        expect(
          Buffer.from(f.authority.store.blobGet(`${ORG}:${WORKSPACE}`, hash)!),
        ).toEqual(Buffer.from(expectedHashBytes.get(hash)!));
      }

      const copyAttempt = f.attempts
        .filter(
          (attempt) =>
            attempt.intent.command.kind === "resource" &&
            attempt.intent.command.action === "copy.commit",
        )
        .at(-1);
      expect(copyAttempt).toBeDefined();
      const receivedCommand = JSON.stringify(copyAttempt!.intent.command);
      expect(receivedCommand).toContain("alpha-private-body");
      expect(receivedCommand).not.toContain("UNSELECTED_PRIVATE_SECRET");
      expect(receivedCommand).not.toContain("page_secret");
      expect(receivedCommand).not.toContain(ASSET_SECRET);

      for (const id of privatePageIds)
        expect(pageRow(store, id)).toBe(pagesBefore.get(id));
      for (const id of assetIds)
        expect(readFileSync(join(assetsDirectory, id))).toEqual(
          assetsBefore.get(id),
        );
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects a source mutation after preview with COPY_SOURCE_CHANGED before any queue or head movement",
    async () => {
      const f = await fixture();
      const privateDir = mkdtempSync(join(tmpdir(), "folio-private-changed-"));
      const assetsDirectory = join(privateDir, "assets");
      mkdirSync(assetsDirectory, { recursive: true, mode: 0o700 });
      const store = new Store(join(privateDir, "folio.sqlite"));
      cleanups.push(() => {
        try {
          store.close();
        } catch {}
        rmSync(privateDir, { recursive: true, force: true });
      });
      insertPage(
        store,
        "page_changed",
        documentWith(paragraph("c1", "before-change")),
      );

      const opened = await openService(f, (ids) =>
        readPrivateCopySources(store, assetsDirectory, ids),
      );
      const preview = (await opened.service.handle({
        type: "copyPreview",
        generation: opened.generation,
        sourceIds: ["page_changed"],
      })) as { previewId: string };
      const headBefore = f.authority.head();
      const commitsBefore = f.attempts.filter(
        (attempt) =>
          attempt.intent.command.kind === "resource" &&
          attempt.intent.command.action === "copy.commit",
      ).length;

      updatePage(
        store,
        "page_changed",
        documentWith(paragraph("c1", "after-change")),
      );
      await expect(
        opened.service.handle({
          type: "copyCommit",
          generation: opened.generation,
          previewId: preview.previewId,
        }),
      ).rejects.toMatchObject({ code: "COPY_SOURCE_CHANGED" });
      expect(f.authority.head()).toEqual(headBefore);
      expect(
        f.attempts.filter(
          (attempt) =>
            attempt.intent.command.kind === "resource" &&
            attempt.intent.command.action === "copy.commit",
        ).length,
      ).toBe(commitsBefore);
    },
    TEST_TIMEOUT,
  );

  it(
    "stages small bytes, publishes a resource and reads back the exact sha through the main service",
    async () => {
      const f = await fixture();
      const { service, generation } = await openService(f);
      const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 254, 255]);
      const hash = sha(bytes);
      const beforeStage = f.authority.head();

      const staged = (await service.handle({
        type: "assetStage",
        generation,
        uploadId: "upload_connected",
        base64: Buffer.from(bytes).toString("base64"),
      })) as { hash: string; bytes: number };
      expect(staged).toEqual({ hash, bytes: bytes.byteLength });
      expect(f.authority.head()).toEqual(beforeStage);

      const published = (await service.handle({
        type: "resource",
        generation,
        scope: f.scope,
        command: {
          kind: "resource",
          action: "asset.publish",
          payload: { uploadId: "upload_connected", hash },
        },
      })) as Receipt;
      expect(published.status).toBe("SERVER_ACCEPTED");
      expect(published.cut.seq).toBe(beforeStage.seq + 1);
      expect(f.authority.head()).toEqual(published.cut);
      expect(
        f.authority.store.get("asset", `${ORG}:${WORKSPACE}:${hash}`),
      ).not.toBeNull();

      const read = (await service.handle({
        type: "assetRead",
        generation,
        hash,
      })) as { hash: string; base64: string; bytes: number };
      expect(read.hash).toBe(hash);
      expect(read.bytes).toBe(bytes.byteLength);
      const returned = new Uint8Array(Buffer.from(read.base64, "base64"));
      expect(Buffer.from(returned)).toEqual(Buffer.from(bytes));
      expect(sha(returned)).toBe(hash);
    },
    TEST_TIMEOUT,
  );

  it(
    "retains the committed receipt while refusing a sender that expires after dispatch",
    async () => {
      const f = await fixture();
      const { service, generation } = await openService(f);
      const before = f.authority.head();
      let checks = 0;
      const authorized = () => f.attempts.length === 0;
      const outcome = await service
        .handle(
          {
            type: "resource",
            generation,
            scope: f.scope,
            command: {
              kind: "resource",
              action: "db.create",
              payload: { databaseId: "db_stale", revision: 0, properties: [] },
            },
          },
          authorized,
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok)
        expect(outcome.error).toMatchObject({
          code: "UNAUTHORIZED_IPC_SENDER",
        });
      // The request was authorized at dispatch. A later navigation cannot
      // undo a remote commit; its durable receipt stays in the old writer.
      expect(f.authority.head().seq).toBe(before.seq + 1);
      const recovered = JSON.parse(
        (await service.handle({ type: "recover", generation })) as string,
      ) as {
        resources: {
          queue: {
            intent: Attempt["intent"];
            state: string;
            attempts: { receipt: Receipt | null }[];
          }[];
        };
      };
      const queued = recovered.resources.queue.find(
        (entry) =>
          entry.intent.command.kind === "resource" &&
          entry.intent.command.action === "db.create",
      );
      expect(queued?.state).toBe("CLIENT_RECEIPT_DURABLE");
      expect(queued?.attempts[0].receipt?.cut).toEqual(f.authority.head());
      expect(f.attempts).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});

describe("root normalization and genesis restore", () => {
  it("rejects rewritten immutable attempt and intent base hashes after reopen", () => {
    for (const target of ["attempt", "intent"] as const) {
      const h = directHarness();
      const first = attemptRows(h.authority)[0]!;
      expect(first).toBeDefined();
      rewriteAttempt(h.authority, first.key, (row) =>
        target === "attempt"
          ? {
              ...row.attempt,
              base: {
                ...row.attempt.base,
                hash: digest("forged-attempt-base"),
              },
            }
          : {
              ...row.attempt,
              intent: {
                ...row.attempt.intent,
                base: {
                  ...row.attempt.intent.base,
                  hash: digest("forged-intent-base"),
                },
              },
            },
      );
      h.authority.close();
      expect(reopenCode(h.dir)).toBe("STATE_ROOT_MISMATCH");
    }
  });

  it("rejects a changed current receipt cut hash even when normalization blanks that hash", () => {
    const h = directHarness();
    const head = h.authority.head();
    const current = attemptRows(h.authority).find(
      (entry) =>
        entry.row.receipt.cut.epoch === head.epoch &&
        entry.row.receipt.cut.seq === head.seq,
    );
    expect(current).toBeDefined();
    h.authority.store.transaction(() => {
      const row = h.authority.store.get(
        "authority.attempts",
        current!.key,
      ) as AttemptRow;
      h.authority.store.set("authority.attempts", current!.key, {
        ...row,
        receipt: {
          ...row.receipt,
          cut: { ...row.receipt.cut, hash: digest("forged-current-cut") },
        },
      });
    });
    h.authority.close();
    expect(reopenCode(h.dir)).toBe("CORRUPT_CUT_POINTER");
  });

  it(
    "restores an old backup under a later current owner and requires the freshly returned key",
    async () => {
      const h = directHarness();
      const backup = h.authority.backup(h.token, "org_root");
      const invite = h.authority.invite(
        h.token,
        "org_root",
        "newowner",
        600_000,
      );
      const joined = h.authority.acceptInvite(invite, "newowner-device");
      h.authority.grant(h.token, h.scope, "newowner", "editor");
      h.authority.handoff(h.token, "org_root", "newowner", ["ws_root"]);
      const current = h.authority.store.get("organization", "org_root") as {
        ownerIds: string[];
        memberIds: string[];
      };
      expect(current.ownerIds).toEqual(["newowner"]);
      expect(current.memberIds).toContain("user_root");

      const deniedDestination = new RuntimeStore(join(h.dir, "denied"));
      expect(
        codeOf(() =>
          h.authority.restoreInto(
            h.token,
            "org_root",
            backup,
            deniedDestination,
            "epoch_denied_old_owner",
          ),
        ),
      ).toBe("FORBIDDEN");
      deniedDestination.close();

      const destinationDir = join(h.dir, "restored");
      const destination = new RuntimeStore(destinationDir);
      const restored = h.authority.restoreInto(
        joined.token,
        "org_root",
        backup,
        destination,
        "epoch_after_old_backup",
      );
      destination.close();
      expect(restored.requiresReauthorization).toBe(true);
      expect(restored.newCut).toMatchObject({
        epoch: "epoch_after_old_backup",
        seq: 0,
      });

      const reopened = new SharedAuthority(destinationDir);
      cleanups.push(() => {
        try {
          reopened.close();
        } catch {}
      });
      expect(() => reopened.verify()).not.toThrow();
      expect(reopened.head()).toEqual(restored.newCut);
      expect(
        reopened.store.get(
          "authority.prefix",
          `${restored.newCut.epoch}:${restored.newCut.seq}`,
        ),
      ).toEqual(restored.newCut);
      expect(reopened.store.get("organization", "org_root")).toMatchObject({
        ownerIds: ["newowner"],
      });
      expect(
        reopened.store.get("identity.users", "org_root/newowner"),
      ).toMatchObject({
        orgId: "org_root",
        userId: "newowner",
        role: "owner",
        status: "active",
      });

      expect(
        codeOf(() =>
          reopened.recover("org_root", h.recoveryKey, "old-key-device"),
        ),
      ).toBe("RECOVERY_INVALID");

      const recovered = reopened.recover(
        "org_root",
        restored.recoveryKey,
        "new-key-device",
      );
      expect(recovered.auth.userId).toBe("newowner");
      expect(() => reopened.verify()).not.toThrow();
      const head = reopened.head();
      expect(head).toMatchObject({ epoch: "epoch_after_old_backup", seq: 1 });
      expect(
        reopened.store.get("authority.prefix", `${head.epoch}:${head.seq}`),
      ).toEqual(head);
      expect(reopened.store.all("authority.events")).toHaveLength(1);
    },
    TEST_TIMEOUT,
  );
});

describe("workspace creation and durable coordinator fences", () => {
  it("creates the first page of a new empty workspace without fabricating a document snapshot", async () => {
    const f = await fixture();
    const service = new SharedRuntimeService(join(f.tmp, "empty-service"));
    f.services.push(service);
    const session = (await service.handle({
      type: "connect",
      url: f.url,
      token: f.token,
      orgId: ORG,
    })) as { generation: number };
    await service.handle({
      type: "admin",
      command: {
        action: "workspaceCreate",
        orgId: ORG,
        workspaceId: "new_space",
        name: "新しい領域",
      },
    });
    await service.handle({ type: "list" });
    const scope = {
      orgId: ORG,
      workspaceId: "new_space",
      documentId: "new_page",
      incarnationId: "new_inc",
    };
    const receipt = (await service.handle({
      type: "resource",
      generation: session.generation,
      scope,
      command: {
        kind: "resource",
        action: "document.create",
        payload: {
          title: "新しいページ",
          document: documentWith(paragraph("new_p", "new body")),
        },
      },
    })) as Receipt;
    expect(receipt.status).toBe("SERVER_ACCEPTED");
    expect(f.authority.snapshot(f.token, scope).cut).toEqual(receipt.cut);
    const opened = (await service.handle({ type: "open", scope })) as {
      scope: Scope;
    };
    expect(opened.scope).toEqual(scope);
    f.authority.verify();
  });
  it("blocks a document UNKNOWN across reconnect even before any document is opened", async () => {
    const f = await fixture();
    const root = join(f.tmp, "pending-service");
    class BeforeSend extends HttpSharedProvider {
      async submit(_attempt: Attempt): Promise<Receipt> {
        throw new Error("OWNED_BEFORE_SEND");
      }
    }
    const directory = join(
      root,
      "writers",
      digest({ url: f.url, orgId: ORG, writerId: f.auth.writerId }),
    );
    const client = new SharedRuntimeClient(
      directory,
      new BeforeSend(f.url, f.token),
      f.scope,
      f.auth.writerId,
    );
    await client.open();
    await expect(
      client.submit({
        kind: "text",
        blockId: "p1",
        before: "Hello",
        from: 0,
        to: 0,
        text: "pending",
      }),
    ).rejects.toThrow("OWNED_BEFORE_SEND");
    client.close();
    const service = new SharedRuntimeService(root);
    f.services.push(service);
    const session = (await service.handle({
      type: "connect",
      url: f.url + "/",
      token: f.token,
      orgId: ORG,
    })) as { generation: number };
    const before = f.authority.head();
    await expect(
      service.handle({
        type: "resource",
        generation: session.generation,
        scope: f.scope,
        command: {
          kind: "resource",
          action: "db.create",
          payload: { databaseId: "blocked_db", revision: 0, properties: [] },
        },
      }),
    ).rejects.toThrow("PENDING_INTENT_BLOCKS_WRITE");
    expect(f.authority.head()).toEqual(before);
  });
  it("excludes trash and old incarnations from current search/export while retaining explicit history", () => {
    const h = directHarness();
    const projection = h.authority.projection(h.token);
    expect(projection.search("org_root", "ws_root", "seed")).toHaveLength(1);
    const base = h.authority.head();
    const auth = h.authority.session(h.token, "org_root");
    const receipt = h.authority.submit(h.token, {
      v: 1,
      attemptId: "trashAttempt",
      base,
      intent: {
        v: 1,
        intentId: "trashIntent",
        writerId: auth.writerId,
        scope: h.scope,
        base,
        command: { kind: "resource", action: "document.trash", payload: {} },
      },
    });
    expect(receipt.status).toBe("SERVER_ACCEPTED");
    expect(projection.search("org_root", "ws_root", "seed")).toHaveLength(0);
    expect(() => projection.exportDocument(h.scope)).toThrow(
      "DOCUMENT_NOT_ACTIVE",
    );
    expect(
      h.authority.documentHistory(h.token, h.scope).length,
    ).toBeGreaterThan(0);
    h.authority.verify();
  });
});

describe("backup operation catalog", () => {
  it("lists a backup as verified only after the real isolated restore proof", () => {
    const h = directHarness();
    const destination = new RuntimeStore(join(h.dir, "verify-catalog"));
    try {
      const proof = h.authority
        .retention(h.token, "org_root")
        .verifyBackup(h.authority.head(), destination, "catalog_epoch");
      const overview = h.authority.admin(h.token, {
        action: "overview",
        orgId: "org_root",
      }) as { backups: { hash: string; verified: boolean }[] };
      expect(overview.backups).toContainEqual(
        expect.objectContaining({ hash: proof.backupHash, verified: true }),
      );
      h.authority.verify();
    } finally {
      destination.close();
    }
  });
});
