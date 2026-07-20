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
const GUEST_PATH = `${NODE_DIR}/bin:${RUNTIME_DIR}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
const DEFAULT_PROFILE = "pibox-worker";
const PI_PACKAGE = "@earendil-works/pi-coding-agent@0.80.8";
const NODE_VERSION = "24.4.1";
const NODE_ASSETS: Partial<Record<NodeJS.Architecture, { arch: string; sha256: string }>> = {
  arm64: {
    arch: "arm64",
    sha256: "555659c36fc72d0617e278b5d26ffcaebc3760a3de354926b1e5f1b0bfd66083",
  },
  x64: {
    arch: "x64",
    sha256: "7e067b13cd0dc7ee8b239f4ebe1ae54f3bba3a6e904553fcb5f581530eb8306d",
  },
};

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
      "PATH",
      "PI_CODING_AGENT_DIR",
      ...prepared.credentials.map((credential) => credential.secretName),
    ]);
    const provider = createSandboxProvider(config.provider, prepared.credentials);
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
      await this.bootstrap(sandbox, config, profileDir, relay, startup);
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
            ...caches.environment,
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
      if (rpc) {
        const activeRpc = rpc;
        await collectCleanup(cleanupErrors, () => activeRpc.close());
      }
      if (sandbox) {
        const activeSandbox = sandbox;
        await collectCleanup(cleanupErrors, () => activeSandbox.remove());
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

    if (await hasPinnedGuestRuntime(sandbox)) {
      reportStartup(
        startup,
        "running-startup-scripts",
        "detail",
        "Using the preinstalled Pibox runtime",
      );
    } else {
      const noninteractive = { env: { DEBIAN_FRONTEND: "noninteractive" } };
      reportStartup(
        startup,
        "running-startup-scripts",
        "detail",
        "Installing Debian bootstrap packages",
      );
      await requireSuccess(
        sandbox,
        ["/usr/bin/apt-get", "update"],
        "apt-get update",
        noninteractive,
      );
      await requireSuccess(
        sandbox,
        [
          "/usr/bin/apt-get",
          "install",
          "-y",
          "--no-install-recommends",
          "ca-certificates",
          "curl",
          "git",
          "xz-utils",
        ],
        "apt-get install",
        noninteractive,
      );
      await requireSuccess(
        sandbox,
        ["/bin/rm", "-rf", "/var/lib/apt/lists"],
        "apt cache cleanup",
      );

      reportStartup(
        startup,
        "running-startup-scripts",
        "detail",
        `Installing Node.js ${NODE_VERSION}`,
      );
      await installNode(sandbox);

      reportStartup(
        startup,
        "running-startup-scripts",
        "detail",
        "Installing Pi",
      );
      await requireSuccess(
        sandbox,
        [
          `${NODE_DIR}/bin/npm`,
          "install",
          "--global",
          "--prefix",
          RUNTIME_DIR,
          "--no-audit",
          "--no-fund",
          PI_PACKAGE,
        ],
        "Pi installation",
        { env: { PATH: GUEST_PATH } },
      );
    }

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

async function hasPinnedGuestRuntime(sandbox: SandboxInstance): Promise<boolean> {
  const nodePresent = await execute(sandbox, ["/usr/bin/test", "-x", `${NODE_DIR}/bin/node`]);
  if (!nodePresent.success) return false;
  const node = await execute(sandbox, [`${NODE_DIR}/bin/node`, "--version"]);
  if (!node.success || node.stdout.trim() !== `v${NODE_VERSION}`) return false;

  const piPresent = await execute(sandbox, ["/usr/bin/test", "-x", PI_PATH]);
  if (!piPresent.success) return false;
  const pi = await execute(sandbox, [PI_PATH, "--version"], {
    env: { PATH: GUEST_PATH },
  });
  if (
    !pi.success ||
    pi.stdout.trim() !== PI_PACKAGE.slice(PI_PACKAGE.lastIndexOf("@") + 1)
  ) {
    return false;
  }

  const git = await execute(sandbox, ["/usr/bin/test", "-x", "/usr/bin/git"]);
  return git.success;
}

async function installNode(sandbox: SandboxInstance): Promise<void> {
  const asset = NODE_ASSETS[process.arch];
  if (!asset) {
    throw new Error(`Node.js bootstrap is not available for architecture ${process.arch}`);
  }
  const archive = `node-v${NODE_VERSION}-linux-${asset.arch}.tar.xz`;
  await requireSuccess(
    sandbox,
    [
      "/usr/bin/curl",
      "--proto",
      "=https",
      "--tlsv1.2",
      "-fsSL",
      `https://nodejs.org/dist/v${NODE_VERSION}/${archive}`,
      "-o",
      "/tmp/node.tar.xz",
    ],
    "Node.js download",
  );
  const digest = await execute(sandbox, ["/usr/bin/sha256sum", "/tmp/node.tar.xz"]);
  if (!digest.success) {
    throw new Error(`Guest Node.js checksum command exited with ${digest.code}`);
  }
  const actual = digest.stdout.trim().split(/\s+/, 1)[0];
  if (actual !== asset.sha256) {
    throw new Error(
      `Node.js checksum mismatch: expected ${asset.sha256}, received ${actual ?? "empty output"}`,
    );
  }
  await requireSuccess(sandbox, ["/bin/mkdir", "-p", NODE_DIR], "Node.js directory creation");
  await requireSuccess(
    sandbox,
    [
      "/bin/tar",
      "-xJf",
      "/tmp/node.tar.xz",
      "--strip-components=1",
      "-C",
      NODE_DIR,
    ],
    "Node.js extraction",
  );
  await requireSuccess(sandbox, ["/bin/rm", "-f", "/tmp/node.tar.xz"], "Node.js cleanup");
  await requireSuccess(sandbox, [`${NODE_DIR}/bin/node`, "--version"], "Node.js verification");
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
