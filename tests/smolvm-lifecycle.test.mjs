import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from 'smolmachines';
import { loadTypeScript } from './load-typescript.mjs';

const { SmolvmProvider } = await loadTypeScript('../src/sandboxes/smolvm.ts');
const { WorkerRegistry } = await loadTypeScript('../src/worker-registry.ts');

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'pibox-lifecycle-test-'));
  const state = join(dir, 'state.json');
  const cli = join(dir, 'smolvm');
  await writeFile(state, JSON.stringify({ machines: {}, calls: [] }));
  await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2), action = args[1], name = args[args.indexOf('--name') + 1];
state.calls.push({ action, name, publishAddress: process.env.SMOLVM_PUBLISH_ADDR ?? null });
let error;
if (action === 'create') {
  if (state.machines[name]) error = "machine '" + name + "' already exists or is being created";
  else {
    state.machines[name] = 'stopped';
    state.labels ??= {};
    state.labels[name] = Object.fromEntries(args.flatMap((arg, i) => arg === '--label' ? [args[i + 1].split('=')] : []));
    state.files ??= {}; state.files[name] = { sentinel: 'preserved' };
  }
} else if (action === 'start') {
  if (state.failStart) error = 'boot failed';
  else { state.machines[name] = 'running'; state.boots ??= {}; state.boots[name] = (state.boots[name] ?? 0) + 1; }
} else if (action === 'stop') {
  if (state.failStop) error = 'stop failed';
  else state.machines[name] = 'stopped';
} else if (action === 'delete') {
  if (state.failDelete) error = 'delete failed';
  else { delete state.machines[name]; delete state.labels?.[name]; delete state.files?.[name]; }
}
fs.writeFileSync(path, JSON.stringify(state));
if (error) { console.error(error); process.exit(1); }
`);
  await chmod(cli, 0o700);
  const previous = process.env.PIBOX_SMOLVM_CLI;
  const home = process.env.HOME;
  process.env.HOME = dir;
  const originalOpen = Machine.open, originalList = Machine.list;
  Machine.open = async (name, options) => {
    assert.equal(options.target, 'local');
    if (!(await read()).machines[name]) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    return { state: async () => (await read()).machines[name] };
  };
  Machine.list = async () => {
    const state = await read();
    return Object.entries(state.machines).map(([name, status]) => ({ name, state: status, labels: state.labels?.[name] ?? {} }));
  };
  process.env.PIBOX_SMOLVM_CLI = cli;
  const read = async () => JSON.parse(await readFile(state, 'utf8'));
  const set = async (value) => writeFile(state, JSON.stringify({ ...await read(), ...value }));
  try { await run({ read, set, dir }); }
  finally {
    Machine.open = originalOpen; Machine.list = originalList;
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (previous === undefined) delete process.env.PIBOX_SMOLVM_CLI;
    else process.env.PIBOX_SMOLVM_CLI = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function registry(name = 'same-worktree') {
  return new WorkerRegistry({
    configuredName: async () => ({ name }),
    createWorker: async () => ({
      id: name, name, sandbox: await new SmolvmProvider([]).create(name, {}, []),
      rpc: { getState: async () => ({ isStreaming: false }), close: async () => {} },
      configPath: 'pibox.toml', worktreeRoot: '/worktree',
      authRelay: { providerState: new Map(), cleanup() {} },
      relayedProviders: [], skippedProviders: [],
    }),
  });
}

test('graceful shutdown stops smolVM and a new adapter reopens its persisted machine', async () => {
  await fixture(async ({ read }) => {
    const first = registry();
    await first.upsertAndRoute('/worktree', {}, {});
    await first.shutdownAll();
    const second = registry();
    await second.upsertAndRoute('/worktree', {}, {});
    assert.equal((await read()).machines['same-worktree'], 'running');
    assert.equal((await read()).calls.filter(c => c.action === 'create').length, 1);
    assert.equal((await read()).files['same-worktree'].sentinel, 'preserved');
    assert.equal((await read()).boots['same-worktree'], 2);
    await second.shutdownAll();
    assert.deepEqual((await read()).machines, { 'same-worktree': 'stopped' });
    assert.ok(!(await read()).calls.some(c => c.action === 'delete'));
  });
});

test('failed create never stops or deletes a pre-existing smolVM', async () => {
  await fixture(async ({ read, set }) => {
    await set({ machines: { existing: 'running' } });
    await assert.rejects(new SmolvmProvider([]).create('existing', {}, []), /Legacy migration/);
    assert.deepEqual((await read()).machines, { existing: 'running' });
    assert.deepEqual((await read()).calls, []);
  });
});

test('failed start removes only the machine whose create succeeded', async () => {
  await fixture(async ({ read, set }) => {
    await set({ failStart: true, machines: { unrelated: 'running' } });
    await assert.rejects(new SmolvmProvider([]).create('owned', {}, []), /boot failed/);
    assert.deepEqual((await read()).machines, { unrelated: 'running' });
    assert.deepEqual((await read()).calls.map(c => c.action), ['create', 'start', 'delete']);
  });
});

test('stopped workers remain removable and explicit removal permits fresh creation', async () => {
  await fixture(async ({ read }) => {
    const controller = registry();
    await controller.upsertAndRoute('/worktree', {}, {});
    await controller.stop('same-worktree');
    assert.equal(controller.active().length, 0);
    await assert.rejects(controller.upsertAndRoute('/worktree', {}, {}), /Use \/pibox-rm/);
    await controller.remove('same-worktree');
    assert.deepEqual((await read()).machines, {});
    await controller.upsertAndRoute('/worktree', {}, {});
    await controller.remove('same-worktree');
    await controller.shutdownAll();
    assert.deepEqual((await read()).machines, {});
  });
});

test('keep-running leaves a worker running only until controller shutdown', async () => {
  await fixture(async ({ read }) => {
    const controller = registry();
    await controller.upsertAndRoute('/worktree', {}, {});
    controller.leave();
    assert.equal((await read()).machines['same-worktree'], 'running');
    await controller.shutdownAll();
    assert.equal((await read()).machines['same-worktree'], 'stopped');
  });
});


test('CLI does not opt into fleet mode and preserves explicit operator network policy',async()=>{
 const original=process.env.SMOLVM_PUBLISH_ADDR;
 try {
  delete process.env.SMOLVM_PUBLISH_ADDR;
  await fixture(async({read})=>{const box=await new SmolvmProvider([]).create('local',{},[]);await box.remove();assert.ok((await read()).calls.every(c=>c.publishAddress===null));});
  process.env.SMOLVM_PUBLISH_ADDR='127.0.0.1';
  await fixture(async({read})=>{const box=await new SmolvmProvider([]).create('fleet',{},[]);await box.remove();assert.ok((await read()).calls.every(c=>c.publishAddress==='127.0.0.1'));});
 }finally{if(original===undefined)delete process.env.SMOLVM_PUBLISH_ADDR;else process.env.SMOLVM_PUBLISH_ADDR=original;}
});

test('running matching machine is adopted without restart; another controller is fenced', async () => {
  await fixture(async ({ read, set }) => {
    const first = await new SmolvmProvider([]).create('running', {}, []);
    await assert.rejects(new SmolvmProvider([]).create('running', {}, []), /another Pibox controller/);
    await first.stop();
    // Simulate a manual start after the controller released its stopped VM.
    await set({ machines: { running: 'running' } });
    const before = (await read()).calls.length;
    const second = await new SmolvmProvider([]).create('running', {}, []);
    assert.equal((await read()).calls.length, before, 'adoption never starts/stops/creates');
    await assert.rejects(first.remove(), /another Pibox controller/);
    await second.rollback();
    assert.equal((await read()).machines.running, 'running');
    const third = await new SmolvmProvider([]).create('running', {}, []);
    await third.remove();
  });
});

test('configuration, mounts, credentials and operator policy mismatches leave disks untouched', async () => {
  await fixture(async ({ read }) => {
    const first = await new SmolvmProvider([]).create('config', { net: false }, []);
    await first.stop();
    const before = await read();
    await assert.rejects(new SmolvmProvider([]).create('config', { net: true }, []), /different Pibox configuration/);
    await assert.rejects(new SmolvmProvider([]).create('config', { net: false }, [{ source: '/host', target: '/guest' }]), /different Pibox configuration/);
    const policy = process.env.PIBOX_SMOLVM_AUTH_POLICY;
    const address = process.env.SMOLVM_PUBLISH_ADDR;
    try {
      process.env.PIBOX_SMOLVM_AUTH_POLICY = 'guest-environment';
      await assert.rejects(new SmolvmProvider([{ provider: 'test', secretName: 'TOKEN', allowedHosts: ['example.com'] }]).create('config', { net: false }, []), /different Pibox configuration/);
      if (policy === undefined) delete process.env.PIBOX_SMOLVM_AUTH_POLICY; else process.env.PIBOX_SMOLVM_AUTH_POLICY = policy;
      process.env.SMOLVM_PUBLISH_ADDR = '127.0.0.1';
      await assert.rejects(new SmolvmProvider([]).create('config', { net: false }, []), /different Pibox configuration/);
    } finally {
      if (policy === undefined) delete process.env.PIBOX_SMOLVM_AUTH_POLICY; else process.env.PIBOX_SMOLVM_AUTH_POLICY = policy;
      if (address === undefined) delete process.env.SMOLVM_PUBLISH_ADDR; else process.env.SMOLVM_PUBLISH_ADDR = address;
    }
    assert.deepEqual(await read(), before);
    await first.remove();
  });
});

test('stopped reuse boot failure preserves disks and releases the controller lock', async () => {
  await fixture(async ({ read, set }) => {
    const first = await new SmolvmProvider([]).create('retry', {}, []);
    await first.stop();
    await set({ failStart: true });
    await assert.rejects(new SmolvmProvider([]).create('retry', {}, []), /boot failed/);
    assert.equal((await read()).files.retry.sentinel, 'preserved');
    assert.ok(!(await read()).calls.some(c => c.action === 'delete'));
    await set({ failStart: false });
    const retry = await new SmolvmProvider([]).create('retry', {}, []);
    await retry.remove();
  });
});

test('in-progress and paused machines cannot be reused or deleted', async () => {
  await fixture(async ({ read, set }) => {
    const first = await new SmolvmProvider([]).create('pending', {}, []);
    await first.stop();
    const before = (await read()).calls;
    for (const state of ['creating', 'starting', 'paused']) {
      await set({ machines: { pending: state } });
      await assert.rejects(new SmolvmProvider([]).create('pending', {}, []), /not ready for reuse/);
    }
    assert.deepEqual((await read()).calls, before);
  });
});

test('create reservation collision does not grant deletion rights', async () => {
  await fixture(async ({ read, set }) => {
    await set({ machines: { collision: 'creating' } });
    // Reservation not visible to open yet, but create still collides.
    Machine.open = async () => { throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); };
    await assert.rejects(new SmolvmProvider([]).create('collision', {}, []), /already exists or is being created/);
    assert.deepEqual((await read()).calls.map(c => c.action), ['create']);
    assert.equal((await read()).machines.collision, 'creating');
  });
});

test('unexpected native open errors never fall through to create', async () => {
  await fixture(async ({ read }) => {
    Machine.open = async () => { throw new Error('database unavailable'); };
    await assert.rejects(new SmolvmProvider([]).create('unknown', {}, []), /database unavailable/);
    assert.deepEqual((await read()).calls, []);
  });
});

test('actual worker bootstrap failure rolls back new machines but preserves reused disks', async () => {
  const { WorkerManager } = await loadTypeScript('../src/worker-manager.ts');
  const { AuthRelay } = await loadTypeScript('../src/auth-relay.ts');
  const prepare = AuthRelay.prepareAvailable;
  AuthRelay.prepareAvailable = async () => ({ credentials: [], skipped: [] });
  try { await fixture(async ({ read, set, dir }) => {
    const configPath = join(dir, 'pibox.toml');
    await writeFile(configPath, 'provider = "smolvm"\n[pibox]\nname = "bootstrap"\nworkdir = "/workspace"\n[sandbox]\n');
    const manager = new WorkerManager();
    manager.bootstrap = async () => { throw new Error('bootstrap failed'); };
    const start = () => manager.createWorker(dir, { config: configPath }, { getAvailable: () => [] });
    await assert.rejects(start(), /bootstrap failed/);
    assert.deepEqual((await read()).machines, {});
    const first = await new SmolvmProvider([]).create('bootstrap', {}, []);
    await first.stop();
    await assert.rejects(start(), /bootstrap failed/);
    assert.equal((await read()).machines.bootstrap, 'stopped');
    assert.equal((await read()).files.bootstrap.sentinel, 'preserved');
    await set({ machines: { bootstrap: 'running' } });
    const before = (await read()).calls.length;
    await assert.rejects(start(), /bootstrap failed/);
    assert.equal((await read()).calls.length, before, 'running rollback never stops or deletes');
    const retry = await new SmolvmProvider([]).create('bootstrap', {}, []);
    await retry.remove();
  }); } finally { AuthRelay.prepareAvailable = prepare; }
});

test('old stopped handles cannot delete a replacement machine', async () => {
  await fixture(async ({ read, set }) => {
    const first = await new SmolvmProvider([]).create('replacement', {}, []);
    await first.stop();
    const state = await read();
    state.labels.replacement['pibox.instance'] = 'different-instance';
    await set({ labels: state.labels });
    const before = (await read()).calls.length;
    await assert.rejects(first.remove(), /replaced outside this controller/);
    assert.equal((await read()).calls.length, before);
    const second = await new SmolvmProvider([]).create('replacement', {}, []);
    await second.remove();
  });
});

test('fingerprints ignore key order and rotated per-session credential references, not bindings', async () => {
  const { machineLabels } = await loadTypeScript('../src/sandboxes/smolvm-lifecycle.ts');
  const credentials = [{ provider: 'test', secretName: 'TOKEN', allowedHosts: ['api.example'], sourceEnvName: 'SESSION_A', lastAppliedValue: 'secret-a' }];
  const first = machineLabels({ cpus: 1, net: false }, [], credentials);
  const second = machineLabels({ net: false, cpus: 1 }, [], [{ ...credentials[0], sourceEnvName: 'SESSION_B', lastAppliedValue: 'secret-b' }]);
  assert.equal(first['pibox.config.v1'], second['pibox.config.v1']);
  const changed = machineLabels({ cpus: 1, net: false }, [], [{ ...credentials[0], allowedHosts: ['another.example'] }]);
  assert.notEqual(first['pibox.config.v1'], changed['pibox.config.v1']);
  assert.ok(!JSON.stringify(first).includes('secret-a'));
});

test('uncertain RPC closure retains VM and lock; confirmed closure allows running rollback', async () => {
  const { WorkerManager } = await loadTypeScript('../src/worker-manager.ts');
  const { AuthRelay } = await loadTypeScript('../src/auth-relay.ts');
  const { PiRpcClient } = await loadTypeScript('../src/pi-rpc.ts');
  const prepare = AuthRelay.prepareAvailable, connect = PiRpcClient.connect;
  AuthRelay.prepareAvailable = async () => ({ credentials: [], skipped: [] });
  try {
    for (const closeFails of [false, true]) {
      await fixture(async ({ read, set, dir }) => {
        const configPath = join(dir, 'pibox.toml');
        await writeFile(configPath, 'provider = "smolvm"\n[pibox]\nname = "rpc-failure"\nworkdir = "/workspace"\n[sandbox]\n');
        const first = await new SmolvmProvider([]).create('rpc-failure', {}, []);
        await first.stop();
        await set({ machines: { 'rpc-failure': 'running' } });
        const before = (await read()).calls.filter(c => c.action !== 'exec');
        PiRpcClient.connect = process => ({
          getState: async () => { throw new Error('RPC initialization failed'); },
          close: async () => {
            await process.close();
            if (closeFails) throw new Error('RPC close uncertain');
          },
        });
        const manager = new WorkerManager();
        manager.bootstrap = async () => {};
        await assert.rejects(manager.createWorker(dir, { config: configPath }, { getAvailable: () => [] }), error => {
          assert.match(error.message, /RPC initialization failed/);
          if (closeFails) {
            assert.match(error.message, /RPC close uncertain/);
            assert.match(error.message, /Sandbox rpc-failure and its controller lock were retained/);
          }
          return true;
        });
        assert.equal((await read()).machines['rpc-failure'], 'running');
        assert.deepEqual((await read()).calls.filter(c => c.action !== 'exec'), before);
        if (closeFails) {
          await assert.rejects(new SmolvmProvider([]).create('rpc-failure', {}, []), /another Pibox controller.*\.lock/);
        } else {
          const retry = await new SmolvmProvider([]).create('rpc-failure', {}, []);
          await retry.remove();
        }
      });
    }
  } finally { AuthRelay.prepareAvailable = prepare; PiRpcClient.connect = connect; }
});

test('failed stop and deletion retain controller ownership until successful retry', async () => {
  await fixture(async ({ read, set }) => {
    const first = await new SmolvmProvider([]).create('failed-cleanup', {}, []);
    await set({ failStop: true, failDelete: true });
    await assert.rejects(first.stop(), /stop failed/);
    await assert.rejects(first.remove(), /delete failed/);
    assert.equal((await read()).machines['failed-cleanup'], 'running');
    await assert.rejects(new SmolvmProvider([]).create('failed-cleanup', {}, []), /another Pibox controller/);
    await assert.rejects(first.remove(), /delete failed/);
    await set({ failStop: false, failDelete: false });
    await first.remove();
    assert.deepEqual((await read()).machines, {});
    const second = await new SmolvmProvider([]).create('failed-cleanup', {}, []);
    await second.remove();
  });
});

test('native process close rejects failed kills and unconfirmed exit; confirmed exit is idempotent', async t => {
  const { default: childProcess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  await fixture(async () => {
    const box = await new SmolvmProvider([]).create('kill-failure', {}, []);
    for (const mode of ['kill-error', 'no-exit', 'confirmed-exit']) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin = { end() {} };
      child.pid = 12345;
      const signals = [];
      child.kill = signal => {
        signals.push(signal);
        if (mode === 'kill-error') { child.emit('error', new Error('kill denied')); return false; }
        if (mode === 'confirmed-exit') child.emit('close', 0, null);
        return true;
      };
      const spawn = childProcess.spawn, timeout = globalThis.setTimeout;
      try {
        childProcess.spawn = () => child;
        syncBuiltinESMExports();
        t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => timeout(fn, Math.min(delay, 10), ...args));
        const process = await box.startProcess(['pi']);
        if (mode === 'confirmed-exit') {
          await process.close(); await process.close();
          assert.deepEqual(signals, ['SIGTERM']);
          assert.equal((await process.receive()).type, 'exit');
        } else {
          await assert.rejects(process.close(), /kill denied|terminate|exit/i);
          await assert.rejects(process.close(), /kill denied|terminate|exit/i);
          assert.deepEqual(signals, mode === 'kill-error' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
          if (mode === 'kill-error') assert.equal((await process.receive()).type, 'stderr');
        }
      } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); t.mock.restoreAll(); }
    }
    await box.remove();
  });
});
