import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  CollaborationError,
  demand,
  identifier,
  safeCounter,
  wellFormed,
  type AuthContext,
} from "./contract";
import { digest } from "./digest";
import type { StoragePort } from "./storage-port";

const ORGANIZATION = "organization";
const USERS = "identity.users";
const DEVICES = "identity.devices";
const SESSIONS = "identity.sessions";
const INVITES = "identity.invites";
const RECOVERY = "identity.recovery";
const RECOVERY_STATUS = "identity.recovery-status";
const MEMBERSHIP_GENERATIONS = "identity.membership-generations";

const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type Role = "owner" | "member";
type Lifecycle = "active" | "revoked";
type InviteStatus = "pending" | "accepted" | "expired";

type OrganizationRecord = {
  orgId: string;
  ownerIds: string[];
  memberIds: string[];
  version: number;
};
type UserRecord = {
  orgId: string;
  userId: string;
  role: Role;
  status: Lifecycle;
};
type DeviceRecord = {
  orgId: string;
  userId: string;
  deviceId: string;
  writerId: string;
  sessionId: string;
  status: Lifecycle;
  generation: number;
};
type SessionRecord = {
  orgId: string;
  userId: string;
  deviceId: string;
  writerId: string;
  sessionId: string;
  tokenHash: string;
  status: Lifecycle;
  generation: number;
};
type InviteRecord = {
  inviteId: string;
  orgId: string;
  userId: string;
  tokenHash: string;
  status: InviteStatus;
  createdAt: number;
  expiresAt: number;
  membershipGeneration: number;
};
type RecoveryRecord = { orgId: string; recoveryHash: string };
type RecoveryStatus = { required: boolean };

type Secret = { value: string; hash: string };
type Resolved = {
  auth: AuthContext;
  org: OrganizationRecord;
  user: UserRecord;
  device: DeviceRecord;
  session: SessionRecord;
};

function object(value: unknown): Record<string, unknown> {
  demand(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "STORAGE_CORRUPT",
  );
  return value as Record<string, unknown>;
}

function identifiers(value: unknown): string[] {
  demand(Array.isArray(value), "STORAGE_CORRUPT");
  return value.map(identifier);
}

function hashHex(value: unknown): string {
  demand(
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
    "STORAGE_CORRUPT",
  );
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  demand(
    typeof value === "string" && (allowed as readonly string[]).includes(value),
    "STORAGE_CORRUPT",
  );
  return value as T;
}

function readOrganization(value: unknown): OrganizationRecord {
  const record = object(value);
  return {
    orgId: identifier(record.orgId),
    ownerIds: identifiers(record.ownerIds),
    memberIds: identifiers(record.memberIds),
    version: safeCounter(record.version),
  };
}

function readUser(value: unknown): UserRecord {
  const record = object(value);
  return {
    orgId: identifier(record.orgId),
    userId: identifier(record.userId),
    role: oneOf(record.role, ["owner", "member"] as const),
    status: oneOf(record.status, ["active", "revoked"] as const),
  };
}

function readDevice(value: unknown): DeviceRecord {
  const record = object(value);
  return {
    orgId: identifier(record.orgId),
    userId: identifier(record.userId),
    deviceId: identifier(record.deviceId),
    writerId: identifier(record.writerId),
    sessionId: identifier(record.sessionId),
    status: oneOf(record.status, ["active", "revoked"] as const),
    generation: safeCounter(record.generation),
  };
}

function readSession(value: unknown): SessionRecord {
  const record = object(value);
  return {
    orgId: identifier(record.orgId),
    userId: identifier(record.userId),
    deviceId: identifier(record.deviceId),
    writerId: identifier(record.writerId),
    sessionId: identifier(record.sessionId),
    tokenHash: hashHex(record.tokenHash),
    status: oneOf(record.status, ["active", "revoked"] as const),
    generation: safeCounter(record.generation),
  };
}

function readInvite(value: unknown): InviteRecord {
  const record = object(value);
  return {
    inviteId: identifier(record.inviteId),
    orgId: identifier(record.orgId),
    userId: identifier(record.userId),
    tokenHash: hashHex(record.tokenHash),
    status: oneOf(record.status, ["pending", "accepted", "expired"] as const),
    createdAt: safeCounter(record.createdAt),
    expiresAt: safeCounter(record.expiresAt),
    membershipGeneration:
      record.membershipGeneration === undefined
        ? 0
        : safeCounter(record.membershipGeneration),
  };
}

