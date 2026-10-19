# Divine public-room moderation

This fork adds relay enforcement and room-scoped Coop actions. It does not retire Discord or replace platform-wide moderation. Deployment and pilot gates are in the [IaC runbook](https://github.com/divinevideo/divine-iac-coreconfig/blob/feat/concord-trust-safety/docs/how-to/services/concord-moderation.md).

## Staff workflow

Reports enter the Room Review queue as opaque case references. The authenticated Coop server fetches verified evidence from the moderation service. The evidence panel displays the author, reported text, room/channel target and expiry; plaintext is not copied into Coop item storage. Neighboring message bodies are not currently collected or displayed as case context. Ordinary approved reviewers assigned to the queue can remove a reported message. Moderation managers/admins can ban or unban within that community. These actions do not ban an account throughout Divine. Discord guild bans additionally require explicit guild scope and admin authority; they are never implied by a community ban.

After acting, check all three delivery rows: **Divine relay**, **Concord**, **Discord**. Queued/acknowledged is not verified. A verified relay removal means the currently indexed outer carriers were deleted, a fresh local query found none, and durable tombstones reject exact and alternate-wrap replay. Verified Concord delivery means read-back plus authorization folding succeeded. Discord verification requires an exact mapped public message/user and REST read-back; no name matching. Native-only content displays not applicable for Discord.

Use Retry for a failed, unexpired, authorized action with attempts remaining. Keep unresolved delivery failures in escalation; do not interpret a closed review item as successful enforcement. Evidence expiry preserves the delivery record, clears plaintext/audit material and signed pending bytes, and disables further execution. Re-reporting requires live verifiable evidence. The portal's pause control stops a mapping; it does not remove old content or delete the Discord server.

For one member, the newest ban or unban wins within each requested scope. Any newer membership decision supersedes earlier unsent community effects; only a newer explicitly Guild-confirmed decision supersedes an earlier Guild effect. A community-only action preserves queued Guild intent in either action direction. Superseded delivery rows read failed with `superseded_by_newer_decision`, status names a successor in `supersededBy`, and the earlier decision stays on record. Inspect each delivery: a decision can have superseded community targets and a still-pending Guild target. A delivery already in progress for the earlier decision (a send underway, or a Concord edition whose publication was attempted and is still being read back) finishes first, and the newer decision then applies on top. An exhausted or failed Concord publication with an uncertain outcome still holds the newer Concord delivery for operator recovery. Expiry clears its signed bytes as before and records `concord_recovery_requires_operator`; it does not establish that publication failed. Superseded rows are not counted as failed deliveries. Retry refuses superseded targets (`member_decision_superseded` when none can resume); an independently surviving Guild target can retry only with Guild authority, without restarting the superseded community actions.

Migration 016 adds a durable Guild revision fence to the existing member-order ledger, preserving its lifetime and global source-order acceptance rule. It backfills only explicitly confirmed Guild revisions present in stored decisions and fixes a boundary at each pre-upgrade global head. An older Guild target below that boundary with no proven later Guild successor has unknown historical scope ordering: it fails with `guild_scope_order_requires_operator`, rather than being cancelled as community intent or replayed. Unrevisioned historical Guild targets receive the same explicit disposition. Ordinary Retry cannot clear this state; reconcile the historical intent or record a new authorized staff decision. A known later Guild revision still supersedes, even after its decision is pruned. Repeated bootstrap preserves the boundary and Guild fence; old writers that omit the Guild fence cannot insert new Guild decisions. Pause old writers during upgrade and retain the ordering ledger on rollback. This repair does not select retention/holds, audit/appeal recovery, community-unban consumer display, case identity/capacity, category exclusions or control-history lifecycle contracts; those owner and consumer gates remain open.

Keep pre-016 outbox workers stopped as well as old API writers: their scope-blind sweep can silently cancel a surviving queued Guild target behind a community-only successor, even against the migrated database. Retaining the ledger alone does not make a pre-016 executable a compatible rollback. Keep delivery paused until scope-aware code is restored; do not resume old workers to drain the queue or infer which historical targets are safe to revive from a missing decision row.

`member_decision_superseded` from Retry is not proof that every target was superseded. A community moderator without Guild authority also receives it when only a Guild target survives and no community target can resume. Inspect the individual delivery rows and escalate that surviving target to authorized Guild staff; do not issue a replacement community action to retry it. More precise consumer refusal/display behavior remains a consumer-contract follow-up.

Concord retries preserve signed event bytes once publication may have begun.
An older, superseded action is never prepared again by Retry. A live failed
Concord target with retained attempted bytes and send attempts remaining may
resume only that exact generation under its original current-authority and
expiry checks; its relay and Discord targets stay stopped. This is publication
settlement, not permission to reissue the old staff intent.

When a newer Concord target is waiting behind a terminal older publication, the
worker also checks receipts without publishing. Opaque public-event IDs remain
with the durable delivery record; expiry still clears signed pending payloads,
case plaintext and audit material. A fetched event must match its recorded ID,
verify cryptographically and appear in the fresh canonical history. That marks the old target
`concord_superseded_publication_settled` / not applicable, then lets the newer
target proceed. This read-only check does not reset or spend the send budget and
can settle an expired action without executing it. Missing, invalid, noncanonical
or unavailable proof never releases the successor: the old target records
`concord_recovery_awaiting_proof`, and waiting targets report
`concord_waiting_on_prior_publication`. A missing-proof/expired-generation
operator release procedure (including legacy rows whose identities were already
erased before this migration) and its broader proof-retention policy remain part of the
unresolved case/audit lifecycle contract; do not clear markers or guess a
successful outcome in SQL. Read-only recovery uses the existing maximum retry
backoff, not a tight loop.

Legacy unfenced expired rows with a conservative send marker but no surviving
identity are quarantined as operator recovery only if they were claimed, not
guessed to be unsent. Zero attempts proves no send through the supported worker
path; a durable unattempted marker is also different. Neither creates that
blocker when migrations run again on restart. Never reset attempt counters in
SQL to manufacture that proof.

Only a persisted generation proved unattempted may be rebuilt against a newer
banlist. `concord_recovery_requires_operator` is not an ordinary Retry action:
keep that delivery failed and inspect the current canonical banlist and original
action with an authorized operator. Do not clear its signed bytes or send marker
to force a retry. Existing generations are conservatively treated as attempted.

## Provisioning and key boundaries

Owner signs genesis and grants locally. No owner private key belongs in the portal, database, relay, bot, moderation service or Kubernetes. Give the moderation member only the public community grants needed for removal/ban actions. Bot removal still needs the protocol's rekey/refounding ceremony. Public reading and previously copied messages cannot be revoked by an account ban.

Provision one puppet root for the selected public community/guild before activation. Portal `BRIDGE_MASTER_SECRET` and the worker's value must come from the same protected source, with matching portal `BRIDGE_COMMUNITY_ID`. The portal refuses another pairing or a different previously stored root. Do not extract/decrypt an existing root in a shell transcript. This is a bot identity root, never the community owner key.

Both services require an explicit public-channel allowlist and excluded category IDs. Fresh Discord REST visibility is checked before import/replay/forwarding/enforcement. Tickets and private channels stay excluded even if the bot has administrator access. Do not grant administrator to the bot merely to bypass missing permissions.

## Local verification

Use a disposable loopback Postgres for the integration suite:

```sh
bash scripts/test-integration.sh
bash scripts/test-image-contract.sh
bash scripts/build-test-images.sh
bun scripts/test-moderation-e2e.ts --local-synthetic
```

The first command requires `DATABASE_URL` set securely to the disposable instance. The last requires `STRFRY_TEST_IMAGE` naming a locally built, source-labelled image. The harness creates its own isolated Docker network and synthetic fixtures and rejects unspecified/live modes. It does not prove real Discord permissions, mobile display behavior, staff usability, actual latency or pilot costs.

## Outage and recovery

Failing/stale policy, disconnected control state, missing validator, malformed output and validator timeout/crash reject writes. Do not disable the mandatory write hook to restore availability. A rekey-pending state requires matching recovery material; a missing owner grant cannot be repaired by elevating the workload to owner.

The validator's soft deadline requests cancellation and waits for its database
admission to settle before writing a decision or accepting another request.
It does not announce rejection while that transaction can still commit. An
external relay/process failure is still an uncertain transport outcome, not a
cross-database atomic commit guarantee; reconcile policy and relay storage
before treating recovery as complete.

A worker owns the community through a Postgres transaction lock; delivery leases and stable decision IDs survive replacement. Acknowledge/verify is a separate step. Inspect target status before retrying; automatic retries stop at their configured budget and preserve failure. Rate limits are failures to retry, never successes.

When upgrading the publication-attempt schema, stop old moderation workers
before starting new workers. Do not mix versions across that transition: all
publishers must record intent before sending. This is a deployment prerequisite,
not permission to deploy.

Relay purge accepts up to 128 indexed carriers per removal. Overflow, SQL work
exceeding its 1.5-second statement limit, or exhausted barrier database budget
(30 seconds) fails the removal rather than reporting a partial purge as verified.
Keep the tombstone and escalate an overflow for controlled reconciliation; do
not remove the admission barrier to increase throughput. Discord visibility
reads use a process-local, bot-scoped queue (64 pending reads, four attempts,
30-second wait budget). Provider delays beyond that budget defer the effect;
there is no successful-authorization cache shared between effects.

Before restoring an older relay snapshot: stop the public listener, restore current moderation state independently, supply explicit minimum policy revisions, run `offlineRelayRestore.ts` against the offline relay volume, and require success before bringing the listener back. Never roll moderation policy/tombstones back to the relay snapshot. Restore into an isolated namespace first. A failed reconciliation leaves the public listener stopped. Keep community read material, evidence keys and bot keys in the restricted secret store; keep the owner backup separate and audit logged.

The offline target cannot also be the only source of fresh control policy.
For upgrades adding carrier-reference indexing, stop public admission and run
verified offline reconciliation before trusting removals or edited evidence.
Existing edit/reaction rows are deliberately marked unreconciled by migration;
no SQL guess assigns their encrypted contents to a message. A channel containing
such rows blocks purge/evidence rather than reporting partial success. Replay
the actual signed carriers with their required read streams to reindex them,
including carriers now rejected because their author or target was removed.
Missing historical read material remains an operator recovery blocker; do not
mark unknown references as indexed or discard unrelated edits to force success.

Keep an independently current control source available to `PolicyWatcher` while
reconciling the separate offline volume. The bundled worker reads the loopback
`MODERATION_LOCAL_RELAY_URL`; that source must remain available independently of
the volume being restored. Its disconnect invalidates policy, and its snapshots
expire after 30 seconds. A saved database snapshot alone is not a freshness
source. If no independent source is available, recovery remains blocked with
the public listener stopped. Do not extend `validUntil` or bypass readiness to
make the scan finish. The synthetic restore fixture does not establish this
operational prerequisite; rehearse it before pilot acceptance.

Operator metrics contain aggregates only: policy count/revision/age, pending/failed deliveries, oldest pending age, Discord gateway connectivity and relay socket outages. They are internal scrape endpoints, not public portal routes. Never attach report plaintext, credentials, full request payloads or source addresses to monitoring labels or incident comments.

The API remains ready during a Coop handoff backlog so staff can still inspect
status and retry existing work. Alert on `concord_coop_handoffs_pending` and
`concord_coop_oldest_pending_seconds`; an increasing age requires investigation
of Coop delivery or its acknowledgement, not a successful case-delivery claim.
Database failure or failed evidence cleanup still makes the API unready. Worker
policy readiness remains separate and continues to gate enforcement.

Control-history capacity is not an accepted pilot limit yet. The validator
memoizes verified cryptographic decoding only within its own bounded process
cache; every admission still folds the complete installed history and checks
freshness. Cold starts, newly seen editions and cache eviction still require
verification. Strfry starts the plugin on a write, so startup work is part of
that write's external timeout; warming before reading stdin is not an untimed
startup phase. The existing finite history/load bounds also stop reconciliation
when exhausted. Before pilot acceptance, select and verify a bounded history/load
and pre-ceiling lifecycle plan, or an upstream-compatible snapshot/compaction
design. Do not prune to current heads, raise bounds, or disable the hook as an
operator workaround: historical authorization and ban state depend on the fold.

## Separate public deployment

Set `BRIDGE_MODE=public` explicitly on public bridge/portal processes alongside
`BRIDGE_PUBLIC_CHANNELS`. Missing rules fail startup. Ordinary bridge/portal
processes remain legacy by default and retain private, multi-community support.
The moderation worker is already a public-only entrypoint; it does not host
legacy bridges. Use the dedicated public deployment/database/session and bot
credentials described in the root README. Never reuse the existing legacy
portal database or grant moderation access to its private-channel keys.
The public IaC configuration must select this mode when adopting an image with
this compatibility repair. Image publication and deployment need their own
approval; a local test does not authorize rollout.

## Membership source order and recovery

Every new `ban_member` or `unban_member` POST `/v1/decisions` requires
`sourceOrder: {"version":1,"revision":"42"}`. Coop allocates that positive,
canonical PostgreSQL bigint decimal string when it records the staff intent,
under its per-target counter lock. Publication and retry reuse the original
execution ID, actor, reason, scope, confirmation and source order. The bridge
resolves the member from its own case and stores a durable head keyed by
organization, community and member. Do not allocate order at HTTP delivery time.
`remove_message` retains its existing unfenced contract.

Status responses add `executionId` and `sourceOrder` (null for legacy rows).
Signed GET `/v1/decision-executions/:executionId` returns the existing status,
with the same org/community and action-or-view authorization as decision GET.
404 is an observation of no visible committed acceptance, not proof an in-flight
request cannot still commit. Reconcile a lost acceptance response through this
lookup. Delivery Retry is a separate operation and never allocates source order.

New lower revisions return HTTP 409 with `error: "member_intent_superseded"`,
`executionId`, `currentRevision` and `supersededByExecutionId`. Equal revision
with another execution returns `member_intent_order_conflict`; missing ordering
returns `member_intent_order_required`. No refusal creates deliveries. Exact
accepted replays are verified by their stored fingerprint generation first and
return the original record without restarting deliveries, including legacy
executions after evidence expiry. Changed immutable fields conflict.

Migration 013 adds nullable decision ordering fields and backfills existing
fingerprints as version 1. New revisioned hashes use version 2. The default
version 2 also makes an old executable's new unfenced membership INSERT fail
its database constraint; old unfenced removal hashes retain their replay
algorithm at either marker. Runtime roles cannot delete heads; an increasing
revision trigger prevents reset. Bootstrap re-applies these restrictions after
its earlier broad grants. Heads have no evidence/decision foreign key and must
survive pruning, restart, expiry, restore and recovery. Worker supersession and
Retry use source revision (including durable heads), while legacy accepted
membership precedes the revisioned generation. Existing live-lease and uncertain
Concord-publication guards still apply.

Cut over with new membership writes paused: deploy the additive bridge schema,
lookup and fence, reconcile existing Coop pending executions, then enable only
revision-aware registered-intent publication. Unaccepted ambiguous legacy
intents require reconciliation or a fresh explicit staff decision; never assign
them a new revision automatically. Inventory: the API is the production bridge
acceptance boundary; the runtime scenario in
`scripts/fixtures/moderation-runtime.ts` and acceptance fixtures in
`decisions.test.ts` and `executionContext.test.ts` now record explicit revisions.
Worker/protocol fixtures operating on already-stored decisions do not create
new acceptance and require no source-order allocation.

Before any revisioned acceptance, stop membership writers and run
`scripts/moderation-source-order-rollback-preflight.sql` against the intended
database before considering a schema downgrade. This is a read-only refusal
check, not a down migration. Once any revisioned row or head exists, keep both
ledgers, all counters, fingerprint markers and fencing. Disable new writes and
recovery if necessary; preserve reads/reconciliation and safe existing outbox
delivery, then roll forward or deploy a compatible build. Never resume an old
unfenced writer, lower counters or remove ordering from requests. Restore heads
and accepted execution identities together before enabling writes. There is no
automatic down migration; eventual retirement needs separate approval.

The bridge cannot know a newer intent that is still wholly inside Coop. The
fence prevents a delayed older request from undoing a newer revision after the
bridge accepts it; Coop suppresses automatic older sends after recording the
newer intent. Do not claim this provides synchronous ordering for unseen work.

## Independent evidence and action lifecycle

Report cases are per reporter. A fresh authenticated duplicate from the same reporter preserves the original reason, snapshot and expiry, including at capacity; it cannot extend retention. Different reporters retain separate bounded cases. Capacity is per organization, and expired unheld cases free it. These controls are not a per-pubkey Sybil guarantee. Configure the real selected excluded category IDs: stable IDs keep working after rename or channel movement; an empty excluded-category list is rejected.

Evidence expires independently of immutable staff action audit and ordering/execution facts. Set explicitly approved positive MODERATION_AUDIT_RETENTION_SECONDS and MODERATION_HOLD_MAX_SECONDS together with the existing evidence policy; there are no audit/hold defaults. Missing policy permits startup, reads, exact accepted replay, reconciliation and hold release, while new dependent writes return policy_configuration_required before allocation. /readyz is service health; /write-readyz exposes this policy capability separately.

Signed manage_moderation_records permits timed hold/release, appeal and eligible explicit lifecycle closure. Separate view_held_evidence permits reasoned audited access; ordinary views never regain expired content. Holds preserve the existing original/selected-edit ciphertext without extending its original expiry. A new hold cannot revive expired evidence. Held access commits its encrypted access audit before decryption. After relevant holds end, operator cleanup schedules and purges hold/access journals using the approved persisted interval. Legacy holds without such a snapshot cannot invent one.

Use GET /v1/decisions/:id/reversal-context and a NEW POST /v1/decisions/:id/reversals execution/revision to reverse a stored verified ban after report expiry. The bridge derives the target; Coop supplies the durable new source revision. This creates a fresh configured execution window without recreating report evidence or reopening old Retry. Legacy audit already erased remains unavailable. Deleted-message restoration is unsupported.

A community unban does not send a Discord Guild unban and does not claim the Guild restriction disappeared. Decision status reports a separate restriction observation with checkedAt. POST restriction-refresh and publication-refresh schedule read-only operator proof work and return current status; they do not grant mutation authority, resend an expired action or claim synchronous success. Only verified puppet mapping/binding supplies a Discord identity. Missing historic mapping, permission/rate/transport errors or wrong response identity remain unknown. Only the explicit Discord unknown-ban code proves absence; not_applicable is not successful enforcement.

Explicit closure is available after evidence expiry/deletion for settled actions. Expiry alone never closes audit. Active sanctions, appeals, holds, pending/uncertain effects and live leases block erasure. A continuing ban needs a current verified latest unban, no relay/Concord ban and a fresh independently verified absent Guild restriction when Guild history exists. Observation proof binds stable control/source identity; a new source/control change or pending refresh invalidates it, while unchanged polling timestamps do not. Closure records the approved interval; configuration changes cannot shorten a recorded deadline. Cleanup rechecks eligibility and retains heads, tombstones, immutable execution identity and publication safety references.

Apply the additive schema with incompatible writers drained. After any lifecycle/hold/reversal/source fence exists, retain its safety records and use a compatible build or roll forward. Never resume audit-at-evidence-expiry cleanup, reset heads, recycle executions, recreate evidence or downgrade to an unfenced writer. Restore the ordering ledgers and execution facts together. This source slice does not certify public capacity: P1 measured capacity and P2 durable admission/pause enforcement remain subsequent implementation and release gates.
