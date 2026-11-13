import { isIP } from "node:net";
import type { SandboxInstance, SandboxProcess } from "./sandbox.js";
import { DISCOVER_SCRIPT } from "./network-guest.js";

export const NETWORK_NODE = "/opt/pibox/node/bin/node";
export interface DockerService {
  id: string;
  name: string;
  containerPort: number;
  project: string;
  service: string;
  replica: string;
}
export interface GuestListener { host: string; port: number; address: string; process: string; docker?: DockerService }
export function listenerKey(listener: Pick<GuestListener, "host" | "port">): string {
  return `${listener.host}:${listener.port}`;
}
export function validateDestination(host: string, port: number): void {
  if (!isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid guest TCP endpoint");
  }
}

export async function discoverListeners(sandbox: SandboxInstance, lifetime?: AbortSignal): Promise<GuestListener[]> {
  const controller = new AbortController();
  const signal = lifetime ? AbortSignal.any([controller.signal, lifetime]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error("Guest discovery timed out")), 12_000);
  let process: SandboxProcess | undefined;
  let output = "";
  try {
    process = await startNetworkProcess(sandbox, [NETWORK_NODE, "-e", DISCOVER_SCRIPT], signal);
    for (;;) {
      const event = await abortable(process.receive(), signal);
      if (!event) throw new Error("Guest listener discovery ended unexpectedly");
      if (event.type === "stdout") {
        output += Buffer.from(event.data).toString("utf8");
        if (output.length > 1_048_576) throw new Error("Too many guest listeners");
      }
      if (event.type === "exit") {
        if (event.code !== 0) throw new Error("Guest listener discovery failed");
        const rows: unknown = JSON.parse(output);
        if (!Array.isArray(rows)) throw new Error("Invalid guest listener list");
        return groupDockerListeners(rows.map((row: unknown) => {
          if (!row || typeof row !== "object") throw new Error("Invalid guest listener");
          const r = row as Record<string, unknown>;
          if (typeof r.host !== "string" || typeof r.port !== "number" ||
              typeof r.address !== "string" || typeof r.process !== "string") throw new Error("Invalid guest listener");
          validateDestination(r.host, r.port);
          const docker = parseDockerService(r.docker);
          return { host: r.host, port: r.port, address: r.address, process: r.process, ...(docker ? { docker } : {}) };
        }));
      }
    }
  } finally {
    clearTimeout(timer);
    if (process) await closeNetworkProcess(process);
  }
}

export async function startNetworkProcess(sandbox: SandboxInstance, command: string[], signal: AbortSignal): Promise<SandboxProcess> {
  const pending = sandbox.startProcess(command);
  void pending.then((child) => {
    if (signal.aborted) void closeNetworkProcess(child).catch(() => undefined);
  }, () => undefined);
  return abortable(pending, signal);
}
async function closeNetworkProcess(process: SandboxProcess): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Guest discovery cleanup timed out")), 8000);
  try { await abortable(process.close(), controller.signal); } finally { clearTimeout(timer); }
}
export async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Network operation cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}


function parseDockerService(value: unknown): DockerService | undefined {
  if (!value || typeof value !== "object") return undefined;
  const d = value as Record<string, unknown>;
  if (["id", "name", "project", "service", "replica"].some((key) => typeof d[key] !== "string") ||
      typeof d.containerPort !== "number" || !Number.isInteger(d.containerPort) || d.containerPort < 1 || d.containerPort > 65535) return undefined;
  return d as unknown as DockerService;
}

/** Only collapse a proven pair of Docker wildcard bindings, not arbitrary sockets. */
export function groupDockerListeners(rows: GuestListener[]): GuestListener[] {
  return rows.filter((row) => !(row.address === "::" && row.docker?.id && rows.some((other) =>
    other.address === "0.0.0.0" && other.port === row.port &&
    other.docker?.id === row.docker!.id && other.docker?.containerPort === row.docker!.containerPort,
  )));
}
