import type {
  Attempt,
  AuthContext,
  Cut,
  Receipt,
  Role,
  RuntimeEvent,
  Scope,
  Snapshot,
} from "./contract";
export type WorkspaceListing = {
  workspaceId: string;
  name: string;
  role: Role | null;
  documents: { documentId: string; incarnationId: string; title: string }[];
};
export interface SharedProvider {
  protocol?(scope: Scope): Promise<1003 | 1004>;
  state?(scope: Scope): Promise<Snapshot>;
  acceptedEvent?(scope: Scope, attemptId: string): Promise<RuntimeEvent>;
  snapshot(scope: Scope, after?: number): Promise<Snapshot>;
  submit(attempt: Attempt): Promise<Receipt>;
  receipt(attempt: Attempt): Promise<Receipt | null>;
  invalidate(attempt: Attempt): Promise<Receipt>;
  proof(scope: Scope, seq: number): Promise<Cut | null>;
  workspaces(orgId: string): Promise<WorkspaceListing[]>;
  close(): void;
}
export interface SharedAuthorityEndpoint {
  stageAsset?(
    token: string,
    scope: Scope,
    uploadId: string,
    bytes: Uint8Array,
  ): { hash: string; bytes: number };
  readAsset?(token: string, scope: Scope, hash: string): Uint8Array;
  backup?(token: string, orgId: string): import("./backup").RuntimeBackup;
  admin?(token: string, input: unknown): unknown;
  join?(
    inviteToken: string,
    orgId: string,
    deviceId: string,
  ): { token: string; auth: AuthContext };
  session?(token: string, orgId: string): AuthContext;
  state?(token: string, scope: Scope): Snapshot;
  acceptedEvent?(token: string, scope: Scope, attemptId: string): RuntimeEvent;
  snapshot(token: string, scope: Scope, after?: number): Snapshot;
  submit(token: string, attempt: Attempt): Receipt;
  receipt(token: string, attempt: Attempt): Receipt | null;
  invalidate(token: string, attempt: Attempt): Receipt;
  proof(token: string, scope: Scope, seq: number): Cut | null;
  workspaces(token: string, orgId: string): WorkspaceListing[];
}
