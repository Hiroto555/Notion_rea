# F14 identity handoff report

## Owned files
- `src/collaboration/runtime/identity.ts`
- `tests/shared-runtime-identity-handoff.test.ts`
- `REPORT.md`

## Implemented API
- `IdentityAuthority.acceptInvite` now treats `organization.ownerIds` as the sole organization-role authority. It never derives owners from cached `user.role`, overwrites existing/new `user.role` from current `ownerIds`, and only joins organization membership through a valid pending invite.
- `IdentityAuthority.recover` selects the first active `org.ownerIds` member whose user record is active, ignoring cached `user.role`.
- `IdentityAuthority.resolve` requires the session user to remain in current `organization.memberIds`; otherwise `TOKEN_INVALID`.
- `IdentityAuthority.fenceRemovedMember(orgId,userId): void`
  - Requires the org to already exclude the user (`MEMBER_PRESENT` otherwise).
  - Marks the user revoked, revokes every matching device/session with `generation + 1`, expires matching pending invites, and increments `identity.membership-generations` key `orgId:userId`.
- `IdentityAuthority.synchronizeOrganization(orgId,invalidateRecovery=false): void`
  - Syncs every matching user's role from current `ownerIds`.
  - With `invalidateRecovery=true`, deletes `identity.recovery`, sets `identity.recovery-status` to `{required:true}`, and expires all pending invites in the org.
- `IdentityAuthority.rotateRecovery(token,orgId): string`
  - Requires the caller to be a current active org owner. Stores a fresh 32-byte secret hash, sets `identity.recovery-status` to `{required:false}`, and returns only the new plaintext recovery key.
- Invites now store `membershipGeneration` (legacy records default to `0`). Acceptance requires equality with the current counter (`INVITE_STALE` otherwise), so a fresh owner invite can reactivate a revoked user while old pending invites cannot.

## Integration points for parent
- `Root.revokeMember`: call `OrganizationService.revoke` then `identity.fenceRemovedMember(orgId,userId)` in the same control transaction.
- `Root.handoff`: call `OrganizationService.handoff` then `identity.synchronizeOrganization(orgId,true)` in the same control transaction.
- `Root.rotateRecovery`: expose a control path that calls `identity.rotateRecovery(token,orgId)` and returns the plaintext key only to that caller.
- `WorkspacePolicy.transferOrganization` retains its existing owner/member changes; identity synchronization supplies the role/recovery/invite continuity fixes.

## Verification status
- Tests were written but not executed in this worker (`NOT_RUN`); parent runs checks/tests/build.
- No GUI/browser/Electron/clipboard/native/network/shell actions were performed.

## Known limitations
- `fenceRemovedMember` treats a missing user record as already removed; it still revokes matching devices/sessions/invites and bumps the generation.
- `synchronizeOrganization` updates existing user records only; it does not create missing user records for owner IDs.
- Legacy invites without `membershipGeneration` are generation `0`; they become stale if the membership generation has already advanced.
- Error codes added: `MEMBER_PRESENT`, `INVITE_STALE`.
