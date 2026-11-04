# Pibox TypeScript Architecture and Authentication

## Architecture

```text
src/
  config.ts                 generic Pibox TOML loader
  sandbox.ts                minimal sandbox and process contracts
  sandbox-provider.ts       two-provider switch
  worker-manager.ts         naming, bootstrap, Pi launch, RPC, cleanup
  pi-rpc.ts                 provider-independent Pi JSONL RPC
  model-credentials.ts      model credential formats and placeholders
  auth-relay.ts             host credential discovery and refresh
  sandboxes/
    microsandbox.ts         Microsandbox builder and ExecHandle wrappers
    smolvm.ts               smolVM CLI lifecycle and duplex execution
```

`worker.ts` implements prompt, state, model, steer, abort, and removal operations. `worker-registry.ts` tracks only workers created by the current coordinator process.

## Configuration boundary

The generic loader validates only the provider selection, Pibox-owned fields, and the presence of a `[sandbox]` table:

```ts
interface PiboxConfig {
  path: string;
  directory: string;
  provider: "microsandbox" | "smolvm";
  pibox: {
    name: string;
    nameSuffix?: string;
    workdir: string;
  };
  sandbox: Record<string, unknown>;
}
```

The sandbox table is opaque outside its adapter. There is no shared image, mount, port, resource, patch, or networking schema.

- Microsandbox maps table keys to same-named builder methods. Nested arrays represent repeated positional calls; callback-style methods accept nested tables. Methods such as `volume()` that combine positional arguments with a callback use an argument array whose final value is the nested table.
- smolVM serializes the table unchanged as a provider-native Smolfile and supplies the derived Pibox name separately.

## Sandbox contract

The common lifecycle surface consists of:

- `create(name, config)`;
- `startProcess(command, { cwd, env })`;
- process `write`, `receive`, and `close`;
- instance `stop` and `remove`.

`execute()` buffers stdout and stderr for ordinary bootstrap commands. Pi RPC uses the same process contract directly for writable stdin and streaming output. Provider-wide discovery, attach, inspect, force-kill, snapshots, templates, and cloning are not part of the contract.

## Process adapters

### Microsandbox

`ExecHandle` is normalized as follows:

- `ExecSink.write()` → `write()`;
- `stdout` and `stderr` events → output events;
- `exited` → exit event;
- stdin EOF, signal 15, and kill → `close()` fallback sequence.

### smolVM

The local smolmachines SDK does not apply `MachineConfig.image` to the persistent guest rootfs. Pibox uses the CLI consistently so a provider-native Smolfile can create an image-backed Debian machine. Processes start with:

```sh
smolvm machine exec --name NAME -i -- COMMAND...
```

No pseudo-terminal is allocated. Host child-process stdout, stderr, and exit are normalized into the common process events.

## Credential flow

The host model registry remains the credential source. `model-credentials.ts` defines provider credential formatting, including the JWT-shaped OpenAI Codex placeholder. The guest auth file contains environment references or synthetic placeholders, never a copied host auth file.

### Microsandbox

The adapter creates secret placeholders before boot and installs real host values with Microsandbox secret modification. Rotation must be applied live with no restart conflict. Source environment variables are deleted during cleanup.

### smolVM

smolVM does not currently provide equivalent host-side HTTP substitution. Pibox therefore refuses authenticated worker creation unless the operator explicitly sets:

```sh
export PIBOX_SMOLVM_AUTH_POLICY=guest-environment
```

With that policy accepted, Pibox keeps each source value in a unique host environment variable and passes only `GUEST_VAR=HOST_VAR` references to `smolvm machine exec --secret-env`. The token enters the guest Pi process environment, so this policy is weaker than the Microsandbox relay. If a host credential changes, the worker must be recreated because an existing guest process environment cannot be rotated.

## Bootstrap

Worker orchestration performs provider-independent steps through `execute()`:

1. create the workdir, profile directory, and `/opt/pibox`;
2. verify the pinned Node.js and Pi runtime already present in the published base image;
3. when absent, install Debian bootstrap packages with `apt-get`, download and verify Node.js, and install Pi;
4. write the guest extension and auth JSON through a short stdin-fed process;
5. start Pi in RPC mode in the configured workdir;
6. call `get_state`, select a relayed model if required, and return the worker.

Provider configurations must supply a Debian slim userspace and working network access when fallback provisioning is required. Microsandbox and smolVM consume the published multi-architecture OCI image directly.

## Verification

Repository checks:

```sh
npm install
npm run typecheck
npm run lint
```

Provider acceptance sequence:

1. load `pibox.toml` and inspect the adapter input;
2. create one sandbox;
3. run a buffered command;
4. start Pi RPC with writable stdin and raw streaming output;
5. call `get_state`;
6. prompt one authenticated model where the provider policy permits it;
7. stop and remove the sandbox;
8. confirm no host process or VM remains.
