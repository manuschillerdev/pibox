import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  assertCacheEnvironmentIsNotReserved,
  resolveCaches,
} from "./cache.js";
import {
  AuthRelay,
  type SkippedProvider,
} from "./auth-relay.js";
import {
  loadConfig,
  resolveConfigPath,
  type ConfigLocationOptions,
  type PiboxConfig,
} from "./config.js";
import { deriveSandboxName } from "./names.js";
import { guestModelCatalog } from "./model-catalog.js";
import { PiRpcClient, type RpcSessionState } from "./pi-rpc.js";
import {
  execute,
  type ProcessOptions,
  type SandboxInstance,
} from "./sandbox.js";
import { createSandboxProvider } from "./sandbox-provider.js";
import type {
  StartupOptions,
  StartupPhase,
  StartupProgressEvent,
} from "./startup.js";

const WORKER_EXTENSION_PATH = "/opt/pibox/worker-extension.ts";
const NODE_DIR = "/opt/pibox/node";
const RUNTIME_DIR = "/opt/pibox/runtime";
const PI_PATH = `${RUNTIME_DIR}/bin/pi`;
const MISE_PATH = "/usr/local/bin/mise";
const SERVICE_PATH = "/usr/sbin/service";
const DOCKER_PATH = "/usr/bin/docker";
const GUEST_PATH = `${NODE_DIR}/bin:${RUNTIME_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const DEFAULT_PROFILE = "pibox-worker";

export interface WorkerCreateOptions extends ConfigLocationOptions {
  profile?: string;
}

export interface StartedWorker {
  id: string;
  name: string;
  sandbox: SandboxInstance;
  rpc: PiRpcClient;
  config: PiboxConfig;
  configPath: string;
  worktreeRoot: string;
  profileDir: string;
  authRelay: AuthRelay;
  initialState: RpcSessionState;
  relayedProviders: string[];
  skippedProviders: SkippedProvider[];
}

export class WorkerManager {
  private readonly guestExtensionHostPath = fileURLToPath(
    new URL("../guest/worker-extension.ts", import.meta.url),
  );

  async configuredName(
    cwd: string,
    options: ConfigLocationOptions = {},
  ): Promise<{ name: string; configPath: string; worktreeRoot: string }> {
    const configPath = await resolveConfigPath(cwd, options);
    const config = await loadConfig(configPath);
    const derived = await deriveSandboxName(
      config,
      options.worktree ? resolve(cwd, options.worktree) : undefined,
    );
    return { name: derived.name, configPath, worktreeRoot: derived.worktreeRoot };
  }

  async createWorker(
    cwd: string,
    options: WorkerCreateOptions,
    modelRegistry: ModelRegistry,
    startup: StartupOptions = {},
  ): Promise<StartedWorker> {
    reportStartup(startup, "reading-configuration", "started");
    const configPath = await resolveConfigPath(cwd, options);
    reportStartup(startup, "reading-configuration", "detail", `Loading ${configPath}`);
    const config = await loadConfig(configPath);
    const { name, worktreeRoot } = await deriveSandboxName(
      config,
      options.worktree ? resolve(cwd, options.worktree) : undefined,
    );
    const profile = validateProfile(options.profile ?? DEFAULT_PROFILE);
    const profileDir = `/root/.pi/${profile}`;
    const caches = await resolveCaches(config, worktreeRoot);
    const prepared = await AuthRelay.prepareAvailable(name, modelRegistry);
    assertCacheEnvironmentIsNotReserved(caches.environment, [
      "MISE_TRUSTED_CONFIG_PATHS",
      "PATH",
      "PI_CODING_AGENT_DIR",
      ...prepared.credentials.map((credential) => credential.secretName),
    ]);
    const workerEnvironment = {
      ...caches.environment,
      MISE_TRUSTED_CONFIG_PATHS: config.pibox.workdir,
    };
    const provider = await createSandboxProvider(config.provider, prepared.credentials);
    reportStartup(startup, "reading-configuration", "completed");
    reportStartup(
      startup,
      "creating-sandbox",
      "started",
      `Creating ${name} with ${config.provider}`,
    );

    let sandbox: SandboxInstance | undefined;
    let rpc: PiRpcClient | undefined;
    let authRelay: AuthRelay | undefined;

    try {
      sandbox = await provider.create(name, config.sandbox, caches.mounts);
      const relay = new AuthRelay(
        name,
        modelRegistry,
        prepared,
        provider.credentialBroker,
      );
      authRelay = relay;
      reportStartup(startup, "creating-sandbox", "completed");

      reportStartup(startup, "running-startup-scripts", "started");
      await this.bootstrap(sandbox, config, profileDir, relay, modelRegistry, startup);
      await startDocker(sandbox, startup);
      await installProjectTools(
        sandbox,
        config.pibox.workdir,
        workerEnvironment,
        startup,
      );
      reportStartup(startup, "running-startup-scripts", "completed");

      reportStartup(startup, "starting-worker-pi", "started");
      const process = await sandbox.startProcess(
        [
          PI_PATH,
          "--mode",
          "rpc",
          "--no-session",
          "--extension",
          WORKER_EXTENSION_PATH,
        ],
        {
          cwd: config.pibox.workdir,
          env: {
            ...workerEnvironment,
            PATH: GUEST_PATH,
            PI_CODING_AGENT_DIR: profileDir,
          },
        },
      );
      rpc = PiRpcClient.connect(process);
      reportStartup(startup, "starting-worker-pi", "completed");
      reportStartup(startup, "connecting-rpc", "started");

      let initialState = await rpc.getState();
      const available = await rpc.getAvailableModels();
      const initialModel = available.models.find((model) =>
        relay.providerState.has(model.provider),
      );
      if (!initialModel) {
        throw new Error(
          "Worker Pi did not expose any models authenticated by its Pibox auth configuration",
        );
      }
      if (
        !initialState.model ||
        !relay.providerState.has(initialState.model.provider)
      ) {
        await rpc.setModel(initialModel.provider, initialModel.id);
        initialState = await rpc.getState();
      }
      reportStartup(startup, "connecting-rpc", "completed");

      return {
        id: name,
        name,
        sandbox,
        rpc,
        config,
        configPath,
        worktreeRoot,
        profileDir,
        authRelay: relay,
        initialState,
        relayedProviders: relay.relayedProviders(),
        skippedProviders: prepared.skipped,
      };
    } catch (primaryError) {
      const cleanupErrors: Error[] = [];
      let rpcCloseFailed = false;
      if (rpc) {
        try { await rpc.close(); }
        catch (error) {
          rpcCloseFailed = true;
          cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (sandbox) {
        const activeSandbox = sandbox;
        if (rpcCloseFailed && activeSandbox.rollback) {
          cleanupErrors.push(new Error(
            `Sandbox ${name} and its controller lock were retained because guest RPC closure could not be confirmed. Verify that controller and guest RPC have exited before recovering ownership; retrying startup identifies the lock path.`,
          ));
        } else {
          await collectCleanup(cleanupErrors, () => activeSandbox.rollback
            ? activeSandbox.rollback()
            : activeSandbox.remove());
        }
      }
      authRelay?.cleanup();
      if (!authRelay) provider.credentialBroker.cleanup();
      throw combinePrimaryAndCleanup(primaryError, cleanupErrors);
    }
  }

  private async bootstrap(
    sandbox: SandboxInstance,
    config: PiboxConfig,
    profileDir: string,
    authRelay: AuthRelay,
    modelRegistry: ModelRegistry,
    startup: StartupOptions,
  ): Promise<void> {
    reportStartup(
      startup,
      "running-startup-scripts",
      "detail",
      "Creating Pibox directories",
    );
    await requireSuccess(
      sandbox,
      ["/bin/mkdir", "-p", config.pibox.workdir, profileDir, "/opt/pibox"],
      "create guest directories",
    );

    // Relay model metadata, not host auth/config files or credential headers.
    // Published images can have an older catalog than the controller.
    const providers = guestModelCatalog(
      modelRegistry.getAvailable(),
      authRelay.relayedProviders(),
    );
    await writeGuestFile(
      sandbox,
      `${profileDir}/pibox-models.json`,
      `${JSON.stringify(providers)}\n`,
      "0600",
    );

    const extension = await readFile(this.guestExtensionHostPath, "utf8");
    await writeGuestFile(sandbox, WORKER_EXTENSION_PATH, extension, "0644");
    await writeGuestFile(
      sandbox,
      `${profileDir}/auth.json`,
      `${JSON.stringify(authRelay.guestAuthJson(), null, 2)}\n`,
      "0600",
    );
  }
}

async function startDocker(
  sandbox: SandboxInstance,
  startup: StartupOptions,
): Promise<void> {
  reportStartup(
    startup,
    "running-startup-scripts",
    "detail",
    "Starting Docker Engine",
  );
  await requireSuccess(
    sandbox,
    [
      "/bin/sh",
      "-c",
      `${SERVICE_PATH} docker start && attempt=0; until ${DOCKER_PATH} info >/dev/null 2>&1; do attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || exit 1; sleep 1; done`,
    ],
    "Docker Engine startup",
  );
}

async function installProjectTools(
  sandbox: SandboxInstance,
  workdir: string,
  environment: Readonly<Record<string, string>>,
  startup: StartupOptions,
): Promise<void> {
  reportStartup(
    startup,
    "running-startup-scripts",
    "detail",
    "Installing project tools with mise",
  );
  await requireSuccess(
    sandbox,
    [MISE_PATH, "install", "--yes"],
    "mise install",
    { cwd: workdir, env: environment },
  );
}

async function requireSuccess(
  sandbox: SandboxInstance,
  command: readonly string[],
  context: string,
  options?: ProcessOptions,
): Promise<void> {
  const result = await execute(sandbox, command, options);
  if (!result.success) {
    throw new Error(
      `Guest ${context} exited with ${result.code}${
        result.stderr.trim() ? `: ${result.stderr.trim().slice(-8192)}` : ""
      }`,
    );
  }
}

async function writeGuestFile(
  sandbox: SandboxInstance,
  path: string,
  content: string,
  mode: string,
): Promise<void> {
  const process = await sandbox.startProcess([
    "/bin/sh",
    "-c",
    'umask 077; cat > "$1"',
    "pibox-write",
    path,
  ]);
  let stderr = "";
  let code: number | undefined;
  try {
    await process.write(content);
    const closing = process.close();
    while (true) {
      const event = await process.receive();
      if (event === null) break;
      if (event.type === "stderr") {
        stderr += Buffer.from(event.data).toString("utf8");
      } else if (event.type === "exit") {
        code = event.code;
        break;
      }
    }
    await closing;
  } finally {
    await process.close().catch(() => undefined);
  }
  if (code !== 0) {
    throw new Error(
      `Unable to write guest file ${path}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  await requireSuccess(sandbox, ["/bin/chmod", mode, path], `chmod ${path}`);
}

function validateProfile(profile: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profile)) {
    throw new Error(
      "Worker profile must be 1-64 characters containing only letters, numbers, dot, underscore, and dash",
    );
  }
  return profile;
}

function reportStartup(
  options: StartupOptions,
  phase: StartupPhase,
  kind: StartupProgressEvent["kind"],
  text?: string,
): void {
  options.onProgress?.({
    phase,
    kind,
    ...(text === undefined ? {} : { text }),
  });
}

async function collectCleanup(
  errors: Error[],
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
}

function combinePrimaryAndCleanup(primary: unknown, cleanup: Error[]): Error {
  const error = primary instanceof Error ? primary : new Error(String(primary));
  if (cleanup.length === 0) return error;
  return new Error(
    `${error.message}; cleanup also failed: ${cleanup.map((item) => item.message).join("; ")}`,
    { cause: error },
  );
}
