import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import {
  registerInteractiveBridge,
  setBridgeStartingStatus,
  syncBridgeStatus,
} from "./interactive-bridge.js";
import { runWithStartupUi } from "./startup-ui.js";
import { registerTools } from "./tools.js";
import { WorkerRegistry } from "./worker-registry.js";

export default function piboxExtension(pi: ExtensionAPI): void {
  const registry = new WorkerRegistry();
  registerCommands(pi, registry);
  registerTools(pi, registry);
  registerInteractiveBridge(pi, registry);

  pi.registerFlag("pibox", {
    description: "Start and enter the configured Pibox worker",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || pi.getFlag("pibox") !== true) return;

    setBridgeStartingStatus(ctx);
    try {
      const worker = await runWithStartupUi(ctx, (startup) =>
        registry.createAndRoute(ctx.cwd, {}, ctx.modelRegistry, startup),
      );
      syncBridgeStatus(ctx, registry);
      ctx.ui.notify(
        `Worker ${worker.id} is ready and connected over RPC (${worker.worktreeRoot})`,
        "info",
      );
    } catch (error) {
      syncBridgeStatus(ctx, registry);
      ctx.ui.notify(
        `Unable to start Pibox: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await registry.shutdownAll();
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  });
}
