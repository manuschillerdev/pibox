import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { loadTypeScript } from './load-typescript.mjs';

const { PiRpcClient } = await loadTypeScript('../src/pi-rpc.ts');
const bytes = text => new TextEncoder().encode(text);
function processFixture(close = async () => {}) {
  const events = [], receivers = [];
  let closes = 0;
  const process = {
    write: async () => {},
    receive: async () => events.length ? events.shift() : new Promise(resolve => receivers.push(resolve)),
    close: async () => { closes++; await close(); },
  };
  return {
    rpc: PiRpcClient.connect(process),
    push(event) { const receiver = receivers.shift(); if (receiver) receiver(event); else events.push(event); },
    get closes() { return closes; },
  };
}
function shortTimeouts(t) {
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => timeout(fn, Math.min(delay, 20), ...args));
}

test('close rejects when transport close returns without a process exit', async t => {
  shortTimeouts(t);
  const f = processFixture();
  await assert.rejects(f.rpc.close(), /exit|termination/i);
});

test('stream failure cannot conceal a failed process close', async () => {
  const f = processFixture(async () => { throw new Error('kill denied'); });
  const failed = f.rpc.waitForEvent('ready', 1000);
  f.push({ type: 'stdout', data: bytes('not-json\n') });
  await assert.rejects(failed, /stream failed/);
  await nextTurn();
  await assert.rejects(f.rpc.close(), /kill denied/);
});

test('concurrent close calls share termination failure rather than returning early', async t => {
  shortTimeouts(t);
  const f = processFixture();
  const results = await Promise.allSettled([f.rpc.close(), f.rpc.close()]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(f.closes, 1);
});

test('close is bounded when the underlying close never settles', async t => {
  shortTimeouts(t);
  const f = processFixture(() => new Promise(() => {}));
  await assert.rejects(f.rpc.close(), /termination|timed out/i);
});

test('successful close confirms exit and is idempotent', async () => {
  const f = processFixture(async () => f.push({ type: 'exit', code: 0 }));
  await Promise.all([f.rpc.close(), f.rpc.close()]);
  await f.rpc.close();
  assert.equal(f.closes, 1);
});

test('decoder failure keeps draining until confirmed exit', async () => {
  const f = processFixture(async () => f.push({ type: 'exit', code: 1 }));
  const failed = f.rpc.waitForEvent('ready', 1000);
  f.push({ type: 'stdout', data: bytes('invalid\n') });
  await assert.rejects(failed, /stream failed/);
  await f.rpc.close();
  assert.equal(f.closes, 1);
});

test('an exit with an incomplete JSONL record still confirms termination', async () => {
  const f = processFixture();
  const failed = f.rpc.waitForEvent('ready', 1000);
  f.push({ type: 'stdout', data: bytes('{') });
  f.push({ type: 'exit', code: 1 });
  await assert.rejects(failed, /unterminated/);
  await f.rpc.close();
  assert.equal(f.closes, 0);
});
