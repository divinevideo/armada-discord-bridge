# Agent Checkpoint — Relay removal batching

Generated 2026-10-24 by OpenAI GPT-6 / Codex.

## Objective
Finish the approved bounded relay-removal repair, verify it, and deliver it through the normal reviewed release path.

## Current Status
[VERIFIED] Implementation is committed at 1b92183f1d13de81d323886576a4a8ce55476106 on branch juicy-husky, based on bdcaa06527fea5bee64a27a9769d3dd0d19000a2. Independent review and hosted CI remain pending at generation time. No deployment readiness is inferred from local tests.

## Build and Test Status
[VERIFIED] `DATABASE_URL=postgres://bridge@127.0.0.1:55478/bridge_test bash scripts/test-integration.sh` passed: four typechecks, portal build, skip gate, 989 tests, zero failures or skips, 4027 assertions. The database is a disposable PostgreSQL 15 instance owned by this task.

## Current Mental Model
- Preserve the tombstone before acquiring the writer barrier. All related-carrier scans, raw deletion verification and checkpoints remain inside that barrier.
- A checkpoint records independently verified external absence. It must not be advanced merely because a delete command returned successfully.
- Each successful batch commits its cursor before starting the next transaction. Those commits do not reset the original database deadline. A later failure keeps earlier verified progress but leaves the whole removal failed and retryable.
- Carrier metadata is retained for evidence and offline restore. Restoring older relay data still requires the existing offline reconciliation procedure before serving it.
- Database query factories prevent expired work from being constructed or dispatched. Cancelling an unstarted query on a reserved connection can strand the connection before rollback.
- CLI carrier IDs describe the most recent batch; removedCount describes acknowledged progress in the current attempt, not prior attempts.

## Remaining Work
1. Inspect the independent review against the implementation commit and fix any verified blockers.
2. Push the branch, open the pull request, request the mapped team once, and inspect hosted source/runtime checks before merging.
3. Advance the complete application image set together through the existing release workflow. Operational configuration and live acceptance are separate from this code-only checkpoint.

## Constraints
[VERIFIED] Migration024 is additive and gives existing removals an empty cursor. No Concord authorization gate or popup handoff contract changes. Never insert real account identifiers or credentials into fixtures or public review artifacts.