function readRecovery(value: unknown): RecoveryRecord {
  const record = object(value);
  return {
    orgId: identifier(record.orgId),
    recoveryHash: hashHex(record.recoveryHash),
  };
}

function tokenValue(value: unknown): string {
  demand(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      wellFormed(value),
    "TOKEN_INVALID",
  );
  return value;
}

function safeEqualHash(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function randomId(): string {
  return randomBytes(32).toString("base64url");
}

function freshId(excluded: readonly string[]): string {
  let value = randomId();
  while (excluded.includes(value)) value = randomId();
  return value;
}

function secret(): Secret {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: digest(value) };
}

function userKey(orgId: string, userId: string): string {
  return orgId + "/" + userId;
}

function deviceKey(orgId: string, deviceId: string): string {
  return orgId + "/" + deviceId;
}

function membershipKey(orgId: string, userId: string): string {
  return orgId + ":" + userId;
}

function authContext(
  userId: string,
  deviceId: string,
  writerId: string,
  sessionId: string,
): AuthContext {
  return Object.freeze({ userId, deviceId, writerId, sessionId });
}

export class IdentityAuthority {
  constructor(
    private readonly store: StoragePort,
    private readonly now: () => number = Date.now,
  ) {}

  bootstrap(
    orgIdInput: string,
    userIdInput: string,
    deviceIdInput: string,
  ): { token: string; recoveryKey: string; auth: AuthContext } {
    const orgId = identifier(orgIdInput);
    const userId = identifier(userIdInput);
    const deviceId = identifier(deviceIdInput);

    return this.run(() => {
      if (this.store.get(ORGANIZATION, orgId) !== null)
        throw new CollaborationError("ORG_EXISTS");

      const token = secret();
      const recoveryKey = secret();
      const writerId = freshId([deviceId]);
      const sessionId = freshId([deviceId, writerId]);
      const organization: OrganizationRecord = {
        orgId,
        ownerIds: [userId],
        memberIds: [userId],
        version: 1,
      };
      const user: UserRecord = {
        orgId,
        userId,
        role: "owner",
        status: "active",
      };
      const device: DeviceRecord = {
        orgId,
        userId,
        deviceId,
        writerId,
        sessionId,
        status: "active",
        generation: 1,
      };
      const session: SessionRecord = {
        orgId,
        userId,
        deviceId,
        writerId,
        sessionId,
        tokenHash: token.hash,
        status: "active",
        generation: 1,
      };
      const recovery: RecoveryRecord = {
        orgId,
        recoveryHash: recoveryKey.hash,
      };

      this.store.set(ORGANIZATION, orgId, organization);
      this.store.set(USERS, userKey(orgId, userId), user);
      this.store.set(DEVICES, deviceKey(orgId, deviceId), device);
      this.store.set(SESSIONS, token.hash, session);
      this.store.set(RECOVERY, orgId, recovery);

      return {
        token: token.value,
        recoveryKey: recoveryKey.value,
        auth: authContext(userId, deviceId, writerId, sessionId),
      };
    });
  }

  invite(
    tokenInput: string,
    orgIdInput: string,
    userIdInput: string,
    ttlMsInput: number,
  ): string {
    const token = tokenValue(tokenInput);
    const orgId = identifier(orgIdInput);
    const userId = identifier(userIdInput);
    const ttlMs = this.ttl(ttlMsInput);

    return this.run(() => {
      const resolved = this.resolve(token);
      if (resolved.org.orgId !== orgId)
        throw new CollaborationError("ORG_MISMATCH");
      if (!resolved.org.ownerIds.includes(resolved.auth.userId))
        throw new CollaborationError("NOT_OWNER");
      if (resolved.user.status !== "active")
        throw new CollaborationError("TOKEN_INVALID");

      const existingRecipient = this.store.get(USERS, userKey(orgId, userId));
      if (existingRecipient !== null) {
        const recipient = readUser(existingRecipient);
        if (recipient.orgId !== orgId)
          throw new CollaborationError("STORAGE_CORRUPT");
      }

      const createdAt = this.clock();
      const expiresAt = createdAt + ttlMs;
      demand(Number.isSafeInteger(expiresAt), "TTL_INVALID");
      const inviteToken = secret();
      const invite: InviteRecord = {
        inviteId: freshId([]),
        orgId,
        userId,
        tokenHash: inviteToken.hash,
        status: "pending",
        createdAt,
        expiresAt,
        membershipGeneration: this.currentMembershipGeneration(orgId, userId),
      };
      this.store.set(INVITES, inviteToken.hash, invite);
      return inviteToken.value;
    });
  }

