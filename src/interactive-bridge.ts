import { randomUUID } from "node:crypto";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Container,
  Markdown,
  Text,
} from "@earendil-works/pi-tui";
import type { RpcRecord } from "./pi-rpc.js";
import type { WorkerRegistry } from "./worker-registry.js";

const ENTRY_TYPE = "pibox-rpc-message";
const STATUS_KEY = "pibox-rpc";

interface RpcTranscriptEntry {
  workerId: string;
  role: "user" | "assistant" | "error" | "stream";
  text: string;
  imageCount?: number;
  provider?: string;
  modelId?: string;
  streamId?: string;
}

interface StreamPreview {
  text: string;
  activity: string;
}

export function registerInteractiveBridge(
  pi: ExtensionAPI,
  registry: WorkerRegistry,
): void {
  const streamPreviews = new Map<string, StreamPreview>();
  const supportsEntryRenderer = typeof pi.registerEntryRenderer === "function";
  if (supportsEntryRenderer) {
    pi.registerEntryRenderer<RpcTranscriptEntry>(
      ENTRY_TYPE,
      (entry, _options, theme) =>
        renderTranscriptEntry(entry.data, theme, streamPreviews),
    );
  } else {
    pi.registerMessageRenderer<RpcTranscriptEntry>(
      ENTRY_TYPE,
      (message, _options, theme) =>
        renderTranscriptEntry(message.details, theme, streamPreviews),
    );
  }

  pi.on("model_select", async (event, ctx) => {
    const worker = registry.routed();
    if (!worker) return;
    try {
      await worker.setModel(event.model.provider, event.model.id);
    } catch (error) {
      ctx.ui.notify(`Could not select worker model: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const worker = registry.routed();
    if (!worker) {
      clearBridgeUi(ctx);
      return { action: "continue" };
    }

    appendTranscriptEntry(pi, supportsEntryRenderer, {
      workerId: worker.id,
      role: "user",
      text: event.text,
      ...(event.images?.length ? { imageCount: event.images.length } : {}),
    });

    const streamId = randomUUID();
    const preview: StreamPreview = { text: "", activity: "thinking" };
    streamPreviews.set(streamId, preview);
    appendTranscriptEntry(pi, supportsEntryRenderer, {
      workerId: worker.id,
      role: "stream",
      text: "",
      streamId,
    });
    updateBridgeStatus(ctx, worker.id, preview);
    const unsubscribe = worker.onEvent((record) => {
      updatePreview(preview, record);
      updateBridgeStatus(ctx, worker.id, preview);
    });

    try {
      // Also synchronize on the first prompt and after switching workers. Session
      // restoration and worker creation do not emit a host model_select event.
      if (ctx.model) {
        const state = await worker.rpc.getState();
        if (
          state.model?.provider !== ctx.model.provider ||
          state.model.id !== ctx.model.id
        ) {
          await worker.setModel(ctx.model.provider, ctx.model.id);
        }
      }
      const result = await worker.prompt(event.text, {
        ...(event.images?.length ? { images: event.images } : {}),
      });
      const model = result.state.model;
      streamPreviews.delete(streamId);
      appendTranscriptEntry(pi, supportsEntryRenderer, {
        workerId: worker.id,
        role: "assistant",
        text: result.lastAssistantText ?? "_(Worker returned no assistant text.)_",
        ...(model ? { provider: model.provider, modelId: model.id } : {}),
      });
    } catch (error) {
      const message = errorMessage(error);
      streamPreviews.delete(streamId);
      appendTranscriptEntry(pi, supportsEntryRenderer, {
        workerId: worker.id,
        role: "error",
        text: message,
      });
      ctx.ui.notify(message, "error");
    } finally {
      unsubscribe();
      streamPreviews.delete(streamId);
      syncBridgeStatus(ctx, registry);
    }

    return { action: "handled" };
  });

  pi.on("user_bash", async (event, ctx) => {
    const worker = registry.routed();
    if (!worker) return;

    ctx.ui.setStatus(STATUS_KEY, `${worker.id} · bash`);
    try {
      return {
        result: await worker.bash(event.command, event.excludeFromContext),
      };
    } catch (error) {
      const message = errorMessage(error);
      ctx.ui.notify(message, "error");
      return {
        result: {
          output: `Pibox RPC error: ${message}`,
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    } finally {
      syncBridgeStatus(ctx, registry);
    }
  });
}

function appendTranscriptEntry(
  pi: ExtensionAPI,
  supportsEntryRenderer: boolean,
  data: RpcTranscriptEntry,
): void {
  if (supportsEntryRenderer) {
    pi.appendEntry<RpcTranscriptEntry>(ENTRY_TYPE, data);
    return;
  }
  pi.sendMessage<RpcTranscriptEntry>({
    customType: ENTRY_TYPE,
    content: data.text,
    display: true,
    details: data,
  });
}

function renderTranscriptEntry(
  data: RpcTranscriptEntry | undefined,
  theme: Theme,
  streamPreviews: ReadonlyMap<string, StreamPreview>,
): Component {
  if (!data) return new Text(theme.fg("error", "Invalid Pibox RPC entry"), 0, 0);

  if (data.role === "stream") {
    return new StreamingTranscriptComponent(data.streamId, streamPreviews, theme);
  }

  if (data.role === "user") {
    const attachment = data.imageCount
      ? `\n[${data.imageCount} image${data.imageCount === 1 ? "" : "s"}]`
      : "";
    const box = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
    box.addChild(
      new Text(theme.fg("userMessageText", `${data.text}${attachment}`), 0, 0),
    );
    return box;
  }

  if (data.role === "error") {
    const box = new Box(1, 0, (text) => theme.bg("toolErrorBg", text));
    box.addChild(new Text(theme.fg("error", data.text), 0, 0));
    return box;
  }

  const model =
    data.provider && data.modelId ? ` · ${data.provider}/${data.modelId}` : "";
  const output = new Container();
  output.addChild(new Text(theme.fg("dim", `${data.workerId}${model}`), 0, 0));
  output.addChild(new Markdown(data.text, 0, 0, getMarkdownTheme()));
  return output;
}

class StreamingTranscriptComponent implements Component {
  private readonly markdown = new Markdown("", 0, 0, getMarkdownTheme());

  constructor(
    private readonly streamId: string | undefined,
    private readonly streamPreviews: ReadonlyMap<string, StreamPreview>,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const preview = this.streamId
      ? this.streamPreviews.get(this.streamId)
      : undefined;
    if (!preview) return [];
    const activity = new Text(
      this.theme.fg("dim", `… ${preview.activity}`),
      0,
      0,
    ).render(width);
    if (!preview.text) return activity;
    this.markdown.setText(`${preview.text}▌`);
    return [...this.markdown.render(width), ...activity];
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}

export function setBridgeStartingStatus(
  ctx: Pick<ExtensionContext, "ui">,
): void {
  ctx.ui.setStatus(STATUS_KEY, "Pibox · starting");
}

export function syncBridgeStatus(
  ctx: Pick<ExtensionContext, "ui">,
  registry: WorkerRegistry,
): void {
  const worker = registry.routed();
  ctx.ui.setStatus(STATUS_KEY, worker ? `RPC → ${worker.id}` : undefined);
}

function clearBridgeUi(ctx: Pick<ExtensionContext, "ui">): void {
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

function updateBridgeStatus(
  ctx: Pick<ExtensionContext, "ui">,
  workerId: string,
  preview: StreamPreview,
): void {
  ctx.ui.setStatus(STATUS_KEY, `${workerId} · ${preview.activity}`);
}

function updatePreview(preview: StreamPreview, record: RpcRecord): void {
  switch (record.type) {
    case "message_start":
      if (object(record.message)?.role === "assistant") {
        preview.text = "";
        preview.activity = "thinking";
      }
      break;
    case "message_update": {
      const event = object(record.assistantMessageEvent);
      if (event?.type === "thinking_delta") {
        preview.activity = "thinking";
      } else if (event?.type === "text_delta" && typeof event.delta === "string") {
        preview.activity = "responding";
        preview.text += event.delta;
      }
      break;
    }
    case "tool_execution_start":
      preview.activity =
        typeof record.toolName === "string" ? `running ${record.toolName}` : "running tool";
      break;
    case "tool_execution_end":
      preview.activity = "responding";
      break;
    case "auto_retry_start":
      preview.text = "";
      preview.activity = "retrying";
      break;
    case "compaction_start":
      preview.activity = "compacting";
      break;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
