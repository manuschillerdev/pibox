import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadTypeScript } from './load-typescript.mjs';
const piRoot = process.env.PIBOX_TEST_PI_ROOT
  ? pathToFileURL(process.env.PIBOX_TEST_PI_ROOT.replace(/\/$/, '') + '/dist/')
  : new URL('./', import.meta.resolve('@earendil-works/pi-coding-agent'));
const { CustomEntryComponent } = await import(new URL('modes/interactive/components/custom-entry.js', piRoot));
const { initTheme } = await import(new URL('modes/interactive/theme/theme.js', piRoot));
initTheme('dark');
const { PiRpcClient } = await loadTypeScript('../src/pi-rpc.ts');
const { Worker } = await loadTypeScript('../src/worker.ts');
const { registerInteractiveBridge } = await loadTypeScript('../src/interactive-bridge.ts');

// JSONL wire fixture uses Pi's documented message_start/update/end schemas.
// No credentials, VM, or model calls; the real RPC client, Worker and bridge run.
function fixture({ twoTurns = false, thinkingLevel = 'high', rejectThinking = false, failedAttempt = false, differentModel = false } = {}) {
  const queued = [], receivers = [], commands = [], entries = [], components = [], frames = [];
  const handlers = new Map();
  let renderEntry;
  let workerLevel = 'off';
  const model = { provider: 'test', id: 'reasoner', reasoning: true };
  let selected = differentModel ? { ...model, id: 'initial' } : model;
  const send = record => {
    const event = { type: 'stdout', data: Buffer.from(JSON.stringify(record) + '\n') };
    const receive = receivers.shift();
    if (receive) receive(event); else queued.push(event);
  };
  const message = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason,
    provider: 'test', model: 'reasoner', api: 'openai-responses', timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const turn = (content, stopReason) => {
    send({ type: 'message_start', message: message([]) });
    content.forEach((part, contentIndex) => {
      if (part.type === 'thinking') send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex, delta: part.thinking } });
      if (part.type === 'text') send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex, delta: part.text } });
    });
    send({ type: 'message_end', message: message(content, stopReason ?? (content.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop')) });
  };
  const process = {
    receive: async () => queued.length ? queued.shift() : new Promise(resolve => receivers.push(resolve)),
    close: async () => { for (const receive of receivers.splice(0)) receive({ type: 'exit', code: 0 }); },
    write: async line => {
      const command = JSON.parse(line); commands.push(command);
      let data;
      if (command.type === 'get_state') data = { model: selected, thinkingLevel: workerLevel, isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
      if (command.type === 'set_model') {
        selected = model;
        workerLevel = 'off';
        data = model;
      }
      if (command.type === 'set_thinking_level') {
        if (rejectThinking) {
          send({ type: 'response', id: command.id, command: command.type, success: false, error: 'thinking unavailable' });
          return;
        }
        workerLevel = command.level;
      }
      if (command.type === 'get_available_models') data = { models: [model] };
      if (command.type === 'get_messages') data = { messages: [] };
      if (command.type === 'get_session_stats') data = {};
      if (command.type === 'prompt') data = { disposition: 'started' };
      send({ type: 'response', id: command.id, command: command.type, success: true, data });
      if (command.type === 'prompt') {
        if (failedAttempt) {
          turn([{ type: 'thinking', thinking: 'Discard failed attempt reasoning' }], 'error');
          send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: 'synthetic transient error' });
        }
        if (twoTurns) {
          turn([{ type: 'thinking', thinking: 'Reasoning before tool execution' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }]);
          send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: {} });
          send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', result: { content: [] }, isError: false });
          turn([{ type: 'text', text: 'Final answer' }]);
        } else {
          turn([...(workerLevel === 'off' ? [] : [{ type: 'thinking', thinking: 'Visible provider reasoning' }]), { type: 'text', text: 'Final answer' }]);
        }
        send({ type: 'agent_settled' });
      }
    },
  };
  const rpc = PiRpcClient.connect(process);
  const worker = new Worker({ id: 'test', rpc, authRelay: { providerState: new Map(), refresh: async () => {} } });
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    getThinkingLevel: () => thinkingLevel,
    registerEntryRenderer: (_type, renderer) => { renderEntry = renderer; },
    appendEntry: (customType, data) => {
      entries.push(data);
      components.push(new CustomEntryComponent({ type: 'custom', customType, data }, renderEntry));
    },
  };
  registerInteractiveBridge(pi, { routed: () => worker });
  const ctx = { model, ui: {
    setStatus() { frames.push(components.flatMap(c => c.render(120)).join('\n')); },
    notify() {},
  } };
  return { rpc, worker, commands, entries, handlers, ctx, components, frames,
    setHostThinking(level) { thinkingLevel = level; } };
}

