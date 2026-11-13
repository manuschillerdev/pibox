import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { syncBridgeStatus } from "./interactive-bridge.js";
import { showNetworkOverlay } from "./network-ui.js";
import { runWithStartupUi } from "./startup-ui.js";
import type { WorkerCreateOptions } from "./worker-manager.js";
import type { WorkerRegistry } from "./worker-registry.js";

export function registerCommands(
  pi: ExtensionAPI,
  registry: WorkerRegistry,
): void {
  pi.registerCommand("pibox", {
    description: "Create or enter the Pibox worker for the current worktree",
    handler: command(async (args, ctx) => {
      const options = parseCreateOptions(splitArguments(args));
      const worker = await runWithStartupUi(ctx, (startup) =>
        registry.upsertAndRoute(ctx.cwd, options, ctx.modelRegistry, startup),
      );
      syncBridgeStatus(ctx, registry);
      ctx.ui.notify(
        `Worker ${worker.id} is ready and connected over RPC (${worker.worktreeRoot})`,
        "info",
      );
    }),
  });

  pi.registerCommand("pibox-vscode", {
    description: "Prepare key-only SSH and open a smolVM workspace in VS Code",
    handler: command(async (args, ctx) => {
      const explicit = singleArgument(args, "/pibox-vscode");
      const worker = explicit ? registry.get(explicit) : registry.routed();
      if (!worker) throw new Error("Connect a worker with /pibox first, or use /pibox-vscode <worker>");
      const vscode = worker.vscode;
      await vscode.preflight();
      if (!ctx.hasUI) throw new Error("/pibox-vscode requires UI confirmation before provisioning SSH");
      if (!await ctx.ui.confirm("Open Pibox in VS Code?", "Install OpenSSH in the guest if needed and start a dedicated key-only root SSH daemon? Pibox will publish it on host loopback, generate a private host identity, and add a managed Include to ~/.ssh/config (backing up existing contents). Existing SSH services and guest workspace permissions are unchanged. Use the default Remote - SSH config file; custom remote.SSH.configFile settings are unsupported.")) return;
      ctx.ui.notify("Preparing guest SSH and VS Code connection (first install may take a few minutes)…", "info");
      const alias = await vscode.open();
      ctx.ui.notify(`Opened VS Code via ${alias}. Keep this Pibox controller running.`, "info");
    }),
  });

  pi.registerCommand("pibox-net", {
    description: "Discover and publish guest TCP services without restarting the worker",
    handler: command(async (args, ctx) => {
      const explicit = singleArgument(args, "/pibox-net");
      const worker = explicit ? registry.get(explicit) : registry.routed();
      if (!worker) throw new Error("Connect a worker with /pibox first, or use /pibox-net <worker>");
      await showNetworkOverlay(pi, ctx, worker.network, worker.name);
    }),
  });

  pi.registerCommand("pibox-leave", {
    description: "Stop the connected worker and return input to the host Pi session",
    handler: command(async (args, ctx) => {
      const argv = splitArguments(args);
      const keepRunning = removeFlag(argv, "--keep-running");
      if (argv.length > 0) throw new Error("Usage: /pibox-leave [--keep-running]");
      const workerId = registry.leave();
      syncBridgeStatus(ctx, registry);
      if (!workerId) {
        ctx.ui.notify("No worker was connected", "info");
        return;
      }
      if (keepRunning) {
        ctx.ui.notify(`Disconnected from ${workerId}; worker is still running`, "info");
        return;
      }
      await registry.stop(workerId);
      syncBridgeStatus(ctx, registry);
      ctx.ui.notify(`Disconnected from and stopped ${workerId}`, "info");
    }),
  });

  pi.registerCommand("pibox-stop", {
    description: "Gracefully stop an active Pibox worker",
    handler: command(async (args, ctx) => {
      const name = await targetName(registry, ctx, singleArgument(args, "/pibox-stop"));
      try {
        await registry.stop(name);
      } finally {
        syncBridgeStatus(ctx, registry);
      }
      ctx.ui.notify(`Stopped ${name}`, "info");
    }),
  });

  pi.registerCommand("pibox-rm", {
    description: "Stop and remove an active Pibox worker",
    handler: command(async (args, ctx) => {
      const name = await targetName(registry, ctx, singleArgument(args, "/pibox-rm"));
      try {
        await registry.remove(name);
      } finally {
        syncBridgeStatus(ctx, registry);
      }
      ctx.ui.notify(`Removed ${name}`, "info");
    }),
  });
}

function command(
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args, ctx) => {
    try {
      await handler(args, ctx);
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  };
}

function parseCreateOptions(argv: string[]): WorkerCreateOptions {
  const options: WorkerCreateOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      options.config = requireValue(argv, ++index, argument);
    } else if (argument === "--worktree") {
      options.worktree = requireValue(argv, ++index, argument);
    } else if (argument === "--profile") {
      options.profile = requireValue(argv, ++index, argument);
    } else if (argument?.startsWith("--")) {
      throw new Error(`Unknown option ${argument}`);
    } else if (argument && options.config === undefined) {
      options.config = argument;
    } else if (argument) {
      throw new Error(`Unexpected argument ${argument}`);
    }
  }
  return options;
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

async function targetName(
  registry: WorkerRegistry,
  ctx: ExtensionCommandContext,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;
  return (await registry.manager.configuredName(ctx.cwd)).name;
}

function singleArgument(input: string, commandName: string): string | undefined {
  const argv = splitArguments(input);
  if (argv.length > 1) throw new Error(`Usage: ${commandName} [worker]`);
  return argv[0];
}

function removeFlag(argv: string[], flag: string): boolean {
  const index = argv.indexOf(flag);
  if (index < 0) return false;
  argv.splice(index, 1);
  return true;
}

export function splitArguments(input: string): string[] {
  const output: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of input.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        output.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unterminated quote in command arguments");
  if (current) output.push(current);
  return output;
}
