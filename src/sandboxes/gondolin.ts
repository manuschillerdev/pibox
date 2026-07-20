import {
  VM,
  RealFSProvider,
  createHttpHooks,
  type ExecProcess,
  type SecretManager,
  type VMOptions,
} from "@earendil-works/gondolin";
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

export class GondolinProvider implements SandboxProvider {
  readonly credentialBroker: GondolinCredentialBroker;

  constructor(private readonly credentials: PreparedCredential[]) {
    this.credentialBroker = new GondolinCredentialBroker();
  }

  async create(
    name: string,
    config: Record<string, unknown>,
    mounts: readonly SandboxMount[],
  ): Promise<SandboxInstance> {
    const auth = createHttpHooks({
      secrets: Object.fromEntries(
        this.credentials.map((credential) => [
          credential.secretName,
          {
            hosts: credential.allowedHosts,
            value: credential.lastAppliedValue,
            placeholder: credential.placeholder,
          },
        ]),
      ),
    });
    this.credentialBroker.attach(auth.secretManager);
    try {
      const options = config as VMOptions;
      const vfs = mergeCacheMounts(options.vfs, mounts);
      const vm = await VM.create({
        ...options,
        sessionLabel: name,
        httpHooks: auth.httpHooks,
        env: mergeEnvironment(options.env, auth.env),
        ...(vfs === undefined ? {} : { vfs }),
      });
      return new GondolinInstance(vm);
    } catch (error) {
      this.credentialBroker.cleanup();
      throw new Error(`Failed to create Gondolin VM: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

class GondolinInstance implements SandboxInstance {
  private closed = false;

  constructor(private readonly vm: VM) {}

  startProcess(
    command: readonly string[],
    options: ProcessOptions = {},
  ): Promise<SandboxProcess> {
    if (command.length === 0) throw new Error("Sandbox command must not be empty");
    const abort = new AbortController();
    const process = this.vm.exec([...command], {
      stdin: true,
      stdout: "pipe",
      stderr: "pipe",
      signal: abort.signal,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return Promise.resolve(new GondolinProcess(process, abort, () => this.stop()));
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    await this.vm.close();
    this.closed = true;
  }

  async remove(): Promise<void> {
    await this.stop();
  }
}

class GondolinProcess implements SandboxProcess {
  private readonly output: AsyncIterator<{
    stream: "stdout" | "stderr";
    data: Buffer;
    text: string;
  }>;
  private readonly exit: Promise<number>;
  private exited = false;
  private exitEmitted = false;
  private closed = false;

  constructor(
    private readonly process: ExecProcess,
    private readonly abort: AbortController,
    private readonly terminateVm: () => Promise<void>,
  ) {
    this.output = process.output()[Symbol.asyncIterator]();
    this.exit = process.result.then((result) => {
      this.exited = true;
      return result.exitCode;
    });
  }

  write(data: string | Uint8Array): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Sandbox process stdin is closed"));
    this.process.write(typeof data === "string" ? data : Buffer.from(data));
    return Promise.resolve();
  }

  async receive(): Promise<ProcessEvent | null> {
    if (this.exitEmitted) return null;
    const next = await this.output.next();
    if (!next.done) {
      return {
        type: next.value.stream,
        data: new Uint8Array(next.value.data),
      };
    }
    const code = await this.exit;
    this.exitEmitted = true;
    return { type: "exit", code };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.process.end();
    if (this.exited || (await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS))) return;
    this.abort.abort();
    if (await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS)) return;
    await this.terminateVm();
  }
}

class GondolinCredentialBroker implements CredentialBroker {
  private manager: SecretManager | undefined;

  attach(manager: SecretManager): void {
    this.manager = manager;
  }

  refresh(credential: PreparedCredential, value: string): Promise<void> {
    if (!this.manager) {
      return Promise.reject(new Error("Gondolin credential broker is not attached"));
    }
    this.manager.updateSecret(credential.secretName, {
      value,
      hosts: credential.allowedHosts,
    });
    return Promise.resolve();
  }

  cleanup(): void {
    if (this.manager) {
      for (const secret of this.manager.listSecrets()) {
        this.manager.deleteSecret(secret.name);
      }
    }
    this.manager = undefined;
  }
}

function mergeCacheMounts(
  configured: VMOptions["vfs"],
  mounts: readonly SandboxMount[],
): VMOptions["vfs"] {
  if (mounts.length === 0) return configured;
  if (configured === null) {
    throw new Error("Gondolin cache mounts conflict with disabled sandbox.vfs");
  }
  const configuredMounts = configured?.mounts ?? {};
  for (const mount of mounts) {
    if (Object.hasOwn(configuredMounts, mount.target)) {
      throw new Error(
        `Gondolin cache mount ${mount.target} conflicts with sandbox.vfs.mounts`,
      );
    }
  }
  return {
    ...(configured ?? {}),
    mounts: {
      ...configuredMounts,
      ...Object.fromEntries(
        mounts.map((mount) => [mount.target, new RealFSProvider(mount.source)]),
      ),
    },
  };
}

function mergeEnvironment(
  configured: VMOptions["env"],
  auth: Record<string, string>,
): NonNullable<VMOptions["env"]> {
  if (Array.isArray(configured)) {
    return [...configured, ...Object.entries(auth).map(([key, value]) => `${key}=${value}`)];
  }
  return { ...(configured ?? {}), ...auth };
}

async function exitsWithin(exit: Promise<number>, timeoutMs: number): Promise<boolean> {
  return await Promise.race([
    exit.then(() => true, () => true),
    new Promise<false>((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), timeoutMs),
    ),
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
