import type { SandboxProcess } from "./sandbox.js";

export interface RpcRecord {
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse extends RpcRecord {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type RpcThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RpcSessionState {
  model: RpcModel | null;
  thinkingLevel?: RpcThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  pendingMessageCount: number;
  [key: string]: unknown;
}

export interface RpcModel {
  provider: string;
  id: string;
  api: string;
  baseUrl: string;
  [key: string]: unknown;
}

export interface RpcPromptAcceptance {
  disposition: "started" | "queued" | "handled";
}

export interface RpcImage {
  type: "image";
  data: string;
  mimeType: string;
}

export interface RpcBashResult {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
}

interface PendingRequest {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

type RecordListener = (record: RpcRecord) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const BASH_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const PROCESS_CLOSE_TIMEOUT_MS = 7_000;
const STDERR_LIMIT_BYTES = 8 * 1024;

export class PiRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventListeners = new Set<RecordListener>();
  private readonly extensionUiListeners = new Set<RecordListener>();
  private readonly terminationListeners = new Set<(error: Error) => void>();
  private readonly decoder = new StrictJsonlDecoder();
  private readonly exitPromise: Promise<number>;
  private resolveExit!: (code: number) => void;
  private nextRequestId = 1;
  private closed = false;
  private closing = false;
  private exited = false;
  private closePromise: Promise<void> | undefined;
  private stderrTail = "";
  private writeTail: Promise<void> = Promise.resolve();

  private constructor(private readonly process: SandboxProcess) {
    this.exitPromise = new Promise<number>((resolve) => {
      this.resolveExit = resolve;
    });
    void this.pump();
  }

  static connect(process: SandboxProcess): PiRpcClient {
    return new PiRpcClient(process);
  }

  onEvent(listener: RecordListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onExtensionUiRequest(listener: RecordListener): () => void {
    this.extensionUiListeners.add(listener);
    return () => this.extensionUiListeners.delete(listener);
  }

  async request<T = unknown>(
    command: string,
    fields: Record<string, unknown> = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed || this.closing) {
      throw new Error("Worker Pi RPC process is closed");
    }
    const id = `pibox-${this.nextRequestId++}`;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi RPC request ${command} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { command, resolve, reject, timeout });
    });

