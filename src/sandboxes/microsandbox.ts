import {
  Sandbox,
  type ExecHandle,
  type SandboxBuilder,
  type SecretBuilder,
  type SandboxModificationPlan,
} from "microsandbox";
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
const SANDBOX_STOP_TIMEOUT_MS = 5_000;
const CALLBACK_METHODS = new Set([
  "imageWith",
  "network",
  "patch",
  "registry",
  "secret",
]);
const POSITIONAL_CALLBACK_METHODS = new Set(["initWith", "volume"]);
const NO_ARGUMENT_METHODS = new Set([
  "disableMetricsSample",
  "disableNetwork",
  "quietLogs",
  "replace",
]);

export class MicrosandboxProvider implements SandboxProvider {
  readonly credentialBroker = new MicrosandboxCredentialBroker();

  constructor(private readonly credentials: PreparedCredential[]) {}

  async create(
    name: string,
    config: Record<string, unknown>,
    mounts: readonly SandboxMount[],
  ): Promise<SandboxInstance> {
    const effectiveConfig = withMicrosandboxDefaults(config);
    assertNoCacheMountConflicts(effectiveConfig, mounts);
    let builder = applyBuilderConfig(Sandbox.builder(name), effectiveConfig);
    for (const mount of mounts) {
      // Keep default stat virtualization: relaxed mode makes mise's tar
      // extraction fail with ELOOP when restoring symlink timestamps (npm/npx).
      builder = builder.volume(mount.target, (volume: {
        bind(host: string): {
          hostPermissions(policy: string): unknown;
        };
      }) =>
        volume
          .bind(mount.source)
          .hostPermissions("mirror"));
    }
    for (const credential of this.credentials) {
      builder = builder.env(credential.secretName, credential.placeholder);
      builder = builder.secret((secret: InstanceType<typeof SecretBuilder>) => {
        let current = secret
          .env(credential.secretName)
          .value(credential.lastAppliedValue)
          .placeholder(credential.placeholder);
        for (const host of credential.allowedHosts) current = current.allow(host);
        return current;
      });
    }

    let sandbox: Sandbox | undefined;
    try {
      sandbox = await builder.create();
      this.credentialBroker.attach(sandbox);
      await this.credentialBroker.install(this.credentials);
      return new MicrosandboxInstance(sandbox, this.credentials);
    } catch (error) {
      this.credentialBroker.cleanup();
      if (sandbox) {
        await sandbox.stopWithTimeout(SANDBOX_STOP_TIMEOUT_MS).catch(() => undefined);
        await Sandbox.remove(name).catch(() => undefined);
      }
      throw new Error(
        `Failed to create Microsandbox ${name}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

class MicrosandboxInstance implements SandboxInstance {
  private stopped = false;
  private removed = false;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly credentials: readonly PreparedCredential[],
  ) {}

  async startProcess(
    command: readonly string[],
    options: ProcessOptions = {},
  ): Promise<SandboxProcess> {
    const [executable, ...args] = command;
    if (!executable) throw new Error("Sandbox command must not be empty");
    const handle = await this.sandbox.execStreamWith(executable, (exec) => {
      let current = exec.args(args).stdinPipe();
      if (options.cwd !== undefined) current = current.cwd(options.cwd);
      // Native exec does not reliably inherit the builder's guest environment.
      // Pi's auth.json references these variables; only placeholders enter the VM.
      for (const credential of this.credentials) {
        current = current.env(credential.secretName, credential.placeholder);
      }
      for (const [key, value] of Object.entries(options.env ?? {})) {
        current = current.env(key, value);
      }
      return current;
    });
    return await MicrosandboxProcess.create(handle);
  }

  async stop(): Promise<void> {
    if (this.stopped || this.removed) return;
    await this.sandbox.stopWithTimeout(SANDBOX_STOP_TIMEOUT_MS);
    this.stopped = true;
  }

  async remove(): Promise<void> {
    if (this.removed) return;
    await this.stop().catch(() => undefined);
    try {
      await Sandbox.remove(this.sandbox.name);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.removed = true;
  }
}

class MicrosandboxProcess implements SandboxProcess {
  private readonly exit: Promise<number>;
  private resolveExit!: (code: number) => void;
  private readonly stdin: NonNullable<
    Awaited<ReturnType<ExecHandle["takeStdin"]>>
  >;
  private exited = false;
  private closed = false;

  private constructor(
    private readonly handle: ExecHandle,
    stdin: NonNullable<Awaited<ReturnType<ExecHandle["takeStdin"]>>>,
  ) {
    this.stdin = stdin;
    this.exit = new Promise<number>((resolveExit) => {
      this.resolveExit = resolveExit;
    });
  }

  static async create(handle: ExecHandle): Promise<MicrosandboxProcess> {
    const stdin = await handle.takeStdin();
    if (!stdin) throw new Error("Microsandbox process did not expose writable stdin");
    return new MicrosandboxProcess(handle, stdin);
  }

  async write(data: string | Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Sandbox process stdin is closed");
    await this.stdin.write(data);
  }

  async receive(): Promise<ProcessEvent | null> {
    while (true) {
      const event = await this.handle.recv();
      if (event == null) {
        if (this.exited) return null;
        const status = await this.handle.wait();
        this.markExited(status.code);
        return { type: "exit", code: status.code };
      }
      switch (event.kind) {
        case "started":
          break;
        case "stdout":
          return { type: "stdout", data: event.data };
        case "stderr":
          return { type: "stderr", data: event.data };
        case "exited":
          this.markExited(event.code);
          return { type: "exit", code: event.code };
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stdin.close().catch(() => undefined);
    if (this.exited || (await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS))) return;
    await this.handle.signal(15).catch(() => undefined);
    if (await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS)) return;
    await this.handle.kill().catch(() => undefined);
    await exitsWithin(this.exit, PROCESS_EXIT_TIMEOUT_MS);
  }

  private markExited(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit(code);
  }
}

class MicrosandboxCredentialBroker implements CredentialBroker {
  private sandbox: Sandbox | undefined;
  private readonly credentials = new Map<string, PreparedCredential>();

  attach(sandbox: Sandbox): void {
    this.sandbox = sandbox;
  }

  install(credentials: PreparedCredential[]): Promise<void> {
    for (const credential of credentials) {
      // The builder already installed the initial value and guest placeholder.
      this.credentials.set(credential.provider, credential);
    }
    return Promise.resolve();
  }

  async refresh(credential: PreparedCredential, value: string): Promise<void> {
    await this.apply(credential, value);
  }

  cleanup(): void {
    this.credentials.clear();
    this.sandbox = undefined;
  }

  private async apply(credential: PreparedCredential, value: string): Promise<void> {
    if (!this.sandbox) throw new Error("Microsandbox credential broker is not attached");
    const plan = await this.sandbox.modify({
      secrets: {
        [credential.secretName]: {
          value,
          placeholder: credential.placeholder,
          allowedHosts: credential.allowedHosts,
        },
      },
      policy: "no_restart",
    });
    requireLiveRotation(plan, credential.secretName);
  }
}

export function withMicrosandboxDefaults(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (!isTable(config.network)) {
    return { ...config, network: { trustHostCAs: true } };
  }
  return {
    ...config,
    network: { trustHostCAs: true, ...config.network },
  };
}

function assertNoCacheMountConflicts(
  config: Record<string, unknown>,
  mounts: readonly SandboxMount[],
): void {
  const configured = configuredVolumeTargets(config.volume);
  for (const mount of mounts) {
    if (configured.has(mount.target)) {
      throw new Error(
        `Microsandbox cache mount ${mount.target} conflicts with sandbox.volume`,
      );
    }
  }
}

function configuredVolumeTargets(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  const entries = value.every((entry) => Array.isArray(entry)) ? value : [value];
  return new Set(
    entries.flatMap((entry) =>
      Array.isArray(entry) && typeof entry[0] === "string" ? [entry[0]] : [],
    ),
  );
}

function applyBuilderConfig(
  initial: SandboxBuilder,
  config: Record<string, unknown>,
): SandboxBuilder {
  let builder = initial;
  for (const [method, value] of Object.entries(config)) {
    builder = invokeBuilderMethod(builder, method, value) as SandboxBuilder;
  }
  return builder;
}

function invokeBuilderMethod(builder: object, method: string, value: unknown): object {
  const callable = (builder as Record<string, unknown>)[method];
  if (typeof callable !== "function") {
    throw new Error(`Unsupported Microsandbox builder method \`${method}\``);
  }
  const methodFunction = callable as (this: object, ...args: unknown[]) => unknown;
  const invoke = (...args: unknown[]): object => {
    const result: unknown = methodFunction.call(builder, ...args);
    return typeof result === "object" && result !== null ? result : builder;
  };

  if (NO_ARGUMENT_METHODS.has(method)) {
    if (value === false) return builder;
    if (value !== true) {
      throw new Error(`Microsandbox builder method \`${method}\` expects a boolean`);
    }
    return invoke();
  }
  if (CALLBACK_METHODS.has(method)) {
    const entries = Array.isArray(value) ? value : [value];
    let current = builder;
    for (const entry of entries) {
      if (!isTable(entry)) {
        throw new Error(`Microsandbox builder method \`${method}\` expects a table`);
      }
      current = invokeNestedBuilder(current, method, [], entry);
    }
    return current;
  }
  if (POSITIONAL_CALLBACK_METHODS.has(method)) {
    const entries = isArgumentLists(value) ? value : [value];
    let current = builder;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) {
        throw new Error(
          `Microsandbox builder method \`${method}\` expects positional arguments followed by a table`,
        );
      }
      const positional = entry as unknown[];
      const nested: unknown = positional.at(-1);
      if (!isTable(nested)) {
        throw new Error(
          `Microsandbox builder method \`${method}\` expects its final argument to be a table`,
        );
      }
      current = invokeNestedBuilder(current, method, positional.slice(0, -1), nested);
    }
    return current;
  }
  if (isArgumentLists(value)) {
    let current = builder;
    for (const args of value) {
      const repeated = (current as Record<string, unknown>)[method];
      if (typeof repeated !== "function") {
        throw new Error(`Unsupported Microsandbox builder method \`${method}\``);
      }
      const repeatedMethod = repeated as (
        this: object,
        ...args: unknown[]
      ) => unknown;
      const result: unknown = repeatedMethod.call(current, ...args);
      if (typeof result === "object" && result !== null) current = result;
    }
    return current;
  }
  return invoke(value);
}