test('interactive input forwards host thinking level before RPC prompt', async () => {
  const f = fixture();
  try {
    await f.handlers.get('input')({ source: 'interactive', text: 'hello' }, f.ctx);
    assert.ok(f.commands.findIndex(c => c.type === 'set_thinking_level') >= 0, 'host high must not leave worker thinking off');
    assert.ok(f.commands.findIndex(c => c.type === 'set_thinking_level') < f.commands.findIndex(c => c.type === 'prompt'));
    assert.equal(f.entries.find(e => e.role === 'assistant').thinking, 'Visible provider reasoning');
    assert.ok(f.frames.some(frame => frame.includes('Visible provider reasoning')), 'stream renders through actual Pi entry component');
    assert.match(f.components.flatMap(c => c.render(120)).join('\n'), /Visible provider reasoning/);
  } finally { await f.rpc.close(); }
});

test('reasoning before a tool turn survives final text-only assistant response', async () => {
  const f = fixture({ twoTurns: true });
  try {
    await f.handlers.get('input')({ source: 'interactive', text: 'hello' }, f.ctx);
    const answer = f.entries.find(e => e.role === 'assistant');
    assert.equal(answer.text, 'Final answer');
    assert.equal(answer.thinking, 'Reasoning before tool execution');
    assert.ok(f.frames.some(frame => frame.includes('Final answer') && frame.includes('Reasoning before tool execution')));
    for (const component of f.components) component.invalidate();
    assert.match(f.components.flatMap(c => c.render(120)).join('\n'), /Reasoning before tool execution/);
  } finally { await f.rpc.close(); }
});

test('thinking selection event reaches the worker; prompt resynchronizes after switching workers or stale state', async () => {
  const f = fixture();
  try {
    await f.handlers.get('thinking_level_select')({ level: 'low', previousLevel: 'off' }, f.ctx);
    assert.equal((await f.rpc.getState()).thinkingLevel, 'low');
    f.setHostThinking('high');
    await f.handlers.get('input')({ source: 'interactive', text: 'hello' }, f.ctx);
    assert.equal((await f.rpc.getState()).thinkingLevel, 'high');
  } finally { await f.rpc.close(); }
});

test('off stays off and a failed level sync surfaces instead of prompting with stale settings', async () => {
  const off = fixture({ thinkingLevel: 'off' });
  try {
    await off.handlers.get('input')({ source: 'interactive', text: 'hello' }, off.ctx);
    assert.ok(!off.commands.some(c => c.type === 'set_thinking_level'));
    assert.equal(off.entries.find(e => e.role === 'assistant').thinking, undefined);
  } finally { await off.rpc.close(); }
  const failure = fixture({ rejectThinking: true });
  try {
    await failure.handlers.get('input')({ source: 'interactive', text: 'hello' }, failure.ctx);
    assert.ok(!failure.commands.some(c => c.type === 'prompt'));
    assert.match(failure.entries.find(e => e.role === 'error').text, /thinking unavailable/);
  } finally { await failure.rpc.close(); }
});

test('model selection happens before thinking sync; failed retry reasoning is not persisted', async () => {
  const f = fixture({ differentModel: true, failedAttempt: true });
  try {
    await f.handlers.get('input')({ source: 'interactive', text: 'hello' }, f.ctx);
    const types = f.commands.map(c => c.type);
    assert.ok(types.indexOf('set_model') < types.indexOf('set_thinking_level'));
    assert.ok(types.indexOf('set_thinking_level') < types.indexOf('prompt'));
    const answer = f.entries.find(e => e.role === 'assistant');
    assert.equal(answer.thinking, 'Visible provider reasoning');
    assert.doesNotMatch(f.components.flatMap(c => c.render(120)).join('\n'), /Discard failed attempt/);
  } finally { await f.rpc.close(); }
});
