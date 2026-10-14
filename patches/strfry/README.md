# Divine community relay build

Upstream: https://github.com/hoytech/strfry/tree/3fd1bc538e5e4dc2d122041064753be0177748b4
(strfry 1.1.1, GPL-3.0).

Apply these patches only to that revision. The build checks the revision and
retains the patched source, submodule sources and upstream LICENSE in the image
at /usr/share/strfry-source. Publish this directory alongside released binaries.
The bridge and moderation application retain their AGPL-3.0 license.

The write hook is mandatory in this build. Plugin failures reject writes and
produce a constant diagnostic without request or response contents. Unused
import/router paths must stay disabled in deployment.

The admission/purge barrier patch holds `/data/admission.lock` from before
validator execution through the writer's LMDB commit. The local purge worker
commits its Postgres tombstone first, then takes that lock, deletes exact
indexed carriers and verifies with a fresh local WebSocket query. All processes
must share the same data volume and UID. Offline import/router/sync commands
are not supported ingestion paths for this build; restoring a database requires
reconciliation against independently recovered policy before the public listener
starts. The recovery policy revision floor must come from the policy backup
record, never from the relay backup being restored.
