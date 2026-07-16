import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkerCreateOptions } from "./worker-manager.js";
import type { WorkerRegistry } from "./worker-registry.js";

const workerIdSchema = Type.Object({
  workerId: Type.String({ description: "Active worker identifier returned by worker_create" }),
});

export function registerTools(pi: ExtensionAPI, registry: WorkerRegistry): void {
  pi.registerTool({
    name: "worker_create",
    label: "Create Worker",
    description:
      "Create a worktree-aware Pibox sandbox, relay host model authentication, bootstrap Pi, and start a complete Pi RPC worker.",
    parameters: Type.Object({
      config: Type.Optional(Type.String({ description: "Config path relative to the worktree" })),
      worktree: Type.Optional(Type.String({ description: "Git worktree path relative to the host Pi cwd" })),
      profile: Type.Optional(Type.String({ description: "Guest-only Pi profile name" })),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.(textResult("Creating and bootstrapping Pibox worker..."));
      const options: WorkerCreateOptions = {};
      if (params.config !== undefined) options.config = params.config;
      if (params.worktree !== undefined) options.worktree = params.worktree;
      if (params.profile !== undefined) options.profile = params.profile;
      const worker = await registry.create(ctx.cwd, options, ctx.modelRegistry);
      const state = await worker.state();
      return jsonResult({
        workerId: worker.id,
        name: worker.name,
        configPath: worker.configPath,
        worktreeRoot: worker.worktreeRoot,
        relayedProviders: worker.relayedProviders,
        skippedProviders: worker.skippedProviders,
        state: state.state,
      });
    },
  });

  pi.registerTool({
    name: "worker_prompt",
    label: "Prompt Worker",
    description:
      "Refresh the worker provider credential, send a prompt to worker Pi, wait until its run settles, and return its latest assistant response.",
    parameters: Type.Object({
      workerId: Type.String(),
      message: Type.String(),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.(textResult(`Prompting worker ${params.workerId}...`));
      const result = await registry
        .get(params.workerId)
        .prompt(params.message, signal ? { signal } : {});
      return jsonResult({
        accepted: result.accepted,
        state: result.state,
        lastAssistantText: truncateUtf8(result.lastAssistantText, 40 * 1024),
        sessionStats: result.sessionStats,
      });
    },
  });

  pi.registerTool({
    name: "worker_state",
    label: "Worker State",
    description: "Read current Pi RPC state and session statistics for an active worker.",
    parameters: workerIdSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = await registry.get(params.workerId).state();
      return jsonResult({
        state: result.state,
        messageCount: result.messages.length,
        sessionStats: result.sessionStats,
      });
    },
  });

  pi.registerTool({
    name: "worker_steer",
    label: "Steer Worker",
    description: "Queue a steering message while an active worker Pi run is streaming.",
    parameters: Type.Object({
      workerId: Type.String(),
      message: Type.String(),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await registry.get(params.workerId).steer(params.message);
      return textResult(`Steering queued for ${params.workerId}`);
    },
  });

  pi.registerTool({
    name: "worker_abort",
    label: "Abort Worker",
    description: "Abort the current Pi operation in an active worker.",
    parameters: workerIdSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await registry.get(params.workerId).abort();
      return textResult(`Abort requested for ${params.workerId}`);
    },
  });

  pi.registerTool({
    name: "worker_set_model",
    label: "Set Worker Model",
    description:
      "Ensure the provider credential is installed, verify model availability, and select a model in worker Pi.",
    parameters: Type.Object({
      workerId: Type.String(),
      provider: Type.String(),
      modelId: Type.String(),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const model = await registry
        .get(params.workerId)
        .setModel(params.provider, params.modelId);
      return jsonResult({ workerId: params.workerId, model });
    },
  });

  pi.registerTool({
    name: "worker_remove",
    label: "Remove Worker",
    description:
      "Abort and stop an active worker, stop its services and sandbox, clear relay environment variables, and remove persisted sandbox state.",
    parameters: workerIdSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await registry.remove(params.workerId);
      return textResult(`Removed worker ${params.workerId}`);
    },
  });
}

function textResult(text: string): {
  content: [{ type: "text"; text: string }];
  details: Record<string, never>;
} {
  return { content: [{ type: "text", text }], details: {} };
}

function jsonResult(value: unknown): {
  content: [{ type: "text"; text: string }];
  details: Record<string, never>;
} {
  return textResult(JSON.stringify(value, null, 2));
}

function truncateUtf8(value: string | null, maxBytes: number): string | null {
  if (value === null || Buffer.byteLength(value) <= maxBytes) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width > maxBytes) break;
    result += character;
    bytes += width;
  }
  return `${result}\n[Worker response truncated]`;
}
