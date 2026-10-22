# Divine public-room moderation

This fork adds relay enforcement and room-scoped Coop actions. It does not retire Discord or replace platform-wide moderation. Deployment and pilot gates are in the [IaC runbook](https://github.com/divinevideo/divine-iac-coreconfig/blob/feat/concord-trust-safety/docs/how-to/services/concord-moderation.md).

## Staff workflow

Reports enter the Room Review queue as opaque case references. The authenticated Coop server fetches verified evidence from the moderation service. The evidence panel displays the author, reported text, room/channel target and expiry; plaintext is not copied into Coop item storage. Neighboring message bodies are not currently collected or displayed as case context. Ordinary approved reviewers assigned to the queue can remove a reported message. Moderation managers/admins can ban or unban within that community. These actions do not ban an account throughout Divine. Discord guild bans additionally require explicit guild scope and admin authority; they are never implied by a community ban.

After acting, check all three delivery rows: **Divine relay**, **Concord**, **Discord**. Queued/acknowledged is not verified. A verified relay removal means the currently indexed outer carriers were deleted, a fresh local query found none, and durable tombstones reject exact and alternate-wrap replay. Verified Concord delivery means read-back plus authorization folding succeeded. Discord verification requires an exact mapped public message/user and REST read-back; no name matching. Native-only content displays not applicable for Discord.

Use Retry for a failed, unexpired, authorized action with attempts remaining. Keep unresolved delivery failures in escalation; do not interpret a closed review item as successful enforcement. Evidence expiry preserves the delivery record and action audit, clears unheld report evidence and signed pending bytes, and disables execution of the expired action. Action audit follows explicit lifecycle closure and its separately configured retention interval; a timed hold preserves evidence without making it ordinarily viewable. Re-reporting requires live verifiable evidence. The portal's pause control stops a mapping; it does not remove old content or delete the Discord server.

For one member, the newest ban or unban wins within each requested scope. Any newer membership decision supersedes earlier unsent community effects; only a newer explicitly Guild-confirmed decision supersedes an earlier Guild effect. A community-only action preserves queued Guild intent in either action direction. Superseded delivery rows read failed with `superseded_by_newer_decision`, status names a successor in `supersededBy`, and the earlier decision stays on record. Inspect each delivery: a decision can have superseded community targets and a still-pending Guild target. A delivery already in progress for the earlier decision (a send underway, or a Concord edition whose publication was attempted and is still being read back) finishes first, and the newer decision then applies on top. An exhausted or failed Concord publication with an uncertain outcome still holds the newer Concord delivery for operator recovery. Expiry clears its signed bytes as before and records `concord_recovery_requires_operator`; it does not establish that publication failed. Superseded rows are not counted as failed deliveries. Retry refuses superseded targets (`member_decision_superseded` when none can resume); an independently surviving Guild target can retry only with Guild authority, without restarting the superseded community actions.

Migration 016 adds a durable Guild revision fence to the existing member-order ledger, preserving its lifetime and global source-order acceptance rule. It backfills only explicitly confirmed Guild revisions present in stored decisions and fixes a boundary at each pre-upgrade global head. An older Guild target below that boundary with no proven later Guild successor has unknown historical scope ordering: it fails with `guild_scope_order_requires_operator`, rather than being cancelled as community intent or replayed. Unrevisioned historical Guild targets receive the same explicit disposition. Ordinary Retry cannot clear this state; reconcile the historical intent or record a new authorized staff decision. A known later Guild revision still supersedes, even after its decision is pruned. Repeated bootstrap preserves the boundary and Guild fence; old writers that omit the Guild fence cannot insert new Guild decisions. Pause old writers during upgrade and retain the ordering ledger on rollback. The selected lifecycle, case-identity, category and bounded-capacity implementations are described below. Consumer acceptance and configured launch inputs remain separate; see the [review closeout](moderation-review-closeout.md).

Keep pre-016 outbox workers stopped as well as old API writers: their scope-blind sweep can silently cancel a surviving queued Guild target behind a community-only successor, even against the migrated database. Retaining the ledger alone does not make a pre-016 executable a compatible rollback. Keep delivery paused until scope-aware code is restored; do not resume old workers to drain the queue or infer which historical targets are safe to revive from a missing decision row.

`member_decision_superseded` from Retry is not proof that every target was superseded. A community moderator without Guild authority also receives it when only a Guild target survives and no community target can resume. Inspect the individual delivery rows and escalate that surviving target to authorized Guild staff; do not issue a replacement community action to retry it. More precise consumer refusal/display behavior remains a consumer-contract follow-up.

Concord membership delivery is serialized across the whole community, because
all members share one banlist generation. An uncertain publication therefore
holds Concord bans and unbans for every member in that community, not just the
member named by the original action. Divine relay and Discord deliveries, and
other communities, can continue; inspect each destination rather than assuming
their enforcement states agree. Canonical proof releases the fence. A losing
noncanonical generation or a legacy generation with no surviving identity can
remain operator-gated indefinitely. There is no automatic release or ordinary
Retry that resolves those cases; retain the uncertainty and escalate for an
authorized recovery decision instead of clearing the marker. The supported
public-pilot procedure and its limits are in
[Public pilot publication recovery](#public-pilot-publication-recovery).

Before upgrading from per-member ordering, stop accepting new membership
decisions and let the current compatible worker settle attempted Concord
deliveries where proof is available. Do not equate an unproved generation with
a drained outbox or resume an incompatible worker to force it through.
Leftover attempted generations for different members may coexist. They may
reconcile by read-only canonical
readback even before expiry, without spending send attempts or publishing over
one another. Missing proof keeps them unresolved; this is not an operator
release for an event that never landed or whose identity is gone.

Concord retries preserve signed event bytes once publication may have begun.
An older, superseded action is never prepared again by Retry. A live failed
Concord target with retained attempted bytes and send attempts remaining may
resume only that exact generation under its original current-authority and
expiry checks; its relay and Discord targets stay stopped. This is publication
settlement, not permission to reissue the old staff intent.

When a newer Concord target is waiting behind a terminal older publication, the
worker also checks receipts without publishing. Opaque public-event IDs remain
with the durable delivery record; expiry still clears signed pending payloads,
unheld case plaintext. Action audit follows its independent lifecycle. A fetched event must match its recorded ID,
verify cryptographically and appear in the fresh canonical history. That marks the old target
`concord_superseded_publication_settled` / not applicable, then lets the newer
target proceed. This read-only check does not reset or spend the send budget and
can settle an expired action without executing it. Missing, invalid, noncanonical
or unavailable proof never releases the successor: the old target records
`concord_recovery_awaiting_proof`, and waiting targets report
`concord_waiting_on_prior_publication`. For public pilots, use the supported
[operator recovery procedure](#public-pilot-publication-recovery), not marker
clearing or a guessed successful outcome in SQL. Unknown legacy provenance is
explicitly excluded there, not declared recovered. Read-only recovery uses the
existing maximum retry backoff, not a tight loop.
A failed unban can reconcile for its own waiting relay leg without another
member creating work. An inconclusive upgrade readback preserves the original
pending/acknowledged state and attempts for later guarded observation/retry.
Publication refresh schedules failed receipt work only; it does not move a
pending send's backoff merely because a peer might settle before the claim.

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

The selected capacity contract is a bounded pilot with a durable pause and finite moderation reserve, as described below; no deployment envelope is certified by the implementation alone. The validator
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

Signed manage_moderation_records permits timed hold/release, appeal and eligible explicit lifecycle closure. Separate view_held_evidence permits reasoned audited access; ordinary views never regain expired content. Holds preserve the existing original/selected-edit ciphertext without extending its original expiry. A new hold cannot revive expired evidence. A later hold request on a case with an active hold extends that hold (audited as `hold_extended`), including after the case's natural expiry; it never shortens one, and each request is capped at MODERATION_HOLD_MAX_SECONDS from the request, so renewal past that window is a deliberate, audited staff action. Opening an appeal places or extends a hold on the decision's case to that maximum; an appeal on evidence that has already expired unheld opens without one. The hold outlives the appeal and blocks lifecycle closure until it lapses or staff release it. Held access commits its encrypted access audit before decryption. After relevant holds end, operator cleanup schedules and purges hold/access journals using the approved persisted interval. Legacy holds without such a snapshot cannot invent one.

Use GET /v1/decisions/:id/reversal-context and a NEW POST /v1/decisions/:id/reversals execution/revision to reverse a retained ban after report expiry when either destination verified enforcement or canonical Concord readback settled its publication. The bridge derives the target; Coop supplies the durable new source revision. This creates a fresh configured execution window without recreating report evidence or reopening old Retry. Legacy audit already erased remains unavailable. A relay-only ban with a known-unsent Concord leg can reverse through fresh Concord verification and relay unban. An actually uncertain prior publication remains operator-gated until canonical proof settles it; accepting fresh reversal intent does not bypass that fence or promise immediate release. Deleted-message restoration is unsupported.

A community unban does not send a Discord Guild unban and does not claim the Guild restriction disappeared. Decision status reports a separate restriction observation with checkedAt. POST restriction-refresh and publication-refresh schedule read-only operator proof work and return current status; they do not grant mutation authority, resend an expired action or claim synchronous success. Only verified puppet mapping/binding supplies a Discord identity. Missing historic mapping, permission/rate/transport errors or wrong response identity remain unknown. Only the explicit Discord unknown-ban code proves absence; not_applicable is not successful enforcement.

Explicit closure is available after evidence expiry/deletion for settled actions. Expiry alone never closes audit. Active sanctions, appeals, holds, pending/uncertain effects and live leases block erasure. A continuing ban needs a current verified latest unban, no relay/Concord ban and a fresh independently verified absent Guild restriction when Guild history exists. Observation proof binds stable control/source identity; a new source/control change or pending refresh invalidates it, while unchanged polling timestamps do not. Closure records the approved interval; configuration changes cannot shorten a recorded deadline. Cleanup rechecks eligibility and retains heads, tombstones, immutable execution identity and publication safety references. For recorded Guild history, migration019 also requires a new Discord restriction observation after the audit retention deadline before erasure. A closure-time absence cannot authorize later cleanup. The worker rotates due observations by last-check time so a retained or unknown restriction cannot starve other records. The database guard protects older cleanup code after upgrade; retain it on rollback.

Apply the additive schema with incompatible writers drained. After any lifecycle/hold/reversal/source fence exists, retain its safety records and use a compatible build or roll forward. Never resume audit-at-evidence-expiry cleanup, reset heads, recycle executions, recreate evidence or downgrade to an unfenced writer. Restore the ordering ledgers and execution facts together. Public admission remains closed until a source-matched measured capacity contract and reviewed destination/controller envelope exist; implementation and synthetic calibration do not certify a public launch.


Currently, an open appeal does not independently extend evidence retention
past its timed hold. Staff must renew that hold before it lapses if evidence
must remain; expiry or explicit release can erase the evidence while the
appeal stays open. Held access still requires an active hold. An appeal-based
retention or access override requires a separate policy decision.

When opening an appeal, record its case, actual `holdUntil`, and the staff
owner responsible for renewal in the operational handoff. Schedule that owner's
review before the deadline; confirm a deliberate audited extension or release
before it passes. An open appeal alone is not a reminder or an extension, and
the service does not supply an automatic renewal/alert system.

Post-expiry reversal uses retained community enforcement from Concord or the
Divine relay, not a Discord-only Guild ban as its source. Guild administration
remains separately scoped: adding explicit Guild scope to fresh intent requires
the Guild action permission and a verified mapping. The old decision ID is
provenance, not a promise to selectively undo only that decision's effects.

Legacy holds without an approved policy snapshot do not acquire one merely
because current configuration exists or staff extend the deadline. Their held
access and audit cleanup remain conservatively unavailable until an explicitly
approved reconciliation/migration supplies the missing policy; this release
does not guess it or retroactively expose/erase that evidence.

## Durable public capacity

Mount externally reviewed measurement JSON at MODERATION_CAPACITY_CONTRACT_FILE in the relay plugin, worker, portal and standalone public bridge. MODERATION_SOURCE_SHA is bound to the image build revision; validation compares the contract against that source and the actual native platform. MODERATION_COMMUNITY_ORGS supplies the existing approved organization/community scope. Missing, invalid, mismatched or stale evidence closes new public mutation. Legacy mode keeps its existing behavior. Do not convert synthetic calibration into a launch contract or claim a destination envelope from an emulated build.

The worker observes actual complete history, bytes, rekeys and streams under its operator database authority. The validator can only read the durable018 state; it repeats current counts under the admission policy lock before mutation. Ordinary chat and managed elective control warn at the warning bound and stop at the pause bound. Only already-verified staff deletion, banlist control and rekey authority can use the finite measured reserve; no caller emergency flag exists. Relay-side self-deletions whose every target the member authored, and authenticated guestbook leaves, use that same measured capacity gate after policy admission; ordinary chat, edits and joins remain paused. Exhaustion, unavailable policy and unknown configuration fail closed. A capacity refusal (pause, unknown or missing contract, exhausted reserve) reaches clients as `rate-limited: room is at capacity, try again later`; all other refusals retain the opaque `blocked:` message. Independently authorized external churn remains a controller-model release assumption.

Member self-deletions and leaves newly remain admissible during a capacity pause.
This is a control-history growth gate, not a complete traffic shutdown or a
per-member rate quota. Repeated authenticated leaves do not consume the
control-history reserve, and the gate does not require a prior join for each
leave. They still require policy admission and the measured gate's remaining
bounds; do not interpret the pause as stopping all member writes.
Not consuming history is not a reserve bypass: projected history and in-flight
headroom still count in this conservative measured gate, and zero remaining
headroom refuses even a leave or deletion. `urgentReserve` is a threshold, not
a guarantee that exactly that many further mutations will be admitted. Native
capacity review must account for the actual projection/in-flight margin and
all other measured maxima, not infer an action quota from that field alone.

A pause survives restart, low counts and missing samples. To observe or pause using the existing operator database connection, run `bun packages/moderation/src/capacityOperator.ts observe COMMUNITY_ID` or `bun packages/moderation/src/capacityOperator.ts pause COMMUNITY_ID REASON_CODE`. Explicit resume is `bun packages/moderation/src/capacityOperator.ts resume COMMUNITY_ID ACTOR_ID CONTRACT_HASH` and rechecks the current complete policy, measured contract and counts under the same lock. The read API and validator cannot clear the latch. Apply018 after repeated bootstrap too; its final grants remove broad replayed001 authority.

Capacity metrics contain only aggregate counts/states and observation age. Full settled inner-admission latency is unknown in the counts-only operator snapshot. gate_elapsed_ms is an optional partial monotonic pressure signal through the admission gate, not full latency. Set MODERATION_CAPACITY_TIMING=1 to emit aggregate settled inner-admission timing to plugin stderr for measurement; stdout remains the existing relay decision protocol. Existing SQL1500ms/plugin2000ms/external3000ms fences and commit/cancellation settlement remain mandatory. Neither missing telemetry nor a synthetic timing value is a measured launch proof.

## Public pilot publication recovery

This release supports a fresh, separately scoped **public pilot** community. It
is not an in-place conversion of a private or multiple-community bridge. Those
bridges keep their compatible path. Before admitting a pilot, run:

```
bun packages/moderation/src/publicationOperator.ts preflight COMMUNITY_ID
bun packages/moderation/src/publicationOperator.ts status COMMUNITY_ID
```

Use the existing operator database connection and the single-community
`MODERATION_COMMUNITY_ORGS` mapping. Worker startup performs the same provenance
preflight and invalidates admission policy if it fails. A legacy publication with neither retained signed bytes nor verified structural
metadata, including an identity-less marker, is **excluded**, not declared recovered. Restore authentic original
publication provenance from an existing trusted record/backup, or provision a
fresh separate pilot community and mapping. Preserve the old decisions and audit.
An operator assertion, an ordinary grant revocation, or a root rekey cannot
establish that an unknown delayed edition is impossible; do not clear its marker.
The preflight establishes local publication provenance, not deployment history or
production acceptance.

A pre-023 attempted row may still have authentic bytes but no structural
metadata. Status names it `replay_before_expiry_or_recover_original_event`:
it is eligible while those bytes survive, not guaranteed eligible after they
expire. Preserve authentic original provenance or recover before its execution
window ends. After expiry, missing metadata excludes that community on the next
worker preflight; it is not a reason to extend the payload lifetime or invent
metadata in SQL.

Decision status includes `publicationBlockers`, naming the holding decision,
original event ID when known, recovery version, lease and available recovery
class. This survives the waiting decision's expiry. Use the operator status
command for maintenance, including non-Coop diagnostics.
Status also reports `executionExpiresAt` and `executionWindowExpired` for each
blocker. Assign an operator to inspect exhausted deliveries before that
deadline: an unexpired window is necessary for replay, not sufficient authority
or proof that the old head still permits it. Do not defer an outage handoff
until the retained bytes have already expired.

Proof-only maintenance uses a read-only control snapshot and cannot enable
admission, even when authentic original provenance settles a legacy row. Exact
replay instead checks the whole community's publication provenance before every
installing authority refresh, while holding controller and execution ownership.
It also refreshes the operator capacity observation, preserving the durable
pause and contract hash, and registers stream keys for normal relay auth.
The operator must mount the same reviewed capacity contract/source identity
used by the worker and relay (`MODERATION_CAPACITY_CONTRACT_FILE` and
`MODERATION_SOURCE_SHA`). Missing/changed contracts, unknown capability state,
stale samples and exhausted measured bounds are not waived by recovery.
An eligible pilot can refresh normal admission after an outage or policy expiry;
an excluded community is refused before any installation. Restart the worker
after successful recovery and preflight to resume normal processing.

Stop the community worker before recovery. The command checks both controller
and execution locks; no force option exists. Supply a request JSON file:

```
{"decisionId":"00000000-0000-4000-8000-000000000001","expectedVersion":0,"eventId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","operation":"replay","reason":"Relay restored; replay original publication"}
```

Supply an operator audit identity JSON file with the mapped `orgId`, a nonempty
`actorId`, and permissions `view`, `recover_publication`, and the decision's action
(`ban_member` or `unban_member`). For example (all identifiers synthetic):

```
{"orgId":"synthetic-pilot","actorId":"synthetic-operator","permissions":["view","recover_publication","ban_member","unban_member"]}
```

The local operator database credential is the
command's access boundary; the file records who authorized maintenance. The
mounted member identity must have current community moderation authority;
replay additionally requires current mutation authority over the subject.
Use existing worker provisioning (`MODERATION_COMMUNITY_ENTRY_FILE`,
`MODERATION_MEMBER_KEY`, `MODERATION_LOCAL_RELAY_URL`) plus
`MODERATION_EVIDENCE_KEY` for the encrypted actor/reason audit:

```
bun packages/moderation/src/publicationOperator.ts recover COMMUNITY_ID request.json actor.json
```

`replay` is one deliberate attempt of the **exact retained, unexpired original
signed event**. It never prepares replacement bytes or replenishes the normal
eight-attempt budget. Current authority and the original generation are checked
before sending and after readback. The audit and incremented recovery version
commit before network I/O. Repeating a stale request is refused. An unavailable
relay leaves uncertainty fenced; inspect status and make another deliberate
request using the new recovery version after its lease clears.

Use `operation: "prove"` after expiry, or for a losing generation. The command
first accepts canonical ancestry as a receipt. An owner endorsement of the same
content hash is structural supersession, not the old publisher's applied
receipt. Same-publisher/rumor alternate wraps remain one action. Non-owner
moderators can race on the same logical edition hash; that common intent may
settle only when adding the actual old edition changes no head, ban or ban-time
in a fresh view, the current held view, or the original edition's held view.
This does not claim which carrier/publisher won. If those semantic projections
do not converge, keep the fence and use explicit owner proof where available.

For an expired
legacy row with an ID but no structural metadata, an `originalEvent` object may
be supplied; its signature and exact durable original ID are checked. Relay
absence never releases a fence.

A losing generation can instead be released only with this narrow existing
protocol proof: the canonical banlist history contains an **owner-authored
sibling at the original version and predecessor with the exact original
content hash**, followed by an
**owner-authored canonical head at a strictly greater version**. The command
checks actual kernel folds with the old sibling present for a fresh client,
the bridge's current tracking floor, and a client holding the original
edition's own floor; all must retain the canonical head and member set. This
includes the chain check as well as owner authority, because a greater version
alone does not establish supersession. Owner-authorized publication/advancement
is an external prerequisite, not something this CLI signs or performs. If the
proof fails, do not merely advance a different-content sibling branch: it
cannot connect a client already tracking the original hash. The owner must
endorse the exact authentic original content at its original version and
predecessor, then advance that common hash with a new complete list. Edition
identity hashes exact content bytes but not signer or rumor ID, so this
connects both sibling orders without grinding hashes or changing the kernel.
This connects the lost edition and its exact-content endorsement only. Another
competing content hash at that version can still win the chain walk and make
an advance on the endorsement incomplete. Before any owner-authorized advance,
verify that the served complete history actually connects through the intended
endorsement. Do not advance an incompatible branch merely because its owner
signature passes the authority gate. Any change to those kernel fork/chain
semantics belongs in CORD, not in this maintenance command.
If that content cannot be recovered and verified against the retained hash,
keep the fence and use a fresh separate pilot community. Owner signing remains
an external authorized prerequisite; this CLI never performs it. No
same-community bypass is available.

Before owner proof, inspect the original structural metadata using the existing
operator database access (no publication or key material is needed for this
read):

```sql
SELECT publication_metadata, c.expires_at
FROM moderation.deliveries d JOIN moderation.decisions c USING (decision_id)
WHERE d.decision_id = 'DECISION_ID' AND d.target = 'concord';
```

The endorsement must match the original version, predecessor and content hash.
If content is lost, a non-owner edit made replay stale, or no complete safe
owner branch can be established, keep the fence and use the documented fresh
pilot fallback. Actual replay still requires the original execution window,
an active public source channel and current authority over the target. Proof
does not execute that action: it requires current community moderation
authority, the existing operator/action capability, complete fresh policy and
revocation/rekey fences, but not a historical channel or the target's former
rank. A deleted channel or promoted target therefore does not wedge unrelated
members behind proof that can be safely observed.

A request rejected before its initial proof is established writes no recovery
audit. After the recovery audit/version commits, a later proof/lease failure
does retain that attempt and its lease. Inspect status before retrying; do not
assume every refusal leaves `expectedVersion` unchanged.

Successful owner supersession records `not_applicable /
concord_operator_superseded`. It is **not** proof that the old ban/unban was
applied and does not qualify its relay unban. Submit fresh ordered intent if
that member still needs a change. Later queued members can proceed on the
proved canonical head. A superseded unban's undelivered relay leg is retired
as not applicable in the same lease-fenced completion transaction, without
changing relay enforcement or replenishing attempts. Supersession resolves
publication uncertainty for lifecycle closure, but it is not enforcement
proof: current applied Concord unban (verified send or exact canonical receipt),
verified relay unban, Discord restriction observations,
holds, appeals and independent retention must still satisfy every existing
closure/erasure guard. Recovery actor/reason can then expire with that
decision's audit; immutable opaque recovery ordering remains.

Decisions that expired while waiting are not revived by recovery or by a fresh
community. Submit fresh ordered intent for each member still needing a change.

Exact event IDs and verified structural metadata
(entity/version/predecessor/hash/rumor/signer) survive signed-payload expiry;
actor/reason use existing deliberate lifecycle audit retention. Recovery
ordering records remain immutable. Restart the worker only after inspecting
status and rerunning preflight. Upgrade/rollback must preserve migration 023
and its records; rolling back application code does not erase recovery history.

The released moderation image already contains the CLI at
/app/packages/moderation/src/publicationOperator.ts (the runtime image copies
the whole moderation package). From an approved Linux maintenance host that can
reach the local relay on loopback and the operator database, an explicit image
invocation is:

```
docker run --rm --network host --env-file "$RECOVERY_ENV_FILE" --mount "type=bind,src=$COMMUNITY_ENTRY_FILE,dst=/recovery/community.json,readonly" --mount "type=bind,src=$RECOVERY_REQUEST_FILE,dst=/recovery/request.json,readonly" --mount "type=bind,src=$RECOVERY_ACTOR_FILE,dst=/recovery/actor.json,readonly" --mount "type=bind,src=$CAPACITY_CONTRACT_FILE,dst=/recovery/capacity.json,readonly" --env MODERATION_COMMUNITY_ENTRY_FILE=/recovery/community.json --env MODERATION_CAPACITY_CONTRACT_FILE=/recovery/capacity.json --entrypoint bun "$MODERATION_IMAGE" packages/moderation/src/publicationOperator.ts recover "$COMMUNITY_ID" /recovery/request.json /recovery/actor.json
```

Use the reviewed image digest for `MODERATION_IMAGE`; use absolute, readable
paths for all four mounted files, including the reviewed capacity contract.
The image supplies its build source identity; a checkout invocation must use
the same reviewed source identity and native contract rather than an old image's
measurement. `RECOVERY_ENV_FILE` contains existing
maintenance provisioning, including an operator-role database URL reachable
from that host and `MODERATION_LOCAL_RELAY_URL` reachable on its loopback
interface. It is not a copy of an API-only credential. If running remotely,
establish approved local port forwarding for the relay WebSocket and database
first, then point these two URLs at their forwarded loopback ports. Do not
publish ports or change relay authentication to make recovery work. The same
CLI is supported from a checkout of the reviewed release with Bun 1.3.10 and
`bun install --ignore-scripts --frozen-lockfile`, using
`bun --env-file "$RECOVERY_ENV_FILE" packages/moderation/src/publicationOperator.ts status "$COMMUNITY_ID"`.
The image/network commands above are maintenance instructions; this release
work does not execute them against a deployed service.
