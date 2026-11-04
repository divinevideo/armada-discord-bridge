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

- [x] Bridge reference: generate and verify a signed synthetic invite, control history and chat fixture shared by both clients. Assert actual public channels/stream addresses, banned member and unauthorized-edition rejection.
- [x] Web: verified invite bootstrap, unchanged kernel fold, real catalog and streams, visible acknowledged delivery/reconnect, account isolation. Test the shared fixture and malformed/revoked/unauthorized state.
- [x] Native: implement invite/bootstrap and missing community authority semantics, then integrate catalog with conversation, activity and mentions providers. Test shared vectors, moderation, rekeys, account switching and durable delivery.
- [ ] Release: audit actual backend/Coop state and existing provisioning. Complete concrete deployment prerequisites under the existing platform process before admission.
- [ ] Review: independently review changes, fix findings, run required repository checks, commit and publish reviewable pull requests.
- [ ] Acceptance: prove Discord to both clients and each client to Discord, no duplicate echoes, reconnect/restart, edits/deletes, moderation and exclusion across the approved channel inventory.

## Source delivery checkpoint — November 4

The implementation is tracked in these pull requests. Their current checks and reviewer decisions remain the source of truth for integration readiness:

- [Bridge reference fixtures #5](https://github.com/divinevideo/armada-discord-bridge/pull/5): shared invite/catalog/moderation vectors, exact native fold projections, and signed rotation/dissolution/reopen carriers. The protocol kernel is unchanged.
- [Web integration #759](https://github.com/divinevideo/divine-web/pull/759): verified real community entry, public catalog, acknowledged sends, signed reports and current-authority fences. Hosted lint, typecheck, build and 3,418 tests pass.
- [Native integration #10707](https://github.com/divinevideo/divine-mobile/pull/10707): verified community/session/catalog, moderation/reporting, account-erasure barriers and explicit recovery of retired-epoch pending messages. Independent functional findings are resolved; final repository guard cleanup and hosted validation are in progress at this checkpoint. Delivered chat history from prior root epochs remains outside this implementation; retained own-message drafts can be restored and explicitly re-signed.
- [Capacity contract mount #2403](https://github.com/divinevideo/divine-iac-coreconfig/pull/2403): gives the portal, relay validator and worker the file their existing admission gate reads. This supplies no measurement or capacity certificate. Relevant hosted checks pass.

Bridge source and runtime CI pass at 686cdbb, including all 996 tests with PostgreSQL enabled and no skips. Independent reviews verified the fixture deltas. The production source changes remain unmerged and no live Discord exchange has been claimed.

## Release sequence still required

1. Complete required source reviews and merges. Use the same approved public invite/community and actual channel mapping across both clients and the bridge; exclude Tickets and private support.
2. Publish the verified Coop artifact set through its existing per-run authorization workflow, then use registry manifest digests for the coordinated server/worker/migrator/client rollout. The [build-only run](https://github.com/divinevideo/coop/actions/runs/41767425857) passed for merged source 5cf5a1350dacd348be5ca86c733ea7ca7db73f92; it did not publish images.
3. Complete the production runbook prerequisites: operator-owned, negatively tested acceptance admission; native destination capacity measurements and contract; owner genesis/scoped grants and second-human recovery; effective secret IAM/auditing, alert routing and backup/restore evidence. Names of provisioned secrets do not prove their contents or these outcomes.
4. Platform performs the exact reviewed manual deployment under the selected admission control. Coop staff experience remains with the owner of [issue #24](https://github.com/divinevideo/coop/issues/24).
5. Prove Discord to web/native and each client to Discord, exclusions, no duplicate echoes, restart/reconnect, edits/deletes, reporting and staff ban/unban/retry behavior on the shipped revisions. Complete actual signed-device acceptance before a TestFlight group. Rabble approves final public go-live after the recorded checks pass.

The operational authority is the [production runbook](https://github.com/divinevideo/divine-iac-coreconfig/blob/main/docs/how-to/services/concord-production.md). Production hosts, paths, private provisioning evidence and credentials are not copied into this public plan.

## Workspaces

Bridge worktree is the existing task workspace. Web and native use isolated branches named fix/chat-real-community-20261104. Their shared fixture is test-fixtures/concord/community-interop.json. No production data is included.

Native now has an owner-rooted authority fold verified against shared kernel outputs. Source verification remains distinct from production membership, device and staff acceptance.
