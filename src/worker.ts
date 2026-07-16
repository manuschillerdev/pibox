import type { AppliedCredential } from "./auth-relay.js";
import type {
  RpcBashResult,
  RpcImage,
  RpcModel,
  RpcRecord,
  RpcSessionState,
} from "./pi-rpc.js";
import type { StartedWorker } from "./worker-manager.js";

const PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
const RPC_SHUTDOWN_REQUEST_TIMEOUT_MS = 2_000;
const RPC_CLOSE_TIMEOUT_MS = 8_000;
const SANDBOX_STOP_TIMEOUT_MS = 8_000;

export interface WorkerPromptResult {
  accepted: true;
  state: RpcSessionState;
  lastAssistantText: string | null;
  messages: unknown[];
  sessionStats: unknown;
}

export interface WorkerStateResult {
  state: RpcSessionState;
  messages: unknown[];
  sessionStats: unknown;
}

export interface WorkerPromptOptions {
  signal?: AbortSignal;
  images?: RpcImage[];
}

export class Worker {
  readonly id: string;
  readonly name: string;
  readonly sandbox: StartedWorker["sandbox"];
  readonly rpc: StartedWorker["rpc"];
  readonly configPath: string;
  readonly worktreeRoot: string;
  readonly providerState: Map<string, AppliedCredential>;
  readonly relayedProviders: string[];
  readonly skippedProviders: StartedWorker["skippedProviders"];
  private closed = false;

  constructor(private readonly started: StartedWorker) {
    this.id = started.id;
    this.name = started.name;
    this.sandbox = started.sandbox;
    this.rpc = started.rpc;
    this.configPath = started.configPath;
    this.worktreeRoot = started.worktreeRoot;
    this.providerState = started.authRelay.providerState;
    this.relayedProviders = started.relayedProviders;
    this.skippedProviders = started.skippedProviders;
  }

  async prompt(
    message: string,
    options: WorkerPromptOptions = {},
  ): Promise<WorkerPromptResult> {
    this.assertOpen();
    const { signal, images } = options;
    if (signal?.aborted) throw new Error("Worker prompt was aborted before it started");
    const before = await this.rpc.getState();
    const provider = before.model?.provider;
    if (!provider) throw new Error(`Worker ${this.id} has no selected model`);
    await this.started.authRelay.refresh(provider);

    const waitController = new AbortController();
    const onAbort = (): void => {
      waitController.abort();
      void this.rpc.abort().catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const settled = this.rpc.waitForEvent(
      "agent_settled",
      PROMPT_TIMEOUT_MS,
      waitController.signal,
    );
    try {
      await this.rpc.prompt(message, images);
      await settled;
    } catch (error) {
      waitController.abort();
      await settled.catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }

    const [state, messageData, sessionStats] = await Promise.all([
      this.rpc.getState(),
      this.rpc.getMessages(),
      this.rpc.getSessionStats(),
    ]);
    return {
      accepted: true,
      state,
      lastAssistantText: lastAssistantText(messageData.messages),
      messages: messageData.messages,
      sessionStats,
    };
  }

  async state(): Promise<WorkerStateResult> {
    this.assertOpen();
    const [state, messageData, sessionStats] = await Promise.all([
      this.rpc.getState(),
      this.rpc.getMessages(),
      this.rpc.getSessionStats(),
    ]);
    return { state, messages: messageData.messages, sessionStats };
  }

  async bash(command: string, excludeFromContext = false): Promise<RpcBashResult> {
    this.assertOpen();
    return await this.rpc.bash(command, excludeFromContext);
  }

  async steer(message: string): Promise<void> {
    this.assertOpen();
    await this.rpc.steer(message);
  }

  async abort(): Promise<void> {
    this.assertOpen();
    await this.rpc.abort();
  }

  async setModel(provider: string, modelId: string): Promise<RpcModel> {
    this.assertOpen();
    await this.started.authRelay.refresh(provider);
    const available = await this.rpc.getAvailableModels();
    if (
      !available.models.some(
        (model) => model.provider === provider && model.id === modelId,
      )
    ) {
      throw new Error(`Model ${provider}/${modelId} is not available in worker ${this.id}`);
    }
    const selected = await this.rpc.setModel(provider, modelId);
    if (selected.provider !== provider || selected.id !== modelId) {
      throw new Error(
        `Worker selected ${selected.provider}/${selected.id} instead of ${provider}/${modelId}`,
      );
    }
    return selected;
  }

  onEvent(listener: (record: RpcRecord) => void): () => void {
    return this.rpc.onEvent(listener);
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const cleanupErrors: Error[] = [];

    try {
      const state = await withDeadline(
        this.rpc.getState(),
        RPC_SHUTDOWN_REQUEST_TIMEOUT_MS,
        `Worker ${this.id} RPC state check`,
      );
      if (state.isStreaming) {
        await withDeadline(
          this.rpc.abort(),
          RPC_SHUTDOWN_REQUEST_TIMEOUT_MS,
          `Worker ${this.id} RPC abort`,
        );
      }
    } catch (error) {
      cleanupErrors.push(asError(error));
    }

    await cleanup(cleanupErrors, () =>
      withDeadline(this.rpc.close(), RPC_CLOSE_TIMEOUT_MS, `Worker ${this.id} RPC close`),
    );
    await cleanup(cleanupErrors, () =>
      withDeadline(
        this.sandbox.stop(),
        SANDBOX_STOP_TIMEOUT_MS,
        `Worker ${this.id} sandbox stop`,
      ),
    );
    this.started.authRelay.cleanup();

    if (cleanupErrors.length > 0) {
      throw new Error(
        `Worker ${this.id} cleanup failed: ${cleanupErrors
          .map((error) => error.message)
          .join("; ")}`,
      );
    }
  }

  async shutdownAndRemove(): Promise<void> {
    let primary: Error | undefined;
    try {
      await this.shutdown();
    } catch (error) {
      primary = asError(error);
    }
    try {
      await this.sandbox.remove();
    } catch (error) {
      const removal = asError(error);
      if (primary) {
        throw new Error(`${primary.message}; sandbox removal failed: ${removal.message}`, {
          cause: primary,
        });
      }
      throw removal;
    }
    if (primary) throw primary;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Worker ${this.id} is closed`);
  }
}

function lastAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
    const text = record.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as Record<string, unknown>).type === "text" &&
          typeof (part as Record<string, unknown>).text === "string",
      )
      .map((part) => part.text)
      .join("");
    return text || null;
  }
  return null;
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function cleanup(
  errors: Error[],
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(asError(error));
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
