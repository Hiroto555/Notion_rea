import { previewFencedStaging, abandonFencedStaging, type StagingReclaimRequest } from "./staging-maintenance";
import { migrateEditorProtocol, readRuntimeProtocol } from "./protocol-migration";
import { SharedCopyStaging } from "./copy-staging";
import { rememberEditorVersions, editorBaseState } from "./editor-versions";
import { applyEditorBatch } from "./editor-batch";
import { executeAssetCollection } from "./maintenance";
import { applyCopyPayload } from "./copy-command";
import { authorizeRestoredOperator } from "./restore-authorization";
import { assertDeleteBase } from "./delete-conflict";
import {
  captureDeleteWitness,
  storeDeleteWitness,
  validateRestoreWitness,
  markRestoreUsed,
} from "./undo-witness";
import { executeSharedAdmin } from "./admin";
import { randomUUID } from "node:crypto";
import type { Doc } from "../../shared/types";
import { type RuntimeStoreOptions, RuntimeStore } from "./store";
import { IdentityAuthority } from "./identity";
import { WorkspacePolicy } from "./policy";
import { SharedAssets } from "./assets";
import { applyRecords, readRecords } from "./records";
import { DocumentLifecycle } from "./lifecycle";
import { SharedProjection } from "./projection";
import { OrganizationService } from "./organization";
import { RuntimeOperations } from "./operations";
import { exportBackup, restoreBackup } from "./backup";
import { RetentionService, readRetentionCheckpoint } from "./retention";
import { applyBlock } from "./block-commands";
import { applyTable, seedTables } from "./table-commands";
import { applyText } from "./text-intent";
import { initialState, checkedState } from "./document";
import { digest } from "./digest";
import { canonical } from "./canonical";
import {
  authorityStateRoot,
  createRuntimeGenesis,
  assertRuntimeStateRoot,
} from "./state-root";
import { parseAttempt, parseScope, parseCut } from "./wire";
import {
  demand,
  identifier,
  sameScope,
  scopeKey,
  clone,
  CollaborationError,
  type Scope,
  type Attempt,
  type AuthContext,
  type Cut,
  type DocumentState,
  type Receipt,
  type RuntimeEvent,
  type Snapshot,
  type Json,
} from "./contract";

type AttemptRecord = {
  attempt: Attempt;
  attemptHash: string;
  intentHash: string;
  userId: string;
  deviceId: string;
  state: string;
  receipt: Receipt;
};
type IntentRecord = {
  intentHash: string;
  userId: string;
  writerId: string;
  accepted: Receipt | null;
};
const asJson = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const eventKey = (seq: number) => String(seq).padStart(16, "0");
const GENESIS_FORMAT = "folio.shared.genesis/2";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
export function runtimeEventHash(event: RuntimeEvent): string {
  const base = {
    seq: event.seq,
    epoch: event.epoch,
    previousHash: event.previousHash,
    scope: event.scope,
    intentId: event.intentId,
    attemptId: event.attemptId,
    writerId: event.writerId,
    command: event.command,
    appliedText: event.appliedText,
    state: event.state,
    status: event.receipt.status,
    code: event.receipt.code,
    resultHash: event.receipt.resultHash,
    intentHash: event.receipt.intentHash,
    attemptHash: event.receipt.attemptHash,
  };
  if (event.appliedBefore !== undefined) Object.assign(base, { appliedBefore: event.appliedBefore });
  return digest(
    event.authorityStateHash === undefined
      ? base
      : { ...base, authorityStateHash: event.authorityStateHash },
  );
}
function readAuthorityGenesis(store: RuntimeStore): {
  epoch: string;
  authorityStateHash: string;
} {
  const value = store.get("meta", "genesis");
  demand(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "UNROOTED_AUTHORITY",
  );
  const record = value as Record<string, unknown>;
  demand(
    record.format === GENESIS_FORMAT && Object.keys(record).length === 4,
    "UNROOTED_AUTHORITY",
  );
  const epoch = identifier(record.epoch);
  demand(
    typeof record.authorityStateHash === "string" &&
      HASH_PATTERN.test(record.authorityStateHash),
    "UNROOTED_AUTHORITY",
  );
  demand(
    record.sourceHash === null ||
      (typeof record.sourceHash === "string" &&
        HASH_PATTERN.test(record.sourceHash)),
    "UNROOTED_AUTHORITY",
  );
  const proof = store.get("authority.prefix", epoch + ":0");
  demand(proof !== null, "GENESIS_PREFIX_MISSING");
  const cut = parseCut(proof);
  demand(
    cut.epoch === epoch && cut.seq === 0 && cut.hash === digest(record),
    "GENESIS_PREFIX_MISMATCH",
  );
  return { epoch, authorityStateHash: record.authorityStateHash };
}

