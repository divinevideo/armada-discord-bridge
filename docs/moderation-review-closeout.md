# Moderation review closeout

This maps the outstanding review contracts on [PR 1](https://github.com/divinevideo/armada-discord-bridge/pull/1) to the implemented bridge behavior. It records evidence for re-review; it does not dismiss reviews or certify a public launch.

The maintainer's [contract selection](https://github.com/divinevideo/armada-discord-bridge/pull/1#issuecomment-6244862215) must be read together with the decisions recorded in the PR discussion: per-reporter cases, existing category exclusions, independent evidence/action lifecycle and a measured bounded pilot. Deployment policy values and destination measurements remain release inputs. Do not substitute synthetic test values for those inputs.

| Review contract | Implementation and regression evidence | Remaining acceptance |
| --- | --- | --- |
| Preserve existing deployments | Legacy is the default in `packages/bridge/src/deploymentMode.ts`; public mode is explicit and separated. `deploymentMode.test.ts`, portal `env.test.ts`, importer and manager tests cover compatibility and guarded public effects. | Verify actual deployment separation and identity continuity before cutover. |
| Original staff-decision order and scope | `decisions.ts`, migrations013/016 and `sourceOrder.test.ts`/`guildScope.test.ts` enforce durable source revisions, idempotent acceptance and scope-aware supersession/Retry. Community-only successors preserve Guild work. | Final matching Coop source and client acceptance. A wholly unseen Coop intent cannot be ordered by the bridge. |
| Retention, holds, appeals and post-expiry unban | `lifecycle.ts`, `decisionReversals.ts`, migration017, `lifecycle.test.ts`, `lifecycleSchema.test.ts` and `decisionReversals.test.ts` cover timed holds, separately authorized audited access, explicit closure and fresh reversal from retained action facts. Missing audit/hold configuration refuses new dependent writes. | Approved audit/hold values and operational ownership before release. Legacy audit already erased cannot be reconstructed. |
| Fresh proof before audit erasure | Migration019 and `discordRestriction.test.ts` require a new Discord restriction observation after retention elapses when Guild history exists, including under the operator role. Due readback rotates so unresolved records cannot monopolize the worker. | Live provider permissions and readback acceptance. External state can still change after any observation. |
| Truthful community unban | `discordActions.ts`, `discordRestriction.ts` and their tests keep community enforcement separate from independently observed Guild restriction. Unknown, absent, present and not-applicable have distinct meanings. | Coop presentation and staff acceptance tracked in [Coop PR23](https://github.com/divinevideo/coop/pull/23) and [issue24](https://github.com/divinevideo/coop/issues/24). |
| Case identity and abuse bounds | `reports.ts`/`reports.test.ts` preserve per-reporter identity and original snapshot/expiry on authenticated duplicates, including at capacity. Organization case bounds and reporter rate limits remain enforced. | Accept the documented limits: pubkey rotation is not a Sybil defense, and different reporters consume separate cases. |
| Category exclusions | `publicChannelPolicy.ts`/`.test.ts` retain required nonempty stable excluded IDs plus Tickets-name exclusion. Rename/move regressions preserve configured exclusions. | Supply the actual excluded IDs before public startup. |
| Control-history capacity and recovery | `capacityContract.ts`, `publicCapacity.ts`, migration018, their tests and `scripts/fixtures/strfry-capacity.ts` validate measured evidence, close admission without it, retain a durable pause and reserve bounded capacity for authorized moderation. Resume requires operator authority and current counts. | Native destination/resource/controller measurements, reviewed thresholds/reserve, and an operational pause/recovery rehearsal before launch. Synthetic calibration is not capacity certification. |

## Consumer boundary

The bridge's readback/status API and its synthetic TLS Coop fixture do not establish acceptance of a real Coop client. Final paired verification must record both full source SHAs and exercise original receipt identity, lost-response lookup/recovery, source-order refusal, holds, expired-source reversal and surviving Guild restriction display. Existing historical pair receipts remain historical.

Retry retains a compatibility limitation: `member_decision_superseded` can also be returned when only a Guild target survives and the actor lacks Guild authority. Consumers must inspect destination rows and escalate that target rather than reporting that all effects were canceled or creating replacement community intent. Changing the refusal contract requires coordinated consumer handling.

## Release and rollback

Before public use, record approved policy values, measured destination capacity, matching reviewed source artifacts and infrastructure pins, paused revision-aware cutover, verified legacy-reference reindexing where needed, independently current restore policy, and live Discord/relay/client staff acceptance. These operations are not performed by local tests or image builds.

Migrations are additive and re-applied at bootstrap. Retain ordering heads/counters, execution identities, publication receipts, lifecycle/hold records, capacity state and the audit-refresh guard. Stop incompatible writers and workers; roll forward or restore a compatible build. Do not resume an unfenced or scope-blind binary, clear a durable pause in SQL, prune authorization history or reconstruct missing evidence.

## Review evidence

Attach exact-head integration, runtime and automated-review results to the PR handoff. Report skipped or unavailable coverage explicitly. A pending/partial automated report is not complete review. Existing requested-changes verdicts need their reviewers' closeout; contributor lineage and actual human diff-reading cannot be certified by test output.
