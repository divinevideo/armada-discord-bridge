# Bridge deletion authority implementation plan

> Execute inline, without subagents. The source of authority remains the unchanged Concord kernel.

**Goal:** Delete a Discord message or mirrored reaction only when the current Concord fold authorizes that exact actor over its scoped target, while retaining future-citation actions across restart.

**Architecture:** Keep minimal pending deletion records in the existing mapping store, keyed by tenant, community, Discord guild/channel, Concord channel, deletion rumor and target rumor. A new additive migration supplies the durable Postgres table; memory storage supplies the same bounded contract for tests. Current authorization is checked again at the Discord adapter's final dispatch boundary, after its asynchronous policy checks and webhook lookup.

**Reference:** GitHub issue #6; `scripts/fixtures/community-interop.test.ts`; `packages/concord-core/src/control.ts` citation semantics and `roles.ts` member hierarchy.

## Constraints and review focus

- Do not change kernel admission or the popup contract. Self-deletes need no moderator citation; every other action requires `citationSatisfied` and `canActOnMember(..., MANAGE_MESSAGES)` in the current fold.
- Discord-origin authors resolve through this router's puppet identity; reaction targets must resolve to a message mapping in this exact link.
- Store minimal public deletion metadata, not content, keys or tokens. Bound outstanding records at 4096 per link and 256 per actor. Enqueue all targets transactionally or fail; never evict unprocessed actions or silently advance the cursor over a storage failure.
- Retain actions whose citations or permissions may become resolvable later. Missing non-owner citations can never acquire authority; unknown targets remain bounded and retry when mappings arrive.
- Retries use fresh authority, visibility and lease checks. Partial effects are idempotent, and a failed reaction removal must retain the mapping needed to retry it.
- Await durable dispatch before cursor advancement in both entry points. A failed dispatch pins that subscription's cursor until a fresh catch-up, rather than allowing a later event to skip it.

## Tasks

1. Add signed deletion regressions using the shared vectors and generated equal-rank/puppet/future-grant controls. Verify message and reaction refusal for owner/admin/equal-rank targets, missing citations, wrong link/channel, and authority changes during an awaited effect guard.
2. Implement router-level current-fold authorization and explicit final-effect callbacks in `DiscordAdapter.delete/unreact`. Preserve self-deletes and resolve Discord authors through the puppet cache. Make already-absent Discord message deletion idempotent.
3. Add minimal pending deletion types and memory/Postgres store methods, additive migration 019, atomic duplicate/cap handling, and durable restart tests against isolated Postgres. Keep failed effects pending and persist before any cursor can advance.
4. Replay pending work on initial startup, control refolds, new target mappings and a coalesced periodic retry. Wire the same behavior in `packages/bridge/src/index.ts` and `packages/portal/src/manager.ts`, clearing timers on shutdown/lease loss.
5. Make subscription callbacks await dispatch and cursor writes; test cursor ordering/failure and restart beyond the original cursor overlap.
6. Run focused regressions, the complete `bun test` with isolated Postgres, concord-core typecheck, portal typecheck and bridge typecheck. Commit focused slices, push a reviewable PR closing #6, and request the mapped review team once. Do not merge or deploy.
