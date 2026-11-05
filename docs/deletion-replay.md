# Concord deletion delivery

A Discord copy is removed only under the current client rule: self-deletion,
or `citationSatisfied` together with `canActOnMember(..., MANAGE_MESSAGES)`.
A permission bit alone is insufficient. Discord-origin target authors resolve
through the link's puppet identity; reaction scope comes from its parent message
mapping. Tenant, community, Concord channel and Discord channel must match.

Migration `019_pending_concord_deletes.sql` adds a durable queue of minimal
verified deletion metadata. It stores actor/target identifiers and the grant
citation, never content, private keys or invite material. Future citations and
unknown mappings stay pending across cursor advancement and worker restart.

Outstanding records are bounded at 4096 per link and 1024 per actor. Enqueue is
atomic and deduplicated: capacity refusal never evicts earlier work or partially
accepts a deletion. A failed nondurable write pins cursor advancement until a
restart/catch-up; resolve storage or capacity first and do not manually advance
the cursor to silence the failure. Actions without a non-owner citation are
removed once their mapped target proves they are neither owner nor author.
Cited denials remain eligible for reevaluation under later current authority.

Workers retry at startup, on control folds, when target mappings appear, and
every ten seconds. Periodic/fold retries share the normal channel effect lane,
coalesce overlapping notifications, and rotate through at most 128 records per
batch so a denied prefix cannot starve a later satisfied citation. Both dispatch
entry points await durable handling before acknowledging stream cursors. Live
subscriptions admit at most 200 wraps, including the in-flight delivery, before
constructing their promise chain. Overflow is refused synchronously and pins
the client’s cursor acknowledgements across all later subscriptions so a fresh
live-tail REQ cannot hide the replay gap. Only restart followed by successful
catch-up can restore acknowledgement. Migration `021_channel_delivery_checkpoints.sql`
stores progress for the full tenant/community/Concord-channel/Discord-guild/
Discord-channel link, independent of changing stream keys. Workers persist its
initial floor before admitting routed live work; legacy per-stream progress is
inherited at the lowest existing watermark. Fresh links start at the current
live-tail floor. Ordinary mirror send failures warn and continue, including the
portal missing-permission alert, without poisoning deletion durability.

Catch-up reads all configured relays and splits saturated 500-wrap time windows
into disjoint smaller windows, delivered oldest-first. Each fully handled batch
commits its own checkpoint before reading later work, so a crash or failure can
resume from the last complete batch. Streaming worker callbacks retain only the
current bounded batch; they do not collect the whole backlog. Same-second ties
expand only that second’s query, up to a 16,384-wrap query ceiling; Nostr has no
within-second offset. A still-saturated second fails closed before its checkpoint
advances. Incomplete catch-up keeps the worker serving live best-effort traffic
with cursor writes disabled and retries every ten seconds; overlapping retries
coalesce. Fix the unavailable relay or excessive same-second bucket instead of
manually moving the checkpoint past unprocessed work.

Lease/visibility checks and the synchronous current-fold check run again at the
Discord adapter's final dispatch boundary. Reactions retain their active mapping until
removal succeeds. Migration `020_retired_concord_reactions.sql` then preserves
scoped target evidence atomically with active mapping removal. This evidence
outlives pending-action cleanup, so crash replay and later distinct deletions
can resolve the original author without removing a newly added reaction. Retired
rows remain outside active Discord reaction lookups, and old reaction rumor
replays cannot resurrect them. Like message mappings, this target evidence is
retained independently of the bounded pending-action queue. Partial message
deletes can retry idempotently. A webhook's
Unknown Message response alone does not prove a Discord-origin post is gone:
the bot endpoint must also resolve the fallback.

Ship all three additive migrations with the worker source through the existing release
process. Local synthetic tests and an isolated database prove source behavior,
not live Discord delivery or production admission readiness.
