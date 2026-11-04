import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTypeScript } from './load-typescript.mjs';

const { Worker } = await loadTypeScript('../src/worker.ts');
const { guestModelCatalog } = await loadTypeScript('../src/model-catalog.ts');

function fixture({ history = [], reply, refresh = async () => {} } = {}) {
  const listeners = new Set();
  let selected = { provider: 'test', id: 'initial' };
  const selections = [];
  const rpc = {
    getState: async () => ({ model: selected }),
    getAvailableModels: async () => ({ models: ['initial', 'A', 'B'].map(id => ({ provider: 'test', id })) }),
    setModel: async (provider, id) => { selections.push(id); selected = { provider, id }; return selected; },
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    waitForEvent: async () => ({ type: 'agent_settled' }),
    prompt: async () => {
      if (reply) for (const listener of listeners) listener({ type: 'message_end', message: reply });
    },
    abort: async () => {},
    getMessages: async () => ({ messages: history }),
    getSessionStats: async () => ({}),
  };
  const worker = new Worker({ id: 'test', rpc, authRelay: { providerState: new Map(), refresh } });
  return { worker, rpc, selections, listeners };
}

test('model selections and prompt credential refresh cannot overtake each other', async () => {
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ refresh: async () => { calls.push('refresh'); if (calls.length === 1) await gate; } });
  const first = f.worker.setModel('test', 'A');
  const second = f.worker.setModel('test', 'B');
  const prompt = f.worker.prompt('test');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(f.selections, []);
  release();
  await Promise.all([first, second, prompt]);
  assert.deepEqual(f.selections, ['A', 'B']);
  assert.equal((await f.rpc.getState()).model.id, 'B');
  assert.equal(calls.length, 3);
});

test('current assistant failures surface rather than empty text', async () => {
  const f = fixture({ reply: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'authentication failed' } });
  await assert.rejects(f.worker.prompt('test'), /authentication failed/);
  assert.equal(f.listeners.size, 0);
});

test('a handled prompt cannot return an old assistant answer or old failure', async () => {
  for (const message of [
    { role: 'assistant', content: [{ type: 'text', text: 'stale' }] },
    { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'old failure' },
  ]) {
    const f = fixture({ history: [message] });
    assert.equal((await f.worker.prompt('new turn')).lastAssistantText, null);
    assert.equal(f.listeners.size, 0);
  }
});

test('assistant text comes from the current run even if history was compacted', async () => {
  const f = fixture({ history: [], reply: { role: 'assistant', content: [{ type: 'text', text: 'fresh answer' }], stopReason: 'stop' } });
  assert.equal((await f.worker.prompt('test')).lastAssistantText, 'fresh answer');
});

test('failed model selection does not poison later selections', async () => {
  const f = fixture();
  await assert.rejects(f.worker.setModel('test', 'missing'), /not available/);
  assert.equal((await f.worker.setModel('test', 'B')).id, 'B');
});

test('handled prompts complete without agent_settled and unblock later selections', async () => {
  const f = fixture();
  f.rpc.prompt = async () => ({ disposition: 'handled' });
  f.rpc.waitForEvent = (_type, _timeout, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('wait cancelled')), { once: true });
  });
  assert.equal((await f.worker.prompt('/extension-command')).lastAssistantText, null);
  assert.equal((await f.worker.setModel('test', 'B')).id, 'B');
});

test('cancellation drains a delayed abort before the next model operation', async () => {
  const f = fixture();
  const controller = new AbortController();
  let releaseAbort;
  let started;
  const abortGate = new Promise(resolve => { releaseAbort = resolve; });
  const startedGate = new Promise(resolve => { started = resolve; });
  f.rpc.prompt = async () => { started(); return { disposition: 'started' }; };
  f.rpc.abort = () => abortGate;
  f.rpc.waitForEvent = (_type, _timeout, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('wait aborted')), { once: true });
  });
  const prompt = f.worker.prompt('test', { signal: controller.signal });
  await startedGate;
  controller.abort();
  const selection = f.worker.setModel('test', 'B');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.selections, []);
  releaseAbort();
  await assert.rejects(prompt, /aborted/);
  assert.equal((await selection).id, 'B');
});

test('catalog handles prototype-like provider names and never relays auth headers', () => {
  const model = {
    id: 'model', name: 'Model', api: 'openai-completions', baseUrl: 'https://example.com/v1',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000, maxTokens: 100,
    headers: { Authorization: 'secret', Cookie: 'secret', 'X-Api-Key': 'secret', 'NVCF-POLL-SECONDS': '3600' },
  };
  const names = ['constructor', '__proto__', 'toString'];
  const catalog = guestModelCatalog(names.map(provider => ({ ...model, provider })), names);
  assert.equal(Object.getPrototypeOf(catalog), null);
  assert.deepEqual(Object.keys(catalog), names);
  for (const name of names) assert.deepEqual(catalog[name].models[0].headers, { 'NVCF-POLL-SECONDS': '3600' });
  assert.ok(!JSON.stringify(catalog).includes('secret'));
  const invalid = guestModelCatalog([{ ...model, provider: 'bad', headers: { 'NVCF-POLL-SECONDS': 'secret' } }], ['bad']);
  assert.equal(invalid.bad.models[0].headers, undefined);
  const known = guestModelCatalog(['kimi-coding', 'github-copilot'].map(provider => ({ ...model, provider, headers: { 'User-Agent': 'secret' } })), ['kimi-coding', 'github-copilot']);
  assert.equal(known['kimi-coding'].models[0].headers['User-Agent'], 'KimiCLI/1.5');
  assert.equal(known['github-copilot'].models[0].headers['User-Agent'], 'GitHubCopilotChat/0.35.0');
  assert.ok(!JSON.stringify(known).includes('secret'));
  assert.deepEqual(Object.keys(guestModelCatalog([{ ...model, provider: 'other' }], ['allowed'])), []);
});
