# Pibox images

Pibox publishes `ghcr.io/manuschillerdev/pibox-base:bookworm`, a multi-architecture Debian Bookworm OCI image used directly by Microsandbox and smolVM.

The OCI image includes:

- Node.js **26.13.1 LTS**, Pi **1.5.2**, and agent-browser **0.43.0** under `/opt/pibox`;
- mise **2026.11.7**, Docker Engine, its matching CLI, Docker Compose, `iptables`, and `libatomic1`;
- Debian Chromium, its runtime dependencies, Liberation fonts, and Noto color emoji;
- agent-browser's bundled discovery skill at `/root/.agents/skills/agent-browser`, available to isolated Pibox worker profiles.

`AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium` selects the system browser on both architectures; no separate Chrome download is needed. The skill loads version-matched instructions with `agent-browser skills get core`. Chromium runs headlessly; agent-browser disables Chromium's sandbox when running as root, so the VM remains the outer isolation boundary.

Docker is configured with the nested-VM-compatible `vfs` storage driver. Pibox starts the daemon and runs `mise install` when the worker starts. Published image updates apply to newly created VMs, not existing persistent guest filesystems.

## Publishing

Pushing changes to `images/base/` or the publishing workflow on `main`, tagging a release, or manually running `.github/workflows/publish-images.yml` publishes the OCI image for `linux/amd64` and `linux/arm64`.

CI first runs repository tests, type checking, and lint. Each architecture builds on native hardware and must pass a real browser smoke test: Pi skill discovery under an isolated worker profile, local-page navigation, accessibility snapshots, a JavaScript click, and a PNG screenshot. Only after both pass does CI publish the multi-architecture `bookworm` and `sha-<commit>` tags (plus the release tag when applicable).

## Local builds

From the repository root:

```sh
docker build -t pibox-base:bookworm images/base
docker run --rm pibox-base:bookworm node /opt/pibox/image-smoke.mjs
```
