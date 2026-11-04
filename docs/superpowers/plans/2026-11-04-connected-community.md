# Connected Divine community implementation plan

Goal: Divine web, native Rooms and Discord exchange messages through the same real Concord community and channel mappings.

Architecture: resolve a configured standard Concord public invite, verify its bundle and owner-rooted control state, and derive channels/epochs from that state. The bridge's unchanged concord-core is the protocol reference. Existing signers remain the user identity. Public configuration failures never select synthetic POC keys.

The user approved this direction after the source/live-state investigation. This is implementation authorization; production admission still follows the existing release runbook. One channel proves the first round trip; delivery scope remains all approved public channels, excluding private support and Tickets.

## Constraints

- Preserve kernel authorization and the Armada popup handoff contract.
- No owner private keys in workloads or client configuration.
- Test fixtures contain synthetic identities only.
- Preserve account isolation, failed-send drafts and relay acknowledgement semantics.
- Real room reading requires current authority, channel epochs and moderation handling; connecting a socket is insufficient.
- Do not infer production readiness from local fixtures. Live acceptance includes Discord, web, native and staff moderation.

## Tasks

- [ ] Bridge reference: generate and verify a signed synthetic invite, control history and chat fixture shared by both clients. Assert actual public channels/stream addresses, banned member and unauthorized-edition rejection.
- [ ] Web: verified invite bootstrap, unchanged kernel fold, real catalog and streams, visible acknowledged delivery/reconnect, account isolation. Test the shared fixture and malformed/revoked/unauthorized state.
- [ ] Native: implement invite/bootstrap and missing community authority semantics, then integrate catalog with conversation, activity and mentions providers. Test shared vectors, moderation, rekeys, account switching and durable delivery.
- [ ] Release: audit actual backend/Coop state and existing provisioning. Complete concrete deployment prerequisites under the existing platform process before admission.
- [ ] Review: independently review changes, fix findings, run required repository checks, commit and publish reviewable pull requests.
- [ ] Acceptance: prove Discord to both clients and each client to Discord, no duplicate echoes, reconnect/restart, edits/deletes, moderation and exclusion across the approved channel inventory.

## Current execution

Bridge worktree is the existing task workspace. Web and native use isolated branches named fix/chat-real-community-20261104. Their shared fixture is test-fixtures/concord/community-interop.json. No production data is included.

The native implementation starts with a material missing dependency: it currently folds only self-authored message edits/deletes, not owner-rooted community authority. This work must not report native readiness until that dependency and its integration are complete.
