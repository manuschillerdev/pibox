FROM debian:bookworm-slim

ARG TARGETARCH
ARG NODE_VERSION=26.13.1
ARG PI_VERSION=1.5.2
ARG MISE_VERSION=2026.11.7
ARG AGENT_BROWSER_VERSION=0.43.0

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/opt/pibox/node/bin:/opt/pibox/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates \
         chromium \
         curl \
         fonts-liberation \
         fonts-noto-color-emoji \
         docker-compose \
         docker.io \
         git \
         iptables \
         libatomic1 \
         xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
         arm64) \
           NODE_SHA256=89e1853138db51e8b82d3e98ba9c0d3f2956a28e5e55ea1b7e12d25aae92d5dd; \
           MISE_ARCH=arm64; \
           MISE_SHA256=e4392a51b1b99107b3dd0c8c1b1efa737b614e15950af34921067ce829929af8 ;; \
         amd64) \
           NODE_SHA256=5c063e46bab0fbc1c17cc445d7ff129cbdcd0471be6ed83b6ab864f8143bc864; \
           MISE_ARCH=x64; \
           MISE_SHA256=8f5426d9971eaf713b37509749174ca69cf2f08b8b25e389168dcfcab9cd1a4d ;; \
         *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && NODE_ARCH="$(case "$TARGETARCH" in arm64) echo arm64 ;; amd64) echo x64 ;; esac)" \
    && NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    && curl --proto '=https' --tlsv1.2 -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" \
    && echo "${NODE_SHA256}  ${NODE_ARCHIVE}" | sha256sum -c - \
    && mkdir -p /opt/pibox/node /opt/pibox/runtime /workspace \
    && tar -xJf "$NODE_ARCHIVE" --strip-components=1 -C /opt/pibox/node \
    && rm "$NODE_ARCHIVE" \
    && npm install --global --prefix /opt/pibox/runtime --no-audit --no-fund \
         "@earendil-works/pi-coding-agent@${PI_VERSION}" \
         "agent-browser@${AGENT_BROWSER_VERSION}" \
    && mkdir -p /root/.agents/skills \
    && ln -s /opt/pibox/runtime/lib/node_modules/agent-browser/skills/agent-browser /root/.agents/skills/agent-browser \
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
    && docker-compose --version \
    && chromium --version \
    && agent-browser --version \
    && agent-browser skills get core >/dev/null \
    && test -s /root/.agents/skills/agent-browser/SKILL.md

COPY smoke.mjs /opt/pibox/image-smoke.mjs

WORKDIR /workspace
