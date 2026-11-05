# Recoverable bridge delivery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task by task.

**Goal:** Keep real Discord delivery recoverable after relay caps, temporary storage/external failures, rotation and restarts.
**Architecture:** One link lifecycle owns serial delivery and certified interval checkpoints. Separate finite unresolved retention from durable actionable retries. Enumerate each configured relay explicitly before certifying its interval.
**Tech Stack:** Bun, TypeScript, PostgreSQL, Nostrify, nostr-tools Negentropy engine.
**Spec:** Existing docs/deletion-replay.md plus the converged read-only committee decisions recorded in the task ledger. Root has the user's authorization to implement and deliver.

## Global constraints
- Preserve concord-core, all current citation/rank/self-delete/puppet/scoped-author and adapter final-dispatch authorization, and the popup contract.
- Every configured relay must certify coverage. Do not silently downgrade an unavailable or ambiguous relay.
- No real messages, secret payloads, production writes, new runtime credentials or publication.
- Add migrations; do not edit applied migrations019–021. Retain merged main PR8 capacity and PR9 monitoring.
- Focused commits after the repository test/typecheck gates. No pushes until final independent review; coordinate on the owned PR7 branch.
- Full IDs and synthetic fixtures only. Keep private operational evidence outside version control.

## Review focus
- A repair finishing during a newer intake gap or rotation cannot heal that newer gap.
- Actionable authorization loss must stop effects without converting the durable row into expiring quarantine.
- Stale lease/lifecycle callbacks must fail database predicates atomically after unlink/relink.
- Exact ID enumeration/fetch must survive caps4/8 in the same second, and NEG-ERR/missing IDs must never count as completion.
- Legacy deletion recovery must not resurrect ordinary older messages/reactions.

### Task 1: Complete per-relay replay
Files: packages/bridge/src/concord/pool.ts, client.ts and focused tests; new bounded reconciliation module/tests as useful; package dependency range/lock only if necessary; synthetic isolated relay interoperability fixture.
Interfaces: Add typed per-relay inventory enumeration and exact-ID fetch to RelayLike. Existing query/queryStrict remain control-plane APIs. backfillChannel keeps compatibility for callers until task3, but emits an explicit certified interval endpoint separately from newest event timestamp. New callbacks must distinguish payload batches from window completion.
- [ ] Reproduce capped300/400 and4/8same-second loss, per-relay subset/unavailability and error-as-close.
- [ ] Use locked nostr-tools2.24.1 nip77 engine, empty local inventory, direct current raw socket sessions, preserving stream authentication. Do not use NegentropySync or unsupported Nostrify typed send.
- [ ] Bound frames, rounds, IDs, duration and fetch batches; always clean sessions/listeners. Explicit NEG-ERR/version/disconnect/timeout/no-progress failures.
- [ ] Process chronological five-minute windows. Union at most16384IDs; split overflow/sync-limit windows oldest first, fail closed at oversized one second. Omit reconciliation filter limit.
- [ ] Fetch outstanding IDs in batches100 until exhausted, independently per relay; do not let returned lower cap certify missing IDs. Bounded retry/reconcile for purged carriers. Deliver decoded payloads in small batches with explicit completed-window callback. Preserve meaningful chronological delivery semantics within resource bounds; raise concrete interface conflict to root rather than inventing coverage.
- [ ] Freeze upper bound at run start (never future wrap max); only interval endpoints certify. Fallback only with explicit verified newest-prefix/fixed-cap contract; saturated seconds incomplete.
- [ ] Run focused regressions, full repository gate/types and commit. Isolated pinned-strfry wire interoperability is required evidence; report unavailable runtime honestly.

