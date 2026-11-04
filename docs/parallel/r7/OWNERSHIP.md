# R7 W0→W1 ownership and validation contract

Base: origin/master `02b83806d6d08b1b2c1b70a3a8f172466d8d658e`, fetched 2026-11-04 (Asia/Tokyo). Main checkout remains at bd0f1e7 with its existing artifacts/ and outputs/. No push, deployment, user-data migration or termination of pre-existing apps.

Boundary extraction: `d5e5c3455ca87d46a361de2fe484fa81315000a5`. Each worker starts here in its own worktree. No shared DB. Main integration owns App, LiveRecordDatabase, RecordPage/Editor lifecycle, store/main/preload, shared schema/types, coordinators, lockfiles, and test configuration. Workers never write other worktrees.

Model: OpenCode Go `opencode-go/deepseek-v4.1-flash`, variant high. Ten local CLI workers: implementation 4, research 4, independent QA 2. Each execution/session export is retained outside the repository in outputs/folio-r7-w1-20261104/deepseek/. An initial launch had incorrect worktree-relative permissions and was stopped; corrected launches explicitly use --dir and PWD with scoped permissions. No replacement model.

| Worker | Role | Owned paths |
|---|---|---|
| D1 | DB controls | `src/database/DatabaseSettingsPanel.tsx`, `src/database/database-settings-panel.css`, `src/database/settings-menu/**`, `tests/r7-settings-menu.test.ts` |
| D2 | Board body excerpts | `src/database/DatabasePresentation.tsx`, `src/database/card-excerpt.ts`, `src/database/card-excerpt.css`, `tests/r7-card-excerpt.test.ts` |
| D3 | Ranked contextual search | `src/renderer/SearchPanel.tsx`, `src/renderer/search-panel.css`, `src/persistence/search-query.ts`, `src/shared/search-snippet.ts`, `tests/r7-search.test.ts` |
| D4 | Markdown title round trip | `src/document-io/**`, `tests/r7-markdown.test.ts` |
| D5 | W2 backlink context | Read-only report |
| D6 | W2 page layout | Read-only report |
| D7 | R6 input and focus paths | Read-only report |
| D8 | Search IO and future restore | Read-only report |
| Q1 | Independent acceptance scenarios | `tests/e2e/r7-acceptance/**` |
| Q2 | Data safety and fixture | `tests/e2e/r7-data-safety/**`, `tests/fixtures/r7/**`, `scripts/r7-demo.mjs`, `scripts/r7-demo-seed.ts`, `scripts/verify-r7-workspace.mjs` |

Acceptance: compact reachable DB settings with visible active conditions/save issues; nested AND/OR and multi-sort/Select/schema operations preserved; readOnly board body snippets use existing session docs; title-ranked short Japanese search with real match context and no stale responses; marked Folio Markdown title/body roundtrip without stripping external H1; same record Editor/undo/selection across side/full and retained raw numeric inputs across navigation.

Validation layers: current R6 build/typecheck/unit/Electron baseline; worker focused checks; parent diff review and dependency-order integration; final build/typecheck/unit/Electron regressions; before/after same synthetic dataset screenshots and runnable development demo. Synthetic composition is distinct from physical IME. W2 research is informational only.
