# Pibox images

Pibox publishes two image families from one Debian Bookworm userspace definition:

- `ghcr.io/manuschillerdev/pibox-base:bookworm` is a multi-architecture OCI image used directly by Microsandbox and smolVM.
- `pibox-gondolin-aarch64.tar.gz` and `pibox-gondolin-x86_64.tar.gz` are Gondolin guest assets derived from that OCI image.

The OCI image contains the pinned Node.js and Pi runtime under `/opt/pibox`. Pibox verifies those versions at startup and provisions them only when a compatible prebuilt runtime is absent.

## Publishing

Tagging a release or manually running `.github/workflows/publish-images.yml` publishes the OCI image and builds both Gondolin architectures. Tagged runs also attach the Gondolin archives to the matching GitHub release.

## Installing Gondolin assets

Download the archive matching the host architecture, extract it, and import it into Gondolin's local image store:

```sh
tar -xzf pibox-gondolin-aarch64.tar.gz
npx gondolin image import ./pibox-gondolin-aarch64 --tag pibox-debian:bookworm
```

Use `pibox-gondolin-x86_64.tar.gz` on x86-64 hosts.

## Local Gondolin builds

On macOS, install the asset-builder prerequisites with Nanobrew:

```sh
nb install e2fsprogs lz4
```

Build and import the native architecture:

```sh
npx gondolin build \
  --config images/gondolin/aarch64.json \
  --output ./dist/pibox-gondolin-aarch64 \
  --tag pibox-debian:bookworm
```

Use `images/gondolin/x86_64.json` on x86-64 hosts.

Gondolin 0.12 uses its Alpine-based boot-asset pipeline for kernel and initramfs construction. The VM root filesystem and package environment come from the Pibox Debian OCI image.
