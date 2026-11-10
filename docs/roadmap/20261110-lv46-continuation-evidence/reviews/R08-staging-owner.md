# R08 — fenced-writer staging owner cleanup

Independent READONLY source review. No product edits, tests, build, GUI or network. Parent/implementation worker owns execution results.

**Result: no confirmed unresolved P1/P2 finding in this narrow slice.**

- `SharedAuthority.stagingPreview` authenticates the current session, requires current organization membership + ownerIds membership, and requires workspace manage. A workspace owner who is only an ordinary organization member cannot use the owner route.
- `stagingAbandon` enters the existing authenticated organization control transaction, reauthorizes workspace manage, and checks the exact current HEAD epoch/seq/hash before mutation. Success produces a new metadata-only control event; failure rolls back without advancing the cut.
- The target scope/copy/writer are looked up from the immutable stored manifest, whose key is reconstructed from its original scope/writer and whose complete actor/scope/hash are subsequently validated by SharedCopyStaging. Request data does not impersonate or rewrite the original actor.
- `fencedActor` requires a known matching original user/device/writer in BOTH device and session namespaces. For every row sharing that writerId it requires same organization and revoked status; missing identities or any active matching-writer device/session fail closed. Consequently the currently active writer cannot be reclaimed.
- The actual deletion remains `SharedCopyStaging.abandon`: exact manifest hash, same stored actor/scope, committed pointer refused, only that manifest's part prefix removed, manifest and abandoned tombstone retained. The original source events/intents/receipts are not edited. A final copy that already committed cannot be deleted by this route; a delayed old writer remains revoked and the abandoned marker prevents reuse.
- No lifecycle assertion is used for the scope anchor. This intentionally permits cleanup after that document is trashed while authorization still binds the organization/workspace and the selected original manifest scope. There is no cross-workspace cleanup through another anchor.
- Admin schemas are strict and include exact-cut/hash fields. The two maintenance CLI routes call the same authority methods; preview returns metadata only and abandon requires the explicit writer/copy/hash/cut proposal.
- The six source tests cover actual HTTP/SQLite recovery cleanup, active writer refusal, stale cut, organization-member denial despite workspace ownership, inactive anchor/repeat behavior, committed/mismatched manifest refusal, immutable old raw/receipts and actual maintenance-operator routing. These were READ, not run by this reviewer; do not convert source inspection into test PASS.

Limits: this frees redundant uncommitted staging part rows/reservations. It deliberately retains old raw audit/attempt history and does not claim to reclaim binary uploads or all historical storage. Native Windows/GUI/physical acceptance remains NOT_RUN.

Reviewed at 2026-11-10T14:24:57.705195+00:00 UTC.

Reviewed source SHA256:

```json
{
  "src/collaboration/runtime/staging-maintenance.ts": "9b64e8ea981a176acd5ae700a34465069167522512e2caa1bfe4fd20bb883ebd",
  "src/collaboration/runtime/authority.ts": "04c19fe7f359e6141b2e56c7ec38a65ca02d758c9a3dc5b5ecd29dddea7a7dc8",
  "src/collaboration/runtime/admin.ts": "540022fa3afd98bd93bcf4c59d6ee57848a9423d3516d9101e0519708935e65c",
  "src/collaboration/runtime/maintenance-operator.ts": "7f464f5c444f2eea055069cd9ebd6695730309d044c8125eeb61b0e5c52aa4ee",
  "src/collaboration/runtime/copy-staging.ts": "00faa6a198696c7895cbf1ef4e57edd99c56367a402acd5e74acff7c08bd557f",
  "src/collaboration/runtime/identity.ts": "01ea15553f6c9f0e0d1c173553c17ae6bbd52013b8e4a1e38a5413e72b3ec779",
  "tests/shared-staging-maintenance.test.ts": "b7c784fb849a81712e8fd64639556d5bf136799a20d0d18151dba8d3560017f9"
}
```
