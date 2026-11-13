import { randomBytes } from "node:crypto";
import { execute, type SandboxInstance } from "./sandbox.js";
import { listenerKey, NETWORK_NODE, type GuestListener } from "./network-discovery.js";
import type { PublishedService, WorkerNetwork } from "./network.js";
import { VSCODE_GUEST } from "./vscode-guest.js";
import { hasControls, publicKey, VscodeHost } from "./vscode-host.js";

export type VscodeHostOperations = Pick<VscodeHost, "id" | "alias" | "preflight" | "prepare" | "configure" | "probe" | "launch" | "remove">;

/** One SSH identity and daemon per live worker; native mappings belong to WorkerNetwork. */
export class WorkerVscode {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private service: PublishedService | undefined;
  private guestTouched = false;
  private pinnedHostKey: string | undefined;
  constructor(
    private readonly sandbox: SandboxInstance,
    private readonly network: WorkerNetwork,
    private readonly provider: string,
    private readonly workdir: string,
    private readonly host: VscodeHostOperations = new VscodeHost(randomBytes(16).toString("hex")),
  ) {}
  async preflight(): Promise<void> {
    this.assertOpen();
    if (this.provider !== "smolvm") throw new Error("/pibox-vscode currently supports smolVM only; Microsandbox TCP publishing is not available");
    if (!this.workdir.startsWith("/") || hasControls(this.workdir)) throw new Error("Invalid guest workspace path");
    await this.network.permission();
    await this.host.preflight();
    this.assertOpen();
  }
  open(): Promise<string> {
    return this.serial(async () => {
      await this.preflight();
      try {
        const key = publicKey(await this.host.prepare());
        this.assertOpen();
        this.guestTouched = true;
        const result: unknown = JSON.parse(await this.guest({ action: "prepare", publicKey: key }));
        const { port, hostKey } = parseGuest(result);
        if (this.pinnedHostKey && this.pinnedHostKey !== hostKey) throw new Error("Guest SSH host key changed; refusing to replace its pin");
        this.pinnedHostKey = hostKey;
        this.assertOpen();
        const listener: GuestListener = { host: "127.0.0.1", address: "0.0.0.0", port, process: "sshd (Pibox VS Code)" };
        const listenerId = listenerKey(listener);
        if (this.service && listenerKey(this.service.listener) !== listenerId) await this.revoke();
        const existing = this.network.published.get(listenerId);
        if (existing && (existing !== this.service || existing.mode !== "tcp" || existing.error)) {
          throw new Error("The SSH listener has a conflicting or failed publication; unpublish it with /pibox-net and retry");
        }
        if (!existing) {
          try { await this.network.publish(listener, `vscode-${this.host.id}`, "tcp"); }
          finally {
            const published = this.network.published.get(listenerId);
            // A concurrent /pibox-net operation may win the publication race.
            // Only claim the record created with this exact listener object.
            this.service = published?.listener === listener ? published : undefined;
          }
        }
        this.assertOpen();
        await this.host.configure(this.service!.hostPort, hostKey);
        await this.host.probe();
        this.assertOpen();
        await this.host.launch(this.workdir);
        this.assertOpen();
        return this.host.alias;
      } catch (error) {
        try {
          await this.revoke();
          if (this.guestTouched) {
            await this.guest({ action: "stop" });
            this.guestTouched = false;
          }
          await this.host.remove();
          this.pinnedHostKey = undefined;
        } catch (cleanup) {
          throw new Error(`${String(error)}; SSH cleanup incomplete: ${String(cleanup)}. Retry /pibox-vscode or stop/remove the worker; inspect /pibox-net for remaining mappings.`, { cause: error });
        }
        throw error;
      }
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return this.serial(async () => {
      await this.revoke();
      // The worker lifecycle stops the VM immediately afterward, terminating
      // the daemon and existing SSH sessions. Do not exec into a stopped VM on
      // cleanup retries. Remove credentials only after native revocation.
      await this.host.remove();
    });
  }
  private async revoke(): Promise<void> {
    if (!this.service) return;
    const key = listenerKey(this.service.listener);
    await this.network.unpublish(key, this.service);
    this.service = undefined;
  }
  private async guest(input: Record<string, unknown>): Promise<string> {
    // The helper bounds each subprocess. Await it to settle before rollback;
    // racing cleanup against an uncancelled package install is unsafe.
    const result = await execute(this.sandbox, [NETWORK_NODE, "-e", VSCODE_GUEST, JSON.stringify({ ...input, id: this.host.id })]);
    if (!result.success) throw new Error(result.stderr.trim() || "Guest SSH setup failed");
    return result.stdout.trim();
  }
  private assertOpen(): void { if (this.closed) throw new Error("Worker VS Code connection is closed"); }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}

export function parseGuest(value: unknown): { port: number; hostKey: string } {
  if (!value || typeof value !== "object") throw new Error("Invalid guest SSH response");
  const record = value as Record<string, unknown>;
  if (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 || typeof record.hostKey !== "string") {
    throw new Error("Invalid guest SSH endpoint");
  }
  return { port: record.port, hostKey: publicKey(record.hostKey) };
}
