# Sandbox Forking Comparison

Forking, snapshots, templates, and cloning are outside the Pibox lifecycle contract. This comparison records provider-native behavior without proposing a shared capability API.

| Provider | Native mechanism | Source state | Processes preserved | Resume behavior |
| --- | --- | --- | --- | --- |
| smolVM | Live copy-on-write memory and disk fork | Running forkable VM | Yes | Warm clone |
| Gondolin | qcow2 disk checkpoint and resume | Checkpointed VM disk | No | Cold boot |
| Microsandbox | Sparse disk snapshot and `fromSnapshot()` | Stopped sandbox | No | Cold boot |

## smolVM

smolVM can use a running VM as a forkable golden base:

```sh
smolvm machine start --name golden --forkable
smolvm machine fork --golden golden --name worker-1
```

A clone inherits guest RAM, disk state, and the running workload. The golden remains the fork base. Forks are constrained to the same architecture, hypervisor, and host, and nested forks are not supported.

Source: [Pre-warmed browser pools via fork](https://github.com/smol-machines/smolvm/blob/main/examples/headless-browser/README.md)

## Gondolin

Gondolin checkpoints disk state into qcow2 storage and resumes each VM with an independent overlay. RAM and processes are not retained, so Pi and supporting services restart after resume.

Source: [Gondolin storage snapshots](https://github.com/earendil-works/gondolin/blob/main/docs/sdk-storage.md)

## Microsandbox

Microsandbox snapshots capture a stopped sandbox's writable filesystem and pin its base image. Sandboxes restored from one snapshot receive independent writable state, but restoration is a cold boot.

Source: [Microsandbox snapshots](https://github.com/superradcompany/microsandbox/blob/main/docs/sandboxes/snapshots.mdx)

## Pibox boundary

The ordinary Pibox path is create, start Pi, communicate, stop, and remove. Provider-native clone operations remain directly configurable or externally managed and do not add methods to `SandboxProvider` or `SandboxInstance`.
