import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import { SmolvmNetwork } from "./smolvm-network.js";
import {
  assertMachineIdentity, existingMachine, lockMachine, machineIdentity, machineLabels,
} from "./smolvm-lifecycle.js";
import type {
  CredentialBroker,
  PreparedCredential,
} from "../auth-relay.js";
import type {
  ProcessEvent,
  ProcessOptions,
  SandboxInstance,
  SandboxMount,
  SandboxProcess,
  SandboxProvider,
} from "../sandbox.js";

const PROCESS_EXIT_TIMEOUT_MS = 2_000;
const AUTH_POLICY_ENV = "PIBOX_SMOLVM_AUTH_POLICY";
const ACCEPTED_AUTH_POLICY = "guest-environment";

export class SmolvmProvider implements SandboxProvider {
  readonly credentialBroker = new SmolvmCredentialBroker();

  constructor(private readonly credentials: PreparedCredential[]) {}

  async create(
    name: string,
    config: Record<string, unknown>,
    mounts: readonly SandboxMount[],
  ): Promise<SandboxInstance> {
    if (
      this.credentials.length > 0 &&
      process.env[AUTH_POLICY_ENV] !== ACCEPTED_AUTH_POLICY
    ) {
      throw new Error(
        `smolVM model authentication is blocked because tokens enter the guest process environment; set ${AUTH_POLICY_ENV}=${ACCEPTED_AUTH_POLICY} only after explicitly accepting that weaker policy`,
      );
    }

    assertNoCacheMountConflicts(config, mounts);
    const labels = machineLabels(config, mounts, this.credentials);
    const release = await lockMachine(name);
    let directory: string | undefined;
    let created = false;
    try {
      const existing = await existingMachine(name, labels);
      this.credentialBroker.install(this.credentials);
      if (existing) {
        if (existing.state === "stopped") {
          await runSmolvm(["machine", "start", "--name", name]);
        }
        return new SmolvmInstance(name, this.credentialBroker.secretEnvironment(),
          existing.identity, release, existing.state === "running" ? "running" : "stopped");
      }
      directory = await mkdtemp(join(tmpdir(), "pibox-smolvm-"));
      const smolfile = join(directory, "Smolfile");
      await writeFile(smolfile, stringify(config));
      await runSmolvm([
        "machine", "create", "--name", name, "--smolfile", smolfile,
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        ...mounts.flatMap((mount) => ["--volume", `${mount.source}:${mount.target}`]),
      ]);
      created = true;
      await runSmolvm(["machine", "start", "--name", name]);
      return new SmolvmInstance(name, this.credentialBroker.secretEnvironment(),
        machineIdentity(labels), release, "new");
    } catch (error) {
      // Failed create/reopen grants no deletion rights over persisted data.
      if (created) {
        await runSmolvm(["machine", "delete", "--name", name, "--force"])
          .catch(() => undefined);
      }
      this.credentialBroker.cleanup();
      await release();
      throw new Error(`Failed to open or create smolVM machine ${name}: ${errorMessage(error)}`, {
        cause: error,
      });
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

class SmolvmInstance implements SandboxInstance {
  private readonly network: SmolvmNetwork;
  private stopped = false;
  private removed = false;

  constructor(
    private readonly name: string,
    private readonly secrets: readonly SecretEnvironment[],
    private readonly identity: string,
    private release: (() => Promise<void>) | undefined,
    private readonly origin: "new" | "running" | "stopped",
  ) { this.network = SmolvmNetwork.forMachine(name); }

  publishTcp(guestPort: number): Promise<number> {
    if (this.stopped || this.removed || !this.release) return Promise.reject(new Error("smolVM worker is stopped"));
    return this.network.publish(guestPort);
  }

  unpublishTcp(hostPort: number, guestPort: number): Promise<void> {
    return this.network.unpublish(hostPort, guestPort);
  }

  startProcess(
    command: readonly string[],
    options: ProcessOptions = {},
  ): Promise<SandboxProcess> {
    if (this.stopped || this.removed || !this.release) throw new Error("smolVM worker is stopped");
    if (command.length === 0) throw new Error("Sandbox command must not be empty");
    const args = ["machine", "exec", "--name", this.name, "-i"];
    if (options.cwd !== undefined) args.push("--workdir", options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push("--env", `${key}=${value}`);
    }
    for (const secret of this.secrets) {
      args.push("--secret-env", `${secret.guestName}=${secret.hostName}`);
    }
    args.push("--", ...command);
    const child = spawn(smolvmCommand(), args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return Promise.resolve(new SmolvmProcess(child));
  }

  async stop(): Promise<void> {
    if (this.stopped || this.removed) return;
    this.release ??= await lockMachine(this.name);
    await assertMachineIdentity(this.name, this.identity);
    await runSmolvm(["machine", "stop", "--name", this.name]);
    await this.release?.();
    this.release = undefined;
    this.stopped = true;
  }

  async rollback(): Promise<void> {
    if (this.origin === "new") return this.remove();
    if (this.origin === "stopped") return this.stop();
    // Failed bootstrap on an adopted running VM must not stop its services.
    await this.release?.();
    this.release = undefined;
    this.stopped = true;
  }

  async remove(): Promise<void> {
    if (this.removed) {
      await this.release?.();
      this.release = undefined;
      return;
    }
    // A stopped handle no longer owns the VM: another controller may use it.
    const reacquired = !this.release;
    this.release ??= await lockMachine(this.name);
    try {
      await assertMachineIdentity(this.name, this.identity);
    } catch (error) {
      // A stale stopped handle has not touched the replacement machine.
      if (reacquired && this.stopped) {
        await this.release();
        this.release = undefined;
      }
      throw error;
    }
    // A failed delete may leave a running guest: retain this lease for retry.
    await runSmolvm(["machine", "delete", "--name", this.name, "--force"]);
    this.removed = true;
    this.stopped = true;
    await this.release();
    this.release = undefined;
  }
}

class SmolvmProcess implements SandboxProcess {
  private readonly events: ProcessEvent[] = [];
  private readonly receivers: Array<(event: ProcessEvent | null) => void> = [];
  private readonly exit: Promise<number>;
  private resolveExit!: (code: number) => void;
  private ended = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private processError: Error | undefined;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.exit = new Promise<number>((resolveExit) => {
      this.resolveExit = resolveExit;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.push({ type: "stdout", data: new Uint8Array(chunk) });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.push({ type: "stderr", data: new Uint8Array(chunk) });
    });
    child.on("error", (error) => {
      this.processError = error;
      this.push({
        type: "stderr",
        data: new TextEncoder().encode(`smolvm CLI process error: ${error.message}\n`),
      });
      // A spawn failure has no process; a failed kill does not prove exit.
      if (child.pid === undefined) this.finish(1);
    });
    child.once("close", (code, signal) => {
      this.finish(code ?? (signal ? 128 : 1));
    });
  }

  async write(data: string | Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Sandbox process stdin is closed");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async receive(): Promise<ProcessEvent | null> {
    const event = this.events.shift();
    if (event) return event;
    if (this.ended) return null;
    return await new Promise<ProcessEvent | null>((resolve) => {
      this.receivers.push(resolve);
    });
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeProcess();
  }

  private async closeProcess(): Promise<void> {
    this.closed = true;
    this.child.stdin.end();
    if (this.ended || (await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS))) return;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (!this.child.kill(signal)) {
        throw this.processError ?? new Error(`Unable to terminate smolvm CLI with ${signal}`);
      }
      if (await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS)) return;
    }
    throw new Error("smolvm CLI exit could not be confirmed after SIGKILL");
  }

