# Provider examples

Each provider directory contains native Pibox configuration. Run Pi from that directory with `--pibox`, or pass its config path to `/pibox-run --config ...` or `worker_create`.

From the repository root:

```sh
(cd examples/gondolin && pi -e ../../src/index.ts --pibox)
```

Every worker uses Debian Bookworm. Microsandbox and smolVM provision the pinned Node.js and Pi runtime on first boot when the optimized Pibox image is unavailable.

The Gondolin example expects a local Gondolin guest asset tagged `pibox-debian:bookworm`. Build or import it using the commands in [`../images/README.md`](../images/README.md) before starting the worker.

The smolVM example requires the separate `smolvm` CLI. Model authentication is blocked unless `PIBOX_SMOLVM_AUTH_POLICY=guest-environment` is explicitly set.
