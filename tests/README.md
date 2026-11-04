# Tests

Install the pinned npm dependencies with `npm ci`. Unit regressions need no VM or credentials:

```sh
npm test
```

They cover model-selection ordering, handled prompts and cancellation/draining, current-turn assistant results/errors, safe model-catalog serialization, enforced deadlines, late provisioning cleanup and stalled Git identity lookups.

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
