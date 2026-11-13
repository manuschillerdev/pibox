import { createServer } from "node:net";
import { Machine, type PublishedPort } from "smolmachines";
import { PendingTcpPublicationError } from "../sandbox.js";

export interface NativePort { host: number; guest: number; protocol: "tcp" | "udp" }
export interface NativePorts {
  state(): Promise<string>;
  ports(): Promise<NativePort[]>;
  publish(port: { host: number; guest: number; protocol: "tcp" }): Promise<NativePort>;
  unpublish(port: NativePort): Promise<void>;
}

/** Open, never connect: publication must not boot or restart a worker. */
export class SmolvmNetwork {
  private readonly owned = new Map<number, number>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly open: () => Promise<NativePorts>) {}

  static forMachine(name: string): SmolvmNetwork {
    return new SmolvmNetwork(async () => {
      const machine = await Machine.open(name, { target: "local" });
      return {
        state: () => machine.state(),
        ports: async () => (await machine.ports()).map(localPort),
        publish: async (port) => localPort(await machine.publish(port)),
        unpublish: (port) => machine.unpublish(port),
      };
    });
  }

  publish(guestPort: number): Promise<number> {
    return this.serial(async () => {
      if (!Number.isInteger(guestPort) || guestPort < 1 || guestPort > 65535) throw new Error("Invalid guest TCP port");
      if (process.env.SMOLVM_PUBLISH_ADDR && process.env.SMOLVM_PUBLISH_ADDR !== "127.0.0.1") {
        throw new Error("Pibox publishing requires SMOLVM_PUBLISH_ADDR unset or 127.0.0.1");
      }
      const machine = await this.open();
      if (await machine.state() !== "running") throw new Error("Start the smolVM worker before publishing; Pibox never restarts it");
      const before = await machine.ports();
      let host: number;
      do { host = await freeHostPort(); } while (this.owned.has(host) || before.some((port) => port.host === host && port.protocol === "tcp"));
      // The SDK may commit setPorts and then fail while rereading the result.
      // Record the exact attempted endpoint before any mutation can take place.
      this.owned.set(host, guestPort);
      try {
        const mapping = await machine.publish({ host, guest: guestPort, protocol: "tcp" });
        if (mapping.host !== host || mapping.guest !== guestPort || mapping.protocol !== "tcp") {
          throw new Error("smolVM returned a different mapping than the requested endpoint");
        }
      } catch (error) {
        try { await this.removeOwned(host, guestPort); }
        catch (cleanup) {
          throw new PendingTcpPublicationError(host, guestPort, new AggregateError([error, cleanup], "Native publication and cleanup failed"));
        }
        throw new Error(`Native smolVM publishing failed: ${error instanceof Error ? error.message : String(error)}. Use smolvm 1.34.1 or newer and a worker created with net_backend = "virtio-net"; no restart was requested.`, { cause: error });
      }
      return host;
    });
  }

  unpublish(host: number, guest: number): Promise<void> {
    return this.serial(() => this.removeOwned(host, guest));
  }

  private async removeOwned(host: number, guest: number): Promise<void> {
    if (this.owned.get(host) !== guest) throw new Error("Refusing to remove an unowned smolVM port");
    // Reopen after an ambiguous failure, rather than trusting a stale handle.
    const machine = await this.open();
    const mapping = (await machine.ports()).find((port) => port.host === host && port.protocol === "tcp");
    if (mapping && mapping.guest !== guest) throw new Error("Native mapping changed outside Pibox; refusing to remove it");
    if (mapping) await machine.unpublish({ host, guest, protocol: "tcp" });
    this.owned.delete(host);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}

async function freeHostPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("No local port allocated")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function localPort(port: PublishedPort): NativePort {
  if (!Number.isInteger(port.host) || !port.host || port.host < 1 || port.host > 65535) {
    throw new Error("smolVM did not return a valid local host port");
  }
  return { host: port.host, guest: port.guest, protocol: port.protocol ?? "tcp" };
}
