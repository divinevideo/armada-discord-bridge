# Concord deletion delivery

A Discord copy is removed only under the current client rule: self-deletion,
or `citationSatisfied` together with `canActOnMember(..., MANAGE_MESSAGES)`.
A permission bit alone is insufficient. Discord-origin target authors resolve
through the link's puppet identity; reaction scope comes from its parent message
mapping. Tenant, community, Concord channel, Discord guild and Discord channel
must match. Current control authority, epoch retirement, visibility and lease
checks still apply at the adapter's final dispatch boundary. Replay does not
change the shared concord-core authorization rules.

## Finite unresolved evidence and durable accepted actions

The durable queue contains minimal verified deletion metadata: actor, target,
citation and source provenance, never message content, private keys or invites.
Unresolved evidence has its own allocation of 4096 records per link and 1024 per
actor. It expires seven days after the earliest of the verified outer carrier's
creation time, first observation and current time. Replaying that retained row
or source carrier does not renew the deadline. Future-dated unresolved carriers
are disposed of explicitly. Expiry and unresolved overflow are aggregate policy
dispositions, not delivery gaps; earlier work is not evicted to admit new work.

This is a finite opportunity for a target mapping and sufficient current
authority to become available. There is no perpetual first-seen tombstone per
inner rumor: a fresh valid rewrapping after expiry is a new observation that may
be admitted. An old retained carrier can also become actionable on restart if
its target and current authority are now available, even if its earlier
unresolved evidence expired. That does not renew unresolved quarantine.

Once a mapped deletion is accepted as actionable, it uses a separate allocation
with the same 4096/link and 1024/actor caps. Accepted actions never silently
expire or downgrade when authority is lost. Current authorization gates every
attempt; permission failures and transient database/Discord failures leave
accepted work durable. Successful/idempotent completion and verified permanent
inapplicability can remove records. Uncited unresolved actions are removed once
the mapped target establishes they are neither owner nor author; cited denials
can be reevaluated while their unresolved retention remains valid.

Retries run at startup, control folds, target mapping arrival and bounded
scheduled due-work scans. Batches handle at most 128 due records; failed work
backs off from ten seconds to one hour, and wakeups coalesce. A full actionable
allocation or failed durable intake/promotion raises a typed gap and pins
certified progress while accepted work drains. Resolve capacity, storage or
permissions; manually advancing progress would discard the recovery obligation.
The caps bound pending allocations, not lifetime mapping storage.

## Lifecycle and crash recovery

A lifecycle belongs to the complete link scope and owner. Persisted worker
session/generation, lifecycle epoch/version and the current lease resource,
holder and token fence mutations. Lease validity is checked inside the locked
transaction, including after awaited work. Checkpoint compare-and-set cannot
certify a newer gap or changed stream/relay inventory. Final external dispatch
also checks current authority; a preflight check alone is insufficient.

Before any active producer attaches, the worker arms durable uncertainty. The
marker is never cleared in this release. Each replacement attachment therefore
enumerates retained deletion history from second zero, even if an older worker
committed a checkpoint after a later gap write failed. This conservative policy
can require scanning the full retained encrypted history on every attachment.
It does not recreate keys or carriers that are no longer available.

Enumeration start and deletion applicability are separate. `deletion_floor`
records the activation second for a genuinely fresh or explicitly relinked
lifecycle. Live intake and replay exclude deletion carriers whose verified
outer timestamp precedes that floor, even when enumeration starts at zero.
The boundary is inclusive. This source-clock policy also excludes a carrier
received later if its signed timestamp predates activation. Unknown legacy or
intermediate lifecycle provenance retains floor zero; erased provenance cannot
be reconstructed. A terminated lifecycle's accepted actions are not inherited
by a new lifecycle, even when old message mappings survive.

Upgrade eligibility is snapshotted once and consumed only by authorized
activation. Eligible existing links inherit the lowest available legacy or
checkpoint floor and retain each stream's own completed-through boundary.
A legacy cursor completes its boundary second; a recovery floor starts with
that second. Only verified streams use their corresponding saved boundaries.
Future legacy watermarks are capped below activation. Ordinary older messages
and reactions are suppressed at their own completed boundaries while deletion
recovery remains independent. Newly discovered streams use the retained
recovery floor; current-stream coverage and preserved ordinary coverage prevent
historical ordinary traffic from being sent again after relay changes.

Fresh links start at activation rather than inheriting arbitrary legacy cursors.
Pause/resume preserves the lifecycle and accepted work. Automatic network failure
or reversible ban/refounding severance suspends and retains state for recovery.
Explicit unlink terminates the lifecycle, removes its pending actions, retired
reaction evidence and checkpoint, and fences stale worker views before cleanup.
A later explicit relink establishes a fresh epoch and applicability floor.

## Certified replay and bounds

Every configured delivery relay must pass the existing public-host validation
and independently provide strict NIP-77 inventory enumeration and exact-ID
fetches. An empty configured list uses a vetted fallback list; an invalid,
unavailable or unsupported configured source is never silently dropped.
Bootstrap discovery is separate from delivery coverage. No uncertified REQ/EOSE
fallback currently establishes completeness.

Before each runtime payload replay, the coordinator requires complete retained
control inventory from every configured source through the same authenticated
per-relay enumeration and exact-ID fetch primitives. Control editions determine
which payload streams exist; a stable partial fold or successful capped control
REQ does not prove that set complete. Control discovery has no settled-time or
future outer-timestamp cutoff: a future-dated edition can reveal a stream with
past payloads. Both runtime entry points use this shared discovery prerequisite. Startup also
requires complete discovery before public/readable channel classification and
key-intake authorization, and repeats it after learning private-channel keys.

