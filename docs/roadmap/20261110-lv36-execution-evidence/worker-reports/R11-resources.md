# R11 resources integration report

## Owned files
- `tests/shared-runtime-resources-integration.test.ts`
- `REPORT.md`

No source, contract, helper, or oracle files were edited.

## Actual API exercised
- `SharedAuthority(directory)`, `bootstrap`, `session`, `head`, `submit`, `receipt`, `createDocument`, `records`, `snapshot`, `close`
- Resource actions through `submit`: `db.create`, `record.create`, `record.patch`, `record.trash`, `record.restore`, `asset.publish`, `workspace.grant`
- `stageAsset`, `readAsset`
- `projection(token).search/exportDocument`
- `createWorkspace`, `invite`, `acceptInvite`, `grant`, `handoff`, `revokeMember`, `organization.overview`
- `backup`, `restoreInto`, `recover`
- `RuntimeStore`, `SHARED_RUNTIME_VERSION`, `CollaborationError`

## Integration points
- `authority.resource` -> `applyRecords` for record/database actions, with lifecycle checks before the resource branch.
- `record.create` body -> `documents` + `seedTables` + `doclifecycles` in `authority.resource`.
- `record.trash`/`record.restore` -> `applyRecords`; lifecycle wiring is expected through `DocumentLifecycle` and `record.restore` `newIncarnationId`.
- Assets -> `SharedAssets.stage/publish/read` plus `asset.publish` resource commit at one authority cut.
- Organization -> `OrganizationService` over `WorkspacePolicy`, with authority-level administrator checks.
- Backup -> `exportBackup`/`restoreBackup` into a real empty `RuntimeStore`, then `SharedAuthority.recover` for reauthorization.

## Expected red tests (source gaps, not test defects)
- `record.create` on a fresh document scope currently hits `lifecycle.assertActive` and returns `REJECTED/LIFECYCLE_MISSING`, although creating a record should establish the record page lifecycle.
- `record.trash` deletes only the record row; it does not mark the document lifecycle deleted, so `records`/`snapshot` do not report `DOCUMENT_DELETED`.
- `record.restore` rejects `newIncarnationId` as `UNKNOWN_PAYLOAD_FIELD` and does not create/activate a fresh incarnation, so the fresh-incarnation write and stale-incarnation assertions cannot pass.

## Unverified / limitations
- Parent runs `npm run check`, `npm test`, and build. This worker did not run shell/tests.
- GUI, Electron, browser, native dialogs, Keychain, and real user data were not used. `NOT_RUN` for GUI/E2E.
- Tests use real temporary `node:sqlite` stores and SHA-256 evidence for staged/published asset bytes and backup hash.
- Cross-restore resubmission of an old attempt is not asserted because recovery rotates the writer identity; old-receipt lookup and stale-epoch base rejection are asserted instead.
- No missing public API port was found.
