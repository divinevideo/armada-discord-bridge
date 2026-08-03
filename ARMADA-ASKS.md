# Armada-side work that would improve the bridge

Friction the bridge cannot solve alone. Each item names the problem as it
shows up in this repo and the Armada-side change that would fix it.
Companion to `BRIDGE-IMPROVEMENTS.md`, which covers the reverse: bridge
work Armada already supports.

## High value

### 1. Native threads
The bridge ignores Discord threads and forum channels entirely
(`ChannelType.GuildText` only), because there is nothing to map them to:
kind 1111 comments flatten into the channel stream. A real thread or
topic container in the client (and a convention for it in the protocol)
would let thread-heavy servers import without losing structure. This is
the largest fidelity gap left.

### 2. Bridged-identity presentation and claim handoff
Puppet npubs look like ordinary members. The client could read the bot
manifest (kind 10304) or a puppet marker and label them "via Discord",
which sets honest expectations about DMs and zaps to a custodial key.
The bigger ask: a protocol-level claim attestation, so when a Discord
user claims their npub the client shows their imported history as theirs
instead of leaving it attributed to a now-orphaned puppet.

### 3. Imported-history semantics
History backfill publishes thousands of backdated messages in minutes.
Clients need a defined behavior for that: honor the original `ms` for
ordering (works today), but suppress unread badges and notifications for
messages older than the member's join, and ideally show an "imported
from Discord" affordance sourced from the NIP-48 proxy tags the bridge
already attaches. Without this, joining a freshly imported community can
mean a wall of stale unreads.

### 4. Severance and rekey signals the bridge can act on
Ban, kick, Refounding, and dissolution all look different on the wire
(kinds 3309, 3303, 3308 vsk 10) but the operator experience depends on
Armada emitting them consistently and documenting the expected client
reaction. The bridge wants to say "this community revoked access" rather
than "severed"; it can only be as precise as the signals it receives.

### 5. A way to grant a bot/bridge npub a channel key without a human
Adding the bridge to a Private Channel means a person opening Armada and
granting its npub the channel's Role, which vends the key as a Direct
Invite. That works (the bridge takes delivery of it), but it makes every
gated room a manual step, and there is no way for the portal to ask on the
operator's behalf. A capability an owner could delegate once — "this npub
may be vended keys for channels it is granted" — would let the import wire
private channels end to end instead of stopping at the structure.

## Nice to have

- Ephemeral rendering: typing (23311) and voice presence (23313) only
  pay off if clients display them; confirm rendering before the bridge
  publishes typing events.
- Custom emoji everywhere: the import packs guild emoji, and NIP-30 tags
  cover messages, but reactions with custom emoji still degrade; a
  client-side emoji-pack picker would close the loop.
- Media parity: BUD-04 mirroring across more than one Blossom server
  would make rehosted attachments durable; today one server holds every
  bridged file.
- Webhook-persona equivalents: Discord lets the bridge restyle name and
  avatar per message. On the Armada side the same effect needs one
  keypair per Discord user (the puppet scheme). A lighter display-name
  override on kind 9, honored by clients for marked bridge accounts,
  would shrink key sprawl for large guilds.
- Zap routing for custodial identities: zaps to puppet npubs go to keys
  the portal holds. A client affordance that redirects zaps for claimed
  accounts to the claimant's wallet would stop value landing in escrow
  nobody watches.