    try {
      await this.enqueueWrite(`${JSON.stringify({ id, type: command, ...fields })}\n`);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(asError(error));
      }
    }

    const result = await response;
    if (!result.success) {
      throw new Error(result.error ?? `Pi RPC command ${command} failed`);
    }
    return result.data as T;
  }

  prompt(message: string, images?: RpcImage[]): Promise<RpcPromptAcceptance | undefined> {
    // Older guest Pi versions return no acceptance data.
    return this.request<RpcPromptAcceptance | undefined>("prompt", {
      message,
      ...(images?.length ? { images } : {}),
    });
  }

  steer(message: string): Promise<void> {
    return this.request<void>("steer", { message });
  }

  abort(): Promise<void> {
    return this.request<void>("abort");
  }

  getState(): Promise<RpcSessionState> {
    return this.request<RpcSessionState>("get_state");
  }

  getAvailableModels(): Promise<{ models: RpcModel[] }> {
    return this.request<{ models: RpcModel[] }>("get_available_models");
  }

  setModel(provider: string, modelId: string): Promise<RpcModel> {
    return this.request<RpcModel>("set_model", { provider, modelId });
  }

  setThinkingLevel(level: RpcThinkingLevel): Promise<void> {
    return this.request<void>("set_thinking_level", { level });
  }

  cycleModel(): Promise<{
    model: RpcModel;
    thinkingLevel: string;
    isScoped: boolean;
  } | null> {
    return this.request("cycle_model");
  }

  getEntries(since?: string): Promise<unknown> {
    return this.request("get_entries", since === undefined ? {} : { since });
  }

  getMessages(): Promise<{ messages: unknown[] }> {
    return this.request("get_messages");
  }

  getSessionStats(): Promise<unknown> {
    return this.request("get_session_stats");
  }

  bash(command: string, excludeFromContext = false): Promise<RpcBashResult> {
    return this.request<RpcBashResult>(
      "bash",
      { command, excludeFromContext },
      BASH_REQUEST_TIMEOUT_MS,
    );
  }

  waitForEvent(
    type: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RpcRecord> {
    if (this.closed) return Promise.reject(new Error("Worker Pi RPC process is closed"));
    return new Promise<RpcRecord>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.eventListeners.delete(onRecord);
        this.terminationListeners.delete(onTermination);
      };
      const onRecord = (record: RpcRecord): void => {
        if (record.type !== type) return;
        cleanup();
        resolve(record);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error(`Waiting for Pi RPC event ${type} was aborted`));
      };
      const onTermination = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Pi RPC event ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.eventListeners.add(onRecord);
      this.terminationListeners.add(onTermination);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.exited) return Promise.resolve();
    this.closing = true;
    // Transport failure is not proof of termination. Keep the same outcome for
    // all callers, including a later cleanup after an automatic stream failure.
    this.closePromise = this.closeProcess();
    return this.closePromise;
  }

  private async closeProcess(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        (async () => {
          await this.process.close();
          await this.exitPromise;
        })(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(this.processExitError(
            `termination could not be confirmed within ${PROCESS_CLOSE_TIMEOUT_MS}ms`,
          )), PROCESS_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.terminate(new Error("Worker Pi RPC process was closed"));
    }
  }

  private async enqueueWrite(line: string): Promise<void> {
    const write = this.writeTail.then(() => this.process.write(line));
    this.writeTail = write.catch(() => undefined);
    await write;
  }

  private async pump(): Promise<void> {
    try {
      while (true) {
        const event = await this.process.receive();
        if (event === null) {
          this.decoder.finish();
          this.terminate(this.processExitError("ended without an exit event"));
          return;
        }
        switch (event.type) {
          case "stdout":
            if (!this.closed) {
              try {
                for (const record of this.decoder.push(event.data)) this.dispatch(record);
              } catch (error) {
                this.streamFailed(error);
                // Keep draining transport events so close can confirm exit.
              }
            }
            break;
          case "stderr":
            this.captureStderr(event.data);
            break;
          case "exit":
            this.exited = true;
            this.resolveExit(event.code);
            if (!this.closed) this.decoder.finish();
            this.terminate(this.processExitError(`exited with code ${event.code}`));
            return;
        }
      }
    } catch (error) {
      this.streamFailed(error);
    }
  }

  private streamFailed(error: unknown): void {
    const failure = asError(error);
    this.terminate(
      new Error(`Worker Pi RPC stream failed: ${failure.message}`, { cause: failure }),
    );
    // Observe the automatic cleanup rejection, but retain it in closePromise
    // so an explicit close cannot mistake it for successful termination.
    void this.close().catch(() => undefined);
  }

  private dispatch(record: RpcRecord): void {
    if (record.type === "response") {
      this.dispatchResponse(record as RpcResponse);
      return;
    }
    const listeners =
      record.type === "extension_ui_request"
        ? this.extensionUiListeners
        : this.eventListeners;
    for (const listener of [...listeners]) listener(record);
  }

  private dispatchResponse(response: RpcResponse): void {
    if (typeof response.id !== "string") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    if (response.command !== pending.command) {
      pending.reject(
        new Error(
          `Pi RPC response command mismatch: expected ${pending.command}, received ${response.command}`,
        ),
      );
      return;
    }
    pending.resolve(response);
  }

  private captureStderr(chunk: Uint8Array): void {
    this.stderrTail += Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(this.stderrTail) > STDERR_LIMIT_BYTES) {
      this.stderrTail = Buffer.from(this.stderrTail)
        .subarray(-STDERR_LIMIT_BYTES)
        .toString("utf8");
    }
  }

  private processExitError(summary: string): Error {
    const diagnostics = this.stderrTail.trim();
    return new Error(
      `Worker Pi RPC process ${summary}${diagnostics ? `; stderr: ${diagnostics}` : ""}`,
    );
  }

  private terminate(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closing = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of [...this.terminationListeners]) listener(error);
    this.terminationListeners.clear();
  }
}

export class StrictJsonlDecoder {
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private readonly textDecoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Uint8Array): RpcRecord[] {
    this.buffer = concatenate(this.buffer, chunk);
    const records: RpcRecord[] = [];
    let start = 0;
    for (let index = 0; index < this.buffer.length; index += 1) {
      if (this.buffer[index] !== 0x0a) continue;
      let end = index;
      if (end > start && this.buffer[end - 1] === 0x0d) end -= 1;
      const line = this.buffer.subarray(start, end);
      start = index + 1;
      if (line.length === 0) continue;
      records.push(this.parseLine(line));
    }
    this.buffer = this.buffer.slice(start);
    return records;
  }

  finish(): void {
    if (this.buffer.length !== 0) {
      throw new Error("Pi RPC stdout ended with an unterminated JSONL record");
    }
  }

  private parseLine(line: Uint8Array): RpcRecord {
    let value: unknown;
    try {
      value = JSON.parse(this.textDecoder.decode(line));
    } catch (error) {
      throw new Error(`Unable to parse Pi RPC JSONL record: ${asError(error).message}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Pi RPC JSONL record must be an object");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.type !== "string") {
      throw new Error("Pi RPC JSONL record is missing a string type");
    }
    return record as RpcRecord;
  }
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left);
  combined.set(right, left.length);
  return combined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
