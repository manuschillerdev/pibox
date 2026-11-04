# Hypeman Provider Evaluation

## Recommendation

Hypeman is a promising experimental Pibox provider, particularly for remote Linux hosts that need VM snapshots and copy-on-write forks. It should not yet be enabled as a production credential broker or treated as an SSH-forwarding solution.

Adopt it in stages:

1. Integrate ordinary instance lifecycle and WebSocket exec behind `provider = "hypeman"`.
2. Prove one explicitly mapped model credential on Linux.
3. Resolve credential persistence and guest-isolation issues before enabling snapshots or forks for authenticated workers.
4. Add cold snapshot/fork support.
5. Design a reconnectable guest RPC transport before exposing warm Pi worker forks.

This assessment covers Hypeman commit [`d60d4d103eba6cd9893dd1714b98716dc64b01a0`](https://github.com/kernel/hypeman/tree/d60d4d103eba6cd9893dd1714b98716dc64b01a0).

## Capability summary

| Requirement | Fit | Conclusion |
| --- | --- | --- |
| Pibox lifecycle | Strong | Hypeman's API and guest-agent exec map cleanly to create, process streaming, stop, and remove. |
| Credential brokering | Conditional | Host-side HTTPS header injection and live rotation are useful, but credentials are persisted in unsafe metadata and transformations must be mapped per model provider. |
| SSH access | Alternative available | The vsock guest agent provides authenticated interactive exec without SSH. |
| SSH agent forwarding | Missing | Hypeman does not forward `SSH_AUTH_SOCK` or implement the SSH agent protocol. |
| Generic port forwarding | Missing | Built-in ingress is HTTP/HTTPS reverse proxying; arbitrary TCP mappings remain future work. |
| Disk CoW | Strong when supported | Linux uses `FICLONE`; macOS uses APFS `clonefile(2)`; unsupported filesystems fall back to sparse copying. |
| Memory/process fork | Supported through snapshot restore | A running source is moved to standby, cloned, and restored; this is not an uninterrupted native live-VM fork. |
| Warm Pibox fork | Blocked | Pibox binds Pi RPC to one exec stream, while restored Hypeman processes do not expose a reconnectable copy of that stream. |

## Pibox lifecycle fit

Pibox deliberately has a small provider contract:

- `create(name, config)`;
- `startProcess(command, { cwd, env })`;
- process `write`, `receive`, and `close`;
- instance `stop` and `remove`.

See [`src/sandbox.ts`](../src/sandbox.ts).

Hypeman supplies the required primitives:

- a JWT-authenticated REST API for instance lifecycle;
- OCI image-backed VM creation;
- bidirectional WebSocket command execution;
- separate stdout and stderr for non-TTY commands;
- process exit codes;
- stop and delete operations.

Its guest agent carries exec traffic over vsock, avoiding guest SSH configuration. The flow is documented in [Hypeman's guest-agent architecture](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/guest/README.md#L1-L106).

The official [`@onkernel/hypeman`](https://github.com/kernel/hypeman-ts) TypeScript package covers the generated REST API, including lifecycle, snapshot, and fork operations. WebSocket exec is registered outside Hypeman's OpenAPI specification, so Pibox would need a small direct WebSocket adapter for `/instances/{id}/exec` rather than relying on the generated SDK for process transport. See [the custom endpoint registration](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/cmd/api/main.go#L403-L426).

## Credential brokering

### Available mechanism

Hypeman has an optional host-side HTTP/HTTPS egress proxy. When enabled, it:

1. puts mock credential values in the guest environment;
2. installs a proxy CA in the guest;
3. directs HTTP and HTTPS clients through the host proxy;
4. injects real values into configured request headers for matching destination hosts;
5. supports live credential rotation through `PATCH /instances/{id}`.

See [Hypeman's egress proxy documentation](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/egressproxy/README.md#L1-L73).

This aligns with Pibox's existing credential model:

- host credential discovery;
- guest placeholders;
- destination host allowlists;
- provider-specific credential validation;
- live broker refresh.

The relevant Pibox contracts are in [`src/auth-relay.ts`](../src/auth-relay.ts) and [`src/model-credentials.ts`](../src/model-credentials.ts).

### Transformation mismatch

Pibox's Microsandbox integration substitutes a placeholder wherever the outgoing request contains it. Hypeman does not perform general placeholder substitution. It overwrites a configured HTTP header.

Pibox therefore needs an explicit Hypeman injection description for every supported model credential, for example:

| Provider | Injection |
| --- | --- |
| OpenAI and OpenAI Codex | `Authorization: Bearer ${value}` |
| Anthropic | `x-api-key: ${value}` |
| Other providers | Explicit adapter required |

Hypeman's current credential transform supports headers only. Query-parameter credentials, body transforms, and request signing are not supported. Pibox should reject providers without an explicit Hypeman mapping instead of guessing from the model endpoint.

### Credential persistence blocker

Hypeman stores real credential values in `StoredMetadata.Env`. Instance metadata is serialized with mode `0644`:

- [`StoredMetadata.Env`](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/instances/types.go#L75-L109)
- [`saveMetadata()` permissions](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/instances/storage.go#L86-L119)

Snapshots copy the full stored metadata, including its environment, and write snapshot metadata with mode `0644`:

- [snapshot metadata cloning](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/instances/snapshot.go#L143-L155)
- [snapshot metadata permissions](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/snapshot/store.go#L58-L72)

This is weaker than Pibox's Microsandbox security model. Production use requires a separate protected secret store or equivalent design with these properties:

- secret values are not serialized into general instance metadata;
- snapshot records do not duplicate secret material;
- persisted secret files are at least mode `0600`;
- deleting or revoking a worker removes its persisted credential values;
- fork authorization is explicit rather than inherited accidentally.

### Guest environment edge case

Hypeman first merges the complete instance environment into guest configuration, then replaces only keys found in the credential policy map with mock values. If a policy key and its `source.env` differ, the real source variable can remain visible in the guest. See [`buildGuestConfig()`](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/instances/configdisk.go#L49-L98).

Until this is fixed upstream, a Pibox adapter must use the same name for:

- the credential policy key;
- `source.env`;
- the guest placeholder environment variable.

It must not send Pibox's temporary `sourceEnvName` as a second instance environment key.

### Platform and CA constraints

Direct-egress enforcement is implemented with Linux TAP and iptables rules. The non-Linux implementation is a no-op: [`lib/egressproxy/enforce_other.go`](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/egressproxy/enforce_other.go).

Consequently, `enforcement.mode = "all"` is not fail-closed on macOS. Initial credential-brokering support should be Linux-only.

Hypeman installs its MITM CA into the guest operating-system trust store. Pibox must separately verify that the pinned Node.js runtime trusts that CA. The worker process may need `NODE_EXTRA_CA_CERTS` or Node system-CA mode at startup.

The Hypeman API itself receives real credentials in instance creation and update request bodies. A remote Pibox connection must use HTTPS, a protected local tunnel, or a trusted private network. Plain remote HTTP is not acceptable.

## SSH and forwarding

Hypeman intentionally replaces SSH-based guest management with a JWT-authorized vsock guest agent. This is a good fit for Pibox's programmatic process contract and removes SSH key distribution from ordinary worker startup.

It does not provide:

- SSH-agent forwarding;
- `SSH_AUTH_SOCK` projection into a guest;
- an SSH-agent protocol proxy over vsock;
- generic local, remote, or dynamic TCP forwarding;
- an arbitrary L4 ingress resource.

Hypeman's Caddy ingress is an HTTP/HTTPS reverse proxy with hostname and TLS routing. The `PortMapping` schema is not wired into instance creation, which still marks `port_mappings` as future work.

For private Git repositories, HTTPS credentials brokered through the egress proxy are feasible. Workloads requiring SSH signatures, hardware-backed keys, or agent forwarding need a separate capability, preferably a narrowly scoped host-side SSH-agent protocol relay rather than exposing a raw host agent socket.

## Snapshot and fork semantics

### Running-source behavior

Hypeman supports forks from stopped, standby, and running instances. A running-source fork performs:

1. guest readiness check;
2. source transition to standby;
3. snapshot clone;
4. fork restoration to the requested target state;
5. source restoration.

See [`forkInstance()`](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/instances/fork.go#L25-L124).

The resulting fork can preserve guest RAM and process state, but the source experiences a standby/snapshot/restore interval. This is snapshot-based warm cloning, not an uninterrupted native hypervisor fork.

### Disk CoW

Hypeman's guest-directory copier attempts a reflink for every regular file and falls back to sparse extent copying when reflinks are unsupported:

- [reflink-first dispatcher](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/forkvm/copy.go#L41-L45)
- [Linux `FICLONE`](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/forkvm/copy_reflink_linux.go#L14-L64)
- [macOS APFS `clonefile(2)`](https://github.com/kernel/hypeman/blob/d60d4d103eba6cd9893dd1714b98716dc64b01a0/lib/forkvm/copy_reflink_darwin.go#L18-L73)

The practical guarantees are:

- Linux CoW requires a reflink-capable filesystem such as appropriately configured XFS, btrfs, ZFS, or bcachefs.
- macOS CoW requires source and destination on the same APFS volume.
- cross-volume and unsupported-filesystem cases use sparse copying and lose the near-instant CoW property.
- snapshots and forks should remain under one filesystem-backed Hypeman `data_dir`.

Hypeman's `lib/forkvm/README.md` still describes regular-file copies as sparse-only. The implementation and newer APFS documentation show that reflink support has shipped, so that README is stale.

### Warm Pi RPC blocker

Pibox starts Pi RPC through `SandboxInstance.startProcess()` and binds `PiRpcClient` directly to that process's stdin and output streams. See [`src/worker-manager.ts`](../src/worker-manager.ts).

Hypeman can restore the guest process that was running Pi, but the host WebSocket and guest-agent gRPC stream used to launch that process are not a reconnectable property of the restored process. A fork can therefore contain a copied Pi process without giving the new Pibox controller a usable RPC transport to it.

A warm Pibox fork needs a guest supervisor with a reconnectable protocol:

- the supervisor owns the Pi process independently of a transient exec session;
- Pi JSONL RPC is exposed over a Unix socket or dedicated vsock service;
- the source and each fork accept a fresh host connection after restore;
- connection identity is regenerated for every fork;
- stale pre-snapshot clients cannot control restored children.

Without this component, Pibox can use Hypeman for CoW disk forks but must launch a new Pi process in each child. That preserves filesystem state but not a warm Pi session.

## Operational and maturity considerations

Hypeman is a substantial service rather than a small embedded runtime. Linux deployments require KVM, network administration, TAP/bridge configuration, forwarding, and supporting system components. macOS uses Virtualization.framework and has different networking and enforcement behavior.

Positive maturity signals include:

- multiple Linux hypervisors plus Apple Virtualization.framework;
- OpenAPI lifecycle definitions;
- generated Go and TypeScript SDKs;
- lifecycle, snapshot, fork, and integration tests;
- active development and tagged releases.

Risks include:

- pre-1.0 API maturity;
- custom exec and copy endpoints outside OpenAPI;
- a security model that currently treats raw credentials as ordinary persisted metadata;
- behavior differences across Linux and macOS;
- greater operational burden than Pibox's existing local provider adapters.

Pibox should pin a tested Hypeman release and validate server capabilities at startup rather than following `main` or assuming every advertised feature is available.

## Proposed integration

### Configuration

Add `"hypeman"` to `SandboxProviderName` and keep `[sandbox]` provider-native. A minimal provider configuration could contain:

```toml
provider = "hypeman"

[pibox]
name = "pibox-hypeman"
workdir = "/workspace"

[sandbox]
baseUrl = "https://hypeman.internal"
image = "ghcr.io/manuschillerdev/pibox-base:bookworm"
hypervisor = "firecracker"
size = "2GB"
vcpus = 2
overlaySize = "10GB"
```

The API token should come from a host environment variable or protected Pi configuration, not from `pibox.toml`.

### Provider implementation

Likely changes:

- [`src/config.ts`](../src/config.ts): add the provider name;
- [`src/sandbox-provider.ts`](../src/sandbox-provider.ts): construct the adapter;
- `src/sandboxes/hypeman.ts`: lifecycle client, WebSocket process adapter, and credential broker;
- [`package.json`](../package.json): add the chosen API and WebSocket dependencies;
- `examples/hypeman/pibox.toml`: provider-native example;
- provider tests for protocol normalization, cleanup, and credential request construction.

The adapter should:

1. create an instance with a long-lived inert entrypoint so guest-agent exec remains available;
2. wait for Running and guest-agent readiness;
3. map each `startProcess()` to a non-TTY exec WebSocket;
4. send the first JSON exec request and then binary stdin frames;
5. map binary output and the final text `exitCode` message into `ProcessEvent` values;
6. stop idempotently;
7. delete idempotently;
8. rotate credential source values through the instance update API;
9. refuse unsupported credential transforms and unsafe platform combinations.

### Optional capability boundary

Snapshot and fork methods should not be added to the base `SandboxInstance` contract merely to support one backend. Introduce an optional capability only after its semantics are defined, for example:

```ts
interface ForkableSandboxInstance extends SandboxInstance {
  snapshot(options: SnapshotOptions): Promise<SandboxSnapshot>;
  fork(options: ForkOptions): Promise<SandboxInstance>;
}
```

Pibox must define whether a fork preserves:

- filesystem state;
- guest RAM;
- Pi process state;
- Pi conversation/session state;
- model credentials;
- controller routing;
- active tool executions.

The API should not call a disk-only clone and a reconnectable warm worker by the same undifferentiated operation.

## Proof-of-concept acceptance criteria

### Basic lifecycle

- Create a Hypeman-backed worker from the Pibox base image.
- Complete bootstrap through buffered exec operations.
- Run Pi RPC through a non-TTY WebSocket exec session.
- Prompt one model and receive streamed output.
- Stop and remove the instance without leaving a VMM, WebSocket, or metadata directory.

### Credential isolation

- Support one explicit provider mapping, initially OpenAI Codex or OpenAI.
- Confirm the real token is absent from guest environment variables, `auth.json`, process arguments, and readable files.
- Confirm only the allowed destination receives the injected header.
- Confirm credential rotation takes effect without restarting Pi.
- Confirm Node accepts the Hypeman proxy CA.
- Confirm direct TCP bypass is blocked on Linux.
- Confirm instance removal deletes persisted credential material.

### Forking

- Verify reflink use and allocated-byte behavior on the target filesystem.
- Fork a stopped authenticated worker only after secret persistence is corrected.
- Verify parent and child disk changes diverge independently.
- Verify credentials are independently authorized and revocable after fork.
- Measure source pause and restore time for a running-source fork.
- Treat warm Pi RPC as unsupported until a restored child accepts a fresh controller connection.

## Decision

Hypeman is worth integrating as an experimental API-backed provider because it combines a strong guest-agent process channel with first-class snapshots and real filesystem CoW on supported hosts. Its ordinary lifecycle is a good match for Pibox.

It does not satisfy SSH-forwarding requirements, and its current credential persistence prevents production use with model tokens. Warm VM state alone also does not provide a usable warm Pibox worker because the Pi RPC stream is not reconnectable. Those constraints should be explicit in the provider and its documentation rather than hidden behind a generic `fork` claim.
