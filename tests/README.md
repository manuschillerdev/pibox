# Tests

Install the pinned npm dependencies with `npm ci`. Unit regressions need no VM or credentials:

```sh
npm test
```

They cover model-selection ordering, handled prompts and cancellation/draining, current-turn assistant results/errors, safe model-catalog serialization, enforced deadlines, late provisioning cleanup and stalled Git identity lookups.

## Interactive thinking

```sh
node --test tests/interactive-thinking.test.mjs tests/interactive-bridge.test.mjs tests/worker-behavior.test.mjs
```

The JSONL fixture exercises the real `PiRpcClient`, `Worker`, interactive bridge, and Pi custom-entry renderer without a VM, credentials, or provider calls. It verifies host thinking-level synchronization, ordering after model selection, streaming and final rendering across tool turns, failed-retry exclusion, and explicit sync failures. To exercise another installed Pi version's entry renderer and theme, set `PIBOX_TEST_PI_ROOT` to its `@earendil-works/pi-coding-agent` package directory.

## Cache deduplication integration tests

```sh
npm run test:cache
```

Requires a working Microsandbox runtime and network access for cold npm, pnpm and Node downloads. The default image is pinned to an **amd64 manifest digest**, not the mutable `bookworm` tag. For another architecture, set `PIBOX_TEST_IMAGE` to a compatible immutable `repository@sha256:...` reference. Reports record the image digest, platform, SDK and guest Node/npm/mise versions.

The harness runs the actual cache resolver and Microsandbox adapter with temporary Git repositories, a linked worktree, isolated cache directories and disposable VMs. Git configuration, hooks, signing and repository-routing environment variables are isolated from the host. No model or credentials are used.

| Scenario | Evidence required |
| --- | --- |
| VM recreation | Install `is-number@7.0.0`, remove the VM, install in a fresh VM with `npm --offline`, execute the package. |
| Linked worktrees | Same resolved cache mounts; pinned pnpm 10.13.1 must resolve its store under the mounted directory; offline npm and pnpm installs in fresh projects; Node reuse must execute the cached binary, verified with `process.execPath`, version, inode, size, mtime and SHA-256. |
| User scope | Unrelated repositories resolve identical mounts; cold installation in one VM followed by offline installation in another. |
| Repository isolation | Unrelated repositories resolve different mounts; offline installation in the empty repository cache must fail with `ENOTCACHED`. |
| Concurrent reuse | Two VMs install npm/pnpm packages concurrently and execute the cached Node binary; `npm cache verify` succeeds and installed-tool metadata is unchanged. |

An online curl control must succeed before the network-disabled consumer's probe is checked. The offline probe must fail with a connection/DNS/timeout error; a missing tool, TLS failure or HTTP error is not accepted as network isolation.

Creation, commands, Git identity lookups and cleanup have rejecting deadlines. SIGINT/SIGTERM interrupt pending operations and initiate bounded cleanup. Attempted VM names and pending creation promises are tracked before creation. A creation that cannot be cancelled must settle before caches can be deleted; late success triggers removal. Cleanup failures fail the run and retain/report cache directories instead of deleting files used by a remaining or still-provisioning VM. Finalization errors are recorded before evidence publication. Hard process termination or runtime failure can still require manual removal of reported `pibox-dedup-*` VMs.

## Evidence reports and limits

Each run writes a unique JSON report outside the repository, including failed/interrupted runs. Set `PIBOX_TEST_REPORT=/absolute/path/evidence.json` to select a CI artifact path; its parent directory must exist. The report is initialized as `running` and becomes `passed` only after successful scenarios and cleanup. Do not commit machine-specific generated reports.

Reports include source hashes, shared mount paths, executable identity, content hashes, metadata fingerprints and file allocation counts. Allocation sums use `st_blocks * 512` once per unique file inode, excluding directories. These are not physical-device savings measurements: filesystem compression, reflinks and snapshots are not accounted for.

These tests establish package-download and installed-tool reuse, **not** shared project `node_modules`, arbitrary build outputs, simultaneous first-time mise installations, reduced RAM/CPU consumption or universal resource efficiency. The base image also contains Node 24.4.1; tests explicitly verify that the consumer executes the separate mise-managed binary. smolVM and the interactive Pi UI are not exercised by this integration suite.

## Regressions caught

- Forcing `statVirtualization("relaxed")` on cache mounts caused mise's Node extraction to fail with `ELOOP` while restoring `bin/npm` symlink timestamps. CLI-only tests missed this; adapter-level tests exercise it. Keep the default stat policy with mirrored host permissions.
- pnpm 10 ignores `PNPM_CONFIG_STORE_DIR`, silently creating a worktree-local store. The preset uses `npm_config_store_dir`, and the integration suite checks the actual resolved store and offline reuse rather than only the variable's spelling.

## smolVM lifecycle

`tests/smolvm-lifecycle.test.mjs` runs the actual adapter, registry, and failed worker bootstrap against an isolated persistent CLI fixture and SDK inspection mocks. It covers reopening after stop, running adoption without restart, exclusive controller ownership, configuration/security mismatch, legacy and in-progress refusal, non-destructive create conflicts, startup rollback, explicit removal, and keep-running scope. Registry tests cover shutdown during pending creation and retrying a failed stop.

An opt-in credential-free check uses a uniquely named disposable VM:

```sh
node tests/smolvm-lifecycle-live.mjs
```

It verifies graceful registry shutdown leaves a stopped machine, a new adapter reopens it with its rootfs sentinel intact, running adoption preserves its boot ID, and a concurrent controller is refused. It does not start Pi RPC or simulate terminal signals. Only the test-owned VM is removed.


## Shared HTTP network

`node tests/smolvm-http-live.mjs` creates one uniquely named disposable VM. It verifies the same `http://<service>.<worker>.pibox.test` URL from host and guest, WebSocket upgrade/data, HTTP 502 readiness, idle connection cleanup, and unchanged VM boot ID. Host requests use an explicit test lookup override; they **do not** prove host OS resolution is configured. Guest curl uses normal resolution. Port 80 must be free; `PIBOX_TEST_HTTP_PORT=0` explicitly selects an ephemeral test port without changing the production default. No existing VM/container, host hosts/resolver/trust, or application configuration is changed.

`network-hosts.test.mjs` tests ownership, unmanaged mapping reuse, conflicts, authorization failures and guest cleanup using temporary files only. It never executes privileged host mutations.

Unit tests cover exact HTTP routes, HTTP/WebSocket forwarding, rejection of remote clients, and scoped hostname mappings. Cleanup regressions verify that guest or route cleanup failures do not prevent native revocation, retries skip already removed native mappings, and pending guest-cleanup names are not restored by other publications. Lifecycle tests verify Pibox no longer injects `SMOLVM_PUBLISH_ADDR` (whose presence selects smolVM fleet policy), while preserving explicit operator values.
