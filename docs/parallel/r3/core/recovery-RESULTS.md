# Portable record recovery: isolated prototype

Status: **incomplete; not connected to IPC, App, normal recovery export, or startup**. The existing recovery guard remains in place. This branch must not be interpreted as enabling recovery of record edits in production.

## Implemented

- A separate, strict v3 record bundle captures a supplied locally merged Page document/title and per-property pending patch, its owning database's saved settings and optional pending non-database Page patch, reachable normal Page links and parents, and referenced attachment bytes. It never acknowledges or clears pending edits. Unknown or lossy database schemas, malformed or incomplete references, oversized payloads, non-regular attachment files, and incompatible external DB/record targets are rejected.
- An isolated restore creates an exclusively new destination, assigns fresh Page and asset IDs, rewrites known document link, image and cover references, writes the membership and values in a SQLite transaction, and validates integrity. An incomplete marker remains on injected failures; files are retained instead of deleting anything whose ownership cannot be proved.
- Existing recovery v1/v2 implementation and App guard are unchanged. The v3 prototype uses a separate parser, so it does not replace them.

## Verification

- `env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs check`: passed with prototype and tests.
- `env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs test portable-recovery`: 4/4 passed; synthetic fixtures only. Tests cover pending fields, owner settings, attachment bytes, image, cover, internal page and attachment links in a new workspace, source preservation, invalid/hash/unknown data, UTF-8 size rejection, pre-existing destination refusal, and injected failures at asset, transaction and completion phases.
- Existing recovery plus prototype, default 5-second test timeout: 16/20 passed; four existing UTF-8 boundary tests timed out and Vitest reported a worker RPC timeout. Cause is not established. Log: `output/agent-workspace/logs/2026-10-27T07-41-43-168Z-test-32e3d995.log`.
- Reference run with different conditions: `env -u ELECTRON_RUN_AS_NODE node scripts/folio-agent.mjs test recovery.test.ts --retry 0 --testTimeout 120000 --maxWorkers 1` passed 20/20 (including all 16 existing recovery tests and 4 prototype tests). This does not establish a pass under the default timeout. Log: `output/agent-workspace/logs/2026-10-27T07-43-20-785Z-test-0cd6354e.log`.

## Remaining and limitations

- This is **not crash-recoverable across SQLite and the filesystem**: no persistent journal with replay/ownership proof exists, and normal startup does not enforce incomplete-marker rejection. A power loss or process termination at each filesystem and SQLite boundary has not been tested. The marker alone is not a production crash protocol. The restored SQLite version also remains the old version; opening it with an old application is unsafe. Do not wire this into production or open its output with an old application until both protections are implemented.
- No existing-workspace import/merge or explicit collision-injection test; a pre-existing destination is rejected and all copied IDs are freshly generated. No live-user data or cross-version upgrade/downgrade was tested.
- Pending database settings changes are rejected; owner non-database fields only can be patched. Other DB records are not automatically captured. Links to unselected records or external databases fail closed. The export input must be assembled from all relevant pending state by a future integration, and that integration must not clear the pending state on any failure.
- Recovery of ordinary Pages in v1/v2 is unchanged. This prototype does not restore histories, arbitrarily unknown Page/schema data or unrecognized forms of embedded references. The source bundle and drafts must be retained in all failure cases. File read/write errors, actual crashes, concurrent pending edits, and full end-to-end App/IPC flows remain unverified.

## Core follow-up

The current Core Store now refuses to open a workspace containing `FOLIO-RECOVERY-INCOMPLETE`; the isolated restore explicitly opts in only while constructing that new workspace. `test portable-recovery` passed 5/5 including this check. This is a fail-closed opening guard, not a completed replay journal: old versions do not honor the marker, filesystem/SQLite crash windows are not fully tested, and the production recovery path remains disabled.

A subsequent Core change marks completed synthetic record conversion and portable-restore SQLite stores as user_version 4 inside their transactions; unconverted workspaces stay at v3. Core rejects v4 stores missing the recognized record schema marker. A test built the fetched old Store source and confirmed it rejects a synthetic v4 sentinel while opening a preserved pre-conversion v3 snapshot. This is not a packaged old-app or real-data downgrade test, and does not complete the filesystem crash journal or enable production migration/recovery.
