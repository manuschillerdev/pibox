import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Machine } from "smolmachines";
import type { PreparedCredential } from "../auth-relay.js";
import type { SandboxMount } from "../sandbox.js";

const OWNER = "pibox.owner";
const CONFIG = "pibox.config.v1";
const ID = "pibox.instance";

export function machineLabels(
  config: Record<string, unknown>,
  mounts: readonly SandboxMount[],
  credentials: readonly PreparedCredential[],
): Record<string, string> {
  const policy = {
    config, mounts,
    // Binding names are stable; source environment names and tokens are per-session.
    credentials: credentials.map(({ provider, secretName, allowedHosts }) => ({
      provider, secretName, allowedHosts: [...allowedHosts].sort(),
    })).sort((a, b) => a.provider.localeCompare(b.provider)),
    authPolicy: process.env.PIBOX_SMOLVM_AUTH_POLICY ?? null,
    publishAddress: process.env.SMOLVM_PUBLISH_ADDR ?? null,
  };
  return { [OWNER]: "pibox", [CONFIG]: digest(canonical(policy)), [ID]: randomUUID() };
}

export async function existingMachine(name: string, expected: Record<string, string>) {
  // open is read-only: unlike connect, it never boots a stopped machine.
  let machine: Machine;
  try { machine = await Machine.open(name, { target: "local", handleSignals: false }); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "NOT_FOUND") return undefined;
    throw error;
  }
  const summary = (await Machine.list({ target: "local" })).find((entry) => entry.name === name);
  if (!summary || summary.labels[OWNER] !== "pibox" || !summary.labels[CONFIG] || !summary.labels[ID]) {
    throw new Error(`Existing smolVM ${name} has no verified Pibox ownership/configuration metadata. Legacy migration requires explicit ownership and configuration verification before adoption; the VM and its data were left untouched.`);
  }
  if (summary.labels[CONFIG] !== expected[CONFIG]) {
    throw new Error(`Existing smolVM ${name} has a different Pibox configuration or security policy; the VM and its data were left untouched.`);
  }
  const state = await machine.state();
  if (state !== "running" && state !== "stopped") {
    throw new Error(`Existing smolVM ${name} is ${state}, not ready for reuse; the VM was left untouched. Wait for its current lifecycle operation to finish.`);
  }
  return { machine, state, identity: summary.labels[ID] };
}

export function machineIdentity(labels: Record<string, string>): string {
  return labels[ID]!;
}

export async function assertMachineIdentity(name: string, identity: string): Promise<void> {
  const summary = (await Machine.list({ target: "local" })).find((entry) => entry.name === name);
  if (!summary || summary.labels[ID] !== identity) {
    throw new Error(`smolVM ${name} was replaced outside this controller; refusing to modify it`);
  }
}

/** A conservative exclusive controller lock, retained on crash rather than stolen. */
export async function lockMachine(name: string): Promise<() => Promise<void>> {
  const directory = join(homedir(), ".pibox", "smolvm-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${digest(name)}.lock`);
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      throw new Error(`smolVM ${name} is reserved by another Pibox controller (${path}). Leave its session untouched. If the controller crashed, verify it has exited and its guest RPC is inactive before clearing this lock; locks are never automatically stolen.`);
    }
    throw error;
  }
  try { await file.writeFile(JSON.stringify({ pid: process.pid, name })); }
  catch (error) { await file.close(); await rm(path); throw error; }
  await file.close();
  let released = false;
  return async () => {
    if (released) return;
    await rm(path);
    released = true;
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
