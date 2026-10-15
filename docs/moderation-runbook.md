# Divine public-room moderation

This fork adds relay enforcement and room-scoped Coop actions. It does not retire Discord or replace platform-wide moderation. Deployment and pilot gates are in the [IaC runbook](https://github.com/divinevideo/divine-iac-coreconfig/blob/feat/concord-trust-safety/docs/how-to/services/concord-moderation.md).

## Staff workflow

Reports enter the Room Review queue as opaque case references. The authenticated Coop server fetches verified evidence from the moderation service. The evidence panel displays the author and context, and its expiry; plaintext is not copied into Coop item storage. Ordinary approved reviewers assigned to the queue can remove a reported message. Moderation managers/admins can ban or unban within that community. These actions do not ban an account throughout Divine. Discord guild bans additionally require explicit guild scope and admin authority; they are never implied by a community ban.

After acting, check all three delivery rows: **Divine relay**, **Concord**, **Discord**. Queued/acknowledged is not verified. A verified relay removal means the currently indexed outer carriers were deleted, a fresh local query found none, and durable tombstones reject exact and alternate-wrap replay. Verified Concord delivery means read-back plus authorization folding succeeded. Discord verification requires an exact mapped public message/user and REST read-back; no name matching. Native-only content displays not applicable for Discord.

Use Retry for a failed, unexpired, authorized action with attempts remaining. Keep unresolved delivery failures in escalation; do not interpret a closed review item as successful enforcement. Evidence expiry preserves the delivery record, clears plaintext/audit material and signed pending bytes, and disables further execution. Re-reporting requires live verifiable evidence. The portal's pause control stops a mapping; it does not remove old content or delete the Discord server.

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

Operator metrics contain aggregates only: policy count/revision/age, pending/failed deliveries, oldest pending age, Discord gateway connectivity and relay socket outages. They are internal scrape endpoints, not public portal routes. Never attach report plaintext, credentials, full request payloads or source addresses to monitoring labels or incident comments.
