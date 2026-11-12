# Provider examples

Each provider directory contains native Pibox configuration. Run Pi from that directory with `--pibox`, or pass its config path to `/pibox --config ...` or `worker_create`.

| Example | Sandbox | Image | Authentication policy |
|---|---|---|---|
| [`microsandbox/`](microsandbox/) | Microsandbox | `ghcr.io/manuschillerdev/pibox-base:bookworm` | Host-side TLS secret substitution with live rotation |
| [`microsandbox/full-stack/`](microsandbox/full-stack/) | Microsandbox with a bind-mounted workspace | Pibox OCI image plus a Compose application | TanStack Start, Quarkus, and PostgreSQL development stack |
| [`smolvm/`](smolvm/) | smolVM | `ghcr.io/manuschillerdev/pibox-base:bookworm` | Blocked unless `PIBOX_SMOLVM_AUTH_POLICY=guest-environment` is accepted |

From the repository root:

```sh
(cd examples/microsandbox && pi -e ../../src/index.ts --pibox)
```

The advanced Microsandbox example runs its complete Compose stack inside the VM:

```sh
(cd examples/microsandbox/full-stack && pi -e ../../../src/index.ts --pibox)
```

Pibox starts Docker and installs the pinned mise tools. Once connected, run `!mise run install` and `!mise run up`.

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
