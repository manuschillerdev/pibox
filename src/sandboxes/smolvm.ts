import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "smol-toml";
import type {
  CredentialBroker,
  PreparedCredential,
} from "../auth-relay.js";
import type {
  ProcessEvent,
  ProcessOptions,
  SandboxInstance,
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
  ): Promise<SandboxInstance> {
    if (
      this.credentials.length > 0 &&
      process.env[AUTH_POLICY_ENV] !== ACCEPTED_AUTH_POLICY
    ) {
      throw new Error(
        `smolVM model authentication is blocked because tokens enter the guest process environment; set ${AUTH_POLICY_ENV}=${ACCEPTED_AUTH_POLICY} only after explicitly accepting that weaker policy`,
      );
    }

    this.credentialBroker.install(this.credentials);
    const directory = await mkdtemp(join(tmpdir(), "pibox-smolvm-"));
    const smolfile = join(directory, "Smolfile");
    try {
      await writeFile(smolfile, stringify(config));
      await runSmolvm([
        "machine",
        "create",
        "--name",
        name,
        "--smolfile",
        smolfile,
      ]);
      await runSmolvm(["machine", "start", "--name", name]);
      return new SmolvmInstance(
        name,
        this.credentialBroker.secretEnvironment(),
      );
    } catch (error) {
      await runSmolvm([
        "machine",
        "delete",
        "--name",
        name,
        "--force",
      ]).catch(() => undefined);
      this.credentialBroker.cleanup();
      throw new Error(`Failed to create smolVM machine ${name}: ${errorMessage(error)}`, {
        cause: error,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

class SmolvmInstance implements SandboxInstance {
  private stopped = false;
  private removed = false;

  constructor(
    private readonly name: string,
    private readonly secrets: readonly SecretEnvironment[],
  ) {}

  startProcess(
    command: readonly string[],
    options: ProcessOptions = {},
  ): Promise<SandboxProcess> {
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
    await runSmolvm(["machine", "stop", "--name", this.name]);
    this.stopped = true;
  }

  async remove(): Promise<void> {
    if (this.removed) return;
    await this.stop().catch(() => undefined);
    await runSmolvm([
      "machine",
      "delete",
      "--name",
      this.name,
      "--force",
    ]);
    this.removed = true;
  }
}

class SmolvmProcess implements SandboxProcess {
  private readonly events: ProcessEvent[] = [];
  private readonly receivers: Array<(event: ProcessEvent | null) => void> = [];
  private readonly exit: Promise<number>;
  private resolveExit!: (code: number) => void;
  private ended = false;
  private closed = false;

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
    child.once("error", (error) => {
      this.push({
        type: "stderr",
        data: new TextEncoder().encode(`Unable to start smolvm CLI: ${error.message}\n`),
      });
      this.finish(1);
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    if (this.ended || (await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS))) return;
    this.child.kill("SIGTERM");
    if (await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS)) return;
    this.child.kill("SIGKILL");
    await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS);
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
  return await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), timeoutMs),
    ),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