/** Single shared SQLite authority. No private Store/checkpoint or Electron imports. */
export class SharedAuthority {
  readonly store: RuntimeStore;
  readonly identity: IdentityAuthority;
  readonly policy: WorkspacePolicy;
  private readonly assets: SharedAssets;
  readonly lifecycle: DocumentLifecycle;
  readonly organization: OrganizationService;
  readonly operations: RuntimeOperations;
  private readonly retentionCore: RetentionService;
  constructor(directory: string, options: RuntimeStoreOptions = {}) {
    this.store = new RuntimeStore(directory, options);
    this.identity = new IdentityAuthority(this.store);
    this.policy = new WorkspacePolicy(this.store);
    this.assets = new SharedAssets(this.store);
    this.lifecycle = new DocumentLifecycle(this.store);
    this.retentionCore = new RetentionService(this.store);
    this.organization = new OrganizationService(this.store, this.policy);
    this.operations = new RuntimeOperations(this.store, (auth, orgId) =>
      this.assertOrganizationAdministrator(auth, orgId),
      migrateEditorProtocol,
    );
    try {
      this.store.transaction(() => {
        const role = this.store.get("meta", "role");
        demand(role === null || role === "authority", "WRONG_STORE_ROLE");
        if (role === null) {
          this.store.set("meta", "role", "authority");
          if (
            this.store.get("meta", "head") === null &&
            this.store.get("meta", "genesis") === null
          )
            createRuntimeGenesis(this.store, randomUUID(), null);
        }
        this.verify();
      });
    } catch (error) {
      this.store.close();
      throw error;
    }
  }
  session(token: string, orgId: string): AuthContext {
    const auth = this.authenticate(token);
    demand(
      orgId === this.store.get("meta", "primary-org"),
      "AUTH_SCOPE_MISMATCH",
    );
    return auth;
  }
  admin(token: string, input: unknown): unknown {
    return this.store.transaction(() => executeSharedAdmin(this, token, input));
  }
  join(inviteToken: string, orgId: string, deviceId: string) {
    demand(
      orgId === this.store.get("meta", "primary-org"),
      "AUTH_SCOPE_MISMATCH",
    );
    return this.acceptInvite(inviteToken, deviceId);
  }
  private protocolVersion(): 1003 | 1004 {
    const orgId = this.store.get("meta", "primary-org");
    demand(typeof orgId === "string", "AUTH_SCOPE_MISMATCH");
    return readRuntimeProtocol(this.store, orgId).protocol;
  }
  protocol(token: string, scope: Scope) {
    this.authorize(this.authenticate(token), parseScope(scope), "read");
    return readRuntimeProtocol(this.store, scope.orgId);
  }
  upgradeProtocol(token: string, orgId: string, backupHash: string) {
    return this.store.transaction(() => {
      const auth = this.authenticate(token); this.assertOrganizationAdministrator(auth, orgId);
      const base = this.head();
      this.operations.beginUpgrade(auth, orgId, 1004, backupHash);
      let code: string | null = null;
      try { this.operations.finishUpgrade(auth, orgId, true); }
      catch (error) {
        code = error instanceof CollaborationError ? error.code : "UPGRADE_FAILED";
        this.operations.finishUpgrade(auth, orgId, false);
      }
      const scope = {orgId, workspaceId: "__organization", documentId: "__control", incarnationId: base.epoch};
      const attempt: Attempt = {v: 1, attemptId: randomUUID(), base, intent: {v: 1, intentId: randomUUID(), writerId: auth.writerId, scope, base, command: {kind: "resource", action: "operations.upgrade", payload: {target: 1004, backupHash}}}};
      this.commit(attempt, auth, code ? "REJECTED" : "SERVER_ACCEPTED", code, null, null, {protocol: 1004});
      return {status: code ? "RECOVERY_REQUIRED" : "COMMITTED", code, protocol: this.protocolVersion()};
    });
  }
  head(): Cut {
    return parseCut(this.store.get("meta", "head"));
  }
  private authenticate(token: string): AuthContext {
    const auth = this.identity.authenticate(token);
    const row = this.store.get("identity.sessions", digest(token)) as {
      orgId?: string;
      userId?: string;
    } | null;
    demand(
      row &&
        row.userId === auth.userId &&
        row.orgId === this.store.get("meta", "primary-org"),
      "AUTH_SCOPE_MISMATCH",
    );
    return auth;
  }
  private authorize(
    auth: AuthContext,
    scope: Scope,
    action: "read" | "write" | "manage" | "audit",
  ): void {
    demand(
      scope.orgId === this.store.get("meta", "primary-org"),
      "AUTH_SCOPE_MISMATCH",
    );
    this.policy.authorize(auth, scope, action);
  }
  private assertOrganizationAdministrator(
    auth: AuthContext,
    orgId: string,
  ): void {
    demand(
      orgId === this.store.get("meta", "primary-org"),
      "AUTH_SCOPE_MISMATCH",
    );
    const org = this.store.get("organization", identifier(orgId)) as {
      ownerIds?: string[];
      memberIds?: string[];
    } | null;
    demand(
      org?.memberIds?.includes(auth.userId) &&
        org.ownerIds?.includes(auth.userId),
      "FORBIDDEN",
    );
  }
  private attemptKey(attempt: Attempt): string {
    return (
      scopeKey(attempt.intent.scope) +
      ":" +
      attempt.intent.writerId +
      ":" +
      attempt.attemptId
    );
  }
  private intentKey(attempt: Attempt): string {
    return (
      scopeKey(attempt.intent.scope) +
      ":" +
      attempt.intent.writerId +
      ":" +
      attempt.intent.intentId
    );
  }
  private prefix(seq: number, epoch = this.head().epoch): Cut | null {
    const cut = this.store.get("authority.prefix", epoch + ":" + seq);
    return cut === null ? null : parseCut(cut);
  }
  proof(token: string, scope: Scope, seq: number): Cut | null {
    const auth = this.authenticate(token);
    this.authorize(auth, parseScope(scope), "read");
    demand(Number.isSafeInteger(seq) && seq >= 0, "INVALID_COUNTER");
    return this.prefix(seq);
  }
  private assertBase(cut: Cut, allowCompacted = false): void {
    const head = this.head();
    demand(cut.epoch === head.epoch, "STALE_EPOCH");
    const checkpoint = readRetentionCheckpoint(this.store);
    demand(
      allowCompacted ||
        !checkpoint ||
        checkpoint.body.cut.epoch !== head.epoch ||
        cut.seq >= checkpoint.body.cut.seq,
      "BASE_COMPACTED",
    );
    const known = this.prefix(cut.seq);
    demand(
      known && known.hash === cut.hash && cut.seq <= head.seq,
      "PREFIX_UNKNOWN_OR_ROLLBACK",
    );
  }
  private assertMoveBase(scope: Scope, blockId: string, base: Cut): void {
    this.assertBase(base);
    for (const event of this.events()) {
      if (!sameScope(event.scope, scope) || event.seq <= base.seq || event.receipt.status !== "SERVER_ACCEPTED") continue;
      const commands = event.command.kind === "batch" ? event.command.commands : [event.command];
      demand(!commands.some(command => (command.kind === "block.move" && command.blockId === blockId) || (command.kind === "block.frame" && [...command.retainIds, ...command.beforeIds].includes(blockId))), "MOVE_CONFLICT");
    }
  }
  private events(): RuntimeEvent[] {
    return this.store
      .all("authority.events")
      .map((row) => row.value as RuntimeEvent)
      .filter((e) => e.epoch === this.head().epoch)
      .sort((a, b) => a.seq - b.seq);
  }
  verify(): void {
    const head = this.head();
    const genesis = readAuthorityGenesis(this.store);
    demand(genesis.epoch === head.epoch, "GENESIS_HEAD_MISMATCH");
    const checkpoint = readRetentionCheckpoint(this.store);
    const active =
      checkpoint && checkpoint.body.cut.epoch === head.epoch
        ? checkpoint
        : null;
    let previous = active ? active.body.cut : this.prefix(0, head.epoch);
    demand(previous, "CORRUPT_GENESIS");
    let expected =
      active?.body.authorityStateHash ?? genesis.authorityStateHash;
    const events = this.events();
    for (const event of events) {
      demand(
        event.authorityStateHash !== undefined &&
          HASH_PATTERN.test(event.authorityStateHash),
        "UNROOTED_EVENT",
      );
      demand(
        event.seq === previous.seq + 1 &&
          event.previousHash === previous.hash &&
          event.hash === runtimeEventHash(event),
        "CORRUPT_EVENT_CHAIN",
      );
      demand(
        event.receipt.cut.hash === event.hash &&
          event.receipt.cut.seq === event.seq &&
          event.receipt.cut.epoch === event.epoch,
        "CORRUPT_RECEIPT",
      );
      previous = event.receipt.cut;
      expected = event.authorityStateHash!;
    }
    demand(
      previous.seq === head.seq && previous.hash === head.hash,
      "CORRUPT_HEAD",
    );
    const stored = this.store.get("meta", "state-root");
    demand(
      typeof stored === "string" && stored === expected,
      "STATE_ROOT_MISMATCH",
    );
    assertRuntimeStateRoot(this.store, expected);
    const assertPointer = (cut: Cut) => {
      const known = this.store.get(
        "authority.prefix",
        cut.epoch + ":" + cut.seq,
      );
      demand(
        known && canonical(known) === canonical(cut),
        "CORRUPT_CUT_POINTER",
      );
    };
    for (const row of this.store.all("authority.attempts")) {
      const record = row.value as AttemptRecord;
      demand(
        record.attemptHash === digest(record.attempt) &&
          record.intentHash === digest(record.attempt.intent) &&
          record.receipt.attemptHash === record.attemptHash &&
          record.receipt.intentHash === record.intentHash,
        "CORRUPT_ATTEMPT",
      );
      assertPointer(record.receipt.cut);
    }
    for (const row of this.store.all("authority.intents")) {
      const record = row.value as IntentRecord;
      if (record.accepted) assertPointer(record.accepted.cut);
    }
    for (const row of this.store.all("authority.undo")) {
      const record = row.value as { cut: Cut | null };
      if (record.cut) assertPointer(record.cut);
    }
    for (const row of this.store.all("doclifecycles")) {
      const record = row.value as { cut: Cut };
      assertPointer(record.cut);
    }
  }
  bootstrap(input: {
    orgId: string;
    userId: string;
    deviceId: string;
    workspaceId: string;
    documentId: string;
    document: Doc;
  }): { token: string; recoveryKey: string; auth: AuthContext; scope: Scope } {
    return this.store.transaction(() => {
      demand(
        this.store.get("meta", "primary-org") === null,
        "ALREADY_BOOTSTRAPPED",
      );
      const result = this.identity.bootstrap(
        identifier(input.orgId),
        identifier(input.userId),
        identifier(input.deviceId),
      );
      this.store.set("meta", "primary-org", input.orgId);
      this.policy.createWorkspace(
        result.auth,
        input.orgId,
        identifier(input.workspaceId),
        "共有ワークスペース",
      );
      const scope = {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        documentId: identifier(input.documentId),
        incarnationId: randomUUID(),
      };
      const receipt = this.createDocument(
        result.token,
        scope,
        input.document,
        "共有ページ",
      );
      demand(
        receipt.status === "SERVER_ACCEPTED",
        receipt.code ?? "SEED_FAILED",
      );
      return { ...result, scope };
    });
  }
  invite(
    token: string,
    orgId: string,
    userId: string,
    ttlMs = 3_600_000,
  ): string {
    return this.control(
      token,
      orgId,
      "identity.invite",
      { userId, ttlMs },
      () => this.identity.invite(token, orgId, userId, ttlMs),
    );
  }
  acceptInvite(inviteToken: string, deviceId: string) {
    return this.store.transaction(() => {
      this.operations.assertWriter(this.protocolVersion());
      const result = this.identity.acceptInvite(inviteToken, deviceId);
      const auth = this.authenticate(result.token);
      const base = this.head();
      const orgId = String(this.store.get("meta", "primary-org"));
      const scope = {
        orgId,
        workspaceId: "__organization",
        documentId: "__control",
        incarnationId: base.epoch,
      };
      const attempt: Attempt = {
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
            action: "identity.accept",
            payload: { userId: auth.userId, deviceId: auth.deviceId },
          },
        },
      };
      this.commit(attempt, auth, "SERVER_ACCEPTED", null, null, null, {
        joined: true,
      });
      return result;
    });
  }
  grant(
    token: string,
    scope: Scope,
    userId: string,
    role: "owner" | "editor" | "viewer" | null,
  ): void {
    const auth = this.authenticate(token);
    const base = this.head();
    const receipt = this.submit(token, {
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
          action: "workspace.grant",
          payload: { userId, role },
        },
      },
    });
    demand(
      receipt.status === "SERVER_ACCEPTED",
      receipt.code ?? "GRANT_FAILED",
    );
  }
  private control<T>(
    token: string,
    orgId: string,
    action: string,
    payload: Json,
    work: () => T,
  ): T {
    return this.store.transaction(() => {
      const auth = this.authenticate(token);
      this.assertOrganizationAdministrator(auth, orgId);
      const base = this.head();
      const scope = {
        orgId,
        workspaceId: "__organization",
        documentId: "__control",
        incarnationId: base.epoch,
      };
      const attempt: Attempt = {
        v: 1,
        attemptId: randomUUID(),
        base,
        intent: {
          v: 1,
          intentId: randomUUID(),
          writerId: auth.writerId,
          scope,
          base,
          command: { kind: "resource", action, payload },
        },
      };
      this.operations.assertWriter(this.protocolVersion());
      const result = work();
      this.commit(attempt, auth, "SERVER_ACCEPTED", null, null, null, {
        action,
      });
      return result;
    });
  }
  stagingPreview(token: string, input: Scope) {
    return this.store.transaction(() => {
      const scope = parseScope(input), auth = this.authenticate(token);
      this.assertOrganizationAdministrator(auth, scope.orgId);
      this.authorize(auth, scope, "manage");
      return previewFencedStaging(this.store, scope);
    });
  }
  stagingAbandon(token: string, input: StagingReclaimRequest) {
    const request = {...input, scope: parseScope(input.scope), expectedCut: parseCut(input.expectedCut)};
    return this.control(token, request.scope.orgId, "maintenance.staging.abandon", asJson(request), () => {
      this.authorize(this.authenticate(token), request.scope, "manage");
      return abandonFencedStaging(this.store, request);
    });
  }
  collectAssetPlan(token: string, scope: Scope, expectedCut: Cut, hashes: readonly string[]) {
    const checked = parseScope(scope);
    return this.control(token, checked.orgId, "maintenance.assets.collect", asJson({ scope: checked, expectedCut, hashes }), () => {
      this.authorize(this.authenticate(token), checked, "manage");
      return executeAssetCollection(this.store, this.assets, checked, expectedCut, hashes);
    });
  }
  createWorkspace(
    token: string,
    orgId: string,
    workspaceId: string,
    name: string,
  ): void {
    this.control(
      token,
      orgId,
      "workspace.create",
      { workspaceId, name },
      () => {
        const auth = this.authenticate(token);
        this.policy.createWorkspace(auth, orgId, workspaceId, name);
      },
    );
  }
  revokeMember(token: string, orgId: string, userId: string): void {
    this.control(token, orgId, "organization.revoke", { userId }, () => {
      this.organization.revoke(this.authenticate(token), orgId, userId);
      this.identity.fenceRemovedMember(orgId, userId);
    });
  }
  handoff(
    token: string,
    orgId: string,
    userId: string,
    workspaces: string[],
  ): void {
    this.control(
      token,
      orgId,
      "organization.handoff",
      { userId, workspaces },
      () => {
        this.organization.handoff(
          this.authenticate(token),
          orgId,
          userId,
          workspaces,
        );
        this.identity.synchronizeOrganization(orgId, true);
      },
    );
  }

  workspaces(token: string, orgId: string) {
    const auth = this.authenticate(token);
    demand(
      orgId === this.store.get("meta", "primary-org"),
      "AUTH_SCOPE_MISMATCH",
    );
    return this.policy
      .workspaces(auth, orgId)
      .filter((w) => w.role !== null)
      .map((w) => ({
        ...w,
        documents: this.documents(auth, orgId, w.workspaceId),
      }));
  }
  private documents(
    auth: AuthContext,
    orgId: string,
    workspaceId: string,
  ): { documentId: string; incarnationId: string; title: string }[] {
    const results: {
      documentId: string;
      incarnationId: string;
      title: string;
    }[] = [];
    for (const row of this.store.all("documents")) {
      const parts = row.key.split(":");
      if (parts.length !== 4 || parts[0] !== orgId || parts[1] !== workspaceId)
        continue;
      const scope = {
        orgId,
        workspaceId,
        documentId: parts[2],
        incarnationId: parts[3],
      };
      this.authorize(auth, scope, "read");
      try {
        this.lifecycle.assertActive(scope);
      } catch {
        continue;
      }
      const meta = this.store.get("page.titles", row.key);
      results.push({
        documentId: scope.documentId,
        incarnationId: scope.incarnationId,
        title: typeof meta === "string" ? meta : "共有ページ",
      });
    }
    return results;
  }
  createDocument(
    token: string,
    scope: Scope,
    document: Doc,
    title = "共有ページ",
  ): Receipt {
    const auth = this.authenticate(token);
    const intent = {
      v: 1 as const,
      intentId: randomUUID(),
      writerId: auth.writerId,
      scope: parseScope(scope),
      base: this.head(),
      command: {
        kind: "resource" as const,
        action: "document.create",
        payload: asJson({ document, title }),
      },
    };
    return this.submit(token, {
      v: 1,
      attemptId: randomUUID(),
      intent,
      base: intent.base,
    });
  }
  state(token: string, input: Scope): Snapshot {
    return this.store.transaction(() => this.snapshot(token, input, this.head().seq));
  }
  acceptedEvent(token: string, input: Scope, attemptId: string): RuntimeEvent {
    return this.store.transaction(() => {
      const scope = parseScope(input), auth = this.authenticate(token);
      this.authorize(auth, scope, "read");
      this.lifecycle.assertActive(scope);
      identifier(attemptId);
      const event = [...this.events(), ...this.store.all("authority.archive.events").map(row => row.value as RuntimeEvent)]
        .find(event => event.attemptId === attemptId && sameScope(event.scope, scope) && event.writerId === auth.writerId && event.receipt.status === "SERVER_ACCEPTED");
      demand(event, "ACCEPTED_EVENT_MISSING");
      demand(runtimeEventHash(event) === event.hash && canonical(event.receipt.cut) === canonical({epoch:event.epoch,seq:event.seq,hash:event.hash}), "EVENT_HASH_MISMATCH");
      this.assertBase(event.receipt.cut);
      return clone(event);
    });
  }
  snapshot(token: string, input: Scope, after = 0): Snapshot {
    return this.store.transaction(() => {
      const scope = parseScope(input),
        auth = this.authenticate(token);
      this.authorize(auth, scope, "read");
      this.lifecycle.assertActive(scope);
      const state = this.store.get("documents", scopeKey(scope));
      demand(state, "DOCUMENT_MISSING");
      const cut = this.head();
      demand(
        Number.isSafeInteger(after) && after >= 0 && after <= cut.seq,
        "INVALID_CURSOR",
      );
      return {
        scope,
        cut,
        state: checkedState(state as DocumentState),
        events: this.events().filter(
          (e) => e.seq > after && sameScope(e.scope, scope) &&
            (e.writerId === auth.writerId || (e.receipt.status === "SERVER_ACCEPTED" &&
              !(e.command.kind === "resource" && e.command.action.startsWith("copy.stage.")))),
        ),
      };
    });
  }
  receipt(token: string, input: Attempt): Receipt | null {
    const attempt = parseAttempt(input);
    return this.store.transaction(() => {
      const auth = this.authenticate(token);
      this.authorize(auth, attempt.intent.scope, "read");
      const record = this.store.get(
        "authority.attempts",
        this.attemptKey(attempt),
      ) as AttemptRecord | null;
      if (record) {
        demand(record.userId === auth.userId, "FORBIDDEN");
        demand(record.attemptHash === digest(attempt), "ID_REUSE");
        return clone(record.receipt);
      }
      const intent = this.store.get(
        "authority.intents",
        this.intentKey(attempt),
      ) as IntentRecord | null;
      if (intent) {
        demand(intent.userId === auth.userId, "FORBIDDEN");
        demand(intent.intentHash === digest(attempt.intent), "ID_REUSE");
        return clone(intent.accepted);
      }
      return null;
    });
  }
  submit(
    token: string,
    input: Attempt,
    hooks: { beforeCommit?: () => void; afterCommit?: () => void } = {},
  ): Receipt {
    const attempt = parseAttempt(input);
    let receipt: Receipt;
    receipt = this.store.transaction(() => {
      const auth = this.authenticate(token);
      demand(auth.writerId === attempt.intent.writerId, "WRITER_MISMATCH");
      this.authorize(
        auth,
        attempt.intent.scope,
        attempt.intent.command.kind === "resource" &&
          attempt.intent.command.action.startsWith("workspace.")
          ? "manage"
          : "write",
      );
      const prior = this.store.get(
        "authority.attempts",
        this.attemptKey(attempt),
      ) as AttemptRecord | null;
      const intent = this.store.get(
        "authority.intents",
        this.intentKey(attempt),
      ) as IntentRecord | null;
      if (prior) {
        demand(
          prior.attemptHash === digest(attempt) &&
            prior.intentHash === digest(attempt.intent),
          "ID_REUSE",
        );
        return clone(prior.receipt);
      }
      if (intent) {
        demand(
          intent.userId === auth.userId &&
            intent.intentHash === digest(attempt.intent),
          "ID_REUSE",
        );
        if (intent.accepted) return clone(intent.accepted);
      }
      this.operations.assertWriter(attempt.protocol ?? 1003);
      this.assertBase(attempt.base);
      this.assertBase(attempt.intent.base);
      const key = scopeKey(attempt.intent.scope);
      let state = this.store.get("documents", key) as DocumentState | null;
      let appliedText: RuntimeEvent["appliedText"] = null;
      let appliedBefore: DocumentState | undefined;
      rememberEditorVersions(this.store, this.head());
      let result: unknown = null;
      let code: string | null = null;
      this.store.db.exec("SAVEPOINT runtime_command");
      try {
        const command = attempt.intent.command;
        if (command.kind === "block.move" && command.positionBase) this.assertMoveBase(attempt.intent.scope, command.blockId, command.positionBase);
        if (state) assertDeleteBase(state, attempt, this.events());
        if (command.kind === "resource")
          result = this.resource(
            auth,
            attempt.intent.scope,
            command.action,
            command.payload,
          );
        else {
          this.lifecycle.assertActive(attempt.intent.scope);
          demand(state, "DOCUMENT_MISSING");
          if (command.kind === "batch" || command.kind === "inline" || command.kind === "inline.patch" || command.kind === "inline.mark" || command.kind === "block.format" || command.kind === "block.frame") {
            appliedBefore = clone(state);
            const basis = editorBaseState(this.store, attempt.intent.scope, attempt.intent.base, this.events());
            const commands = command.kind === "batch" ? command.commands : [command];
            state = applyEditorBatch(basis, state, commands, attempt.intent.scope.incarnationId, (atom, current) => {
              assertDeleteBase(current, { ...attempt, intent: { ...attempt.intent, command: atom } }, this.events());
              if (atom.kind === "block.move") this.assertMoveBase(attempt.intent.scope, atom.blockId, atom.positionBase ?? attempt.intent.base);
              if (atom.kind === "block.frame") for (const id of atom.retainIds) this.assertMoveBase(attempt.intent.scope, id, attempt.intent.base);
            });
            this.store.set("documents", key, state);
          } else {
          const tableCommand = command.kind.startsWith("table.")
            ? (command as Parameters<typeof applyTable>[1])
            : null;
          const witness = tableCommand
            ? captureDeleteWitness(state, tableCommand)
            : null;
          if (
            command.kind === "table.row.restore" ||
            command.kind === "table.column.restore"
          )
            validateRestoreWitness(this.store, attempt, auth, command);
          const applied =
            command.kind === "text"
              ? applyText(
                  state,
                  command,
                  this.events()
                    .filter(
                      (e) =>
                        e.seq > attempt.intent.base.seq &&
                        e.receipt.status === "SERVER_ACCEPTED" &&
                        sameScope(e.scope, attempt.intent.scope) &&
                        e.appliedText !== null,
                    )
                    .map((e) => e.appliedText!),
                )
              : command.kind.startsWith("table.")
                ? applyTable(
                    state,
                    command as Parameters<typeof applyTable>[1],
                    attempt.intent.scope.incarnationId,
                  )
                : applyBlock(
                    state,
                    command as Parameters<typeof applyBlock>[1],
                    attempt.intent.scope.incarnationId,
                  );
          state = applied.state;
          appliedText = applied.appliedText;
          this.store.set("documents", key, state);
          if (witness) storeDeleteWitness(this.store, attempt, auth, witness);
          if (
            command.kind === "table.row.restore" ||
            command.kind === "table.column.restore"
          )
            markRestoreUsed(this.store, attempt, command);
          }
        }
        this.store.db.exec("RELEASE SAVEPOINT runtime_command");
        state = this.store.get("documents", key) as DocumentState | null;
      } catch (error) {
        this.store.db.exec("ROLLBACK TO SAVEPOINT runtime_command");
        this.store.db.exec("RELEASE SAVEPOINT runtime_command");
        if (!(error instanceof CollaborationError)) throw error;
        code = error.code;
        state = this.store.get("documents", key) as DocumentState | null;
        appliedText = null;
        appliedBefore = undefined;
        result = null;
      }
      const saved = this.commit(
        attempt,
        auth,
        code ? "REJECTED" : "SERVER_ACCEPTED",
        code,
        state,
        appliedText,
        result,
        appliedBefore,
      );
      hooks.beforeCommit?.();
      return saved;
    });
    try {
      hooks.afterCommit?.();
    } catch (cause) {
      throw new Error("UNKNOWN", { cause });
    }
    return receipt;
  }
  invalidate(token: string, input: Attempt): Receipt {
    const attempt = parseAttempt(input);
    return this.store.transaction(() => {
      const auth = this.authenticate(token);
      this.authorize(auth, attempt.intent.scope, "read");
      this.assertBase(attempt.base, true);
      this.assertBase(attempt.intent.base, true);
      const found = this.receipt(token, attempt);
      if (found) return found;
      demand(auth.writerId === attempt.intent.writerId, "WRITER_MISMATCH");
      return this.commit(
        attempt,
        auth,
        "INVALIDATED",
        "ATTEMPT_CLOSED",
        this.store.get(
          "documents",
          scopeKey(attempt.intent.scope),
        ) as DocumentState | null,
        null,
        null,
      );
    });
  }
  private undoKey(attempt: Attempt): string {
    return (
      scopeKey(attempt.intent.scope) +
      ":" +
      attempt.intent.writerId +
      ":" +
      attempt.intent.intentId
    );
  }
  private sealUndo(attempt: Attempt, cut: Cut, provisional: boolean): void {
    const key = this.undoKey(attempt);
    const value = this.store.get("authority.undo", key) as {
      cut: Cut | null;
    } | null;
    if (value === null) return;
    if (provisional) {
      if (value.cut === null)
        this.store.set("authority.undo", key, { ...value, cut });
    } else if (value.cut !== null && value.cut.hash === "")
      this.store.set("authority.undo", key, { ...value, cut });
  }
  private commit(
    attempt: Attempt,
    auth: AuthContext,
    status: Receipt["status"],
    code: string | null,
    state: DocumentState | null,
    appliedText: RuntimeEvent["appliedText"],
    result: unknown,
    appliedBefore?: DocumentState,
  ): Receipt {
    const head = this.head();
    demand(head.seq < Number.MAX_SAFE_INTEGER, "SEQUENCE_LIMIT");
    const cut = { epoch: head.epoch, seq: head.seq + 1, hash: "" };
    const lifecycleKey = [
      attempt.intent.scope.orgId,
      attempt.intent.scope.workspaceId,
      attempt.intent.scope.documentId,
    ].join(":");
    const lifecycle =
      status === "SERVER_ACCEPTED" && state
        ? (this.store.get("doclifecycles", lifecycleKey) as {
            activeIncarnation: string;
            deleted: boolean;
            cut: Cut;
          } | null)
        : null;
    const prior = this.store.get(
      "authority.intents",
      this.intentKey(attempt),
    ) as IntentRecord | null;
    if (lifecycle)
      this.store.set("doclifecycles", lifecycleKey, { ...lifecycle, cut });
    const receipt: Receipt = {
      v: 1,
      status,
      intentId: attempt.intent.intentId,
      intentHash: digest(attempt.intent),
      attemptId: attempt.attemptId,
      attemptHash: digest(attempt),
      writerId: attempt.intent.writerId,
      scope: attempt.intent.scope,
      cut,
      resultHash: digest({ state, result }),
      code,
    };
    const accepted = status === "SERVER_ACCEPTED";
    this.store.set("authority.attempts", this.attemptKey(attempt), {
      attempt,
      attemptHash: receipt.attemptHash,
      intentHash: receipt.intentHash,
      userId: auth.userId,
      deviceId: auth.deviceId,
      state: status,
      receipt,
    });
    this.store.set("authority.intents", this.intentKey(attempt), {
      intentHash: receipt.intentHash,
      userId: auth.userId,
      writerId: receipt.writerId,
      accepted: accepted ? receipt : (prior?.accepted ?? null),
    });
    if (accepted) this.sealUndo(attempt, cut, true);
    rememberEditorVersions(this.store, cut);
    const authorityStateHash = authorityStateRoot(this.store, cut);
    const event: RuntimeEvent = {
      authorityStateHash,
      seq: cut.seq,
      epoch: cut.epoch,
      previousHash: head.hash,
      hash: "",
      scope: attempt.intent.scope,
      intentId: receipt.intentId,
      attemptId: receipt.attemptId,
      writerId: receipt.writerId,
      command: attempt.intent.command,
      appliedText,
      state,
      receipt,
    };
    if (appliedBefore !== undefined) event.appliedBefore = clone(appliedBefore);
    event.hash = runtimeEventHash(event);
    cut.hash = event.hash;
    this.store.set("authority.events", eventKey(cut.seq), event);
    this.store.set("authority.prefix", cut.epoch + ":" + cut.seq, cut);
    this.store.set("authority.attempts", this.attemptKey(attempt), {
      attempt,
      attemptHash: receipt.attemptHash,
      intentHash: receipt.intentHash,
      userId: auth.userId,
      deviceId: auth.deviceId,
      state: status,
      receipt,
    });
    this.store.set("authority.intents", this.intentKey(attempt), {
      intentHash: receipt.intentHash,
      userId: auth.userId,
      writerId: receipt.writerId,
      accepted: accepted ? receipt : (prior?.accepted ?? null),
    });
    this.store.set("meta", "head", cut);
    if (lifecycle && accepted && state) {
      this.store.set("doclifecycles", lifecycleKey, { ...lifecycle, cut });
      const historyScope = {
        ...attempt.intent.scope,
        incarnationId: lifecycle.activeIncarnation,
      };
      const historyState = this.store.get("documents", scopeKey(historyScope));
      if (historyState)
        this.store.set("history", scopeKey(historyScope) + ":" + cut.seq, {
          scope: historyScope,
          cut,
          state: historyState,
        });
    }
    if (accepted)
      for (const row of this.store.all("doclifecycles")) {
        const item = row.value as {
          activeIncarnation: string;
          deleted: boolean;
          cut: Cut;
        };
        if (
          item.cut.epoch === cut.epoch &&
          item.cut.seq === cut.seq &&
          item.cut.hash === ""
        ) {
          this.store.set("doclifecycles", row.key, { ...item, cut });
          const parts = row.key.split(":");
          demand(parts.length === 3, "CORRUPT_LIFECYCLE");
          const historyScope = {
            orgId: parts[0],
            workspaceId: parts[1],
            documentId: parts[2],
            incarnationId: item.activeIncarnation,
          };
          const body = this.store.get("documents", scopeKey(historyScope));
          if (body)
            this.store.set("history", scopeKey(historyScope) + ":" + cut.seq, {
              scope: historyScope,
              cut,
              state: body,
            });
        }
      }
    this.store.set("meta", "state-root", authorityStateHash);
    if (accepted) this.sealUndo(attempt, cut, false);
    return clone(receipt);
  }
  private resource(
    auth: AuthContext,
    scope: Scope,
    action: string,
    payload: Json,
  ): unknown {
    if (
      action !== "document.create" &&
      action !== "document.restore" &&
      action !== "copy.stage.abandon" &&
      action !== "record.create" &&
      action !== "record.restore" &&
      !action.startsWith("workspace.")
    )
      this.lifecycle.assertActive(scope);
    if (action.startsWith("copy.stage.")) {
      demand(payload && typeof payload === "object" && !Array.isArray(payload), "INVALID_RESOURCE");
      const p = payload as Record<string, Json>;
      const staging = new SharedCopyStaging(this.store, (assetScope, hash) => {
        const owner = this.store.get("asset.staging.owners", [assetScope.orgId, assetScope.workspaceId, auth.writerId, hash].join(":")) as {userId: string; deviceId: string; uploadId: string} | null;
        demand(owner && owner.userId === auth.userId && owner.deviceId === auth.deviceId, "COPY_ASSET_OWNER_MISMATCH");
        return this.assets.readStaged(assetScope, owner.uploadId, hash);
      });
      if (action === "copy.stage.prepare") return staging.prepare(auth, scope, p.manifest);
      if (action === "copy.stage.abandon") return staging.abandon(auth, scope, identifier(p.copyId), String(p.manifestHash));
      if (action === "copy.stage.part") return staging.stagePart(auth, scope, identifier(p.copyId), Number(p.index), String(p.raw));
      if (action === "copy.stage.commit") {
        const copyId = identifier(p.copyId);
        const manifest = staging.inspect(auth, scope, copyId);
        const result = staging.commit(auth, scope, copyId, String(p.manifestHash));
        for (const asset of manifest.assets) {
          const owner = this.store.get("asset.staging.owners", [scope.orgId, scope.workspaceId, auth.writerId, asset.hash].join(":")) as {uploadId: string; userId: string; deviceId: string} | null;
          demand(owner && owner.userId === auth.userId && owner.deviceId === auth.deviceId, "COPY_ASSET_OWNER_MISMATCH");
          this.assets.publish(scope, owner.uploadId, asset.hash);
        }
        const cut = { ...this.head(), seq: this.head().seq + 1, hash: "" };
        for (const created of result.scopes) {
          const key = [created.orgId, created.workspaceId, created.documentId].join(":");
          const lifecycle = this.store.get("doclifecycles", key) as Record<string, Json>;
          this.store.set("doclifecycles", key, {...lifecycle, cut});
        }
        return result;
      }
      throw new CollaborationError("INVALID_RESOURCE");
    }
    if (action === "copy.commit")
      return applyCopyPayload(this.store, scope, payload);
    if (action === "document.create") {
      demand(
        payload && typeof payload === "object" && !Array.isArray(payload),
        "INVALID_RESOURCE",
      );
      const p = payload as Record<string, Json>;
      demand(
        Object.keys(p).every((k) => ["document", "title"].includes(k)) &&
          typeof p.title === "string" &&
          p.title.length <= 500,
        "INVALID_RESOURCE",
      );
      const key = scopeKey(scope);
      demand(
        !this.store.get(
          "doclifecycles",
          [scope.orgId, scope.workspaceId, scope.documentId].join(":"),
        ),
        "DOCUMENT_EXISTS",
      );
      demand(
        !this.store.get("documents", key) &&
          !this.store.get(
            "pages",
            scope.orgId + ":" + scope.workspaceId + ":" + scope.documentId,
          ),
        "DOCUMENT_EXISTS",
      );
      const state = seedTables(
        initialState(p.document as unknown as Doc),
        scope.incarnationId,
      );
      this.store.set("documents", key, state);
      this.store.set("page.titles", key, p.title);
      const prefix = scope.orgId + ":" + scope.workspaceId + ":";
      let order = 0;
      for (const row of this.store.all("pages")) {
        if (!row.key.startsWith(prefix)) continue;
        const value = row.value as { order: number };
        demand(
          Number.isSafeInteger(value.order) &&
            value.order >= 0 &&
            value.order < Number.MAX_SAFE_INTEGER,
          "CORRUPT_PAGE_ORDER",
        );
        order = Math.max(order, value.order + 1);
      }
      this.store.set("pages", prefix + scope.documentId, {
        id: scope.documentId,
        parentId: null,
        order,
      });
      this.store.set(
        "doclifecycles",
        [scope.orgId, scope.workspaceId, scope.documentId].join(":"),
        {
          activeIncarnation: scope.incarnationId,
          deleted: false,
          cut: this.head(),
        },
      );
      return { scope };
    }
    if (action === "document.trash") return this.lifecycle.trash(scope);
    if (action === "document.restore") {
      demand(
        payload && typeof payload === "object" && !Array.isArray(payload),
        "INVALID_RESOURCE",
      );
      return this.lifecycle.restore(
        scope,
        identifier((payload as Record<string, Json>).incarnationId),
      );
    }
    if (action === "page.move") {
      const parent = (payload as Record<string, Json>)?.parentId;
      if (typeof parent === "string") {
        identifier(parent);
        const life = this.store.get(
          "doclifecycles",
          scope.orgId + ":" + scope.workspaceId + ":" + parent,
        ) as { activeIncarnation: string } | null;
        if (life)
          this.lifecycle.assertActive({
            ...scope,
            documentId: parent,
            incarnationId: life.activeIncarnation,
          });
        else {
          const database = this.store.get(
            "databases",
            scope.orgId + ":" + scope.workspaceId + ":" + parent,
          ) as { deleted: boolean } | null;
          demand(database && !database.deleted, "PARENT_MISSING");
        }
      }
    }
    if (action === "workspace.grant") {
      const p = payload as Record<string, Json>;
      this.policy.grant(
        auth,
        scope.orgId,
        scope.workspaceId,
        identifier(p.userId),
        p.role as "owner" | "editor" | "viewer" | null,
      );
      return { changed: true };
    }
    if (action === "asset.publish") {
      const p = payload as Record<string, Json>;
      demand(p && Object.keys(p).length === 2, "INVALID_RESOURCE");
      return this.assets.publish(scope, identifier(p.uploadId), String(p.hash));
    }
    if (action === "record.create")
      demand(
        !this.store.get(
          "doclifecycles",
          [scope.orgId, scope.workspaceId, scope.documentId].join(":"),
        ),
        "DOCUMENT_EXISTS",
      );
    if (action === "record.restore") {
      demand(
        payload && typeof payload === "object" && !Array.isArray(payload),
        "INVALID_RESOURCE",
      );
      const p = payload as Record<string, Json>;
      demand(
        Object.keys(p).every((k) =>
          ["databaseId", "revision", "newIncarnationId"].includes(k),
        ),
        "INVALID_RESOURCE",
      );
      const result = applyRecords(this.store, scope, {
        kind: "resource",
        action,
        payload: { databaseId: p.databaseId, revision: p.revision },
      });
      const restored = this.lifecycle.restore(
        scope,
        identifier(p.newIncarnationId),
      );
      return { result, scope: restored };
    }
    const result = applyRecords(this.store, scope, {
      kind: "resource",
      action,
      payload,
    });
    if (action === "record.trash") this.lifecycle.trash(scope);
    if (action === "record.create") {
      const body = this.store.get(
        "documents",
        scopeKey(scope),
      ) as DocumentState | null;
      if (body) {
        this.store.set(
          "documents",
          scopeKey(scope),
          seedTables(body, scope.incarnationId),
        );
        this.store.set(
          "doclifecycles",
          [scope.orgId, scope.workspaceId, scope.documentId].join(":"),
          {
            activeIncarnation: scope.incarnationId,
            deleted: false,
            cut: this.head(),
          },
        );
        const p = payload as Record<string, Json>;
        this.store.set("page.titles", scopeKey(scope), p.title);
      }
    }
    return result;
  }
  records(token: string, scope: Scope): Json {
    return this.store.transaction(() => {
      const auth = this.authenticate(token);
      this.authorize(auth, scope, "read");
      this.lifecycle.assertActive(scope);
      return readRecords(this.store, scope);
    });
  }
  trashList(token: string, scope: Scope) {
    this.authorize(this.authenticate(token), parseScope(scope), "read");
    const prefix = [scope.orgId, scope.workspaceId].join(":") + ":";
    return this.store.all("doclifecycles").filter(row => row.key.startsWith(prefix)).flatMap(row => {
      const lifecycle = row.value as {deleted: boolean; activeIncarnation: string; cut: Cut};
      const parts = row.key.split(":");
      if (!lifecycle.deleted || parts.length !== 3 || this.store.get("records", row.key) || this.store.get("databases", row.key)) return [];
      const deletedScope = {...scope, documentId: identifier(parts[2]), incarnationId: identifier(lifecycle.activeIncarnation)};
      return [{scope: deletedScope, title: this.store.get("page.titles", scopeKey(deletedScope)), cut: lifecycle.cut}];
    });
  }
  documentHistory(token: string, scope: Scope) {
    return this.store.transaction(() => {
      const auth = this.authenticate(token);
      this.authorize(auth, parseScope(scope), "read");
      return this.lifecycle.history(scope);
    });
  }
  stageAsset(token: string, scope: Scope, uploadId: string, bytes: Uint8Array) {
    return this.store.transaction(() => {
      const auth = this.authenticate(token);
      this.authorize(auth, parseScope(scope), "write");
      this.lifecycle.assertActive(scope);
      this.operations.assertWriter(this.protocolVersion());
      const result = this.assets.stage(scope, uploadId, bytes);
      this.store.set("asset.staging.owners", [scope.orgId, scope.workspaceId, auth.writerId, result.hash].join(":"), {userId: auth.userId, deviceId: auth.deviceId, uploadId});
      return result;
    });
  }
  copyStageList(token: string, input: Scope) {
    return this.store.transaction(() => {
      const scope = parseScope(input), auth = this.authenticate(token);
      this.authorize(auth, scope, "write");
      this.lifecycle.assertActive(scope);
      return new SharedCopyStaging(this.store).list(auth, scope);
    });
  }
  copyStageStatus(token: string, scope: Scope, copyId: string) {
    const auth = this.authenticate(token); this.authorize(auth, parseScope(scope), "write");
    return new SharedCopyStaging(this.store).inspect(auth, scope, copyId);
  }
  readAsset(token: string, scope: Scope, hash: string): Uint8Array {
    return this.store.transaction(() => {
      const auth = this.authenticate(token);
      this.authorize(auth, parseScope(scope), "read");
      this.lifecycle.assertActive(scope);
      return this.assets.read(scope, hash);
    });
  }
  rotateRecovery(token: string, orgId: string): string {
    return this.control(token, orgId, "identity.rekey", {}, () =>
      this.identity.rotateRecovery(token, orgId),
    );
  }
  recoveryStatus(token: string, orgId: string) {
    const auth = this.authenticate(token);
    this.assertOrganizationAdministrator(auth, orgId);
    return { configured: this.store.get("identity.recovery", orgId) !== null };
  }
  cancelInvite(token: string, orgId: string, inviteHash: string): void {
    this.control(token, orgId, "identity.cancel", { inviteHash }, () => {
      demand(/^[a-f0-9]{64}$/.test(inviteHash), "INVALID_HASH");
      const invite = this.store.get("identity.invites", inviteHash) as {
        orgId: string;
        status: string;
      } | null;
      demand(
        invite && invite.orgId === orgId && invite.status === "pending",
        "INVITE_INVALID",
      );
      this.store.set("identity.invites", inviteHash, {
        ...invite,
        status: "expired",
      });
    });
  }
  revokeDevice(token: string, orgId: string, deviceId: string): void {
    this.control(token, orgId, "identity.revoke", { deviceId }, () =>
      this.identity.revokeDevice(token, deviceId),
    );
  }
  recover(orgId: string, recoveryKey: string, deviceId: string) {
    return this.store.transaction(() => {
      this.operations.assertWriter(this.protocolVersion());
      const result = this.identity.recover(orgId, recoveryKey, deviceId);
      const base = this.head();
      const scope = {
        orgId,
        workspaceId: "__organization",
        documentId: "__control",
        incarnationId: base.epoch,
      };
      const attempt: Attempt = {
        v: 1,
        attemptId: randomUUID(),
        base,
        intent: {
          v: 1,
          intentId: randomUUID(),
          writerId: result.auth.writerId,
          scope,
          base,
          command: {
            kind: "resource",
            action: "identity.recover",
            payload: { deviceId },
          },
        },
      };
      this.commit(attempt, result.auth, "SERVER_ACCEPTED", null, null, null, {
        recovered: true,
      });
      return result;
    });
  }
  verifyBackupArtifact(token: string, orgId: string, backup: import("./backup").RuntimeBackup, destination: import("./storage-port").StoragePort, epoch: string) {
    demand(destination !== this.store && destination.db !== this.store.db, "DESTINATION_NOT_ISOLATED");
    return this.retention(token, orgId).verifyBackup(parseCut(backup.head), destination, epoch, backup);
  }
  retention(token: string, orgId: string) {
    const authorize = () =>
      this.assertOrganizationAdministrator(this.authenticate(token), orgId);
    authorize();
    const core = this.retentionCore;
    return {
      inspect: () => {
        authorize();
        return core.inspect();
      },
      verifyBackup: (...args: Parameters<RetentionService["verifyBackup"]>) => {
        authorize();
        this.operations.assertWriter(this.protocolVersion());
        const proof = core.verifyBackup(...args);
        this.store.transaction(() => {
          this.store.set("backup.verifications", proof.backupHash, {
            backupHash: proof.backupHash,
            epoch: proof.cut.epoch,
            cut: proof.cut,
          });
          this.operations.recordBackup(this.authenticate(token), orgId, {
            hash: proof.backupHash,
            cut: proof.cut,
            verified: true,
          });
        });
        return proof;
      },
      compact: (...args: Parameters<RetentionService["compact"]>) => {
        authorize();
        this.operations.assertWriter(this.protocolVersion());
        return core.compact(...args);
      },
    };
  }
  projection(token: string): SharedProjection {
    const auth = this.authenticate(token);
    return new SharedProjection(
      this.store,
      (scope) => {
        this.authenticate(token);
        this.authorize(auth, scope, "read");
      },
      (scope) => {
        try {
          this.lifecycle.assertActive(scope);
          return true;
        } catch (error) {
          if (
            error instanceof CollaborationError &&
            ["DOCUMENT_DELETED", "SCOPE_NOT_ACTIVE"].includes(error.code)
          )
            return false;
          throw error;
        }
      },
    );
  }
  backup(token: string, orgId: string) {
    return this.store.transaction(() => {
      const auth = this.authenticate(token);
      this.assertOrganizationAdministrator(auth, orgId);
      for (const row of this.store.all("workspaces")) {
        const workspace = row.value as { orgId: string; workspaceId: string };
        if (workspace.orgId === orgId)
          this.authorize(
            auth,
            {
              orgId,
              workspaceId: workspace.workspaceId,
              documentId: "__backup",
              incarnationId: this.head().epoch,
            },
            "read",
          );
      }
      return exportBackup(this.store);
    });
  }
  restoreInto(
    token: string,
    orgId: string,
    backup: unknown,
    destination: RuntimeStore,
    newEpoch: string,
  ) {
    const auth = this.authenticate(token);
    this.assertOrganizationAdministrator(auth, orgId);
    return destination.transaction(() => {
      const holder: {
        value: { recoveryKey: string; bootstrapOwner: string } | null;
      } = { value: null };
      const restored = restoreBackup(backup, destination, newEpoch, (store) => {
        holder.value = authorizeRestoredOperator(store, orgId, auth.userId);
      });
      const authorization = holder.value;
      if (authorization === null)
        throw new CollaborationError("AUTHORIZATION_MISSING");
      return {
        ...restored,
        ...authorization,
        requiresReauthorization: true as const,
      };
    });
  }
  close(): void {
    this.store.close();
  }
}
