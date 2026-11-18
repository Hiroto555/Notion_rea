import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../src/collaboration/runtime/store";
import { createRuntimeGenesis } from "../src/collaboration/runtime/state-root";
import { SharedAssets } from "../src/collaboration/runtime/assets";
import {
  COPY_DOCUMENTS_NAMESPACE,
  COPY_LIFECYCLES_NAMESPACE,
  COPY_PAGES_NAMESPACE,
  previewSharedCopy,
  type SharedCopySource,
} from "../src/collaboration/runtime/copy";
import {
  MAX_COPY_STAGING_PART_BYTES,
  SharedCopyStaging,
  type SharedCopyManifest,
} from "../src/collaboration/runtime/copy-staging";
import {
  CollaborationError,
  type AuthContext,
  type Scope,
} from "../src/collaboration/runtime/contract";
import { canonical } from "../src/collaboration/runtime/canonical";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function newStore(): RuntimeStore {
  const dir = mkdtempSync(join(tmpdir(), "folio-copy-staging-"));
  tempDirs.push(dir);
  const store = new RuntimeStore(dir);
  store.transaction(() => {
    createRuntimeGenesis(store, "epoch-copy-staging", null);
  });
  return store;
}

const auth: AuthContext = {
  userId: "user-1",
  deviceId: "device-1",
  writerId: "writer-1",
  sessionId: "session-1",
};

const otherAuth: AuthContext = {
  userId: "user-2",
  deviceId: "device-2",
  writerId: "writer-2",
  sessionId: "session-2",
};

const jobScope: Scope = {
  orgId: "org-1",
  workspaceId: "workspace-1",
  documentId: "copy-job-1",
  incarnationId: "copy-incarnation-1",
};

const assetScope: Scope = {
  orgId: "org-1",
  workspaceId: "workspace-1",
  documentId: "asset-owner",
  incarnationId: "asset-incarnation",
};

type FixtureSource = SharedCopySource & {
  title: string;
  assets: { hash: string; bytes: Uint8Array }[];
};

function documentWithTexts(prefix: string, texts: string[]) {
  return {
    type: "doc",
    content: texts.map((text, index) => ({
      type: "paragraph",
      attrs: { id: `${prefix}-p${index}` },
      content: [{ type: "text", text }],
    })),
  };
}

function sourceJson(source: FixtureSource): string {
  return canonical({
    id: source.id,
    parentId: source.parentId,
    title: source.title,
    raw: source.raw,
    assets: source.assets
      .map((asset) => ({ hash: asset.hash }))
      .sort((left, right) => left.hash.localeCompare(right.hash)),
  });
}

function splitByBytes(value: string, limit: number): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = start;
    let bytes = 0;
    while (end < value.length) {
      const code = value.charCodeAt(end);
      const width = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
      const piece = value.slice(end, end + width);
      const size = encoder.encode(piece).byteLength;
      if (bytes + size > limit) break;
      bytes += size;
      end += width;
    }
    if (end === start)
      throw new Error("test chunking cannot make progress");
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

function buildFixture(
  copyId: string,
  sources: FixtureSource[],
  allocatedIds: string[],
  options: {
    chunkSize?: number;
    fingerprint?: string;
    assetSizeDelta?: number;
  } = {},
): {
  manifest: SharedCopyManifest;
  parts: string[];
  fingerprint: string;
} {
  const target = { orgId: jobScope.orgId, workspaceId: jobScope.workspaceId };
  let allocated = 0;
  const preview = previewSharedCopy(
    sources,
    sources.map((source) => source.id),
    target,
    () => {
      if (allocated >= allocatedIds.length)
        throw new Error("allocation overflow");
      return allocatedIds[allocated++];
    },
  );

  const chunkSize = options.chunkSize ?? MAX_COPY_STAGING_PART_BYTES;
  const parts: string[] = [];
  const manifestSources = sources.map((source) => {
    const chunks = splitByBytes(sourceJson(source), chunkSize);
    parts.push(...chunks);
    return {
      id: source.id,
      parts: chunks.length,
      assets: source.assets
        .map((asset) => ({
          hash: asset.hash,
          size: asset.bytes.byteLength + (options.assetSizeDelta ?? 0),
        }))
        .sort((left, right) => left.hash.localeCompare(right.hash)),
    };
  });

  const manifest: SharedCopyManifest = {
    copyId,
    selectedIds: sources.map((source) => source.id),
    allocatedIds: [...allocatedIds],
    fingerprint: options.fingerprint ?? preview.fingerprint,
    sources: manifestSources,
    parts: parts.map((part) => ({
      hash: sha256(new TextEncoder().encode(part)),
      size: textBytes(part),
    })),
  };
  return { manifest, parts, fingerprint: preview.fingerprint };
}

