import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { Machine } from "smolmachines";
import type { CredentialBroker, PreparedCredential } from "../auth-relay.js";
import { assertMachineIdentity } from "./smolvm-lifecycle.js";

const exec = promisify(execFile);
const CODEX = "openai-codex";

/** Native binding names and guest variable names contain no credential material. */
export function credentialArgs(credentials: readonly PreparedCredential[]): string[] {
  return credentials.flatMap(credential => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(credential.secretName) ||
        credential.allowedHosts.length === 0 || credential.allowedHosts.some(host =>
          !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host))) {
      throw new Error(`Invalid native credential binding for ${credential.provider}`);
    }
    const setter = credential.provider === CODEX ? ":set-header=authorization" : "";
    return ["--credential", `${credential.secretName}=${bindingVariable(credential)}@${credential.allowedHosts.join(",")}${setter}`];
  });
}

/** Only Codex needs a parseable JWT; native substitution supplies other placeholders. */
export function credentialGuestEnvironment(credentials: readonly PreparedCredential[]): Record<string, string> {
  return Object.fromEntries(credentials.filter(credential => credential.provider === CODEX)
    .map(credential => [credential.secretName, credential.placeholder]));
}

export function credentialHostEnvironment(credentials: readonly PreparedCredential[]): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const credential of credentials) {
    // Until the live update succeeds, missing native sources fail closed.
    delete environment[bindingVariable(credential)];
    delete environment[credential.secretName];
    delete environment[credential.sourceEnvName];
  }
  return environment;
}

export function assertCredentialConfig(config: Record<string, unknown>, credentials: readonly PreparedCredential[]): void {
  if (!credentials.length) return;
  const reserved = new Set(credentials.flatMap(credential => [bindingVariable(credential), credential.secretName]));
  for (const section of [config, config.dev]) {
    if (typeof section !== "object" || section === null) continue;
    const record = section as Record<string, unknown>;
    const secrets = record.secrets;
    if (typeof secrets === "object" && secrets !== null && Object.keys(secrets).some(key => reserved.has(key))) {
      throw new Error("Sandbox secrets must not override Pibox credential bindings");
    }
    if (Array.isArray(record.env) && record.env.some(value => typeof value === "string" && reserved.has(value.split("=", 1)[0]!))) {
      throw new Error("Sandbox environment must not override Pibox credential bindings");
    }
  }
  // Validate before starting a native process or taking a controller lock.
  credentialArgs(credentials);
}

export class SmolvmCredentialBroker implements CredentialBroker {
  private scope: { name: string; identity: string; socket: string } | undefined;
  private readonly credentials = new Map<string, PreparedCredential>();

  async attach(name: string, identity: string, credentials: readonly PreparedCredential[]): Promise<void> {
    if (!credentials.length) return;
    await assertMachineIdentity(name, identity);
    let directory: string;
    try {
      const result = await exec(process.env.PIBOX_SMOLVM_CLI ?? "smolvm", ["machine", "data-dir", "--name", name], {
        timeout: 10_000, maxBuffer: 16 * 1024, env: credentialHostEnvironment(credentials),
      });
      directory = result.stdout.trim();
    } catch {
      throw new Error("Unable to locate the native smolVM credential broker");
    }
    if (!isAbsolute(directory) || /[\r\n\0]/.test(directory)) throw new Error("Invalid smolVM data directory");
    this.scope = { name, identity, socket: join(directory, "credentials.sock") };
    for (const credential of credentials) this.credentials.set(credential.provider, credential);
    await this.update(Object.fromEntries(credentials.map(credential => [credential.secretName, brokerValue(credential, credential.lastAppliedValue)])));
  }

  async refresh(credential: PreparedCredential, value: string): Promise<void> {
    if (this.credentials.get(credential.provider) !== credential || !this.scope) {
      throw new Error(`smolVM credential ${credential.provider} is not installed`);
    }
    await this.update({ [credential.secretName]: brokerValue(credential, value) });
  }

  /** Call only after the owning VM has successfully stopped or been removed. */
  detached(): void {
    this.scope = undefined;
  }

  async cleanup(): Promise<void> {
    if (this.scope) {
      // Empty live values replace old keys and prevent fallback to a host source.
      await this.update(Object.fromEntries([...this.credentials.values()].map(credential => [credential.secretName, ""])));
      this.scope = undefined;
    }
    this.credentials.clear();
  }

  private async update(values: Record<string, string>): Promise<void> {
    const scope = this.scope;
    if (!scope) throw new Error("smolVM credential broker is not attached");
    await assertMachineIdentity(scope.name, scope.identity);
    const machine = await Machine.open(scope.name, { target: "local", handleSignals: false });
    if (await machine.state() !== "running") throw new Error("smolVM credential broker requires a running machine");
    await sendCredentialValues(scope.socket, values);
  }
}

function bindingVariable(credential: PreparedCredential): string {
  return credential.provider === CODEX ? `${credential.secretName}_BROKER` : credential.secretName;
}

function brokerValue(credential: PreparedCredential, value: string): string {
  if (!value || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error(`Invalid credential value for ${credential.provider}`);
  }
  return credential.provider === CODEX ? `Bearer ${value}` : value;
}

/** smolVM 1.34.1 host-only control protocol; no guest process or disk gets values. */
export async function sendCredentialValues(path: string, values: Record<string, string>): Promise<void> {
  const info = await lstat(path);
  if (!info.isSocket() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022) !== 0) {
    throw new Error("Unsafe native credential control socket");
  }
  const request = JSON.stringify({ values });
  if (Buffer.byteLength(request) >= 1024 * 1024) throw new Error("Native credential update is too large");
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    let reply = "";
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timeout = setTimeout(() => done(new Error("Native credential update timed out")), 7_000);
    socket.on("connect", () => socket.end(request));
    socket.on("data", chunk => {
      reply += chunk.toString("utf8");
      if (reply.length > 1024) done(new Error("Invalid native credential acknowledgement"));
    });
    // Never include a request, response or socket error payload in diagnostics.
    socket.on("error", () => done(new Error("Native credential update failed")));
    socket.on("end", () => done(reply.trim() === "ok" ? undefined : new Error("Native credential update was not acknowledged")));
    socket.on("close", () => { if (!settled) done(new Error("Native credential connection closed without acknowledgement")); });
  });
}
