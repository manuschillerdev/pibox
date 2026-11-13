import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  WorkerManager,
  type WorkerCreateOptions,
} from "./worker-manager.js";
import type { StartupOptions } from "./startup.js";
import { Worker } from "./worker.js";
import { EmbeddedPortless } from "./network-portless.js";

export class WorkerRegistry {
  private readonly workers = new Map<string, Worker>();
  private readonly stoppedWorkers = new Map<string, Worker>();
  private closing = false;
  private shutdown: Promise<void> | undefined;
  private readonly networkProxy = new EmbeddedPortless();
  private readonly creating = new Map<string, Promise<Worker>>();
  private routedWorkerId: string | undefined;

  constructor(readonly manager = new WorkerManager()) {}

  async create(
    cwd: string,
    options: WorkerCreateOptions,
    modelRegistry: ModelRegistry,
    startup: StartupOptions = {},
  ): Promise<Worker> {
    this.assertOpen();
    const derived = await this.manager.configuredName(cwd, options);
    this.assertCreatable(derived.name);
    if (this.workers.has(derived.name) || this.creating.has(derived.name)) {
      throw new Error(`Worker ${derived.name} already exists in this coordinator`);
    }
    return await this.createDerived(cwd, options, modelRegistry, derived.name, startup);
  }

  async upsertAndRoute(
    cwd: string,
    options: WorkerCreateOptions,
    modelRegistry: ModelRegistry,
    startup: StartupOptions = {},
  ): Promise<Worker> {
    this.assertOpen();
    const derived = await this.manager.configuredName(cwd, options);
    this.assertCreatable(derived.name);
    const active = this.workers.get(derived.name);
    if (active) return this.route(active.id);

    const pending = this.creating.get(derived.name);
    if (pending) return this.route((await pending).id);

    const worker = await this.createDerived(
      cwd,
      options,
      modelRegistry,
      derived.name,
      startup,
    );
    return this.route(worker.id);
  }

  get(workerId: string): Worker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Unknown active worker ${workerId}`);
    return worker;
  }

  active(): Worker[] {
    return [...this.workers.values()];
  }

  route(workerId: string): Worker {
    this.assertOpen();
    const worker = this.get(workerId);
    this.routedWorkerId = worker.id;
    return worker;
  }

  leave(): string | undefined {
    const workerId = this.routedWorkerId;
    this.routedWorkerId = undefined;
    return workerId;
  }

  routed(): Worker | undefined {
    if (!this.routedWorkerId) return undefined;
    const worker = this.workers.get(this.routedWorkerId);
    if (!worker) this.routedWorkerId = undefined;
    return worker;
  }

  async stop(workerId: string): Promise<void> {
    const worker = this.get(workerId);
    this.clearRoute(workerId);
    try {
      await worker.shutdown();
    } finally {
      // shutdown closes RPC even if a later cleanup step fails. Keep the handle
      // for explicit removal, but never route a closed worker again.
      this.stoppedWorkers.set(workerId, worker);
      this.workers.delete(workerId);
    }
  }

  async remove(workerId: string): Promise<void> {
    const worker = this.stoppedWorkers.get(workerId) ?? this.get(workerId);
    this.clearRoute(workerId);
    await worker.shutdownAndRemove();
    this.workers.delete(workerId);
    this.stoppedWorkers.delete(workerId);
  }

  shutdownAll(): Promise<void> {
    this.closing = true;
    this.routedWorkerId = undefined;
    return this.shutdown ??= this.drainWorkers().catch((error: unknown) => {
      this.shutdown = undefined;
      throw error;
    });
  }

  private async drainWorkers(): Promise<void> {
    // Block new creation first, then include workers still being bootstrapped.
    // Failed creation already owns its rollback in WorkerManager/the adapter.
    await Promise.allSettled([...this.creating.values()]);
    const workers = [...this.active(), ...this.stoppedWorkers.values()];
    const results = await Promise.allSettled(
      workers.map(async (worker) => {
        try {
          await worker.shutdown();
        } finally {
          this.workers.delete(worker.id);
          this.stoppedWorkers.set(worker.id, worker);
        }
      }),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) =>
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    if (errors.length > 0) {
      throw new Error(`Failed to clean up Pibox workers: ${errors.join("; ")}`);
    }
  }

  private async createDerived(
    cwd: string,
    options: WorkerCreateOptions,
    modelRegistry: ModelRegistry,
    name: string,
    startup: StartupOptions,
  ): Promise<Worker> {
    const creation = this.manager
      .createWorker(cwd, options, modelRegistry, startup)
      .then((started) => {
        const worker = new Worker(started, this.networkProxy);
        this.workers.set(worker.id, worker);
        return worker;
      });
    this.creating.set(name, creation);
    try {
      const worker = await creation;
      this.assertOpen();
      return worker;
    } finally {
      this.creating.delete(name);
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Pibox controller is shutting down");
  }

  private assertCreatable(name: string): void {
    this.assertOpen();
    if (this.stoppedWorkers.has(name)) {
      throw new Error(`Worker ${name} is stopped; its sandbox data is retained. Use /pibox-rm ${name} to remove it before creating a fresh worker.`);
    }
  }

  private clearRoute(workerId: string): void {
    if (this.routedWorkerId === workerId) this.routedWorkerId = undefined;
  }
}
