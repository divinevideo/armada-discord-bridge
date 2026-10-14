FROM ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401 AS strfry-build
RUN apt-get update && apt-get install -y --no-install-recommends git g++ make pkg-config libtool ca-certificates patch libssl-dev zlib1g-dev liblmdb-dev libflatbuffers-dev libsecp256k1-dev libzstd-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git init && git remote add origin https://github.com/hoytech/strfry.git && git fetch --depth=1 origin 3fd1bc538e5e4dc2d122041064753be0177748b4 && git checkout --detach FETCH_HEAD && test "$(git rev-parse HEAD)" = 3fd1bc538e5e4dc2d122041064753be0177748b4 && git submodule update --init --recursive
COPY patches/strfry/0001-policy-boundary.patch patches/strfry/0002-connection-diagnostics.patch /patches/
RUN patch -p1 < /patches/0001-policy-boundary.patch && patch -p1 < /patches/0002-connection-diagnostics.patch && make setup-golpe && make -j2
COPY patches/strfry/0003-admission-purge-barrier.patch /patches/
RUN patch -p1 < /patches/0003-admission-purge-barrier.patch && make -j2
RUN mkdir -p /source && git ls-files --recurse-submodules -z | tar --null -T - -cf /source/strfry-source.tar && cp LICENSE /source/LICENSE

FROM oven/bun:1.3.10-slim@sha256:5d5863f35ad9b3acceee8dc134fb2b89f07831129eaeec81af2b19a23dabe3e0 AS bun
FROM ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401 AS relay
ARG VCS_REF
LABEL org.opencontainers.image.source="https://github.com/divinevideo/armada-discord-bridge" \
      org.opencontainers.image.revision=$VCS_REF \
      org.opencontainers.image.licenses="AGPL-3.0-only AND GPL-3.0-only"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates liblmdb0 libssl3 zlib1g libsecp256k1-0 libzstd1 libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN useradd --uid 10001 --create-home relay && mkdir -p /data/db /opt/divine && chown -R 10001:10001 /data /opt/divine
WORKDIR /opt/divine
COPY package.json package-lock.json ./
COPY packages/concord-core/package.json packages/concord-core/package.json
COPY packages/bridge/package.json packages/bridge/package.json
COPY packages/portal/package.json packages/portal/package.json
COPY packages/moderation/package.json packages/moderation/package.json
RUN bun install --ignore-scripts --frozen-lockfile --production
COPY packages/concord-core packages/concord-core
COPY packages/moderation packages/moderation
COPY packages/bridge/src packages/bridge/src
COPY --from=strfry-build /build/strfry /usr/local/bin/strfry
COPY --from=strfry-build /source /usr/share/strfry-source
COPY docker/relay-policy.sh /usr/local/bin/relay-policy
RUN chmod 0755 /usr/local/bin/relay-policy
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/strfry"]
CMD ["--config=/data/strfry.conf", "relay"]
