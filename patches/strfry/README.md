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
