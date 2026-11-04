# Pibox images

Pibox publishes `ghcr.io/manuschillerdev/pibox-base:bookworm`, a multi-architecture Debian Bookworm OCI image used directly by Microsandbox and smolVM.

The OCI image contains the pinned Node.js and Pi runtime under `/opt/pibox`, mise, Docker Engine, its matching CLI, Docker Compose, `iptables`, and `libatomic1`. Docker is configured with the nested-VM-compatible `vfs` storage driver. Pibox starts the daemon and runs `mise install` when the worker starts.

## Publishing

Tagging a release or manually running `.github/workflows/publish-images.yml` publishes the OCI image for `linux/amd64` and `linux/arm64`.

## Local builds

From the repository root:

```sh
docker build -t pibox-base:bookworm images/base
```
