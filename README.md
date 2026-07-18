# Pibox

Pibox is a Pi extension that creates complete Pi RPC workers in Microsandbox, Gondolin, or smolVM sandboxes. Sandbox configuration stays provider-native; Pibox owns only worker naming, bootstrap, RPC, authentication, and cleanup.

## Requirements

- Node.js 23.6.0 or newer
- one supported sandbox runtime:
  - Microsandbox 0.6.6;
  - Gondolin 0.12.0 with its host virtualization requirements;
  - smolmachines 1.6.6 plus a compatible `smolvm` CLI for duplex processes
- at least one model credential in the host Pi profile

```sh
npm install
npm run typecheck
npm run lint
```

## Quick start

Install dependencies, choose a provider example, and start Pi with the Pibox extension:

```sh
npm install
(cd examples/microsandbox && pi -e ../../src/index.ts --pibox)
```

`--pibox` reads `pibox.toml` from the current directory, creates the configured worker, and routes normal prompts and user bash commands to it. Remove the worker with `/pibox-rm`.

Alternatively, start Pi without creating a worker and use the commands interactively:

```sh
pi -e ./src/index.ts
```

```text
/pibox-run --config examples/gondolin/pibox.toml
/pibox-rm <worker-name-shown-at-startup>
```

For repeated local use, `pi install .` loads the package without `-e`, so `pi --pibox` is sufficient.

## Configuration

Pibox loads `pibox.toml` from the current directory unless a command or tool supplies another path.

```toml
provider = "microsandbox"

[pibox]
name = "pibox-demo"
nameSuffix = "worktree"
workdir = "/workspace"

[sandbox]
image = "ghcr.io/manuschillerdev/pibox-base:bookworm"
ephemeral = true
replace = true
```

`provider` must be `microsandbox`, `gondolin`, or `smolvm`. `[pibox]` controls the worker name and guest working directory. `[sandbox]` is passed unchanged to the selected adapter and uses that provider's native names, units, and structures.

Pibox's bootstrap expects Debian slim. The published base image includes the pinned Node.js and Pi runtime under `/opt/pibox`; Pibox verifies it and provisions the same runtime with `apt-get` when it is absent. It writes the guest extension and auth file through stdin and starts Pi in RPC mode. See [`examples/`](examples/) for each provider.

## Images

Pibox publishes one multi-architecture Debian OCI image for Microsandbox and smolVM, plus architecture-specific Gondolin guest assets derived from that OCI image. Gondolin assets must be imported into its local image store as `pibox-debian:bookworm` before using the Gondolin example. Build, publishing, and installation commands are in [`images/README.md`](images/README.md).

## Start and communicate

Start Pi with the configured worker already selected:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/profiles/pibox-controller" pi --pibox
```

Interactive commands:

- `/pibox-run` creates a worker and routes prompts to it.
- `/pibox-leave` disconnects and stops the routed worker.
- `/pibox-leave --keep-running` disconnects without stopping it.
- `/pibox-enter [worker]` routes input to an active in-process worker.
- `/pibox-stop [worker]` stops an active worker.
- `/pibox-rm [worker]` stops and removes an active worker.

Model-facing tools retain their worker names: `worker_create`, `worker_prompt`, `worker_state`, `worker_steer`, `worker_abort`, `worker_set_model`, and `worker_remove`.

## Authentication

Credential discovery remains in the worker layer. Provider adapters install credentials according to their native security model:

- **Microsandbox:** TLS secret substitution with live rotation.
- **Gondolin:** `createHttpHooks()` placeholder substitution with live updates.
- **smolVM:** blocked by default because the real token enters the guest process environment. To explicitly accept that weaker policy, set `PIBOX_SMOLVM_AUTH_POLICY=guest-environment`. Pibox then passes host environment references through `smolvm machine exec --secret-env`; it does not write the token to the guest auth file.

The local smolmachines SDK does not apply `MachineConfig.image` to the persistent guest rootfs. The smolVM adapter therefore uses the CLI consistently with the opaque `[sandbox]` table serialized as a Smolfile, preserving a Debian image-backed machine for creation, lifecycle, and raw duplex execution. Do not add `-t`; Pi RPC requires unmodified pipes.

See [`docs/typescript-extension-auth-relay.md`](docs/typescript-extension-auth-relay.md) for the architecture and verification matrix.