  acceptInvite(
    inviteTokenInput: string,
    deviceIdInput: string,
  ): { token: string; auth: AuthContext } {
    const inviteToken = tokenValue(inviteTokenInput);
    const deviceId = identifier(deviceIdInput);
    const inviteHash = digest(inviteToken);

    return this.run(() => {
      const stored = this.store.get(INVITES, inviteHash);
      if (stored === null) throw new CollaborationError("INVITE_INVALID");
      const invite = readInvite(stored);
      if (!safeEqualHash(invite.tokenHash, inviteHash))
        throw new CollaborationError("INVITE_INVALID");
      if (invite.status === "accepted")
        throw new CollaborationError("INVITE_USED");
      if (invite.status === "expired")
        throw new CollaborationError("INVITE_EXPIRED");
      if (this.clock() >= invite.expiresAt)
        throw new CollaborationError("INVITE_EXPIRED");

      const organizationStored = this.store.get(ORGANIZATION, invite.orgId);
      if (organizationStored === null)
        throw new CollaborationError("ORG_MISSING");
      const organization = readOrganization(organizationStored);
      if (
        invite.membershipGeneration !==
        this.currentMembershipGeneration(invite.orgId, invite.userId)
      )
        throw new CollaborationError("INVITE_STALE");

      const targetKey = userKey(invite.orgId, invite.userId);
      const existingUser = this.store.get(USERS, targetKey);
      const role: Role = organization.ownerIds.includes(invite.userId)
        ? "owner"
        : "member";
      let user: UserRecord;
      if (existingUser === null) {
        user = {
          orgId: invite.orgId,
          userId: invite.userId,
          role,
          status: "active",
        };
      } else {
        const existing = readUser(existingUser);
        if (existing.orgId !== invite.orgId)
          throw new CollaborationError("STORAGE_CORRUPT");
        user = { ...existing, role, status: "active" };
      }

      const targetDeviceKey = deviceKey(invite.orgId, deviceId);
      if (this.store.get(DEVICES, targetDeviceKey) !== null)
        throw new CollaborationError("DEVICE_EXISTS");

      const memberIds = organization.memberIds.includes(invite.userId)
        ? organization.memberIds
        : [...organization.memberIds, invite.userId];
      const changed = memberIds.length !== organization.memberIds.length;
      const nextOrganization: OrganizationRecord = {
        ...organization,
        memberIds,
        version: changed ? organization.version + 1 : organization.version,
      };

      const token = secret();
      const writerId = freshId([deviceId]);
      const sessionId = freshId([deviceId, writerId]);
      const device: DeviceRecord = {
        orgId: invite.orgId,
        userId: invite.userId,
        deviceId,
        writerId,
        sessionId,
        status: "active",
        generation: 1,
      };
      const session: SessionRecord = {
        orgId: invite.orgId,
        userId: invite.userId,
        deviceId,
        writerId,
        sessionId,
        tokenHash: token.hash,
        status: "active",
        generation: 1,
      };
      const accepted: InviteRecord = { ...invite, status: "accepted" };

      this.store.set(ORGANIZATION, organization.orgId, nextOrganization);
      this.store.set(USERS, targetKey, user);
      this.store.set(DEVICES, targetDeviceKey, device);
      this.store.set(SESSIONS, token.hash, session);
      this.store.set(INVITES, inviteHash, accepted);

      return {
        token: token.value,
        auth: authContext(invite.userId, deviceId, writerId, sessionId),
      };
    });
  }

  authenticate(tokenInput: string): AuthContext {
    const token = tokenValue(tokenInput);
    return this.run(() => this.resolve(token).auth);
  }

