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
entry points await durable handling before acknowledging stream cursors.

Lease/visibility checks and the synchronous current-fold check run again at the
Discord adapter's final dispatch boundary. Reactions retain their mapping until
removal succeeds; partial message deletes can retry idempotently. A webhook's
Unknown Message response alone does not prove a Discord-origin post is gone:
the bot endpoint must also resolve the fallback.

Ship the additive migration with the worker source through the existing release
process. Local synthetic tests and an isolated database prove source behavior,
not live Discord delivery or production admission readiness.
