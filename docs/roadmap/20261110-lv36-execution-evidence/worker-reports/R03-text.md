# R03 text-intent adversarial review

## Owned outputs
- `tests/shared-runtime-text-adversarial.test.ts`
- `REPORT.md`

No source, config, helper, or contract files were edited.

## Implemented API exercised
- `applyText(state: DocumentState, command: TextCommand, intervening: AppliedText[]): SemanticResult`
- `rebaseText(command: TextCommand, intervening: AppliedText[]): TextCommand`
- Supporting boundary: `initialState`, `materializedState`, `locate`, `canonical`, `parseSharedInput`, `inspectSharedDocument`, shared `wellFormed`.

`TextCommand.before` is the raw inline text expected by the caller; hard breaks count as one `\n` and positions are UTF-16 offsets that must not split a surrogate pair.

## Integration points
- Server apply path must call `applyText` with the exact current state and only the same-block text patches applied since the command base. `appliedText.from/to` are coordinates in the rebased state, not the original command.
- Any `CollaborationError` is a refusal. The caller must keep the original command and original `DocumentState`; these functions do not publish partial writes.
- Client command builders must supply plain data, exact `before`, and code-point-aligned offsets. Unknown fields are not sanitized here.
- Raw persisted/external documents must go through `initialState`/`inspectSharedDocument`, which preserve the raw string on refusal. `materializedState` is the engine-side normalization path.

## Test coverage
- Insert/delete/replace permutations, marks, hard breaks, astral characters, surrogate splitting, lone surrogates.
- Insert/delete/caret rebasing across earlier inserts, deletes, replacements, same-position inserts, and exact boundary touches.
- Refusal of caret/selection overlap with a replacement and of a delete that would swallow an intervening insertion.
- Malformed command shapes, malformed history, non-array history, other-block/non-text history entries, stale `before`, missing block, unsupported inline nodes, unknown fields, accessor-backed command, and state immutability on every refusal.
- Raw boundary: lossless valid input, unsupported numeric/structural JSON with raw preservation, adjacent unmarked raw text refusal, internal adjacent-run normalization, canonical accessor/unsafe-number/lone-surrogate refusal.

## Limitations / unverified
- Parent runs `npm test`, typecheck and build. This worker did not execute tests, shell, GUI, Electron or browser checks. GUI: `NOT_RUN`.
- Exact-boundary ambiguity: a delete selection exactly matching a concurrent replacement deletes the replacement (`TEXT_CONFLICT` is not raised). This is tested as current OT delete-over-replace behavior. If product policy requires preserving that remote text, the contract needs an explicit conflict decision. Severity: medium ambiguity; no wrong block or unrelated text loss.
- Unknown command/history fields are ignored rather than rejected. Severity: low; transport/schema validation should reject them if strict envelopes are required.
- Command/history objects are read directly and are not canonicalized. An accessor-backed command can throw a non-`CollaborationError`; state is unchanged. Severity: low; callers must pass plain data.
- Non-text and other-block history entries are skipped by design. Supplying unrelated entries cannot corrupt this block, but hides a caller mistake. Severity: low.

## Minimal conflict counterexamples
- Remote insert inside a local delete: base `abcdef`, remote insert `XX` at 3, local delete 2..4 -> `TEXT_CONFLICT`; remote state and text are preserved.
- Remote replacement 2..4 with `Z`, local caret at 3 -> `TEXT_CONFLICT`.
- Delete spanning a hard break -> `UNSUPPORTED_HARD_BREAK`; original state unchanged.
- Offset inside an astral pair -> `TEXT_RANGE`; original state unchanged.
- Raw adjacent unmarked text runs -> `LOSSY_PROJECTION`; original raw string unchanged.
