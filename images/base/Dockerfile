FROM debian:bookworm-slim

ARG TARGETARCH
ARG NODE_VERSION=24.4.1
ARG PI_VERSION=0.80.8
ARG MISE_VERSION=2026.7.7

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/opt/pibox/node/bin:/opt/pibox/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates \
         curl \
         docker-compose \
         docker.io \
         git \
         iptables \
         libatomic1 \
         xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         arm64) \
           NODE_SHA256=555659c36fc72d0617e278b5d26ffcaebc3760a3de354926b1e5f1b0bfd66083; \
           MISE_ARCH=arm64; \
           MISE_SHA256=1b4ef061d25f0ceb508f11169482f3074e55c1698a1494f666386b2fcfb46b9b ;; \
         amd64) \
           NODE_SHA256=7e067b13cd0dc7ee8b239f4ebe1ae54f3bba3a6e904553fcb5f581530eb8306d; \
           MISE_ARCH=x64; \
           MISE_SHA256=429f71e7e989908bf975aafac9066329c16e2d8fc7cd8e74fdf21dd6300ffe7c ;; \
         *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && NODE_ARCH="$(case "$TARGETARCH" in arm64) echo arm64 ;; amd64) echo x64 ;; esac)" \
    && NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    && curl --proto '=https' --tlsv1.2 -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
    && echo "${NODE_SHA256}  ${NODE_ARCHIVE}" | sha256sum -c - \
    && mkdir -p /opt/pibox/node /opt/pibox/runtime /workspace \
    && tar -xJf "$NODE_ARCHIVE" --strip-components=1 -C /opt/pibox/node \
    && rm "$NODE_ARCHIVE" \
    && npm install --global --prefix /opt/pibox/runtime --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force \
    && curl --proto '=https' --tlsv1.2 -fsSL \
         "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${MISE_ARCH}" \
         -o /tmp/mise \
    && echo "${MISE_SHA256}  /tmp/mise" | sha256sum -c - \
    && install -m 0755 /tmp/mise /usr/local/bin/mise \
    && rm /tmp/mise \
    && mkdir -p /etc/docker \
    && printf '{\n  "storage-driver": "vfs"\n}\n' > /etc/docker/daemon.json \
    && node --version \
    && pi --version \
    && mise --version \
    && docker --version \
    && docker-compose --version

WORKDIR /workspace