The control fold retains at most 16,384 unique wraps and 16 MiB of encoded event
bytes per worker, including standing-subscription arrivals. Complete discovery
has a five-minute deadline and fetch batches of at most 100. Source inventory
limits split historical intervals oldest first. An oversized second or
unbounded future tail fails explicitly; no source or matching time range is
silently omitted. Failed discovery retains recovery from zero and retries.
A newly received control wrap invalidates the captured discovery context even
before the batched live refold runs. Certification also checks the same worker,
relay and stream context after awaited work.

A run freezes its settled upper bound at run-start seconds minus 60. It first
requests the full remaining interval, bisecting only when inventory, sync or
decoded resource limits require it, oldest interval first. The union is bounded
at 16,384 IDs per window and decoded payload estimates at 16 MiB. Outstanding
IDs are fetched in batches of at most 100 independently from every source,
including sources whose REQ responses are capped below the requested size.
A disappearing advertised carrier causes one fresh reconciliation; repeated
missing IDs remain incomplete. An oversized one-second interval fails closed.
Transport sessions, callbacks and replay waits have resource/time/abort bounds;
a replay attempt has a five-minute deadline.

Payload callbacks receive bounded batches, followed by a separate completed
window callback only after all payload handling settles. Only that interval
endpoint certifies progress, including empty intervals. Neither the newest live
carrier nor a future timestamp acknowledges history. An incomplete historical
prefix resumes at its exact next second. A settled tail instead overlaps
`max(0, (certified_until ?? activation_floor) - 60)`; discovered streams can
lower the start through their recovery/legacy boundaries. An existing repair
floor is used directly, without repeatedly subtracting the tail overlap.

One serial link lane admits at most 200 durable wraps including in-flight work;
typing is coalesced separately. Live overflow, relay interruption or a stream
change marks a recovery gap. Live dedupe cannot suppress deletion replay.
Incomplete repair can coexist with best-effort live traffic, but never claims
complete history. Shutdown aborts producers/replay, bounds draining and leaves
uncertainty for the successor; cancellation cannot undo an already dispatched
external operation, so late work remains fenced.

Within each decoded window, rumor time orders candidates with a deterministic
carrier tie break. Windows follow outer carrier time. Equivalence to a complete
online history is therefore bounded by available retained carriers/keys,
current authority and mappings, resource limits, and the 60-second
lateness/backdating assumption. Arbitrarily backdated arrivals beyond the
settled overlap, malicious withholding, purged relay history, lost keys and
pre-migration fire-and-forget loss are not guaranteed recoverable. This is not
an infinite storage or loss-free delivery guarantee.

## Mapping evidence and operator inspection

Reactions retain their active mapping until removal succeeds. Retired reaction
rows preserve scoped parent/author evidence atomically with active mapping
removal, independently of pending-action expiry. They stay outside active
Discord reaction lookups; replay cannot resurrect a retired reaction or remove
a newly added one. Message mappings and retired evidence have their own lifetime
and disk cost rather than the pending queue's seven-day retention. Explicit
unlink clears the scoped retired evidence; message mappings may survive.
Partial message deletes retry idempotently. A webhook's Unknown Message response
alone does not prove a Discord-origin post is gone: the bot endpoint must also
resolve the fallback.

`scripts/probe-backlog.ts <bridge-id> [...]` uses the operator's existing
`DATABASE_URL` and `PORTAL_SEAL_KEY`. It reads persisted full-scope lifecycle,
upgrade and legacy-checkpoint metadata under a read-only transaction and a
read-only database connection. It never opens/arms a worker, consumes eligibility,
expires pending records or advances checkpoints. Missing lifecycle state is
reported as unknown history requiring upgrade/activation, not as live-only or
complete. A persisted uncertainty marker selects zero for the replacement scan
without changing the lifecycle's deletion applicability floor.

Probe control discovery requires successful REQ responses from every configured
source before payload replay; a failed source is not hidden by later successful
history enumeration. These control REQs may still be capped: their EOSE does
not certify that all control editions or held stream keys were discovered.
The report therefore always exposes `streamInventory: uncertified_control_req`
and `scanComplete: false`. `discoveredStreamsScanComplete` describes only the
payload inventory for the discovered stream set; it cannot certify the stream
set itself. An otherwise completed scan reports `stream_inventory_uncertified`.

The probe streams decoded candidate counts by kind (message, deletion, reaction,
typing and other). It does not apply lifecycle/ordinary boundaries, current
router authorization, mapping dedupe or no-op handling to predict Discord posts.
It processes at most 65,536 decoded candidates, 4096 completed windows and a
60-second scan deadline per link, using the same bounded replay implementation.
A stopped/failed scan reports incomplete status and only its observed completed
prefix separately from the persisted checkpoint. Partial-window candidate counts
may exceed that prefix. Even a completed scan of discovered streams describes only their retained
inventory through its frozen upper bound, not a complete stream inventory or
end-to-end delivery readiness.
Errors use fixed reason codes without arbitrary source text; timestamps are
seconds converted to milliseconds for display. Imports do not execute the CLI.

Ship the additive migrations with the workers through the existing release
process; do not edit applied migrations or repair history by deleting queue
rows. Local synthetic tests, disposable PostgreSQL and isolated relay wire
fixtures prove the tested contracts, not production relay coverage or actual
Discord admission and effects.
