import { createConnection, createServer, type Server, type Socket } from "node:net";

/** Own both loopback families: Portless races IPv4 and IPv6 upstreams. */
export class LoopbackPair {
  readonly sockets = new Set<Socket>();
  private readonly servers: Server[] = [];
  port = 0;

  static async listen(factory: () => Server, port = 0): Promise<LoopbackPair> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const pair = new LoopbackPair();
      try {
        for (const host of ["127.0.0.1", "::1"]) {
          const server = factory();
          pair.servers.push(server);
          server.on("connection", (socket) => pair.track(socket));
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen({ host, port: pair.port || port, ipv6Only: true }, () => {
              server.off("error", reject);
              server.on("error", () => undefined);
              const address = server.address();
              if (!address || typeof address === "string") { reject(new Error("No loopback endpoint")); return; }
              pair.port = address.port;
              resolve();
            });
          });
        }
        return pair;
      } catch (error) {
        await pair.close();
        if (port || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error("Unable to allocate a dual-loopback port");
  }

  static async forward(port: number): Promise<LoopbackPair> {
    const upstream = new Set<Socket>();
    const pair = await LoopbackPair.listen(() => createServer({ allowHalfOpen: true }, (socket) => {
      const target = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
      upstream.add(target);
      target.once("close", () => upstream.delete(target));
      socket.on("error", () => target.destroy());
      target.on("error", () => socket.destroy());
      socket.once("close", () => target.destroy());
      target.once("close", () => socket.destroy());
      socket.pipe(target).pipe(socket);
    }));
    // Upstream sockets are tracked separately until close so unpublish kills
    // pooled HTTP and WebSocket connections before a native port can be reused.
    pair.upstream = upstream;
    return pair;
  }

  private upstream = new Set<Socket>();
  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }
  async close(): Promise<void> {
    for (const socket of [...this.sockets, ...this.upstream]) socket.destroy();
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
}
