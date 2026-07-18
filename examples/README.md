# Provider examples

Each provider directory contains native Pibox configuration. Run Pi from that directory with `--pibox`, or pass its config path to `/pibox-run --config ...` or `worker_create`.

| Example | Sandbox | Image | Authentication policy |
|---|---|---|---|
| [`microsandbox/`](microsandbox/) | Microsandbox | `ghcr.io/manuschillerdev/pibox-base:bookworm` | Host-side TLS secret substitution with live rotation |
| [`gondolin/`](gondolin/) | Gondolin | Imported `pibox-debian:bookworm` release asset | Host-side HTTP hook substitution with live rotation |
| [`smolvm/`](smolvm/) | smolVM | `ghcr.io/manuschillerdev/pibox-base:bookworm` | Blocked unless `PIBOX_SMOLVM_AUTH_POLICY=guest-environment` is accepted |

From the repository root:

```sh
(cd examples/microsandbox && pi -e ../../src/index.ts --pibox)
```

For Gondolin, first download the release archive matching the host architecture and import it as described in [`../images/README.md`](../images/README.md). Then run:

```sh
(cd examples/gondolin && pi -e ../../src/index.ts --pibox)
```

For smolVM, configure `ghcr.io` under `[images.registries]` with `smolvm config registries init`, reference a `GHCR_TOKEN` environment variable, and then run:

```sh
export GHCR_TOKEN="$(gh auth token)"
(cd examples/smolvm && \
  PIBOX_SMOLVM_AUTH_POLICY=guest-environment \
  pi -e ../../src/index.ts --pibox)
```

The host runtime must be able to pull the GHCR image. For a private package, authenticate Microsandbox with:

```sh
gh auth refresh --hostname github.com --scopes read:packages
gh auth token | msb registry login ghcr.io --username manuschillerdev --password-stdin
```
