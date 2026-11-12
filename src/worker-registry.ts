import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  WorkerManager,
  type WorkerCreateOptions,
} from "./worker-manager.js";
import type { StartupOptions } from "./startup.js";
import { Worker } from "./worker.js";

export class WorkerRegistry {
  private readonly workers = new Map<string, Worker>();
  private readonly creating = new Map<string, Promise<Worker>>();
  private routedWorkerId: string | undefined;

  constructor(readonly manager = new WorkerManager()) {}

  async create(
    cwd: string,
    options: WorkerCreateOptions,
    modelRegistry: ModelRegistry,
    startup: StartupOptions = {},
  ): Promise<Worker> {
    const derived = await this.manager.configuredName(cwd, options);
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
    const derived = await this.manager.configuredName(cwd, options);
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
    await worker.shutdown();
    this.workers.delete(workerId);
  }

  async remove(workerId: string): Promise<void> {
    const worker = this.get(workerId);
    this.clearRoute(workerId);
    await worker.shutdownAndRemove();
    this.workers.delete(workerId);
  }

  async shutdownAll(): Promise<void> {
    this.routedWorkerId = undefined;
    const workers = this.active();
    const results = await Promise.allSettled(
      workers.map(async (worker) => {
        try {
          await worker.shutdown();
        } finally {
          this.workers.delete(worker.id);
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
        const worker = new Worker(started);
        this.workers.set(worker.id, worker);
        return worker;
      });
    this.creating.set(name, creation);
    try {
      return await creation;
    } finally {
      this.creating.delete(name);
    }
  }

  private clearRoute(workerId: string): void {
    if (this.routedWorkerId === workerId) this.routedWorkerId = undefined;
  }
}