### Task 2: Durable lifecycle, deletion policy and upgrade store
Files: router.ts, db/store.ts, db/leases.ts, additive migrations022+, matching memory store/tests, adapter.ts/tests only relevant errors/permission observations.
Interfaces: Typed durable-intake errors; stored/policy-disposed outcomes; explicit unresolved/actionable action class, stable source-wrap time, expiry, next due/attempt fields. Fenced delivery-state handle captures link lifecycle and lease resource/holder/token; expose these on BridgeLease. Store cursor snapshot has version, repair floor, stream coverage/legacy boundaries and lifecycle.
- [ ] Add actual-PG regressions for class quotas, expiry/replay, post-save read failure, lease/lifecycle takeover races and one-time legacy eligibility.
- [ ] Separate4096/link1024/actor allocations. Unresolved expires seven days from min(source wrap timestamp, first observation, now); overflow explicit disposition/counter, no gap. Never renew on replay.
- [ ] Actionable rows never silently expire or downgrade. Current authority still gates every attempt; retry10sec exponential to1hr, limit128 due rows. Full actionable allocation raises typed intake gap. Preserve successful/idempotent completion and verified permanent inapplicability.
- [ ] Contain applier/read failures after durable save. Retain confirmed actionable effects across outage/permission denial. Extend existing permission observation for Manage Messages, no new notifications.
- [ ] Every deletion/retirement/checkpoint state mutation validates lifecycle AND current lease in same transaction/statement; preflight alone insufficient. Unlink invalidates lifecycle before cleanup; stale callbacks cannot recreate state.
- [ ] Migration snapshots upgrade-eligible existing links once. Minimum available legacy floor plus each stream's own previous boundary; below own boundary replay deletion only. Fresh/relinked floor at activation; pause preserves lifecycle.
- [ ] Add due-link bounded query and fold wakeup. Actual reachable PG failures fail tests; only unavailable prerequisites skip.
- [ ] Run focused/actual-PG and full gates/types; commit.

### Task 3: One recoverable coordinator integrated in both runtimes
Files: new concord/linkDelivery.ts/tests, delivery.ts/tests, bridge/index.ts, portal/manager.ts/tests, relevant store integration.
Interfaces: LinkDelivery owns one effect lane, current channel/subscription, generation/version/lifecycle snapshot, repair scheduling/abort/drain. Store task2 handles persisted CAS; replay task1 reports interval completion. Only certified endpoints persist progress; never live timestamp acks.
- [ ] Reproduce rotation with blocked old deletion, typing flood, failed confirm/gateway, concurrent gap during checkpoint await, write failure and SIGTERM during catch-up.
- [ ] Drop/coalesce typing outside200durable admission. Subscription replacement feeds same lane and live dedupe; replay must enumerate/handle durable deletions independently of live dedupe.
- [ ] Synchronously trip gap generation and earliest floor; durable version/lifecycle CAS after full covering replay, then in-memory generation recheck after awaits. Never overwrite newer floor. Persist failure retains old progress and accepted work.
- [ ] Rotation invalidates coverage immediately and replays newly discovered streams from lifecycle/introduction floor with60sec overlap, not latest cursor/now−60.
- [ ] Route-ready active floor before certification; contain pending confirmation failures. Attach/restart must not reset existing lifecycle.
- [ ] One manager-level bounded due-work scheduler instead of per-link timers. Standalone bounded scheduler too. Early shutdown hooks before resources/longawait, abort replay and release lease.
- [ ] Run focused and full integration gates/types; commit.

### Task 4: Contract, probe and final integration
Files: docs/deletion-replay.md, scripts/probe-backlog.ts/tests, task ledger.
- [ ] Probe reads certified state and uses bounded collection; remove only genuinely obsolete APIs, keep final authorization.
- [ ] Document finite unresolved guarantee, durable actionable retries, mapping lifetime, configured-relay availability and60sec lateness/backdating assumptions. No infinite storage/loss guarantee claim.
- [ ] Full actual-PG test gate, all required types/build, isolated wire test where runtime available; fresh independent whole-branch review plus focused re-review of fixes.
- [ ] Commit, push owned PR7, verify current checks, announce fixes and request existing change reviewers only. Merge only actual approved exact head, no bypass.