  revokeDevice(tokenInput: string, deviceIdInput: string): void {
    const token = tokenValue(tokenInput);
    const deviceId = identifier(deviceIdInput);

    this.run(() => {
      const resolved = this.resolve(token);
      const organization = resolved.org;
      const targetKey = deviceKey(organization.orgId, deviceId);
      const targetStored = this.store.get(DEVICES, targetKey);
      if (targetStored === null) throw new CollaborationError("DEVICE_MISSING");
      const target = readDevice(targetStored);
      if (target.orgId !== organization.orgId || target.deviceId !== deviceId)
        throw new CollaborationError("DEVICE_MISSING");

      const callerIsOwner = organization.ownerIds.includes(
        resolved.auth.userId,
      );
      if (!callerIsOwner && target.userId !== resolved.auth.userId)
        throw new CollaborationError("NOT_OWNER");
      if (target.status !== "active") return;

      const targetIsOwner = organization.ownerIds.includes(target.userId);
      if (targetIsOwner) {
        const activeOwnerDevices = this.allDevices().filter(
          (device) =>
            device.orgId === organization.orgId &&
            device.status === "active" &&
            organization.ownerIds.includes(device.userId),
        ).length;
        if (activeOwnerDevices <= 1)
          throw new CollaborationError("LAST_OWNER_DEVICE");
      }

      const revokedDevice: DeviceRecord = {
        ...target,
        status: "revoked",
        generation: target.generation + 1,
      };
      this.store.set(DEVICES, targetKey, revokedDevice);

      for (const entry of this.store.all(SESSIONS)) {
        const session = readSession(entry.value);
        if (
          session.orgId !== organization.orgId ||
          session.deviceId !== deviceId ||
          session.status !== "active"
        )
          continue;
        this.store.set(SESSIONS, entry.key, {
          ...session,
          status: "revoked",
          generation: session.generation + 1,
        } satisfies SessionRecord);
      }
    });
  }

  fenceRemovedMember(orgIdInput: string, userIdInput: string): void {
    const orgId = identifier(orgIdInput);
    const userId = identifier(userIdInput);

    this.run(() => {
      const organization = this.organization(orgId);
      if (
        organization.ownerIds.includes(userId) ||
        organization.memberIds.includes(userId)
      )
        throw new CollaborationError("MEMBER_PRESENT");

      const storedUser = this.store.get(USERS, userKey(orgId, userId));
      let user: UserRecord | null = null;
      if (storedUser !== null) {
        user = readUser(storedUser);
        if (user.orgId !== orgId)
          throw new CollaborationError("STORAGE_CORRUPT");
      }

      const devices = this.store
        .all(DEVICES)
        .map((entry) => ({ key: entry.key, device: readDevice(entry.value) }))
        .filter(
          (entry) =>
            entry.device.orgId === orgId && entry.device.userId === userId,
        );
      const sessions = this.store
        .all(SESSIONS)
        .map((entry) => ({ key: entry.key, session: readSession(entry.value) }))
        .filter(
          (entry) =>
            entry.session.orgId === orgId && entry.session.userId === userId,
        );
      const invites = this.store
        .all(INVITES)
        .map((entry) => ({ key: entry.key, invite: readInvite(entry.value) }))
        .filter(
          (entry) =>
            entry.invite.orgId === orgId &&
            entry.invite.userId === userId &&
            entry.invite.status === "pending",
        );

      const generation = this.currentMembershipGeneration(orgId, userId);
      demand(Number.isSafeInteger(generation + 1), "INVALID_COUNTER");
      for (const entry of devices)
        demand(
          Number.isSafeInteger(entry.device.generation + 1),
          "INVALID_COUNTER",
        );
      for (const entry of sessions)
        demand(
          Number.isSafeInteger(entry.session.generation + 1),
          "INVALID_COUNTER",
        );

      if (user !== null)
        this.store.set(USERS, userKey(orgId, userId), {
          ...user,
          status: "revoked",
        } satisfies UserRecord);
      for (const entry of devices)
        this.store.set(DEVICES, entry.key, {
          ...entry.device,
          status: "revoked",
          generation: entry.device.generation + 1,
        } satisfies DeviceRecord);
      for (const entry of sessions)
        this.store.set(SESSIONS, entry.key, {
          ...entry.session,
          status: "revoked",
          generation: entry.session.generation + 1,
        } satisfies SessionRecord);
      for (const entry of invites)
        this.store.set(INVITES, entry.key, {
          ...entry.invite,
          status: "expired",
        } satisfies InviteRecord);
      this.store.set(
        MEMBERSHIP_GENERATIONS,
        membershipKey(orgId, userId),
        generation + 1,
      );
    });
  }

