# Divine public-room moderation

This fork adds relay enforcement and room-scoped Coop actions. It does not retire Discord or replace platform-wide moderation. Deployment and pilot gates are in the [IaC runbook](https://github.com/divinevideo/divine-iac-coreconfig/blob/feat/concord-trust-safety/docs/how-to/services/concord-moderation.md).

## Staff workflow

Reports enter the Room Review queue as opaque case references. The authenticated Coop server fetches verified evidence from the moderation service. The evidence panel displays the author and context, and its expiry; plaintext is not copied into Coop item storage. Ordinary approved reviewers assigned to the queue can remove a reported message. Moderation managers/admins can ban or unban within that community. These actions do not ban an account throughout Divine. Discord guild bans additionally require explicit guild scope and admin authority; they are never implied by a community ban.

After acting, check all three delivery rows: **Divine relay**, **Concord**, **Discord**. Queued/acknowledged is not verified. A verified relay removal means the currently indexed outer carriers were deleted, a fresh local query found none, and durable tombstones reject exact and alternate-wrap replay. Verified Concord delivery means read-back plus authorization folding succeeded. Discord verification requires an exact mapped public message/user and REST read-back; no name matching. Native-only content displays not applicable for Discord.

Use Retry for a failed, unexpired, authorized action with attempts remaining. Keep unresolved delivery failures in escalation; do not interpret a closed review item as successful enforcement. Evidence expiry preserves the delivery record, clears plaintext/audit material and signed pending bytes, and disables further execution. Re-reporting requires live verifiable evidence. The portal's pause control stops a mapping; it does not remove old content or delete the Discord server.

For one member, the newest ban or unban wins. Accepting one supersedes any earlier ban or unban for that member whose deliveries have not gone out: those rows read failed with `superseded_by_newer_decision`, the status names the newer decision in `supersededBy`, and the earlier decision stays on record. A delivery already in progress for the earlier decision (a send underway, or a Concord edition whose publication was attempted and is still being read back) finishes first, and the newer decision then applies on top. An exhausted or failed Concord publication with an uncertain outcome still holds the newer Concord delivery for operator recovery. Expiry clears its signed bytes as before and records `concord_recovery_requires_operator`; it does not establish that publication failed. Superseded rows are not counted as failed deliveries. Retry refuses an older ban or unban once a newer one exists for that member (`member_decision_superseded`); act on the newer decision instead.

Concord retries preserve signed event bytes once publication may have begun.
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