function invokeNestedBuilder(
  builder: object,
  method: string,
  args: unknown[],
  config: Record<string, unknown>,
): object {
  const callable = (builder as Record<string, unknown>)[method];
  if (typeof callable !== "function") {
    throw new Error(`Unsupported Microsandbox builder method \`${method}\``);
  }
  const nestedMethod = callable as (
    this: object,
    ...args: [...unknown[], (nested: object) => object]
  ) => unknown;
  const result: unknown = nestedMethod.call(builder, ...args, (nested: object) => {
    let nestedBuilder = nested;
    for (const [nestedName, nestedValue] of Object.entries(config)) {
      nestedBuilder = invokeBuilderMethod(nestedBuilder, nestedName, nestedValue);
    }
    return nestedBuilder;
  });
  return typeof result === "object" && result !== null ? result : builder;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArgumentLists(value: unknown): value is unknown[][] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item: unknown) => Array.isArray(item))
  );
}

function requireLiveRotation(
  plan: SandboxModificationPlan,
  secretName: string,
): void {
  if (plan.conflicts.length > 0) {
    throw new Error(
      `Unable to rotate Microsandbox secret ${secretName}: ${plan.conflicts
        .map((conflict) => conflict.message)
        .join("; ")}`,
    );
  }
  const rotation = plan.changes.find(
    (change) => change.kind === "secret" && change.name === secretName,
  );
  if (
    !plan.applied ||
    rotation?.kind !== "secret" ||
    rotation.change !== "rotated" ||
    rotation.disposition !== "live"
  ) {
    const disposition = rotation?.disposition ?? "missing";
    const reason = rotation?.reason ? `: ${rotation.reason}` : "";
    throw new Error(
      `Microsandbox secret ${secretName} did not rotate live (${disposition})${reason}`,
    );
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
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