  synchronizeOrganization(
    orgIdInput: string,
    invalidateRecovery = false,
  ): void {
    const orgId = identifier(orgIdInput);

    this.run(() => {
      const organization = this.organization(orgId);
      const users = this.store
        .all(USERS)
        .map((entry) => ({ key: entry.key, user: readUser(entry.value) }))
        .filter((entry) => entry.user.orgId === orgId);
      const pendingInvites = invalidateRecovery
        ? this.store
            .all(INVITES)
            .map((entry) => ({
              key: entry.key,
              invite: readInvite(entry.value),
            }))
            .filter(
              (entry) =>
                entry.invite.orgId === orgId &&
                entry.invite.status === "pending",
            )
        : [];

      for (const entry of users) {
        const role: Role = organization.ownerIds.includes(entry.user.userId)
          ? "owner"
          : "member";
        if (entry.user.role !== role)
          this.store.set(USERS, entry.key, {
            ...entry.user,
            role,
          } satisfies UserRecord);
      }

      if (!invalidateRecovery) return;
      this.store.set(RECOVERY, orgId, null);
      this.store.set(RECOVERY_STATUS, orgId, {
        required: true,
      } satisfies RecoveryStatus);
      for (const entry of pendingInvites)
        this.store.set(INVITES, entry.key, {
          ...entry.invite,
          status: "expired",
        } satisfies InviteRecord);
    });
  }

  rotateRecovery(tokenInput: string, orgIdInput: string): string {
    const token = tokenValue(tokenInput);
    const orgId = identifier(orgIdInput);

    return this.run(() => {
      const resolved = this.resolve(token);
      if (resolved.org.orgId !== orgId)
        throw new CollaborationError("ORG_MISMATCH");
      if (!resolved.org.ownerIds.includes(resolved.auth.userId))
        throw new CollaborationError("NOT_OWNER");

      const rotated = secret();
      this.store.set(RECOVERY, orgId, {
        orgId,
        recoveryHash: rotated.hash,
      } satisfies RecoveryRecord);
      this.store.set(RECOVERY_STATUS, orgId, {
        required: false,
      } satisfies RecoveryStatus);
      return rotated.value;
    });
  }

  recover(
    orgIdInput: string,
    recoveryKeyInput: string,
    newDeviceIdInput: string,
  ): { token: string; recoveryKey: string; auth: AuthContext } {
    const orgId = identifier(orgIdInput);
    const recoveryKey = tokenValue(recoveryKeyInput);
    const newDeviceId = identifier(newDeviceIdInput);
    const suppliedHash = digest(recoveryKey);

    return this.run(() => {
      const organizationStored = this.store.get(ORGANIZATION, orgId);
      if (organizationStored === null)
        throw new CollaborationError("ORG_MISSING");
      const organization = readOrganization(organizationStored);
      const recoveryStored = this.store.get(RECOVERY, orgId);
      if (recoveryStored === null)
        throw new CollaborationError("RECOVERY_INVALID");
      const recovery = readRecovery(recoveryStored);
      if (
        recovery.orgId !== orgId ||
        !safeEqualHash(recovery.recoveryHash, suppliedHash)
      )
        throw new CollaborationError("RECOVERY_INVALID");

      let ownerId: string | undefined;
      for (const candidate of organization.ownerIds) {
        const stored = this.store.get(USERS, userKey(orgId, candidate));
        if (stored === null) continue;
        const owner = readUser(stored);
        if (owner.orgId === orgId && owner.status === "active") {
          ownerId = candidate;
          break;
        }
      }
      if (ownerId === undefined)
        throw new CollaborationError("RECOVERY_NO_OWNER");

      const newDeviceKey = deviceKey(orgId, newDeviceId);
      if (this.store.get(DEVICES, newDeviceKey) !== null)
        throw new CollaborationError("DEVICE_EXISTS");

      for (const entry of this.store.all(DEVICES)) {
        const device = readDevice(entry.value);
        if (device.orgId !== orgId || device.status !== "active") continue;
        this.store.set(DEVICES, entry.key, {
          ...device,
          status: "revoked",
          generation: device.generation + 1,
        } satisfies DeviceRecord);
      }
      for (const entry of this.store.all(SESSIONS)) {
        const session = readSession(entry.value);
        if (session.orgId !== orgId || session.status !== "active") continue;
        this.store.set(SESSIONS, entry.key, {
          ...session,
          status: "revoked",
          generation: session.generation + 1,
        } satisfies SessionRecord);
      }

      const token = secret();
      const rotated = secret();
      const writerId = freshId([newDeviceId]);
      const sessionId = freshId([newDeviceId, writerId]);
      const device: DeviceRecord = {
        orgId,
        userId: ownerId,
        deviceId: newDeviceId,
        writerId,
        sessionId,
        status: "active",
        generation: 1,
      };
      const session: SessionRecord = {
        orgId,
        userId: ownerId,
        deviceId: newDeviceId,
        writerId,
        sessionId,
        tokenHash: token.hash,
        status: "active",
        generation: 1,
      };
      const nextRecovery: RecoveryRecord = {
        orgId,
        recoveryHash: rotated.hash,
      };

      this.store.set(DEVICES, newDeviceKey, device);
      this.store.set(SESSIONS, token.hash, session);
      this.store.set(RECOVERY, orgId, nextRecovery);

      return {
        token: token.value,
        recoveryKey: rotated.value,
        auth: authContext(ownerId, newDeviceId, writerId, sessionId),
      };
    });
  }

