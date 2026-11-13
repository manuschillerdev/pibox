// Opt-in: creates and removes only a uniquely named disposable local smolVM.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadTypeScript } from './load-typescript.mjs';
const { SmolvmProvider } = await loadTypeScript('../src/sandboxes/smolvm.ts');
const { WorkerRegistry } = await loadTypeScript('../src/worker-registry.ts');
const { execute } = await loadTypeScript('../src/sandbox.ts');
const name = `pibox-lifecycle-${randomUUID()}`;
const config = { cpus: 1, memory: 256, storage: 2 };
let owned;
function registry() {
  return new WorkerRegistry({
    configuredName: async () => ({ name }),
    createWorker: async () => {
      owned = await new SmolvmProvider([]).create(name, config, []);
      return { id: name, name, sandbox: owned,
        rpc: { getState: async () => ({ isStreaming: false }), close: async () => {} },
        configPath: '/unused', worktreeRoot: '/unused',
        authRelay: { providerState: new Map(), cleanup() {} }, relayedProviders: [], skippedProviders: [],
      };
    },
  });
}
const cli = process.env.PIBOX_SMOLVM_CLI || 'smolvm';
try {
  console.log(execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim());
  const first = registry();
  await first.upsertAndRoute('/unused', {}, {});
  const before = execFileSync(cli, ['machine', 'data-dir', '--name', name], { encoding: 'utf8' }).trim();
  assert.equal((await execute(owned, ['/bin/sh', '-c', 'echo preserved >/root/pibox-lifecycle-sentinel'])).code, 0);
  const boot = (await execute(owned, ['cat', '/proc/sys/kernel/random/boot_id'])).stdout.trim();
  await first.shutdownAll();
  const status = execFileSync(cli, ['machine', 'status', '--name', name], { encoding: 'utf8' });
  assert.match(status, /stopped/i);
  const second = registry();
  await second.upsertAndRoute('/unused', {}, {});
  assert.equal(execFileSync(cli, ['machine', 'data-dir', '--name', name], { encoding: 'utf8' }).trim(), before);
  assert.equal((await execute(owned, ['cat', '/root/pibox-lifecycle-sentinel'])).stdout.trim(), 'preserved');
  assert.notEqual((await execute(owned, ['cat', '/proc/sys/kernel/random/boot_id'])).stdout.trim(), boot);
  await assert.rejects(registry().upsertAndRoute('/unused', {}, {}), /another Pibox controller/);
  await second.shutdownAll();
  // This test-owned machine has no guest Pi session. Simulate an operator start.
  execFileSync(cli, ['machine', 'start', '--name', name], { stdio: 'pipe' });
  const runningBoot = execFileSync(cli, ['machine', 'exec', '--name', name, '--', 'cat', '/proc/sys/kernel/random/boot_id'], { encoding: 'utf8' }).trim();
  const third = registry();
  await third.upsertAndRoute('/unused', {}, {});
  assert.equal((await execute(owned, ['cat', '/proc/sys/kernel/random/boot_id'])).stdout.trim(), runningBoot);
  assert.equal((await execute(owned, ['cat', '/root/pibox-lifecycle-sentinel'])).stdout.trim(), 'preserved');
  await third.remove(name);
  owned = undefined;
  console.log('PASS: new adapter reopens stopped VM, sentinel retained, running adoption keeps boot ID, concurrent controller fenced');
} finally {
  if (owned) {
    await owned.remove();
  }
}
