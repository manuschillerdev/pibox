import { PendingTcpPublicationError, type SandboxInstance } from "./sandbox.js";
import { discoverListeners, listenerKey, type GuestListener } from "./network-discovery.js";
import { EmbeddedPortless, networkNamespace, PortlessRoutes, validateServiceName } from "./network-portless.js";
import { GuestHosts } from "./network-guest-hosts.js";
import { hostNetworkReadiness } from "./network-readiness.js";

export interface PublishedService {
  listener: GuestListener;
  name: string;
  mode: "http" | "tcp";
  endpoint: string;
  hostname?: string;
  hostPort: number;
  error?: string;
  cleanup?: { routeRemoved: boolean; nativeRemoved: boolean; guestRemoved: boolean };
  readiness?: { host: string; guest: string };
}
export class WorkerNetwork {
  readonly published = new Map<string, PublishedService>();
  readonly portless: PortlessRoutes;
  readonly guestHosts: GuestHosts;
  private readonly lifetime = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  constructor(private readonly sandbox: SandboxInstance, worker: string, worktree: string, proxy = new EmbeddedPortless()) {
    this.portless = new PortlessRoutes(networkNamespace(worker, worktree), proxy);
    this.guestHosts = new GuestHosts(sandbox, this.portless.namespace);
  }
  private assertOpen(): void {
    if (this.lifetime.signal.aborted) throw new Error("Worker network is closed");
  }
  async discover(): Promise<GuestListener[]> {
    this.assertOpen();
    return discoverListeners(this.sandbox, this.lifetime.signal);
  }
  permission(): Promise<void> {
    this.assertOpen();
    if (!this.sandbox.publishTcp || !this.sandbox.unpublishTcp) {
      return Promise.reject(new Error("Publishing currently supports smolVM native TCP only; Microsandbox publication is deferred"));
    }
    return Promise.resolve();
  }
  publish(listener: GuestListener, name: string, mode: "http" | "tcp"): Promise<void> {
    return this.serial(async () => {
      this.assertOpen();
      validateServiceName(name);
      await this.permission();
      if (listener.address !== "0.0.0.0" && listener.address !== "*") {
        throw new Error("Native publishing requires a service bound to 0.0.0.0 (IPv4 wildcard), not guest localhost or IPv6-only");
      }
      const key = listenerKey(listener);
      if (![...await this.discover()].some((l) => listenerKey(l) === key && l.address === listener.address)) throw new Error("Listener is no longer present; refresh and retry");
      this.assertOpen();
      if (this.published.has(key)) throw new Error("Unpublish the current endpoint before changing its name or mode");
      if ([...this.published.values()].some((p) => p.name === name)) throw new Error("This service name is already in use");
      let hostPort: number;
      try { hostPort = await this.sandbox.publishTcp!(listener.port); }
      catch (error) {
        if (error instanceof PendingTcpPublicationError) {
          this.published.set(key, {
            listener, name, mode, hostPort: error.hostPort,
            endpoint: `127.0.0.1:${error.hostPort}`, error: error.message,
          });
        }
        throw error;
      }
      const service: PublishedService = { listener, name, mode, hostPort, endpoint: `127.0.0.1:${hostPort}` };
      this.published.set(key, service);
      try {
        this.assertOpen();
        if (mode === "http") {
          const route = await this.portless.add(name, hostPort);
          service.hostname = route.hostname;
          service.endpoint = route.url;
          await this.guestHosts.sync(this.hostnames());
          await this.check(key);
        }
        this.assertOpen();
      } catch (error) {
        try { await this.remove(key); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Publishing failed; retry unpublish to finish cleanup"); }
        throw error;
      }
    });
  }
  unpublish(key: string, expected?: PublishedService): Promise<void> {
    return this.serial(() => {
      if (expected && this.published.get(key) !== expected) return Promise.resolve();
      return this.remove(key);
    });
  }
  private async remove(key: string): Promise<void> {
    const service = this.published.get(key);
    if (!service) return;
    const cleanup = service.cleanup ??= {
      routeRemoved: !service.hostname, nativeRemoved: false, guestRemoved: !service.hostname,
    };
    const failures: string[] = [];
    const attempt = async (step: keyof typeof cleanup, action: () => Promise<void>) => {
      if (cleanup[step]) return;
      try { await action(); cleanup[step] = true; }
      catch (error) { failures.push(`${step}: ${error instanceof Error ? error.message : String(error)}`); }
    };
    // Try route revocation first, but never let either route or guest cleanup
    // prevent native revocation. Successful steps must not run again on retry.
    await attempt("routeRemoved", () => this.portless.remove(service.hostname!, service.hostPort));
    await attempt("nativeRemoved", () => this.sandbox.unpublishTcp!(service.hostPort, service.listener.port));
    await attempt("guestRemoved", () => this.guestHosts.sync(this.hostnames()));
    if (failures.length) {
      service.error = `Cleanup failed; native forwarding ${cleanup.nativeRemoved ? "removed" : "may remain active"}: ${failures.join("; ")}`;
      throw new Error(service.error);
    }
    this.published.delete(key);
  }
  private hostnames(): string[] {
    // Pending cleanup records must never regain guest mappings during another
    // service's publication or cleanup.
    return [...this.published.values()].flatMap(service => !service.cleanup && service.hostname ? [service.hostname] : []);
  }
  async check(key: string): Promise<void> {
    const service = this.published.get(key);
    if (!service?.hostname) return;
    const [host, guest] = await Promise.all([hostNetworkReadiness(service.endpoint), this.guestHosts.status(service.endpoint)]);
    service.readiness = { host, guest };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.lifetime.abort(new Error("Worker network is closed"));
    this.closing = this.serial(async () => {
      const failures: string[] = [];
      for (const key of this.published.keys()) {
        try { await this.remove(key); } catch (error) { failures.push(String(error)); }
      }
      if (failures.length) { this.closing = undefined; throw new Error(failures.join("; ")); }
    });
    return this.closing;
  }
  private serial(operation: () => Promise<void>): Promise<void> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