  private push(event: ProcessEvent): void {
    const receiver = this.receivers.shift();
    if (receiver) receiver(event);
    else this.events.push(event);
  }

  private finish(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.push({ type: "exit", code });
    this.resolveExit(code);
  }
}

function assertNoCacheMountConflicts(
  config: Record<string, unknown>,
  mounts: readonly SandboxMount[],
): void {
  const configured = configuredVolumeTargets(config);
  for (const mount of mounts) {
    if (configured.has(mount.target)) {
      throw new Error(
        `smolVM cache mount ${mount.target} conflicts with sandbox volumes`,
      );
    }
  }
}

function configuredVolumeTargets(config: Record<string, unknown>): Set<string> {
  const development = isTable(config.dev) ? config.dev : undefined;
  const developmentVolumes = stringArray(development?.volumes);
  const volumes = developmentVolumes.length > 0
    ? developmentVolumes
    : stringArray(config.volumes);
  return new Set(
    volumes.flatMap((volume) => {
      const components = volume.split(":");
      return components.length >= 2 && components[1] ? [components[1]] : [];
    }),
  );
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SecretEnvironment {
  guestName: string;
  hostName: string;
}

class SmolvmCredentialBroker implements CredentialBroker {
  private readonly credentials = new Map<string, PreparedCredential>();

  install(credentials: PreparedCredential[]): void {
    for (const credential of credentials) {
      process.env[credential.sourceEnvName] = credential.lastAppliedValue;
      this.credentials.set(credential.provider, credential);
    }
  }

  refresh(credential: PreparedCredential, value: string): Promise<void> {
    if (!this.credentials.has(credential.provider)) {
      return Promise.reject(
        new Error(`smolVM credential ${credential.provider} is not installed`),
      );
    }
    if (process.env[credential.sourceEnvName] !== value) {
      return Promise.reject(
        new Error(
          `The host ${credential.provider} credential changed; recreate the smolVM worker because an existing guest process environment cannot be rotated`,
        ),
      );
    }
    return Promise.resolve();
  }

  secretEnvironment(): SecretEnvironment[] {
    return [...this.credentials.values()].map((credential) => ({
      guestName: credential.secretName,
      hostName: credential.sourceEnvName,
    }));
  }

  cleanup(): void {
    for (const credential of this.credentials.values()) {
      delete process.env[credential.sourceEnvName];
    }
    this.credentials.clear();
  }
}

async function runSmolvm(args: readonly string[]): Promise<void> {
  const child = spawn(smolvmCommand(), args, {
    stdio: ["ignore", "ignore", "pipe"],
    // Native defaults publish on loopback. Setting SMOLVM_PUBLISH_ADDR, even
    // to 127.0.0.1, opts into fleet policy and blocks guest-to-host access.
    // Preserve an explicit operator value; never silently weaken that policy.
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192);
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(
      `smolvm ${args.join(" ")} exited with ${code}${
        stderr.trim() ? `: ${stderr.trim()}` : ""
      }`,
    );
  }
}

function smolvmCommand(): string {
  return process.env.PIBOX_SMOLVM_CLI ?? "smolvm";
}

async function exitsWithin(exit: Promise<number>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
