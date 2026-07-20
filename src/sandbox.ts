export interface SandboxMount {
  source: string;
  target: string;
}

export interface SandboxProvider {
  create(
    name: string,
    config: Record<string, unknown>,
    mounts: readonly SandboxMount[],
  ): Promise<SandboxInstance>;
}

export interface SandboxInstance {
  startProcess(
    command: readonly string[],
    options?: ProcessOptions,
  ): Promise<SandboxProcess>;

  stop(): Promise<void>;
  remove(): Promise<void>;
}

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface SandboxProcess {
  write(data: string | Uint8Array): Promise<void>;
  receive(): Promise<ProcessEvent | null>;
  close(): Promise<void>;
}

export type ProcessEvent =
  | { type: "stdout"; data: Uint8Array }
  | { type: "stderr"; data: Uint8Array }
  | { type: "exit"; code: number };

export interface ExecResult {
  code: number;
  success: boolean;
  stdout: string;
  stderr: string;
  stdoutBytes: Uint8Array;
  stderrBytes: Uint8Array;
}

export async function execute(
  instance: SandboxInstance,
  command: readonly string[],
  options?: ProcessOptions,
): Promise<ExecResult> {
  if (command.length === 0) throw new Error("Sandbox command must not be empty");

  const process = await instance.startProcess(command, options);
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let code: number | undefined;

  try {
    while (true) {
      const event = await process.receive();
      if (event === null) break;
      if (event.type === "stdout") stdout.push(event.data);
      else if (event.type === "stderr") stderr.push(event.data);
      else {
        code = event.code;
        break;
      }
    }
  } finally {
    await process.close().catch(() => undefined);
  }

  if (code === undefined) {
    throw new Error("Sandbox process ended without an exit event");
  }

  const stdoutBytes = concatenate(stdout);
  const stderrBytes = concatenate(stderr);
  return {
    code,
    success: code === 0,
    stdout: Buffer.from(stdoutBytes).toString("utf8"),
    stderr: Buffer.from(stderrBytes).toString("utf8"),
    stdoutBytes,
    stderrBytes,
  };
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
