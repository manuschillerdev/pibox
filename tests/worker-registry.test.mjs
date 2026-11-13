import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './load-typescript.mjs';

const { WorkerRegistry } = await loadTypeScript('../src/worker-registry.ts');

function startedWorker(id) {
  return {
    id,
    name: id,
    sandbox: {},
    rpc: {},
    configPath: 'pibox.toml',
    worktreeRoot: '/worktree',
    authRelay: { providerState: new Map() },
    relayedProviders: [],
    skippedProviders: [],
  };
}

test('upsert routes to the active worktree worker without recreating it', async () => {
  let creates = 0;
  const registry = new WorkerRegistry({
    configuredName: async () => ({ name: 'pibox-worktree', configPath: 'pibox.toml', worktreeRoot: '/worktree' }),
    createWorker: async () => {
      creates += 1;
      return startedWorker('pibox-worktree');
    },
  });

  const first = await registry.upsertAndRoute('/worktree', {}, {});
  const second = await registry.upsertAndRoute('/worktree', {}, {});

  assert.equal(creates, 1);
  assert.equal(second, first);
  assert.equal(registry.routed(), first);
});

test('concurrent upserts share one in-progress worker creation', async () => {
  let creates = 0;
  let release;
  const created = new Promise((resolve) => { release = resolve; });
  const registry = new WorkerRegistry({
    configuredName: async () => ({ name: 'pibox-worktree', configPath: 'pibox.toml', worktreeRoot: '/worktree' }),
    createWorker: async () => {
      creates += 1;
      await created;
      return startedWorker('pibox-worktree');
    },
  });

  const first = registry.upsertAndRoute('/worktree', {}, {});
  const second = registry.upsertAndRoute('/worktree', {}, {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates, 1);
  release();

  assert.equal(await first, await second);
  assert.equal(creates, 1);
});

test('shutdown drains pending creation, prevents routing, and refuses later creation', async () => {
  let release, stops = 0, creates = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const registry = new WorkerRegistry({
    configuredName: async () => ({ name: 'pending' }),
    createWorker: async () => {
      creates++;
      await gate;
      return {
        ...startedWorker('pending'),
        sandbox: { stop: async () => { stops++; } },
        rpc: { getState: async () => ({ isStreaming: false }), close: async () => {} },
        authRelay: { providerState: new Map(), cleanup() {} },
      };
    },
  });
  const creating = registry.upsertAndRoute('/worktree', {}, {});
  const rejected = assert.rejects(creating, /shutting down/);
  await new Promise(resolve => setImmediate(resolve));
  const closing = registry.shutdownAll();
  release();
  await rejected;
  await closing;
  assert.equal(stops, 1);
  assert.equal(registry.routed(), undefined);
  assert.equal(registry.active().length, 0);
  await assert.rejects(registry.create('/worktree', {}, {}), /shutting down/);
  await assert.rejects(registry.upsertAndRoute('/worktree', {}, {}), /shutting down/);
  assert.equal(creates, 1);
});

test('shutdown blocks a create still resolving its configured name', async () => {
  let release, creates = 0;
  const name = new Promise(resolve => { release = resolve; });
  const registry = new WorkerRegistry({
    configuredName: async () => name,
    createWorker: async () => { creates++; return startedWorker('late'); },
  });
  const creating = registry.create('/worktree', {}, {});
  const rejected = assert.rejects(creating, /shutting down/);
  await registry.shutdownAll();
  release({ name: 'late' });
  await rejected;
  assert.equal(creates, 0);
});

test('failed stop is retried by shutdown and does not leave a routable closed worker', async () => {
  let stops = 0;
  const registry = new WorkerRegistry({
    configuredName: async () => ({ name: 'retry' }),
    createWorker: async () => ({
      ...startedWorker('retry'),
      sandbox: { stop: async () => { if (++stops === 1) throw new Error('temporary stop failure'); } },
      rpc: { getState: async () => ({ isStreaming: false }), close: async () => {} },
      authRelay: { providerState: new Map(), cleanup() {} },
    }),
  });
  await registry.upsertAndRoute('/worktree', {}, {});
  await assert.rejects(registry.stop('retry'), /temporary stop failure/);
  assert.equal(registry.active().length, 0);
  assert.equal(registry.routed(), undefined);
  await registry.shutdownAll();
  assert.equal(stops, 2);
});