  private run<T>(work: () => T): T {
    if (this.store.db.isTransaction) return work();
    return this.store.transaction(work);
  }

  private organization(orgId: string): OrganizationRecord {
    const stored = this.store.get(ORGANIZATION, orgId);
    if (stored === null) throw new CollaborationError("ORG_MISSING");
    return readOrganization(stored);
  }

  private currentMembershipGeneration(orgId: string, userId: string): number {
    const stored = this.store.get(
      MEMBERSHIP_GENERATIONS,
      membershipKey(orgId, userId),
    );
    return stored === null ? 0 : safeCounter(stored);
  }

  private clock(): number {
    const value = this.now();
    demand(Number.isSafeInteger(value) && value >= 0, "CLOCK_INVALID");
    return value;
  }

  private ttl(value: unknown): number {
    demand(
      Number.isSafeInteger(value) &&
        Number(value) >= MIN_TTL_MS &&
        Number(value) <= MAX_TTL_MS,
      "TTL_INVALID",
    );
    return Number(value);
  }

  private allDevices(): DeviceRecord[] {
    return this.store.all(DEVICES).map((entry) => readDevice(entry.value));
  }

  private resolve(token: string): Resolved {
    const tokenHash = digest(token);
    const storedSession = this.store.get(SESSIONS, tokenHash);
    if (storedSession === null) throw new CollaborationError("TOKEN_INVALID");
    const session = readSession(storedSession);
    if (!safeEqualHash(session.tokenHash, tokenHash))
      throw new CollaborationError("TOKEN_INVALID");
    if (session.status !== "active")
      throw new CollaborationError("TOKEN_INVALID");

    const organizationStored = this.store.get(ORGANIZATION, session.orgId);
    if (organizationStored === null)
      throw new CollaborationError("TOKEN_INVALID");
    const organization = readOrganization(organizationStored);

    const storedUser = this.store.get(
      USERS,
      userKey(session.orgId, session.userId),
    );
    if (storedUser === null) throw new CollaborationError("TOKEN_INVALID");
    const user = readUser(storedUser);
    if (user.orgId !== session.orgId || user.status !== "active")
      throw new CollaborationError("TOKEN_INVALID");
    if (!organization.memberIds.includes(session.userId))
      throw new CollaborationError("TOKEN_INVALID");

    const storedDevice = this.store.get(
      DEVICES,
      deviceKey(session.orgId, session.deviceId),
    );
    if (storedDevice === null) throw new CollaborationError("TOKEN_INVALID");
    const device = readDevice(storedDevice);
    if (
      device.orgId !== session.orgId ||
      device.userId !== session.userId ||
      device.status !== "active" ||
      device.sessionId !== session.sessionId ||
      device.generation !== session.generation
    )
      throw new CollaborationError("TOKEN_INVALID");

    return {
      auth: authContext(
        session.userId,
        session.deviceId,
        session.writerId,
        session.sessionId,
      ),
      org: organization,
      user,
      device,
      session,
    };
  }
}