function prepare(
  store: RuntimeStore,
  staging: SharedCopyStaging,
  manifest: SharedCopyManifest,
) {
  return store.transaction(() =>
    staging.prepare(auth, jobScope, manifest),
  );
}

function stageAll(
  store: RuntimeStore,
  staging: SharedCopyStaging,
  copyId: string,
  parts: string[],
  skip: number[] = [],
) {
  for (let index = 0; index < parts.length; index++) {
    if (skip.includes(index)) continue;
    store.transaction(() =>
      staging.stagePart(auth, jobScope, copyId, index, parts[index]),
    );
  }
}

function publishAsset(store: RuntimeStore, uploadId: string, bytes: Uint8Array) {
  const assets = new SharedAssets(store);
  const hash = sha256(bytes);
  assets.stage(assetScope, uploadId, bytes);
  assets.publish(assetScope, uploadId, hash);
  return { hash, bytes };
}

function expectCode(work: () => unknown, code: string): void {
  let failure: unknown;
  try {
    work();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(CollaborationError);
  expect((failure as CollaborationError).code).toBe(code);
}

describe("SharedCopyStaging", () => {
  it("atomically commits a selected parent tree with separately staged assets", () => {
    const store = newStore();
    const staging = new SharedCopyStaging(store);
    const assetBytes = new TextEncoder().encode("binary asset payload");
    const asset = publishAsset(store, "upload-child-asset", assetBytes);

    const parent: FixtureSource = {
      id: "source-parent",
      parentId: null,
      title: "Parent page",
      raw: canonical(
        documentWithTexts("parent", ["parent first block", "parent second block"]),
      ),
      assets: [],
    };
    const child: FixtureSource = {
      id: "source-child",
      parentId: "source-parent",
      title: "Child page",
      raw: canonical(
        documentWithTexts("child", ["child block with an asset"]),
      ),
      assets: [{ hash: asset.hash, bytes: asset.bytes }],
    };
    const fixture = buildFixture(
      "copy-parent-tree",
      [parent, child],
      ["copied-parent", "copied-child"],
    );
    const prepared = prepare(store, staging, fixture.manifest);
    stageAll(store, staging, fixture.manifest.copyId, fixture.parts);

    const inspection = staging.inspect(auth, jobScope, fixture.manifest.copyId);
    expect(inspection.missingParts).toEqual([]);
    expect(inspection.stagedParts).toBe(fixture.parts.length);
    expect(inspection.committed).toBeNull();

    const result = store.transaction(() =>
      staging.commit(
        auth,
        jobScope,
        fixture.manifest.copyId,
        prepared.manifestHash,
      ),
    );
    expect(result.scopes.map((scope) => scope.documentId)).toEqual([
      "copied-parent",
      "copied-child",
    ]);
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toHaveLength(2);
    expect(store.all(COPY_PAGES_NAMESPACE)).toHaveLength(2);
    expect(store.all(COPY_LIFECYCLES_NAMESPACE)).toHaveLength(2);
    const childPage = store.get(
      COPY_PAGES_NAMESPACE,
      `org-1:workspace-1:${result.scopes[1].documentId}`,
    ) as { id: string; parentId: string | null };
    expect(childPage.id).toBe("copied-child");
    expect(childPage.parentId).toBe("copied-parent");

    const again = store.transaction(() =>
      staging.commit(
        auth,
        jobScope,
        fixture.manifest.copyId,
        prepared.manifestHash,
      ),
    );
    expect(again).toEqual(result);
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toHaveLength(2);
  });

  it("commits a document larger than 850k split into bounded parts with assets separate", () => {
    const store = newStore();
    const staging = new SharedCopyStaging(store);
    const asset = publishAsset(
      store,
      "upload-large-asset",
      new Uint8Array(2048).fill(7),
    );
    const paragraphs = Array.from({ length: 11 }, (_, index) =>
      String.fromCharCode(97 + (index % 26)).repeat(80_000),
    );
    const source: FixtureSource = {
      id: "source-large",
      parentId: null,
      title: "Large page",
      raw: canonical(documentWithTexts("large", paragraphs)),
      assets: [{ hash: asset.hash, bytes: asset.bytes }],
    };
    const fixture = buildFixture(
      "copy-large",
      [source],
      ["copied-large"],
      { chunkSize: 400_000 },
    );
    const prepared = prepare(store, staging, fixture.manifest);
    expect(prepared.totalSourceBytes).toBeGreaterThan(850_000);
    expect(prepared.partCount).toBeGreaterThan(1);
    expect(
      fixture.manifest.parts.every(
        (part) => part.size <= MAX_COPY_STAGING_PART_BYTES,
      ),
    ).toBe(true);
    expect(fixture.manifest.sources[0].assets).toHaveLength(1);
    stageAll(store, staging, fixture.manifest.copyId, fixture.parts);

    const result = store.transaction(() =>
      staging.commit(
        auth,
        jobScope,
        fixture.manifest.copyId,
        prepared.manifestHash,
      ),
    );
    expect(result.scopes.map((scope) => scope.documentId)).toEqual([
      "copied-large",
    ]);
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toHaveLength(1);
  });

  it("fails an incomplete staging set atomically without publishing destinations", () => {
    const store = newStore();
    const staging = new SharedCopyStaging(store);
    const source: FixtureSource = {
      id: "source-incomplete",
      parentId: null,
      title: "Incomplete",
      raw: canonical(documentWithTexts("incomplete", ["one", "two"])),
      assets: [],
    };
    const fixture = buildFixture(
      "copy-incomplete",
      [source],
      ["copied-incomplete"],
      { chunkSize: 100 },
    );
    expect(fixture.parts.length).toBeGreaterThan(1);
    const prepared = prepare(store, staging, fixture.manifest);
    stageAll(store, staging, fixture.manifest.copyId, fixture.parts, [1]);

    expectCode(
      () =>
        store.transaction(() =>
          staging.commit(
            auth,
            jobScope,
            fixture.manifest.copyId,
            prepared.manifestHash,
          ),
        ),
      "COPY_PART_MISSING",
    );
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toHaveLength(0);
    expect(store.all(COPY_PAGES_NAMESPACE)).toHaveLength(0);
    expect(store.all(COPY_LIFECYCLES_NAMESPACE)).toHaveLength(0);
  });

  it("rejects a client fingerprint that does not match the actual staged source", () => {
    const store = newStore();
    const staging = new SharedCopyStaging(store);
    const source: FixtureSource = {
      id: "source-fingerprint",
      parentId: null,
      title: "Fingerprint",
      raw: canonical(documentWithTexts("fingerprint", ["body"])),
      assets: [],
    };
    const fixture = buildFixture(
      "copy-fingerprint",
      [source],
      ["copied-fingerprint"],
      { fingerprint: "a".repeat(64) },
    );
    const prepared = prepare(store, staging, fixture.manifest);
    stageAll(store, staging, fixture.manifest.copyId, fixture.parts);
    expectCode(
      () =>
        store.transaction(() =>
          staging.commit(
            auth,
            jobScope,
            fixture.manifest.copyId,
            prepared.manifestHash,
          ),
        ),
      "COPY_FINGERPRINT_MISMATCH",
    );
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toHaveLength(0);
  });

  it("rejects a staged asset that is not actually published with the declared size", () => {
    const store = newStore();
    const staging = new SharedCopyStaging(store);
    const assetBytes = new TextEncoder().encode("published smaller");
    const asset = publishAsset(store, "upload-size", assetBytes);
    const source: FixtureSource = {
      id: "source-asset-size",
      parentId: null,
      title: "Asset size",
      raw: canonical(documentWithTexts("asset-size", ["body"])),
      assets: [{ hash: asset.hash, bytes: asset.bytes }],
    };
    const fixture = buildFixture(
      "copy-asset-size",
      [source],
      ["copied-asset-size"],
      { assetSizeDelta: 1 },
    );
    const prepared = prepare(store, staging, fixture.manifest);
    stageAll(store, staging, fixture.manifest.copyId, fixture.parts);
    expectCode(
      () =>
        store.transaction(() =>
          staging.commit(
            auth,
            jobScope,
            fixture.manifest.copyId,
            prepared.manifestHash,
          ),
        ),
      "COPY_ASSET_SIZE_MISMATCH",
    );
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toHaveLength(0);
  });

  it("hides staged source from another writer and refuses their commit", () => {
    const store = newStore();
    const staging = new SharedCopyStaging(store);
    const source: FixtureSource = {
      id: "source-secret",
      parentId: null,
      title: "Secret",
      raw: canonical(documentWithTexts("secret", ["secret body"])),
      assets: [],
    };
    const fixture = buildFixture(
      "copy-secret",
      [source],
      ["copied-secret"],
    );
    const prepared = prepare(store, staging, fixture.manifest);
    stageAll(store, staging, fixture.manifest.copyId, fixture.parts);

    expectCode(
      () => staging.inspect(otherAuth, jobScope, fixture.manifest.copyId),
      "COPY_NOT_FOUND",
    );
    expectCode(
      () =>
        store.transaction(() =>
          staging.commit(
            otherAuth,
            jobScope,
            fixture.manifest.copyId,
            prepared.manifestHash,
          ),
        ),
      "COPY_NOT_FOUND",
    );
    expect(store.all(COPY_DOCUMENTS_NAMESPACE)).toHaveLength(0);

    const result = store.transaction(() =>
      staging.commit(
        auth,
        jobScope,
        fixture.manifest.copyId,
        prepared.manifestHash,
      ),
    );
    expect(result.scopes.map((scope) => scope.documentId)).toEqual([
      "copied-secret",
    ]);
  });
});


describe("staging admission and explicit cancellation", () => {
 it("bounds active reservations and frees uncommitted parts only for the original actor", () => {
  const store = newStore(), staging = new SharedCopyStaging(store);
  try {
   const source: FixtureSource = {id:"source-cap",parentId:null,title:"cap",raw:JSON.stringify(documentWithTexts("cap",["private raw"])),assets:[]};
   const fixtures = Array.from({length:9},(_,i)=>buildFixture("cap-"+i,[source],["allocated-"+i]));
   for (const fixture of fixtures.slice(0,8)) prepare(store,staging,fixture.manifest);
   expectCode(()=>prepare(store,staging,fixtures[8].manifest),"COPY_STAGING_CAPACITY");
   const first = fixtures[0], prepared = prepare(store,staging,first.manifest);
   stageAll(store,staging,first.manifest.copyId,first.parts);
   expectCode(()=>store.transaction(()=>staging.abandon(otherAuth,jobScope,first.manifest.copyId,prepared.manifestHash)),"COPY_NOT_FOUND");
   expectCode(()=>store.transaction(()=>staging.abandon(auth,jobScope,first.manifest.copyId,"0".repeat(64))),"COPY_MANIFEST_HASH_MISMATCH");
   expect(store.transaction(()=>staging.abandon(auth,jobScope,first.manifest.copyId,prepared.manifestHash)).removedParts).toBe(first.parts.length);
   expect(store.transaction(()=>staging.abandon(auth,jobScope,first.manifest.copyId,prepared.manifestHash)).removedParts).toBe(0);
   expectCode(()=>prepare(store,staging,first.manifest),"COPY_ABANDONED");
   expectCode(()=>store.transaction(()=>staging.stagePart(auth,jobScope,first.manifest.copyId,0,first.parts[0])),"COPY_ABANDONED");
   expect(()=>prepare(store,staging,fixtures[8].manifest)).not.toThrow();
   expect(store.all("documents")).toHaveLength(0);
  } finally {store.close();}
 });
 it("reserves aggregate manifest bytes before accepting any raw part", () => {
  const store = newStore(), staging = new SharedCopyStaging(store);
  try {
   const source: FixtureSource = {id:"source-reserve",parentId:null,title:"cap",raw:JSON.stringify(documentWithTexts("reserve",["small"])),assets:[]};
   const first = buildFixture("large-reserve",[source],["allocated-a"]).manifest;
   first.parts = Array.from({length:64},()=>({hash:"a".repeat(64),size:500_000})); first.sources[0].parts=64;
   prepare(store,staging,first);
   const second = {...first,copyId:"second-reserve",allocatedIds:["allocated-b"]};
   expectCode(()=>prepare(store,staging,second),"COPY_STAGING_CAPACITY");
   expect(store.all("copy.staging")).toHaveLength(1);
  } finally {store.close();}
 });
});
