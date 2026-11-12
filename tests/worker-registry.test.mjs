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
