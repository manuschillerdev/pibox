import { createHash } from "node:crypto";
import { createConnection, type Server, type Socket } from "node:net";
import { createProxyServer, formatUrl, type RouteInfo } from "portless";
import { LoopbackPair } from "./network-loopback.js";
export const NETWORK_DOMAIN = "pibox.test";

export function networkNamespace(worker: string, worktree: string): string {
  return `pibox-${createHash("sha256").update(worktree + "\0" + worker).digest("hex").slice(0, 8)}`;
}
export function validateServiceName(name: string): void {
  if (name !== name.trim() || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name)) {
    throw new Error("Name must be 1–40 lowercase letters, digits or interior hyphens");
  }
}

/** Private in-memory routes, never shared Portless CLI state. */
export class EmbeddedPortless {
  private readonly routes = new Map<string, { route: RouteInfo; target: number; bridge: LoopbackPair }>();
  private server: BrowserProxy | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly listenPort = 80) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  add(hostname: string, port: number): Promise<string> {
    return this.serial(async () => {
      if (this.routes.has(hostname)) throw new Error(`Name already published: ${hostname}`);
      const bridge = await LoopbackPair.forward(port);
      try {
        if (!this.server) await this.start();
        this.routes.set(hostname, { route: { hostname, port: bridge.port }, target: port, bridge });
        return formatUrl(hostname, this.server!.port, false);
      } catch (error) { await bridge.close(); throw error; }
    });
  }

  remove(hostname: string, port: number): Promise<void> {
    return this.serial(async () => {
      const entry = this.routes.get(hostname);
      if (!entry) return;
      if (entry.target !== port) throw new Error("Refusing to remove another publication");
      this.routes.delete(hostname);
      await entry.bridge.close();
      if (!this.routes.size) {
        const server = this.server;
        this.server = undefined;
        await server?.close();
      }
    });
  }

  private async start(): Promise<void> {
    try {
      this.server = await BrowserProxy.listen(this.listenPort, (port) => createProxyServer({
        getRoutes: () => [...this.routes.values()].map((entry) => entry.route),
        proxyPort: port, tld: NETWORK_DOMAIN, strict: true, loopbackOnly: true, onError: () => undefined,
      }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code === "EADDRINUSE"
        ? "is already in use by another controller or service; Pibox will not share or stop it"
        : code === "EACCES" || code === "EPERM"
          ? "cannot be bound without elevation on this host; on Linux check net.ipv4.ip_unprivileged_port_start (Pibox does not change it)"
          : `is unavailable: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(`HTTP proxy port ${this.listenPort} ${reason}. Raw TCP publishing remains available.`, { cause: error });
    }
  }
}

/** Wildcard binding permits unprivileged port 80 on macOS. Portless 0.17's
 * loopbackOnly wrapper rejects remote peers before HTTP parsing, and checks
 * request/upgrade peers again. Upstream bridges remain strictly loopback-bound.
 */
class BrowserProxy {
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private closing = false;
  port = 0;

  static async listen(port: number, factory: (port: number) => Server): Promise<BrowserProxy> {
    const proxy = new BrowserProxy();
    try {
      // macOS can allow a wildcard bind alongside an existing specific-address
      // listener. Check both browser destinations before claiming a fixed port.
      if (port) await Promise.all([assertUnused("127.0.0.1", port), assertUnused("::1", port)]);
      for (const host of ["0.0.0.0", "::"]) {
        if (host === "::" && !port) await assertUnused("::1", proxy.port);
        const server = factory(proxy.port || port);
        proxy.servers.push(server);
        // Include idle peers in deterministic shutdown.
        server.on("connection", (socket: Socket) => {
          socket.on("error", () => socket.destroy());
          if (proxy.closing) { socket.destroy(); return; }
          proxy.sockets.add(socket);
          socket.once("close", () => proxy.sockets.delete(socket));
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host, port: proxy.port || port, ipv6Only: true }, () => {
            server.off("error", reject);
            server.on("error", () => undefined);
            const address = server.address();
            if (!address || typeof address === "string") { reject(new Error("No proxy endpoint")); return; }
            proxy.port = address.port;
            resolve();
          });
        });
      }
      return proxy;
    } catch (error) {
      await proxy.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    // Portless owns HTTP/WebSocket and upstream-agent teardown.
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}

async function assertUnused(host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Cannot determine whether ${host}:${port} is available (probe timed out)`));
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(Object.assign(new Error(`An existing listener accepts connections at ${host}:${port}`), { code: "EADDRINUSE" }));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(error);
    });
  });
}

export class PortlessRoutes {
  constructor(readonly namespace: string, private readonly proxy = new EmbeddedPortless()) {}
  async add(name: string, port: number): Promise<{ hostname: string; url: string }> {
    validateServiceName(name);
    const hostname = `${name}.${this.namespace}.${NETWORK_DOMAIN}`;
    return { hostname, url: await this.proxy.add(hostname, port) };
  }
  remove(hostname: string, port: number): Promise<void> {
    return this.proxy.remove(hostname, port);
  }
}
